import mongoose from "mongoose";
import { Response } from "express";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { ActivityLog } from "../models/ActivityLog";
import { AssigneeEmail, RfqCounter } from "../models/AssigneeEmail";
import { Attachment } from "../models/Attachment";
import { Enquiry } from "../models/Enquiry";
import { Notification } from "../models/Notification";
import { User } from "../models/User";
import { sendAssignmentEmail } from "../services/emailService";
import {
  ensureEnquiryDriveFolder,
  mirrorAttachmentToDrive,
} from "../services/gdriveService";
import { InboxService, cleanMimeRemnants } from "../services/inboxService";
import { logActivity } from "../utils/auditLogger";

import zlib from "zlib";

export interface ExtractedOfferMetadata {
	enquiryNo: string;
	offerNo: string;
	offerDate: string;
	clientName: string;
	projectName: string;
	rawText?: string;
}

function sanitizeOfferNo(
	offerNo: string | undefined,
	rfqId: string | undefined,
): string {
	if (!offerNo) return "";
	const trimmed = offerNo.trim();
	if (!trimmed) return "";
	if (
		rfqId &&
		(trimmed === rfqId || trimmed === rfqId.replace("/RFQ/", "/OFR/"))
	) {
		return "";
	}
	return trimmed;
}

function extractTextFromDocx(buffer: Buffer): string {
	try {
		let text = "";
		let offset = 0;
		while (offset < buffer.length - 30) {
			if (buffer.readUInt32LE(offset) === 0x04034b50) {
				const compMethod = buffer.readUInt16LE(offset + 8);
				const compSize = buffer.readUInt32LE(offset + 18);
				const nameLen = buffer.readUInt16LE(offset + 26);
				const extraLen = buffer.readUInt16LE(offset + 28);
				const fileName = buffer.toString(
					"utf-8",
					offset + 30,
					offset + 30 + nameLen,
				);
				const dataStart = offset + 30 + nameLen + extraLen;

				if (fileName.includes("word/") || fileName.includes("document.xml")) {
					const compData = buffer.subarray(dataStart, dataStart + compSize);
					try {
						let xml = "";
						if (compMethod === 8) {
							xml = zlib.inflateRawSync(compData).toString("utf-8");
						} else if (compMethod === 0) {
							xml = compData.toString("utf-8");
						}
						const matches = xml.match(/<w:t[^>]*>(.*?)<\/w:t>/gi);
						if (matches) {
							text +=
								" " +
								matches.map((t) => t.replace(/<[^>]+>/g, "").trim()).join(" ");
						}
					} catch (e) {}
				}
				offset += 30 + nameLen + extraLen + compSize;
			} else {
				offset++;
			}
		}
		return text.trim();
	} catch (err) {
		return "";
	}
}

export const extractOfferDetailsFromDoc = async (
	buffer: Buffer,
	filename: string = "",
): Promise<ExtractedOfferMetadata> => {
	let text = "";
	const lowerFn = filename.toLowerCase();

	try {
		if (lowerFn.endsWith(".pdf") || !lowerFn.includes(".")) {
			if (typeof (globalThis as any).DOMMatrix === "undefined") {
				(globalThis as any).DOMMatrix = class DOMMatrix {};
			}
			const pdfParseFunc =
				typeof pdfParse === "function" ? pdfParse : require("pdf-parse");
			const data = await pdfParseFunc(buffer);
			text = data?.text || "";
		} else if (lowerFn.endsWith(".docx") || lowerFn.endsWith(".doc")) {
			text = extractTextFromDocx(buffer);
			if (!text) {
				const utf8Text = buffer.toString("utf-8");
				const textMatches = utf8Text.match(/<w:t[^>]*>(.*?)<\/w:t>/gi);
				if (textMatches) {
					text = textMatches
						.map((t) => t.replace(/<[^>]+>/g, "").trim())
						.join(" ");
				} else {
					text = utf8Text.replace(/[^\x20-\x7E\n\r]/g, " ");
				}
			}
		} else if (
			lowerFn.endsWith(".xlsx") ||
			lowerFn.endsWith(".xls") ||
			lowerFn.endsWith(".csv")
		) {
			const workbook = XLSX.read(buffer, { type: "buffer" });
			text = workbook.SheetNames.map((sheetName) => {
				const sheet = workbook.Sheets[sheetName];
				return XLSX.utils.sheet_to_csv(sheet);
			}).join("\n");
		} else {
			text = buffer.toString("utf-8");
		}
	} catch (err) {
		console.error("Error extracting text from document:", err);
		text = buffer.toString("utf-8");
	}

	if (!text.trim()) {
		return {
			enquiryNo: "",
			offerNo: "",
			offerDate: "",
			clientName: "",
			projectName: "",
		};
	}

	const lines = text
		.split(/\r?\n/)
		.map((l: string) => l.replace(/\s+/g, " ").trim())
		.filter(Boolean);

	const fullText = lines.join(" \n");

	let enquiryNo = "";
	let offerNo = "";
	let offerDate = "";
	let clientName = "";
	let projectName = "";

	function cleanRefToken(raw: string): string {
		if (!raw) return "";
		let cleaned = raw.trim().replace(/^[:\-\s]+|[:\-\s]+$/g, "");
		cleaned = cleaned
			.split(
				/\s+(?:DT|Date|Dated|Client|Company|Subject|Sub|Dear|Kind|PP|Tel|Mobile|Email|TABLE)\b/i,
			)[0]
			.trim();
		cleaned = cleaned.split(/[\r\n\(\)]/)[0].trim();

		const codeMatch = cleaned.match(/([A-Za-z0-9./_\-]{4,})/);
		if (codeMatch && codeMatch[1]) {
			return codeMatch[1];
		}

		return cleaned.substring(0, 40);
	}

	// 1. Extraction matching Python RFQ project (enquiries.py _extract_offer_details_from_pdf)
	const patterns = [
		/(?:Enquiry|Enq(?:uiry)?|ENQ)\s*(?:No|Number|#)?\.?\s*[:\-]?\s*([A-Za-z0-9./_\-\s]+?)(?=\s+(?:DT|Date|Dated)|$|\n)/i,
		/(?:Offer|Quotation|Quote)\s*(?:No|Number|#)?\.?\s*[:\-]?\s*([A-Za-z0-9./_\-\s]+?)(?=\s+(?:DT|Date|Dated)|$|\n)/i,
		/(?:Ref(?:erence)?|Doc(?:ument)?|Order)\s*(?:No|Number|#)?\.?\s*[:\-]?\s*([A-Za-z0-9./_\-\s]+?)(?=\s+(?:DT|Date|Dated)|$|\n)/i,
		/(?:Enquiry|Offer|Ref|Doc)\s*[:\-]\s*([A-Za-z0-9./_\-]+)/i,
	];

	for (const pattern of patterns) {
		const match = fullText.match(pattern);
		if (match && match[1]) {
			let cand = cleanRefToken(match[1]);
			if (
				cand.length > 3 &&
				!["number", "details", "date"].includes(cand.toLowerCase())
			) {
				offerNo = cand;
				break;
			}
		}
	}

	// Line-by-line fallback matching Python RFQ project
	if (!offerNo) {
		for (const l of lines) {
			const match = l.match(
				/(?:Enquiry|Enq(?:uiry)?|ENQ|Offer|Quotation|Quote|Ref)\s*(?:No|Number|#)?\.?\s*[:\-]?\s*(.+)$/i,
			);
			if (!match) continue;
			let tail = cleanRefToken(match[1]);
			if (tail && tail.length > 3) {
				offerNo = tail;
				break;
			}
		}
	}

	// 2. Extract Offer Date matching Python RFQ project
	const datePatterns = [
		/\b(?:DT|Date|Dated)\.?\s*[:\-]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/i,
		/\b(?:Date|Dated)\s*[:\-]?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{2,4})\b/i,
		/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/,
	];
	for (const dp of datePatterns) {
		const dm = fullText.match(dp);
		if (dm && dm[1]) {
			offerDate = dm[1].trim();
			break;
		}
	}

	// 3. Extract Client Name (e.g. Client: PP Rolling Mills)
	const clientPatterns = [
		/(?:Client|Customer)\s*(?:Name)?\s*[:\-]?\s*([^\n\r]+)/i,
	];
	for (const cp of clientPatterns) {
		const cm = fullText.match(cp);
		if (cm && cm[1]) {
			const candidate = cm[1].trim();
			if (
				candidate.length > 2 &&
				!candidate.toLowerCase().includes("project")
			) {
				clientName = candidate;
				break;
			}
		}
	}

	// 4. Extract Project / Equipment Name
	const projectPatterns = [
		/(?:Project\s*\/\s*Equipment|Project\s*Name)\s*[:\-]?\s*([^\n\r]+)/i,
		/(?:Equipment|Item)\s*[:\-]?\s*([^\n\r]+)/i,
	];
	for (const pp of projectPatterns) {
		const pm = fullText.match(pp);
		if (pm && pm[1]) {
			const candidate = pm[1].trim();
			if (candidate.length > 2) {
				projectName = candidate;
				break;
			}
		}
	}

	if (!enquiryNo) enquiryNo = offerNo;
	if (!offerNo) offerNo = enquiryNo;

	return {
		enquiryNo,
		offerNo,
		offerDate,
		clientName,
		projectName,
		rawText: text.substring(0, 500),
	};
};

export const findMatchingEnquiryForOffer = async (
	extracted: ExtractedOfferMetadata,
): Promise<any | null> => {
	const { enquiryNo, clientName } = extracted;

	if (enquiryNo) {
		const cleanNo = enquiryNo.replace(/\bDT\.?\s*\d+.*/i, "").trim();
		const coreNumberMatch = cleanNo.match(/\d{3,5}\.\d+|\d{3,}/);
		const coreNo = coreNumberMatch ? coreNumberMatch[0] : cleanNo;

		const matchedByNo = await Enquiry.findOne({
			$or: [
				{ rfqId: { $regex: cleanNo, $options: "i" } },
				{ rfqId: { $regex: coreNo, $options: "i" } },
				{ clientRefNo: { $regex: cleanNo, $options: "i" } },
				{ clientRefNo: { $regex: coreNo, $options: "i" } },
				{ remarks: { $regex: cleanNo, $options: "i" } },
				{ followupRemarks: { $regex: cleanNo, $options: "i" } },
			],
		});

		if (matchedByNo) return matchedByNo;
	}

	if (clientName) {
		const cleanClient = clientName.split(/\s+/)[0];
		if (cleanClient.length >= 2) {
			const matchedByClient = await Enquiry.findOne({
				companyName: { $regex: clientName, $options: "i" },
				status: { $nin: ["Closed", "Regret", "Cancelled"] },
			}).sort({ createdAt: -1 });

			if (matchedByClient) return matchedByClient;
		}
	}

	return null;
};

const CLOSED_STATUSES = new Set([
	"closed",
	"won",
	"lost",
	"cancelled",
	"rejected",
	"po received",
	"regret",
]);
const STANDARD_TAT_DAYS = 30;

const FULL_ACCESS_ROLES = new Set([
	"ADMIN",
	"CO",
	"GM",
	"PRODUCTION_HEAD",
	"SALES_MARKETING",
]);
const CAN_REVIEW_ROLES = new Set(["ADMIN", "CO", "GM", "PRODUCTION_HEAD"]);
const CAN_EDIT_ROLES = new Set([
	"ADMIN",
	"CO",
	"GM",
	"PRODUCTION_HEAD",
	"SALES_MARKETING",
]);

export function canSeeFullRfqList(user?: any): boolean {
	if (!user) return true;
	const roleName = (
		user.roleName ||
		user.role?.name ||
		user.role ||
		""
	).toUpperCase();
	if (FULL_ACCESS_ROLES.has(roleName)) return true;
	if (
		Array.isArray(user.permissions) &&
		(user.permissions.includes("RFQ:READ_ALL") ||
			user.permissions.includes("USER_MGMT:MANAGE"))
	)
		return true;
	return false;
}

export function canReviewRfq(user?: any): boolean {
	if (!user) return true;
	const roleName = (
		user.roleName ||
		user.role?.name ||
		user.role ||
		""
	).toUpperCase();
	if (CAN_REVIEW_ROLES.has(roleName)) return true;
	if (
		Array.isArray(user.permissions) &&
		user.permissions.includes("RFQ:REVIEW")
	)
		return true;
	return false;
}

export function canFinalApproveRfq(user?: any): boolean {
	if (!user) return true;
	const roleName = (
		user.roleName ||
		user.role?.name ||
		user.role ||
		""
	).toUpperCase();
	if (roleName === "ADMIN") return true;
	if (
		Array.isArray(user.permissions) &&
		user.permissions.includes("RFQ:FINAL_APPROVE")
	)
		return true;
	return false;
}

export function canEditRfq(user?: any): boolean {
	if (!user) return true;
	const roleName = (
		user.roleName ||
		user.role?.name ||
		user.role ||
		""
	).toUpperCase();
	if (CAN_EDIT_ROLES.has(roleName)) return true;
	if (Array.isArray(user.permissions) && user.permissions.includes("RFQ:WRITE"))
		return true;
	return false;
}

async function getAuthenticatedUserInfo(req: AuthenticatedRequest) {
	if (!req.user?.userId) return null;
	const dbUser: any = await User.findById(req.user.userId).populate("roleId");
	if (!dbUser) return null;
	return {
		id: dbUser._id.toString(),
		name: dbUser.name,
		email: dbUser.email,
		roleName: dbUser.roleId?.name || "USER",
	};
}

export function isAdmin(user: any): boolean {
	if (!user) return true;
	const roleName = (
		user.roleName ||
		user.role?.name ||
		user.role ||
		""
	).toUpperCase();
	if (
		roleName === "ADMIN" ||
		roleName === "CO" ||
		roleName === "GM" ||
		roleName === "PRODUCTION_HEAD"
	)
		return true;
	if (
		Array.isArray(user.permissions) &&
		(user.permissions.includes("RFQ:DELETE") ||
			user.permissions.includes("USER_MGMT:MANAGE"))
	)
		return true;
	return false;
}

export function canChangeStatus(user: any): boolean {
	if (!user) return true;
	const roleName = (
		user.roleName ||
		user.role?.name ||
		user.role ||
		""
	).toUpperCase();
	if (
		roleName === "ADMIN" ||
		roleName === "CO" ||
		roleName === "GM" ||
		roleName === "PRODUCTION_HEAD" ||
		roleName === "SALES_MARKETING"
	)
		return true;
	if (
		Array.isArray(user.permissions) &&
		(user.permissions.includes("RFQ:CHANGE_STATUS") ||
			user.permissions.includes("RFQ:WRITE"))
	)
		return true;
	return false;
}

function getTodayIso(): string {
	return new Date().toISOString().split("T")[0];
}

function parseIsoDate(val?: string): string {
	if (!val) return "";
	const trimmed = val.trim();
	const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
	if (isoMatch) return isoMatch[1];

	const d = new Date(trimmed);
	if (!isNaN(d.getTime())) {
		return d.toISOString().split("T")[0];
	}
	return "";
}

function isClosed(status?: string): boolean {
	return CLOSED_STATUSES.has((status || "").toLowerCase());
}

function calculateDaysOpen(
	receivedOn?: string,
	status?: string,
): number | null {
	if (isClosed(status) || !receivedOn) return null;
	const parsed = parseIsoDate(receivedOn);
	if (!parsed) return null;

	const start = new Date(parsed).getTime();
	const now = new Date(getTodayIso()).getTime();
	const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
	return Math.max(diffDays, 0);
}

function calculateAgeClass(daysOpen: number | null): string {
	if (daysOpen === null) return "";
	if (daysOpen >= 30) return "age-red";
	if (daysOpen >= 14) return "age-amber";
	return "age-green";
}

function getTatValue(tatStr?: string): number {
	if (!tatStr) return STANDARD_TAT_DAYS;
	const num = parseInt(tatStr, 10);
	return isNaN(num) || num < 0 ? STANDARD_TAT_DAYS : num;
}

function calculateTentativeOfferDate(
	assignedDate?: string,
	dateReceived?: string,
	tatStr?: string,
): string | null {
	const baseDateIso = parseIsoDate(assignedDate) || parseIsoDate(dateReceived);
	if (!baseDateIso) return null;

	const tatDays = getTatValue(tatStr);
	const base = new Date(baseDateIso);
	base.setDate(base.getDate() + tatDays);
	return base.toISOString().split("T")[0];
}

function isFollowupDue(
	assignedDate?: string,
	dateReceived?: string,
	tatStr?: string,
	status?: string,
): boolean {
	if (isClosed(status)) return false;
	const tod = calculateTentativeOfferDate(assignedDate, dateReceived, tatStr);
	if (!tod) return false;
	return tod <= getTodayIso();
}

/** Generate monotonic RFQ ID e.g. ENC/RFQ/2026/001 */
async function generateNextRfqId(): Promise<string> {
	const year = new Date().getFullYear().toString();
	const counter: any = await RfqCounter.findOneAndUpdate(
		{ year },
		{ $inc: { lastSeq: 1 } },
		{ upsert: true, new: true },
	);
	const seqStr = String(counter.lastSeq).padStart(3, "0");
	return `ENC/RFQ/${year}/${seqStr}`;
}

export const getEnquiries = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const {
			status,
			assignedTo,
			search,
			due,
			overdue,
			mapped,
			tab,
			sort = "_id",
			dir = "desc",
		} = req.query;

		const userInfo = await getAuthenticatedUserInfo(req);
		const isFullAccess = canSeeFullRfqList(userInfo || req.user);

		const where: any = {};
		const tabName = String(tab || "").toLowerCase();

		// 1. Status / Tab filtering
		if (
			status &&
			status !== "all" &&
			status !== "All Statuses" &&
			status !== "All"
		) {
			const s = String(status).trim();
			where.status = { $regex: `^${s}$`, $options: "i" };
		} else if (tabName === "incomplete") {
			where.status = { $regex: "^Incomplete$", $options: "i" };
		} else if (tabName === "review") {
			where.status = { $regex: "^(Under review|Verified)$", $options: "i" };
		} else if (tabName === "approved") {
			where.status = { $regex: "^Approved$", $options: "i" };
		} else if (tabName === "offersent") {
			where.status = { $regex: "^Offer Sent$", $options: "i" };
		} else if (tabName === "active") {
			where.status = { $nin: ["Closed", "REGRET", "closed", "regret"] };
		}

		// 2. Assignee filtering
		if (assignedTo && assignedTo !== "all" && assignedTo !== "All") {
			if (assignedTo === "Unassigned") {
				where.assignedTo = "";
			} else {
				where.assignedTo = String(assignedTo);
			}
		}

		// 3. Search query filtering
		if (search) {
			const q = String(search).trim();
			if (q) {
				where.$or = [
					{ rfqId: { $regex: q, $options: "i" } },
					{ companyName: { $regex: q, $options: "i" } },
					{ itemDescription: { $regex: q, $options: "i" } },
					{ contactPerson: { $regex: q, $options: "i" } },
					{ email: { $regex: q, $options: "i" } },
					{ offerNo: { $regex: q, $options: "i" } },
				];
			}
		}

		// 4. User role scoping
		if (!isFullAccess && userInfo) {
			const userAssigneeFilter = {
				$or: [
					{ assignedTo: userInfo.name },
					{ assignedTo: userInfo.email },
					{ salesResponsibility: userInfo.name },
					{ technical: userInfo.name },
				],
			};

			if (where.$or) {
				where.$and = [{ $or: where.$or }, userAssigneeFilter];
				delete where.$or;
			} else {
				where.$or = userAssigneeFilter.$or;
			}
		}

		// 5. Fetch all matching documents for exact in-memory computations & pagination
		const rawEnquiries: any[] = await Enquiry.find(where)
			.select("-emailBody")
			.sort({ _id: dir === "asc" ? 1 : -1 })
			.lean();

		let enriched = rawEnquiries.map((e) => {
			const daysOpen = calculateDaysOpen(
				e.receivedOn || e.dateReceived,
				e.status,
			);
			const ageClass = calculateAgeClass(daysOpen);
			const tentativeOfferDate = calculateTentativeOfferDate(
				e.assignedDate,
				e.dateReceived,
				e.tat,
			);
			const followupDue = isFollowupDue(
				e.assignedDate,
				e.dateReceived,
				e.tat,
				e.status,
			);
			const isOverdue = !isClosed(e.status) && (daysOpen || 0) >= 30;
			const cleanOfferNo = sanitizeOfferNo(e.offerNo, e.rfqId);

			return {
				...e,
				id: e._id.toString(),
				offerNo: cleanOfferNo,
				daysOpen,
				ageClass,
				tentativeOfferDate,
				followupDue,
				isOverdue,
				tatDays: getTatValue(e.tat),
				isMappedToOffer: Boolean(cleanOfferNo),
			};
		});

		// 6. Secondary memory filters (due, overdue, mapped, unmapped tab)
		if (due === "true" || tabName === "due") {
			enriched = enriched.filter((e) => e.followupDue);
		}
		if (overdue === "true" || tabName === "overdue") {
			enriched = enriched.filter((e) => e.isOverdue);
		}
		if (mapped === "true") {
			enriched = enriched.filter((e) => e.isMappedToOffer);
		} else if (mapped === "false" || tabName === "unmapped") {
			enriched = enriched.filter((e) => !e.isMappedToOffer);
		}

		// 7. Calculate Pagination & Slice Array
		const pageNum = Math.max(
			1,
			parseInt(String(req.query.page || "1"), 10) || 1,
		);
		const limitNum = Math.min(
			100,
			Math.max(1, parseInt(String(req.query.limit || "10"), 10) || 10),
		);

		const totalMatching = enriched.length;
		const totalPages = Math.max(1, Math.ceil(totalMatching / limitNum));
		const clampedPage = Math.min(pageNum, totalPages);

		const pageItems = enriched.slice(
			(clampedPage - 1) * limitNum,
			clampedPage * limitNum,
		);

		const pagination = {
			page: clampedPage,
			limit: limitNum,
			total: totalMatching,
			totalPages,
			hasNextPage: clampedPage < totalPages,
			hasPrevPage: clampedPage > 1,
		};

		// 8. Stats Calculation across all scope
		const baseStatsWhere: any = {};
		if (!isFullAccess && userInfo) {
			baseStatsWhere.$or = [
				{ assignedTo: userInfo.name },
				{ assignedTo: userInfo.email },
				{ salesResponsibility: userInfo.name },
				{ technical: userInfo.name },
			];
		}

		const allRawEnquiries: any[] = await Enquiry.find(baseStatsWhere)
			.select(
				"status assignedTo dateReceived receivedOn assignedDate tat offerNo rfqId",
			)
			.lean();

		const allEnriched = allRawEnquiries.map((e) => {
			const daysOpen = calculateDaysOpen(
				e.receivedOn || e.dateReceived,
				e.status,
			);
			const followupDue = isFollowupDue(
				e.assignedDate,
				e.dateReceived,
				e.tat,
				e.status,
			);
			const cleanOfferNo = sanitizeOfferNo(e.offerNo, e.rfqId);
			return {
				...e,
				daysOpen,
				followupDue,
				isMappedToOffer: Boolean(cleanOfferNo),
			};
		});

		const activeEnquiries = allEnriched.filter((e) => !isClosed(e.status));
		const overdueCount = activeEnquiries.filter((e) => (e.daysOpen || 0) >= 30).length;
		const dueTodayCount = allEnriched.filter((e) => e.followupDue).length;
		const approvedCount = allEnriched.filter(
			(e) => (e.status || "").toLowerCase() === "approved",
		).length;
		const offersSentCount = allEnriched.filter(
			(e) => (e.status || "").toLowerCase() === "offer sent",
		).length;
		const unmappedCount = allEnriched.filter((e) => !e.isMappedToOffer).length;

		const stats = {
			total: allEnriched.length,
			active: activeEnquiries.length,
			incompleteCount: allEnriched.filter(
				(e) => (e.status || "").toLowerCase() === "incomplete",
			).length,
			underReview: allEnriched.filter(
				(e) =>
					(e.status || "").toLowerCase() === "under review" ||
					(e.status || "").toLowerCase() === "verified",
			).length,
			approvedCount,
			approvedCosting: approvedCount,
			offerSent: offersSentCount,
			offersSent: offersSentCount,
			closed: allEnriched.filter((e) => isClosed(e.status)).length,
			overdue: overdueCount,
			overdueCount,
			dueFollowups: dueTodayCount,
			dueToday: dueTodayCount,
			mappedOffersCount: allEnriched.filter((e) => e.isMappedToOffer).length,
			pendingCount: unmappedCount,
			unmappedOffers: unmappedCount,
			byAssignee: Object.entries(
				activeEnquiries.reduce((acc: any, curr) => {
					const assignee = curr.assignedTo || "Unassigned";
					acc[assignee] = (acc[assignee] || 0) + 1;
					return acc;
				}, {}),
			).map(([name, count]) => ({ name, count })),
		};

		return res.json({
			success: true,
			pagination,
			stats,
			data: pageItems,
			isFullAccess,
			userRole: userInfo?.roleName || req.user?.role || "USER",
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const getOfferMapping = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const { show, q } = req.query;
		const userInfo = await getAuthenticatedUserInfo(req);
		const isFullAccess = canSeeFullRfqList(userInfo || req.user);

		const userScopeWhere =
			!isFullAccess && userInfo
				? {
						$or: [
							{ assignedTo: userInfo.name },
							{ assignedTo: userInfo.email },
							{ salesResponsibility: userInfo.name },
							{ technical: userInfo.name },
						],
					}
				: {};

		const where: any = { ...userScopeWhere };

		if (show === "quoted") {
			where.offerNo = { $ne: "" };
		} else if (show === "pending") {
			where.offerNo = "";
		}

		if (q) {
			const searchTerm = String(q).trim();
			if (searchTerm) {
				where.$or = [
					{ rfqId: { $regex: searchTerm, $options: "i" } },
					{ offerNo: { $regex: searchTerm, $options: "i" } },
					{ companyName: { $regex: searchTerm, $options: "i" } },
					{ itemDescription: { $regex: searchTerm, $options: "i" } },
				];
			}
		}

		const all: any[] = await Enquiry.find(userScopeWhere)
			.sort({ _id: -1 })
			.lean();
		const filtered: any[] = await Enquiry.find(where)
			.select("rfqId offerNo offerDate companyName itemDescription status")
			.sort({ _id: -1 })
			.lean();

		const quoted = all.filter((e) =>
			Boolean(sanitizeOfferNo(e.offerNo, e.rfqId)),
		).length;
		const pending = all.length - quoted;

		const formattedData = filtered.map((e) => {
			const cleanOfferNo = sanitizeOfferNo(e.offerNo, e.rfqId);
			return {
				...e,
				id: e._id.toString(),
				offerNo: cleanOfferNo,
			};
		});

		return res.json({
			success: true,
			stats: {
				total: all.length,
				quoted,
				pending,
			},
			data: formattedData,
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const getAnalyticsDashboard = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const userInfo = await getAuthenticatedUserInfo(req);
		const isFullAccess = canSeeFullRfqList(userInfo || req.user);

		const userScopeWhere =
			!isFullAccess && userInfo
				? {
						$or: [
							{ assignedTo: userInfo.name },
							{ assignedTo: userInfo.email },
							{ salesResponsibility: userInfo.name },
							{ technical: userInfo.name },
						],
					}
				: {};

		const enquiries: any[] = await Enquiry.find(userScopeWhere)
			.select("-emailBody")
			.sort({ _id: -1 })
			.lean();

		const enriched = enquiries.map((e) => {
			const daysOpen = calculateDaysOpen(
				e.receivedOn || e.dateReceived,
				e.status,
			);
			const isOverdue = !isClosed(e.status) && (daysOpen || 0) >= 30;
			const followupDue = isFollowupDue(
				e.assignedDate,
				e.dateReceived,
				e.tat,
				e.status,
			);
			return { ...e, id: e._id.toString(), daysOpen, isOverdue, followupDue };
		});

		const activeEnquiries = enriched.filter((e) => !isClosed(e.status));
		const activeDaysOpen = activeEnquiries.map((e) => e.daysOpen || 0);
		const avgOpenAge =
			activeDaysOpen.length > 0
				? Math.round(
						activeDaysOpen.reduce((a, b) => a + b, 0) / activeDaysOpen.length,
					)
				: 0;

		const summary = {
			total: enquiries.length,
			open: enriched.filter((e) => (e.status || "").toLowerCase() === "open")
				.length,
			underReview: enriched.filter(
				(e) => (e.status || "").toLowerCase() === "under review",
			).length,
			offerSent: enriched.filter(
				(e) => (e.status || "").toLowerCase() === "offer sent",
			).length,
			closed: enriched.filter((e) => isClosed(e.status)).length,
			overdue: activeEnquiries.filter((e) => e.isOverdue).length,
			dueFollowups: enriched.filter((e) => e.followupDue).length,
			avgOpenAge,
		};

		const assigneeMap = new Map<
			string,
			{ active: number; overdue: number; ageSum: number }
		>();
		activeEnquiries.forEach((e) => {
			const name = e.assignedTo || "Unassigned";
			const curr = assigneeMap.get(name) || {
				active: 0,
				overdue: 0,
				ageSum: 0,
			};
			curr.active += 1;
			if (e.isOverdue) curr.overdue += 1;
			curr.ageSum += e.daysOpen || 0;
			assigneeMap.set(name, curr);
		});

		const workload = Array.from(assigneeMap.entries()).map(([name, data]) => ({
			name,
			active: data.active,
			overdue: data.overdue,
			avgAge: data.active > 0 ? Math.round(data.ageSum / data.active) : 0,
		}));

		const statusCounts: { [k: string]: number } = {};
		enquiries.forEach((e) => {
			const st = e.status || "Open";
			statusCounts[st] = (statusCounts[st] || 0) + 1;
		});

		const byStatus = Object.entries(statusCounts).map(([label, count]) => ({
			label,
			count,
			pct:
				enquiries.length > 0 ? Math.round((count / enquiries.length) * 100) : 0,
		}));

		const monthCounts: { [k: string]: number } = {};
		enquiries.forEach((e) => {
			const dateStr = parseIsoDate(e.dateReceived || e.receivedOn);
			const monthKey = dateStr ? dateStr.substring(0, 7) : "Unknown";
			monthCounts[monthKey] = (monthCounts[monthKey] || 0) + 1;
		});

		const maxMonthCount = Math.max(...Object.values(monthCounts), 1);
		const byMonth = Object.entries(monthCounts)
			.sort((a, b) => b[0].localeCompare(a[0]))
			.slice(0, 12)
			.map(([label, count]) => ({
				label,
				count,
				pct: Math.round((count / maxMonthCount) * 100),
			}));

		return res.json({
			success: true,
			summary,
			workload,
			byStatus,
			byMonth,
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const getEnquiryById = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id || !mongoose.Types.ObjectId.isValid(id)) {
			return res
				.status(404)
				.json({ success: false, message: "Enquiry not found" });
		}

		const enquiry: any = await Enquiry.findById(id).lean();
		if (!enquiry) {
			return res
				.status(404)
				.json({ success: false, message: "Enquiry not found" });
		}

		const attachments: any[] = await Attachment.find({ enquiryId: id })
			.select("-data")
			.lean();

		const userInfo = await getAuthenticatedUserInfo(req);
		const isFullAccess = canSeeFullRfqList(userInfo || req.user);
		if (!isFullAccess && userInfo) {
			const isAssigned =
				(enquiry.assignedTo &&
					(enquiry.assignedTo === userInfo.name ||
						enquiry.assignedTo === userInfo.email)) ||
				(enquiry.salesResponsibility &&
					enquiry.salesResponsibility === userInfo.name) ||
				(enquiry.technical && enquiry.technical === userInfo.name);
			if (!isAssigned) {
				return res.status(403).json({
					success: false,
					message: "Access Denied: You can only view RFQs assigned to you.",
				});
			}
		}

		const daysOpen = calculateDaysOpen(
			enquiry.receivedOn || enquiry.dateReceived,
			enquiry.status,
		);
		const cleanAttachments = (attachments || []).map((att: any) => ({
			id: att._id.toString(),
			filename: att.filename,
			contentType: att.contentType,
			size: att.size,
			objectKey: att.objectKey,
			uploadedBy: att.uploadedBy,
			kind: att.kind,
			createdAt: att.createdAt,
			url: `/api/rfq/attachments/${att._id}`,
		}));

		let activityLogs: any[] = [];
		try {
			const safeId = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const safeRfqId = enquiry.rfqId
				? String(enquiry.rfqId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				: "";

			const orConditions: any[] = [
				{ details: { $regex: safeId, $options: "i" } },
			];
			if (safeRfqId) {
				orConditions.push({ details: { $regex: safeRfqId, $options: "i" } });
			}

			activityLogs = await ActivityLog.find({ $or: orConditions })
				.sort({ createdAt: -1 })
				.limit(30)
				.lean();
		} catch (logErr) {
			console.warn("[getEnquiryById] ActivityLog fetch warning:", logErr);
			activityLogs = [];
		}

		const cleanOfferNo = sanitizeOfferNo(enquiry.offerNo, enquiry.rfqId);

		const enriched = {
			...enquiry,
			id: enquiry._id.toString(),
			offerNo: cleanOfferNo,
			emailBody: enquiry.emailBody || "",
			attachments: cleanAttachments,
			daysOpen,
			ageClass: calculateAgeClass(daysOpen),
			tentativeOfferDate: calculateTentativeOfferDate(
				enquiry.assignedDate,
				enquiry.dateReceived,
				enquiry.tat,
			),
			followupDue: isFollowupDue(
				enquiry.assignedDate,
				enquiry.dateReceived,
				enquiry.tat,
				enquiry.status,
			),
			isMappedToOffer: Boolean(cleanOfferNo),
		};

		return res.json({ success: true, data: enriched, history: activityLogs });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const createEnquiry = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const body = req.body;
		let rfqId = (body.rfqId || "").trim();
		if (!rfqId) {
			rfqId = await generateNextRfqId();
		}

		const dateReceived = body.dateReceived || getTodayIso();
		const receivedOn = parseIsoDate(dateReceived) || getTodayIso();

		const enquiry: any = await Enquiry.create({
			rfqId,
			dateReceived,
			receivedOn,
			type: body.type || "Equipment",
			companyName: body.companyName || "",
			contactPerson: body.contactPerson || "",
			mobile: body.mobile || "",
			email: body.email || "",
			itemDescription: body.itemDescription || "",
			assignedTo: body.technical || body.assignedTo || "",
			assignedDate: body.technical || body.assignedTo ? getTodayIso() : "",
			tat: body.tat || "30",
			salesResponsibility: body.salesResponsibility || "",
			technical: body.technical || body.assignedTo || "",
			status: body.status || "Open",
			remarks: body.remarks || "",
			pendingRemarks: body.pendingRemarks || "",
			followupRemarks: body.followupRemarks || "",
			nextActionDate: body.nextActionDate || "",
			lastCallDate: body.lastCallDate || "",
			offerNo: body.offerNo || "",
			offerDate: body.offerDate ? parseIsoDate(body.offerDate) : "",
			doc: body.doc || "",
			costing: body.costing || "",
			timeline: body.timeline || "",
		});

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "RFQ_CREATED",
			details: {
				enquiryId: enquiry._id.toString(),
				rfqId: enquiry.rfqId,
				company: enquiry.companyName,
			},
		});

		if (enquiry.assignedTo) {
			createAssignmentNotification(
				enquiry,
				enquiry.assignedTo,
				req.user?.email || "User",
			).catch(() => {});
		}
		if (enquiry.technical && enquiry.technical !== enquiry.assignedTo) {
			createAssignmentNotification(
				enquiry,
				enquiry.technical,
				req.user?.email || "User",
			).catch(() => {});
		}

		const cleanData = {
			...enquiry.toObject(),
			id: enquiry._id.toString(),
			emailBody: undefined,
		};
		return res.status(201).json({ success: true, data: cleanData });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

async function createAssignmentNotification(
	enquiry: any,
	assigneeStr: string,
	assignerEmail: string,
) {
	if (!assigneeStr || !assigneeStr.trim()) return;

	try {
		const targetStr = assigneeStr.trim().toLowerCase();

		const allUsers: any[] = await User.find({ status: "ACTIVE" })
			.populate("roleId")
			.lean();

		let matchedUsers = allUsers.filter((u) => {
			const uName = u.name.toLowerCase();
			const uEmail = u.email.toLowerCase();
			const uRole = u.roleId?.name?.toLowerCase() || "";

			return (
				uName === targetStr ||
				uEmail === targetStr ||
				uName.includes(targetStr) ||
				targetStr.includes(uName) ||
				uEmail.includes(targetStr) ||
				targetStr.includes(uEmail) ||
				(targetStr.includes("tech") &&
					(uRole.includes("tech") || uRole.includes("design")))
			);
		});

		if (
			matchedUsers.length === 0 &&
			(targetStr.includes("tech") || targetStr.includes("assign"))
		) {
			matchedUsers = allUsers.filter((u) => {
				const uRole = u.roleId?.name?.toLowerCase() || "";
				return (
					uRole.includes("tech") ||
					uRole.includes("design") ||
					uRole.includes("engineer")
				);
			});
		}

		if (matchedUsers.length > 0) {
			for (const targetUser of matchedUsers) {
				await Notification.create({
					title: "New RFQ Assigned to You",
					message: `RFQ ${enquiry.rfqId} (${enquiry.companyName || "Enquiry"}) has been assigned to you by ${assignerEmail}.`,
					type: "SYSTEM",
					targetUserId: targetUser._id,
				});

				sendAssignmentEmail({
					toEmail: targetUser.email,
					assigneeName: targetUser.name,
					assignerEmail: assignerEmail,
					enquiry: {
						id: enquiry._id.toString(),
						rfqId: enquiry.rfqId,
						companyName: enquiry.companyName,
						itemDescription: enquiry.itemDescription,
					},
				}).catch((e) =>
					console.error("Error sending assignment email:", e.message),
				);
			}
		}
	} catch (err: any) {
		console.error("Failed to create assignment notification:", err.message);
	}
}

export const updateEnquiry = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const userInfo = await getAuthenticatedUserInfo(req);
		if (!canEditRfq(userInfo || req.user)) {
			return res.status(403).json({
				success: false,
				message:
					"Access Denied: Technical Person is only permitted to upload documents and cannot edit RFQ details.",
			});
		}

		const body = req.body;
		const existing: any = await Enquiry.findById(id);
		if (!existing) {
			return res
				.status(404)
				.json({ success: false, message: "Enquiry not found" });
		}

		const updateData: any = { ...body };
		if (body.assignedTo && body.assignedTo !== existing.assignedTo) {
			updateData.assignedDate = getTodayIso();
		}
		if (body.offerDate) {
			updateData.offerDate = parseIsoDate(body.offerDate);
		}

		const updated: any = await Enquiry.findByIdAndUpdate(id, updateData, {
			new: true,
		});

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "RFQ_UPDATED",
			details: { enquiryId: id, rfqId: updated.rfqId, updates: body },
		});

		if (body.assignedTo && body.assignedTo !== existing.assignedTo) {
			createAssignmentNotification(
				updated,
				body.assignedTo,
				req.user?.email || "User",
			).catch(() => {});
		}

		return res.json({
			success: true,
			message: "Enquiry updated successfully",
			data: { ...updated.toObject(), id: updated._id.toString() },
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const sendForReview = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const updated: any = await Enquiry.findByIdAndUpdate(
			id,
			{ status: "Under review" },
			{ new: true },
		);

		await Notification.create({
			title: "Costing Sent for Review",
			message: `Costing for ${updated.companyName} (${updated.rfqId}) has been marked Under Review by ${req.user?.email || "User"}`,
			type: "SYSTEM",
		});

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "RFQ_SENT_FOR_REVIEW",
			details: { enquiryId: id, rfqId: updated.rfqId },
		});

		return res.json({
			success: true,
			message: "Enquiry status updated to Under review",
			data: { ...updated.toObject(), id: updated._id.toString() },
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const verifyReview = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const userInfo = await getAuthenticatedUserInfo(req);
		if (!canReviewRfq(userInfo || req.user)) {
			return res.status(403).json({
				success: false,
				message:
					"Access Denied: You do not have permission to review & verify RFQs.",
			});
		}

		const existing: any = await Enquiry.findById(id);
		if (!existing)
			return res
				.status(404)
				.json({ success: false, message: "Enquiry not found" });

		const reviewerName = userInfo?.name || req.user?.email || "Reviewer";
		const remarksNote = req.body.remarks
			? ` [Verification Note: ${req.body.remarks}]`
			: "";

		const updated: any = await Enquiry.findByIdAndUpdate(
			id,
			{
				status: "Verified",
				verifiedBy: reviewerName,
				verifiedAt: getTodayIso(),
				remarks: existing.remarks
					? `${existing.remarks}${remarksNote}`
					: req.body.remarks || "",
			},
			{ new: true },
		);

		await Notification.create({
			title: "Costing Verified & Recommended",
			message: `Costing for ${updated.companyName} (${updated.rfqId}) was verified by ${reviewerName}. Awaiting Final Admin Approval.`,
			type: "SYSTEM",
		});

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "RFQ_VERIFIED_REVIEW",
			details: {
				enquiryId: id,
				rfqId: updated.rfqId,
				verifiedBy: reviewerName,
			},
		});

		return res.json({
			success: true,
			message:
				"Review verified & recommended successfully. Status set to Verified.",
			data: { ...updated.toObject(), id: updated._id.toString() },
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const approveReview = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const userInfo = await getAuthenticatedUserInfo(req);
		if (!canFinalApproveRfq(userInfo || req.user)) {
			return res.status(403).json({
				success: false,
				message:
					"Access Denied: Only Admin can grant Final Approval for offer dispatch to client. Other reviewers can verify and recommend.",
			});
		}

		const existing: any = await Enquiry.findById(id);
		if (!existing)
			return res
				.status(404)
				.json({ success: false, message: "Enquiry not found" });

		const finalOfferNo =
			req.body.offerNo || existing.offerNo || existing.clientRefNo || "";
		const finalOfferDate =
			req.body.offerDate || existing.offerDate || getTodayIso();
		const approverName = userInfo?.name || req.user?.email || "Admin";

		const updated: any = await Enquiry.findByIdAndUpdate(
			id,
			{
				status: "Approved",
				offerNo: finalOfferNo,
				offerDate: finalOfferDate,
				approvedBy: approverName,
				approvedAt: getTodayIso(),
			},
			{ new: true },
		);

		await Notification.create({
			title: "Final Costing Approved by Admin",
			message: `Costing for ${updated.companyName} (${updated.rfqId}) granted Final Approval by Admin (${approverName}). Ready for offer dispatch.`,
			type: "SYSTEM",
		});

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "RFQ_APPROVED_REVIEW",
			details: {
				enquiryId: id,
				rfqId: updated.rfqId,
				offerNo: finalOfferNo,
				approvedBy: approverName,
			},
		});

		return res.json({
			success: true,
			message: "Final approval granted successfully. Status set to Approved.",
			data: { ...updated.toObject(), id: updated._id.toString() },
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const uploadAttachment = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const requestedId = req.params.id;
		if (!requestedId) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const file = req.file || (req as any).files?.[0];
		const { kind = "" } = req.body;

		if (!file || !file.buffer) {
			return res
				.status(400)
				.json({ success: false, message: "No file uploaded" });
		}

		const isOfferDoc =
			kind === "offer" ||
			kind === "offer_documents" ||
			String(kind).toLowerCase().includes("offer");

		// 1. Extract metadata ONLY if uploading an offer document
		const extracted: ExtractedOfferMetadata = isOfferDoc
			? await extractOfferDetailsFromDoc(file.buffer, file.originalname)
			: {
					enquiryNo: "",
					offerNo: "",
					offerDate: "",
					clientName: "",
					projectName: "",
				};

		// 2. Intelligent RFQ Resolution by Enquiry No / Client Name
		let targetEnquiryId = requestedId;
		let matchedEnquiry =
			isOfferDoc && (extracted.enquiryNo || extracted.offerNo)
				? await findMatchingEnquiryForOffer(extracted)
				: null;

		if (matchedEnquiry) {
			targetEnquiryId = matchedEnquiry._id.toString();
		} else {
			matchedEnquiry = await Enquiry.findById(requestedId);
		}

		const relObjectKey = `enquiries/${targetEnquiryId}/${file.originalname}`;

		// 3. Create Attachment record linked to targetEnquiryId
		const attachment: any = await Attachment.create({
			enquiryId: targetEnquiryId,
			filename: file.originalname,
			contentType: file.mimetype,
			size: file.size,
			objectKey: relObjectKey,
			kind: kind || (isOfferDoc && extracted.enquiryNo ? "offer" : ""),
			uploadedBy: req.user?.email || "User",
			data: file.buffer,
		});

		mirrorAttachmentToDrive(
			targetEnquiryId,
			file.originalname,
			file.mimetype,
			file.buffer,
			kind,
		).catch((driveErr) => {
			console.error("Google Drive attachment mirror error:", driveErr);
		});

		// 4. Update Matched Enquiry details ONLY for offer document uploads
		if (matchedEnquiry && isOfferDoc) {
			const updateData: any = {};
			const docNo = extracted.offerNo || extracted.enquiryNo;
			if (docNo) {
				updateData.offerNo = docNo;
				updateData.clientRefNo = docNo;
			}
			if (extracted.offerDate) {
				updateData.offerDate = extracted.offerDate;
			}

			if (Object.keys(updateData).length > 0) {
				await Enquiry.findByIdAndUpdate(targetEnquiryId, updateData);
			}
		}

		const cleanAtt = {
			...attachment.toObject(),
			id: attachment._id.toString(),
			data: undefined,
		};
		return res.status(201).json({
			success: true,
			message: matchedEnquiry
				? `Document mapped to RFQ ${matchedEnquiry.rfqId} (${extracted.enquiryNo || matchedEnquiry.companyName})`
				: "Attachment uploaded successfully",
			targetEnquiryId,
			data: {
				...cleanAtt,
				url: `/api/rfq/attachments/${attachment._id}`,
			},
			extracted: {
				enquiryNo: extracted.enquiryNo,
				offerNo: extracted.offerNo,
				offerDate: extracted.offerDate,
				clientName: extracted.clientName,
				projectName: extracted.projectName,
			},
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const autoMapOfferDocApi = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const file = req.file || (req as any).files?.[0];
		if (!file || !file.buffer) {
			return res
				.status(400)
				.json({ success: false, message: "No offer document uploaded" });
		}

		const extracted = await extractOfferDetailsFromDoc(
			file.buffer,
			file.originalname,
		);
		const matchedEnquiry = await findMatchingEnquiryForOffer(extracted);

		if (!matchedEnquiry) {
			return res.status(404).json({
				success: false,
				message: `Could not find matching RFQ for Enquiry No: "${extracted.enquiryNo || "N/A"}" or Client: "${extracted.clientName || "N/A"}".`,
				extracted,
			});
		}

		const targetEnquiryId = matchedEnquiry._id.toString();
		const relObjectKey = `enquiries/${targetEnquiryId}/${file.originalname}`;

		const attachment: any = await Attachment.create({
			enquiryId: targetEnquiryId,
			filename: file.originalname,
			contentType: file.mimetype,
			size: file.size,
			objectKey: relObjectKey,
			kind: "offer",
			uploadedBy: req.user?.email || "User",
			data: file.buffer,
		});

		const docEnquiryNo = extracted.enquiryNo || extracted.offerNo;
		const resolvedOfferDate = extracted.offerDate || getTodayIso();

		await Enquiry.findByIdAndUpdate(targetEnquiryId, {
			offerNo: docEnquiryNo || matchedEnquiry.offerNo || matchedEnquiry.rfqId,
			offerDate: resolvedOfferDate,
			clientRefNo: docEnquiryNo || matchedEnquiry.clientRefNo,
			// Status flow is preserved manually by user; do NOT auto-change to "Offer Sent"
		});

		mirrorAttachmentToDrive(
			targetEnquiryId,
			file.originalname,
			file.mimetype,
			file.buffer,
			"offer",
		).catch(() => {});

		return res.json({
			success: true,
			message: `Offer document successfully mapped to RFQ ${matchedEnquiry.rfqId} (${matchedEnquiry.companyName})!`,
			targetEnquiryId,
			data: {
				id: attachment._id.toString(),
				filename: attachment.filename,
				url: `/api/rfq/attachments/${attachment._id}`,
			},
			extracted,
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const deleteAttachment = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const attId = req.params.attachmentId;
		if (!attId) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid attachment ID" });
		}

		await Attachment.findByIdAndDelete(attId);
		return res.json({
			success: true,
			message: "Attachment deleted successfully",
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const getAttachmentFile = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const attId = req.params.attachmentId;
		if (!attId) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid attachment ID" });
		}

		const attachment: any = await Attachment.findById(attId);
		if (!attachment) {
			return res
				.status(404)
				.json({ success: false, message: "Attachment not found" });
		}

		if (attachment.data && attachment.data.length > 0) {
			res.setHeader(
				"Content-Type",
				attachment.contentType || "application/octet-stream",
			);
			res.setHeader(
				"Content-Disposition",
				`inline; filename="${attachment.filename}"`,
			);
			return res.send(attachment.data);
		}

		return res
			.status(404)
			.json({ success: false, message: "Attachment file content empty" });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const inlineUpdateField = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const userInfo = await getAuthenticatedUserInfo(req);
		if (!canEditRfq(userInfo || req.user)) {
			return res.status(403).json({
				success: false,
				message:
					"Access Denied: Technical Person is only permitted to upload documents and cannot edit RFQ details.",
			});
		}

		const { field, value } = req.body;
		const allowed = ["status", "assignedTo", "type", "offerNo", "offerDate"];
		if (!allowed.includes(field)) {
			return res.status(400).json({
				success: false,
				message: `Field ${field} cannot be updated inline`,
			});
		}

		const existing: any = await Enquiry.findById(id);
		if (!existing) {
			return res
				.status(404)
				.json({ success: false, message: "Enquiry not found" });
		}

		if (field === "status" && value !== existing.status) {
			if (req.user && !canChangeStatus(req.user)) {
				return res.status(403).json({
					success: false,
					message: "Only authorized Status Managers can change enquiry status.",
				});
			}
		}

		const updateData: any = { [field]: value || "" };
		if (field === "assignedTo" && value !== existing.assignedTo) {
			updateData.assignedDate = value ? getTodayIso() : "";
		}
		if (field === "offerDate" && value) {
			updateData.offerDate = parseIsoDate(value);
		}

		const updated: any = await Enquiry.findByIdAndUpdate(id, updateData, {
			new: true,
		});
		const changerName = req.user?.email || "User";

		if (field === "status" && value !== existing.status) {
			await logActivity({
				userId: req.user?.userId,
				userEmail: changerName,
				action: "RFQ_STATUS_UPDATED",
				details: {
					enquiryId: id,
					rfqId: existing.rfqId,
					companyName: existing.companyName,
					oldStatus: existing.status,
					newStatus: value,
					updatedBy: changerName,
				},
			});
		} else if (field === "assignedTo" && value !== existing.assignedTo) {
			await logActivity({
				userId: req.user?.userId,
				userEmail: changerName,
				action: "RFQ_ASSIGNEE_CHANGED",
				details: {
					enquiryId: id,
					rfqId: existing.rfqId,
					oldAssignee: existing.assignedTo || "Unassigned",
					newAssignee: value || "Unassigned",
					updatedBy: changerName,
				},
			});
		}

		return res.json({
			success: true,
			data: { ...updated.toObject(), id: updated._id.toString() },
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const deleteEnquiry = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		if (req.user && !isAdmin(req.user)) {
			return res.status(403).json({
				success: false,
				message: "Admin privileges required to delete RFQ records.",
			});
		}

		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		await Enquiry.findByIdAndDelete(id);
		await Attachment.deleteMany({ enquiryId: id });

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "RFQ_DELETED",
			details: { enquiryId: id },
		});

		return res.json({ success: true, message: "Enquiry deleted successfully" });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const bulkDeleteEnquiries = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		if (req.user && !isAdmin(req.user)) {
			return res.status(403).json({
				success: false,
				message: "Admin privileges required to bulk delete RFQ records.",
			});
		}

		const { ids } = req.body;
		if (!Array.isArray(ids) || ids.length === 0) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid or empty ids array" });
		}

		const stringIds = ids.map((x: any) => String(x)).filter(Boolean);
		const result = await Enquiry.deleteMany({ _id: { $in: stringIds } });
		await Attachment.deleteMany({ enquiryId: { $in: stringIds } });

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "RFQ_BULK_DELETED",
			details: { deletedCount: result.deletedCount, ids: stringIds },
		});

		return res.json({
			success: true,
			count: result.deletedCount,
			message: `Deleted ${result.deletedCount} enquiry(s)`,
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const importExcel = async (req: AuthenticatedRequest, res: Response) => {
	try {
		if (req.user && !isAdmin(req.user)) {
			return res.status(403).json({
				success: false,
				message: "Admin privileges required to import Excel data.",
			});
		}

		if (!req.file) {
			return res
				.status(400)
				.json({ success: false, message: "No Excel file provided" });
		}

		const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
		const sheetName = workbook.SheetNames[0];
		const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

		let createdCount = 0;
		for (const row of rows) {
			const companyName = String(
				row["Company Name"] || row["Company"] || row["company_name"] || "",
			).trim();
			const itemDescription = String(
				row["Item Description"] || row["Item"] || row["item_description"] || "",
			).trim();
			if (!companyName && !itemDescription) continue;

			let rfqId = String(row["RFQ ID"] || row["rfq_id"] || "").trim();
			if (!rfqId) {
				rfqId = await generateNextRfqId();
			}

			await Enquiry.create({
				rfqId,
				companyName,
				itemDescription,
				dateReceived: String(
					row["Date Received"] || row["date_received"] || getTodayIso(),
				),
				receivedOn: parseIsoDate(
					String(row["Date Received"] || row["date_received"] || getTodayIso()),
				),
				contactPerson: String(
					row["Contact Person"] || row["contact_person"] || "",
				),
				mobile: String(row["Mobile"] || row["mobile"] || ""),
				email: String(row["Email"] || row["email"] || ""),
				assignedTo: String(row["Assigned To"] || row["assigned_to"] || ""),
				assignedDate: row["Assigned To"] ? getTodayIso() : "",
				status: String(row["Status"] || row["status"] || "Open"),
				offerNo: String(row["Offer No"] || row["offer_no"] || ""),
				offerDate: parseIsoDate(
					String(row["Offer Date"] || row["offer_date"] || ""),
				),
				remarks: String(row["Remarks"] || row["remarks"] || ""),
			});
			createdCount++;
		}

		return res.json({
			success: true,
			message: `Successfully imported ${createdCount} enquiries from Excel.`,
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const recordOfferApi = async (req: any, res: Response) => {
	try {
		const { enquiry_id, rfq_id, offer_no, offer_number, offer_date } = req.body;
		const finalOfferNo = (offer_no || offer_number || "").trim();

		if (!finalOfferNo) {
			return res.status(400).json({ ok: false, error: "offer_no is required" });
		}

		let enquiry: any = null;
		if (enquiry_id) {
			enquiry = await Enquiry.findById(String(enquiry_id));
		}
		if (!enquiry && rfq_id) {
			enquiry = await Enquiry.findOne({ rfqId: String(rfq_id).trim() });
		}

		if (!enquiry) {
			return res
				.status(404)
				.json({ ok: false, error: "No enquiry matched enquiry_id / rfq_id" });
		}

		const finalOfferDate = parseIsoDate(offer_date) || getTodayIso();
		const already = enquiry.offerNo === finalOfferNo;

		const updated: any = await Enquiry.findByIdAndUpdate(
			enquiry._id,
			{
				offerNo: finalOfferNo,
				offerDate: finalOfferDate,
				status:
					enquiry.status === "Open" || enquiry.status === "Under review"
						? "Offer Sent"
						: enquiry.status,
			},
			{ new: true },
		);

		return res.json({
			ok: true,
			updated: !already,
			enquiry_id: updated._id.toString(),
			rfq_id: updated.rfqId,
			offer_no: updated.offerNo,
			offer_date: updated.offerDate,
		});
	} catch (error: any) {
		return res.status(500).json({ ok: false, error: error.message });
	}
};

export const automationCallbackApi = async (req: any, res: Response) => {
	try {
		const body = req.body || {};
		const enquiry_id = body.enquiry_id || body.enquiryId || req.params?.id;
		const rfq_id = body.rfq_id || body.rfqId;
		const offer_no = (
			body.offer_no ||
			body.offerNo ||
			body.offer_number ||
			""
		).trim();
		const offer_date = body.offer_date || body.offerDate;
		const costingText = (body.costing || body.costingDetails || "").trim();
		const technicalText = (
			body.technical ||
			body.technicalCalculation ||
			body.remarks ||
			""
		).trim();
		const status = (body.status || "").trim();

		let enquiry: any = null;
		if (enquiry_id) {
			enquiry = await Enquiry.findById(String(enquiry_id));
		}
		if (!enquiry && rfq_id) {
			enquiry = await Enquiry.findOne({ rfqId: String(rfq_id).trim() });
		}

		if (!enquiry) {
			return res
				.status(404)
				.json({ ok: false, error: "No enquiry matched enquiry_id / rfq_id" });
		}

		const updateData: any = {};
		if (offer_no) {
			updateData.offerNo = offer_no;
			updateData.offerDate = parseIsoDate(offer_date) || getTodayIso();
		}
		if (costingText) {
			updateData.costing = costingText;
		}
		if (technicalText) {
			updateData.technical = technicalText;
		}
		if (status) {
			updateData.status = status;
		} else if (
			offer_no &&
			(enquiry.status === "Open" || enquiry.status === "Under review")
		) {
			updateData.status = "Offer Sent";
		} else if (costingText && enquiry.status === "Open") {
			updateData.status = "Under review";
		}

		const updated: any = await Enquiry.findByIdAndUpdate(
			enquiry._id,
			updateData,
			{ new: true },
		);

		const attachedFiles: any[] = [];
		if (Array.isArray(req.files) && req.files.length > 0) {
			for (const file of req.files) {
				const fn = file.originalname || `automation_file_${Date.now()}`;
				let kind = "general";
				if (fn.toLowerCase().includes("offer")) kind = "offer";
				else if (fn.toLowerCase().includes("costing")) kind = "costing";

				const relPath = `enquiries/${enquiry._id}/${fn}`;

				const att: any = await Attachment.create({
					enquiryId: enquiry._id,
					filename: fn,
					contentType: file.mimetype || "application/octet-stream",
					size: file.size || file.buffer.length,
					objectKey: relPath,
					uploadedBy: "AUTOMATION_ENGINE",
					kind,
					data: file.buffer,
				});

				mirrorAttachmentToDrive(
					enquiry._id.toString(),
					fn,
					file.mimetype || "application/octet-stream",
					file.buffer,
					kind,
				).catch(() => {});
				attachedFiles.push({
					id: att._id.toString(),
					filename: att.filename,
					kind,
				});
			}
		}

		return res.json({
			ok: true,
			success: true,
			enquiry_id: updated._id.toString(),
			rfq_id: updated.rfqId,
			offer_no: updated.offerNo,
			offer_date: updated.offerDate,
			status: updated.status,
			attachedFiles,
		});
	} catch (error: any) {
		return res.status(500).json({ ok: false, error: error.message });
	}
};

export const getAutomationUrlApi = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const enquiry: any = await Enquiry.findById(id);
		if (!enquiry) {
			return res
				.status(404)
				.json({ success: false, message: "Enquiry not found" });
		}

		const baseUrl = (
			process.env.AUTOMATION_URL ||
			process.env.NEXT_PUBLIC_AUTOMATION_URL ||
			"https://automation.encon.co.in"
		).trim();
		const params = new URLSearchParams({
			rfq_id: enquiry.rfqId || "",
			enquiry_id: enquiry._id.toString(),
			company: enquiry.companyName || "",
			contact: enquiry.contactPerson || "",
			email: enquiry.email || "",
			mobile: enquiry.mobile || "",
			item: enquiry.itemDescription || "",
			type: enquiry.type || "",
			salesResponsibility: enquiry.salesResponsibility || "",
			technical: enquiry.technical || "",
			assignedTo: enquiry.assignedTo || "",
		});

		const sep = baseUrl.includes("?") ? "&" : "?";
		const targetUrl = `${baseUrl}${sep}${params.toString()}`;

		return res.json({
			success: true,
			targetUrl,
			params: Object.fromEntries(params.entries()),
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const getDirectory = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const systemUsers: any[] = await User.find({ status: "ACTIVE" })
			.populate("roleId", "name")
			.select("name email roleId")
			.sort({ name: 1 })
			.lean();

		const userMap = new Map<string, { email: string; role: string }>();
		systemUsers.forEach((u) => {
			if (u.name) {
				userMap.set(u.name.toLowerCase(), {
					email: u.email,
					role: u.roleId?.name || "",
				});
			}
		});

		const legacyAssignees: any[] = await AssigneeEmail.find().lean();
		legacyAssignees.forEach((a) => {
			if (a.name && !userMap.has(a.name.toLowerCase())) {
				userMap.set(a.name.toLowerCase(), { email: a.email, role: "" });
			}
		});

		const [assignedToNames, salesNames, techNames] = await Promise.all([
			Enquiry.distinct("assignedTo"),
			Enquiry.distinct("salesResponsibility"),
			Enquiry.distinct("technical"),
		]);

		const nameSet = new Set<string>();
		systemUsers.forEach((u) => { if (u.name) nameSet.add(u.name); });
		legacyAssignees.forEach((a) => { if (a.name) nameSet.add(a.name); });

		[...assignedToNames, ...salesNames, ...techNames].forEach((val) => {
			if (val) {
				String(val).split("/").forEach((t: string) => {
					const trimmed = t.trim();
					if (trimmed) nameSet.add(trimmed);
				});
			}
		});

		const result = Array.from(nameSet)
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b))
			.map((name) => {
				const info = userMap.get(name.toLowerCase());
				return {
					name,
					email: info?.email || "",
					role: info?.role || "",
				};
			});

		return res.json({ success: true, data: result });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const saveDirectory = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		if (req.user && !isAdmin(req.user)) {
			return res.status(403).json({
				success: false,
				message: "Admin privileges required to update assignee directory.",
			});
		}

		const { items } = req.body;
		if (!Array.isArray(items)) {
			return res
				.status(400)
				.json({ success: false, message: "Expected items array" });
		}

		let renamedCount = 0;
		for (const item of items) {
			const orig = (item.origName || "").trim();
			const name = (item.name || "").trim();
			const email = (item.email || "").trim();

			if (!name) continue;

			if (orig && orig.toLowerCase() !== name.toLowerCase()) {
				const allEnquiries: any[] = await Enquiry.find().lean();
				for (const e of allEnquiries) {
					let modified = false;
					const fields: ("assignedTo" | "salesResponsibility" | "technical")[] =
						["assignedTo", "salesResponsibility", "technical"];
					const updateObj: any = {};

					fields.forEach((field) => {
						const val = e[field];
						if (val) {
							const tokens = val.split("/").map((t: string) => t.trim());
							if (
								tokens.some(
									(t: string) => t.toLowerCase() === orig.toLowerCase(),
								)
							) {
								updateObj[field] = tokens
									.map((t: string) =>
										t.toLowerCase() === orig.toLowerCase() ? name : t,
									)
									.join(" / ");
								modified = true;
							}
						}
					});

					if (modified) {
						await Enquiry.findByIdAndUpdate(e._id, updateObj);
					}
				}

				await AssigneeEmail.deleteMany({ name: orig });
				renamedCount++;
			}

			await AssigneeEmail.findOneAndUpdate(
				{ name },
				{ name, email },
				{ upsert: true, new: true },
			);
		}

		return res.json({
			success: true,
			message: `Directory updated successfully.${renamedCount ? ` Renamed ${renamedCount} assignee(s).` : ""}`,
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

// Track in-progress background ingests so we don't queue duplicates
let _ingestRunning = false;

export const syncInboxApi = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		console.log(
			`📥 [syncInboxApi] Sync request triggered by user: ${req.user?.email || "SYSTEM"}`,
		);
		if (!InboxService.isConfigured()) {
			console.warn(
				"⚠️ [syncInboxApi] Inbox is not configured. Missing IMAP_USER or IMAP_PASSWORD.",
			);
			return res.status(400).json({
				success: false,
				message:
					"Inbox is not configured. Please set IMAP_USER & IMAP_PASSWORD in environment variables.",
			});
		}

		if (_ingestRunning) {
			const stats = InboxService.getLastIngestStats();
			return res.status(202).json({
				success: true,
				message:
					"Inbox sync already in progress. Check /inbox-status for updates.",
				stats,
			});
		}

		// Respond immediately — don't hold the HTTP connection open during IMAP + Drive uploads
		const triggeredBy = req.user?.email || "SYSTEM";
		const userId = req.user?.userId;

		res.status(202).json({
			success: true,
			message:
				"Inbox sync started in background. Check /inbox-status for results.",
			stats: InboxService.getLastIngestStats(),
		});

		// Run ingest fully in background after response is sent
		_ingestRunning = true;
		setImmediate(async () => {
			try {
				const createdCount = await InboxService.ingest();
				const stats = InboxService.getLastIngestStats();
				console.log(
					`✅ [syncInboxApi] Background ingest finished. Created: ${createdCount}, Stats:`,
					stats,
				);

				await logActivity({
					userId,
					userEmail: triggeredBy,
					action: "INBOX_SYNC",
					details: stats,
				}).catch(() => {});
			} catch (bgErr: any) {
				console.error(
					"❌ [syncInboxApi Background Error]:",
					bgErr?.stack || bgErr?.message || bgErr,
				);
			} finally {
				_ingestRunning = false;
			}
		});
	} catch (error: any) {
		_ingestRunning = false;
		console.error(
			"❌ [syncInboxApi Error Stack]:",
			error?.stack || error?.message || error,
		);
		return res.status(500).json({
			success: false,
			message: error?.message || "Inbox sync failed",
			errorDetails: error?.stack || String(error),
		});
	}
};

export const getInboxStatusApi = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		return res.json({
			success: true,
			isConfigured: InboxService.isConfigured(),
			syncInProgress: _ingestRunning,
			stats: InboxService.getLastIngestStats(),
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const openDriveFolderApi = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const driveUrl = await ensureEnquiryDriveFolder(id);
		return res.json({
			success: true,
			driveFolderUrl: driveUrl,
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const syncDriveFolderApi = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const id = req.params.id;
		if (!id) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid enquiry ID" });
		}

		const attachments: any[] = await Attachment.find({ enquiryId: id }).lean();
		let synced = 0;
		for (const att of attachments) {
			if (att.data && att.data.length > 0) {
				await mirrorAttachmentToDrive(
					id,
					att.filename,
					att.contentType,
					att.data,
					att.kind,
				);
				synced++;
			}
		}

		const driveUrl = await ensureEnquiryDriveFolder(id);
		return res.json({
			success: true,
			message: `Synced ${synced} attachment(s) to Google Drive folder`,
			driveFolderUrl: driveUrl,
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};
