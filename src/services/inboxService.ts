import tls from "tls";
import { ProcessedMessage, RfqCounter } from "../models/AssigneeEmail";
import { Attachment } from "../models/Attachment";
import { Enquiry } from "../models/Enquiry";
import { mirrorAttachmentToDrive } from "./gdriveService";

// ---------------------------------------------------------------------------
// Drive Upload Queue — limits concurrent uploads to avoid OOM on the server
// ---------------------------------------------------------------------------
interface DriveUploadTask {
	enquiryId: string;
	filename: string;
	contentType: string;
	data: Buffer;
	kind: string;
}

const DRIVE_QUEUE_CONCURRENCY = 2; // max simultaneous Drive uploads
let _driveActiveUploads = 0;
const _driveQueue: DriveUploadTask[] = [];

function enqueueDriveUpload(task: DriveUploadTask): void {
	_driveQueue.push(task);
	_pumpDriveQueue();
}

function _pumpDriveQueue(): void {
	while (
		_driveActiveUploads < DRIVE_QUEUE_CONCURRENCY &&
		_driveQueue.length > 0
	) {
		const task = _driveQueue.shift()!;
		_driveActiveUploads++;
		mirrorAttachmentToDrive(
			task.enquiryId,
			task.filename,
			task.contentType,
			task.data,
			task.kind,
		)
			.catch((err) =>
				console.error("[DriveQueue] Upload error:", err?.message || err),
			)
			.finally(() => {
				_driveActiveUploads--;
				_pumpDriveQueue();
			});
	}
}

export interface IngestStats {
	mailbox: string;
	includeRead: boolean;
	matched: number;
	downloaded: number;
	skippedKnown: number;
	skippedNoise: number;
	created: number;
	threaded: number;
	lastRunAt?: string;
	error?: string;
}

export interface EmailAttachment {
	filename: string;
	contentType: string;
	data: Buffer;
}

export interface ParsedEmail {
	messageId: string;
	inReplyTo: string;
	references: string;
	fromName: string;
	fromEmail: string;
	subject: string;
	body: string;
	date: string;
	attachments: EmailAttachment[];
}

const INTERNAL_DOMAINS = ["encon.co.in", "encon.in"];
const GENERIC_NAMES = new Set([
	"purchase",
	"purchasing",
	"sales",
	"info",
	"enquiry",
	"enquiries",
	"inquiry",
	"rfq",
	"accounts",
	"procurement",
	"admin",
	"office",
	"mail",
]);
const DOMAIN_DROP = new Set([
	"co",
	"com",
	"net",
	"org",
	"gov",
	"edu",
	"ac",
	"in",
	"info",
]);
const LABEL_REMINDER_SUBJECT = "Reminder: label new RFQ emails";

function envFlag(name: string): boolean | null {
	const val = process.env[name];
	if (!val || !val.trim()) return null;
	return ["1", "true", "yes"].includes(val.trim().toLowerCase());
}

function curatedMailbox(): boolean {
	const mbox = (process.env.IMAP_MAILBOX || "INBOX").trim();
	return mbox.toUpperCase() !== "INBOX";
}

function includeRead(): boolean {
	const flag = envFlag("IMAP_INCLUDE_READ");
	if (flag !== null) return flag;
	return curatedMailbox();
}

function importAll(): boolean {
	const flag = envFlag("IMAP_IMPORT_ALL");
	if (flag !== null) return flag;
	return curatedMailbox();
}

function ignoreSubstrings(): string[] {
	const raw =
		process.env.IMAP_IGNORE_SENDERS ||
		"noreply,no-reply,mailer-daemon,postmaster,google.com,accounts.google.com";
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

function rfqKeywords(): string[] {
	const raw =
		process.env.IMAP_RFQ_KEYWORDS ||
		"rfq,request for quot,quotation,quote,enquiry,enquiries,inquiry,requirement,tender,proforma,offer,price,pricing,supply,budgetary,recuperator,burner,furnace,heat exchanger,oven,dryer,kiln,regenerat,combustion,thermal,heater,preheater,boiler";
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

function isInternalAddr(addr: string): boolean {
	const e = (addr || "").trim().toLowerCase();
	return INTERNAL_DOMAINS.some((d) => e.endsWith("@" + d));
}

function extractPhone(text: string): string {
	const regex = /\+?\d[\d\s\-().]{8,}\d/g;
	let match;
	while ((match = regex.exec(text || "")) !== null) {
		const candidate = match[0].trim();
		const digits = candidate.replace(/\D/g, "");
		if (digits.length >= 10 && digits.length <= 13) {
			return candidate.substring(0, 100);
		}
	}
	return "";
}

export function decodeQuotedPrintable(input: string): string {
	if (!input) return "";

	let text = input.replace(/=\s*[\r\n]+/g, "");

	const bytes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (
			text[i] === "=" &&
			i + 2 < text.length &&
			/[0-9A-Fa-f]{2}/.test(text.substring(i + 1, i + 3))
		) {
			const code = parseInt(text.substring(i + 1, i + 3), 16);
			if (code === 0x91 || code === 0x92) {
				bytes.push(0x27);
			} else if (code === 0x93 || code === 0x94) {
				bytes.push(0x22);
			} else if (code === 0x96 || code === 0x97) {
				bytes.push(0x2d);
			} else if (code === 0x85) {
				bytes.push(0x2e, 0x2e, 0x2e);
			} else if (code === 0xa0) {
				bytes.push(0x20);
			} else {
				bytes.push(code);
			}
			i += 2;
		} else {
			const charCode = text.charCodeAt(i);
			if (charCode < 128) {
				bytes.push(charCode);
			} else {
				const buf = Buffer.from(text[i], "utf8");
				for (const b of buf) {
					bytes.push(b);
				}
			}
		}
	}

	return Buffer.from(bytes)
		.toString("utf8")
		.replace(/\uFFFD/g, "'")
		.replace(/[\uFEFF\u200B\u200C\u200D\u200E\u200F\u0007]/g, "")
		.replace(/=\s+/g, "")
		.replace(/\s+=/g, "")
		.trim();
}

export interface ParsedAttachment {
	filename: string;
	contentType: string;
	data: Buffer;
}

interface MimeParsed {
	html: string;
	plain: string;
	attachments: ParsedAttachment[];
}

function getBoundaryHeader(text: string): string {
	if (!text) return "";
	const match = text.match(
		/boundary\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;\r\n]+))/i,
	);
	if (!match) return "";
	return (match[1] || match[2] || match[3] || "").trim();
}

function extractMimePart(rawPart: string, depth = 0): MimeParsed {
	const result: MimeParsed = { html: "", plain: "", attachments: [] };
	if (!rawPart || depth > 10) return result;

	const sep = rawPart.search(/\r?\n\r?\n/);
	const headerSection = sep !== -1 ? rawPart.substring(0, sep) : rawPart;
	const bodySection =
		sep !== -1 ? rawPart.substring(sep).trim() : rawPart.trim();

	const ctMatch = headerSection.match(/Content-Type:\s*([^\s;]+)/i);
	const ct = ctMatch ? ctMatch[1].toLowerCase() : "text/plain";

	if (ct.startsWith("multipart/")) {
		const boundary = getBoundaryHeader(headerSection);
		if (!boundary) return result;

		const parts = rawPart.split("--" + boundary);

		for (const part of parts) {
			const trimmed = part.trim();
			if (!trimmed || trimmed === "--" || trimmed.startsWith("--")) continue;

			const partSep = trimmed.search(/\r?\n\r?\n/);
			const partHeader =
				partSep !== -1 ? trimmed.substring(0, partSep) : trimmed;

			const partCtMatch = partHeader.match(/Content-Type:\s*([^\s;]+)/i);
			const partCt = partCtMatch ? partCtMatch[1].toLowerCase() : "";

			if (partCt.startsWith("multipart/")) {
				const hasChildBoundary = Boolean(getBoundaryHeader(partHeader));
				if (hasChildBoundary && depth < 10) {
					const nested = extractMimePart(trimmed, depth + 1);
					if (nested.html) {
						result.html = result.html
							? `${result.html}<br><hr style="border:0;border-top:1px dashed #cbd5e1;margin:12px 0;"><br>${nested.html}`
							: nested.html;
					}
					if (nested.plain) {
						result.plain = result.plain
							? `${result.plain}\n\n---\n\n${nested.plain}`
							: nested.plain;
					}
					result.attachments.push(...nested.attachments);
				}
				continue;
			}

			if (partSep === -1) continue;
			const leafHeader = partHeader.replace(/\r?\n[ \t]+/g, " ");
			const bodyRaw = trimmed.substring(partSep).trim();
			if (!bodyRaw) continue;

			const teMatch = leafHeader.match(/Content-Transfer-Encoding:\s*(\S+)/i);
			const transferEncoding = teMatch ? teMatch[1].toLowerCase() : "";

			const cdMatch = leafHeader.match(/Content-Disposition:[^\r\n]*/i);
			const filenameMatch =
				leafHeader.match(/(?:filename|name)\s*=\s*"?([^";\r\n]+)"?/i) ||
				trimmed.match(/(?:filename|name)\s*=\s*"?([^";\r\n]+)"?/i);
			const filename = filenameMatch ? filenameMatch[1].trim() : "";
			const isAttachment =
				/attachment/i.test(cdMatch?.[0] || "") || Boolean(filename);
			const isInline = /inline/i.test(cdMatch?.[0] || "") && Boolean(filename);

			const isBinary =
				Boolean(filename) ||
				isAttachment ||
				isInline ||
				/^(image|audio|video|application|font)\//i.test(partCt) ||
				(transferEncoding === "base64" &&
					partCt !== "text/plain" &&
					partCt !== "text/html");

			if (isBinary) {
				try {
					let buf: Buffer;
					if (transferEncoding === "base64") {
						const rawBase64 = bodyRaw.split(/\r?\n--/)[0] || bodyRaw;
						const cleanBase64 = rawBase64.replace(/[^A-Za-z0-9+/=]/g, "");
						buf = Buffer.from(cleanBase64, "base64");
					} else if (transferEncoding === "quoted-printable") {
						buf = Buffer.from(decodeQuotedPrintable(bodyRaw), "binary");
					} else {
						buf = Buffer.from(bodyRaw, "binary");
					}

					if (buf.length > 0) {
						let ext = "bin";
						if (
							partCt.includes("zip") ||
							(filename && filename.toLowerCase().endsWith(".zip"))
						)
							ext = "zip";
						else if (
							partCt.includes("rar") ||
							(filename && filename.toLowerCase().endsWith(".rar"))
						)
							ext = "rar";
						else if (
							partCt.includes("pdf") ||
							(filename && filename.toLowerCase().endsWith(".pdf"))
						)
							ext = "pdf";
						else if (partCt.split("/")[1]) ext = partCt.split("/")[1];

						const uniqueIdx = result.attachments.length + 1;
						const name =
							filename || `attachment_${Date.now()}_${uniqueIdx}.${ext}`;
						result.attachments.push({
							filename: name,
							contentType: partCt || "application/octet-stream",
							data: buf,
						});
					}
				} catch (e) {
					console.error("[InboxService] Attachment decoding error:", e);
				}
				continue;
			}

			let decoded = bodyRaw;
			if (transferEncoding === "quoted-printable") {
				decoded = decodeQuotedPrintable(bodyRaw);
			} else if (transferEncoding === "base64") {
				decoded = Buffer.from(bodyRaw, "base64").toString("utf8");
			}

			if (partCt === "text/html") {
				result.html = result.html ? `${result.html}<br>${decoded}` : decoded;
			} else if (partCt === "text/plain") {
				result.plain = result.plain ? `${result.plain}\n\n${decoded}` : decoded;
			}
		}

		return result;
	}

	const hasMimeHeaders = Boolean(
		ctMatch || headerSection.match(/Content-Transfer-Encoding:|MIME-Version:/i),
	);
	const targetText = hasMimeHeaders ? bodySection : rawPart;

	let decodedBody = targetText;
	const teMatch = headerSection.match(/Content-Transfer-Encoding:\s*(\S+)/i);
	const transferEncoding = teMatch ? teMatch[1].toLowerCase() : "";
	if (transferEncoding === "quoted-printable") {
		decodedBody = decodeQuotedPrintable(targetText);
	} else if (transferEncoding === "base64") {
		decodedBody = Buffer.from(targetText, "base64").toString("utf8");
	}

	if (ct === "text/html") result.html = decodedBody;
	else result.plain = decodedBody;
	return result;
}

export function cleanMimeRemnants(text: string): string {
	if (!text) return "";
	try {
		return text
			.replace(
				/This is a multipart message in MIME format\.?\s*(?:boundary=.*)?/gim,
				"",
			)
			.replace(/^--?=?[_a-zA-Z0-9.-]+.*$/gm, "")
			.replace(/_NextPart_[a-zA-Z0-9._-]+(?:--)?/g, "")
			.replace(
				/^\s*(?:Content-Type|Content-Transfer-Encoding|Content-Disposition|Content-ID|MIME-Version):\s*.*$/gim,
				"",
			)
			.replace(/^\s*(?:filename|name)\s*=\s*"?[^";\r\n]+"?.*$/gim, "")
			.replace(/\bcharset="?[a-z0-9_-]+"?/gim, "")
			.replace(/^[a-zA-Z0-9+/=]{40,}$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	} catch (err) {
		return (text || "").substring(0, 5000);
	}
}

export function extractMimeWithAttachments(rawMime: string): {
	body: string;
	attachments: ParsedAttachment[];
} {
	if (!rawMime) return { body: "", attachments: [] };

	try {
		let text = rawMime
			.replace(/^\*\s+\d+\s+FETCH\s+\(BODY\.PEEK\[\]\s+\{\d+\}\r?\n/i, "")
			.replace(/\)\s+A\d+\s+OK.*$/gi, "")
			.trim();

		const parsed = extractMimePart(text);
		let body = parsed.html || decodeQuotedPrintable(parsed.plain) || "";

		if (parsed.attachments.length === 0) {
			try {
				const fnRegex =
					/(?:filename|name)\s*=\s*"?([^";\r\n]+\.(?:zip|rar|7z|pdf|docx?|xlsx?|pptx?|msg|eml|png|jpe?g))"?/gi;
				let fnMatch;
				while ((fnMatch = fnRegex.exec(text)) !== null) {
					const fn = fnMatch[1].trim();
					if (!fn) continue;
					const exists = parsed.attachments.some(
						(a) => a.filename.toLowerCase() === fn.toLowerCase(),
					);
					if (exists) continue;

					const matchIdx = fnMatch.index;
					const endIdx = Math.min(text.length, matchIdx + 3000000);
					const afterHeader = text.substring(matchIdx, endIdx);
					const sepIdx = afterHeader.search(/\r?\n\r?\n/);
					if (sepIdx !== -1) {
						const payloadSection =
							afterHeader.substring(sepIdx + 2).split(/\r?\n--/)[0] || "";
						const cleanBase64 = payloadSection.replace(/[^A-Za-z0-9+/=]/g, "");
						if (cleanBase64.length > 40) {
							try {
								const buf = Buffer.from(cleanBase64, "base64");
								if (buf.length > 0) {
									let ct = "application/octet-stream";
									const fnLower = fn.toLowerCase();
									if (fnLower.endsWith(".zip")) ct = "application/zip";
									else if (fnLower.endsWith(".pdf")) ct = "application/pdf";
									parsed.attachments.push({
										filename: fn,
										contentType: ct,
										data: buf,
									});
								}
							} catch (e) {}
						}
					}
				}
			} catch (scannerErr) {
				console.error(
					"[InboxService] Fallback attachment scanner error:",
					scannerErr,
				);
			}
		}

		if (!body) {
			body = cleanMimeRemnants(text);
		} else {
			body = cleanMimeRemnants(body);
		}

		return { body: body.substring(0, 150000), attachments: parsed.attachments };
	} catch (error) {
		console.error("[InboxService] Error in extractMimeWithAttachments:", error);
		return {
			body: cleanMimeRemnants(rawMime).substring(0, 150000),
			attachments: [],
		};
	}
}

export function extractCleanEmailBody(rawMime: string): string {
	if (!rawMime) return "";
	const isRawMime =
		/^\*\s+\d+\s+FETCH|Content-Type:|MIME-Version:|Content-Transfer-Encoding:/i.test(
			rawMime,
		);
	if (!isRawMime) return cleanMimeRemnants(rawMime);
	return extractMimeWithAttachments(rawMime).body;
}

function decodeHeader(headerStr: string): string {
	if (!headerStr) return "";
	let result = headerStr.replace(
		/=\?([^?]+)\?([QB])\?([^?]+)\?=/gi,
		(_, charset, encoding, text) => {
			try {
				if (encoding.toUpperCase() === "B") {
					return Buffer.from(text, "base64").toString("utf8");
				} else if (encoding.toUpperCase() === "Q") {
					const qText = text.replace(/_/g, " ");
					return decodeQuotedPrintable(qText);
				}
			} catch (e) {
				return text;
			}
			return text;
		},
	);
	if (result.includes("=")) {
		result = decodeQuotedPrintable(result);
	}
	return result.trim();
}

function companyFromEmail(addr: string): string {
	if (!addr || !addr.includes("@")) return "";
	const parts = addr.split("@")[1].split(".");
	while (
		parts.length > 1 &&
		DOMAIN_DROP.has(parts[parts.length - 1].toLowerCase())
	) {
		parts.pop();
	}
	const name = parts.length ? parts[parts.length - 1] : "";
	return name.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function originalSender(body: string): [string, string] {
	let fallback: [string, string] = ["", ""];
	const regex = /^from:\s*(.+)$/gim;
	let match;
	while ((match = regex.exec(body || "")) !== null) {
		const line = match[1].trim();
		const emailMatch = line.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
		if (!emailMatch) continue;
		const addr = emailMatch[0];
		let name = line.split("<")[0].trim().replace(/^"|"$/g, "");
		if (name.includes("@") || !name) name = "";

		if (isInternalAddr(addr)) {
			if (!fallback[1]) fallback = [name, addr];
			continue;
		}
		return [name, addr];
	}
	return fallback;
}

export function resolveSender(
	subject: string,
	fromName: string,
	fromEmail: string,
	body: string,
): [string, string, string] {
	const isFwd =
		/^\s*(fwd|fw)\s*:/i.test(subject || "") ||
		(body || "").toLowerCase().includes("forwarded message");
	const isRelay = isInternalAddr(fromEmail);

	let finalSub = subject;
	let finalName = fromName;
	let finalEmail = fromEmail;

	if (isFwd || isRelay) {
		const [oName, oEmail] = originalSender(body);
		if (oEmail && !isInternalAddr(oEmail)) {
			finalEmail = oEmail;
			finalName = oName || fromName;
			finalSub = (subject || "").replace(/^\s*(fwd|fw)\s*:\s*/i, "").trim();
		}
	}
	return [finalSub, finalName, finalEmail];
}

export function extractTenderRef(text: string): string {
	if (!text) return "";
	const match = text.match(
		/(?:GEM\/\d{4}\/[A-Z]\/\d+|Tender\s*(?:No\.?|Ref\.?)?\s*[:\s]?\s*([A-Za-z0-9\/-]+)|RFQ[-_]?\d{4}[-_]?\d+)/i,
	);
	return match ? match[0].trim().toLowerCase() : "";
}

export function isRfq(subject: string, body: string): boolean {
	const keywords = rfqKeywords();
	if (keywords.length === 0) return true;
	const text = `${subject}\n${body}`.toLowerCase();
	return keywords.some((k) => text.includes(k));
}

export function isNoise(
	sender: string,
	subject: string,
	body: string,
	ignore: string[],
): boolean {
	const s = (sender || "").toLowerCase();
	if (ignore.some((sub) => s.includes(sub))) return true;
	if (importAll()) return false;
	return !isRfq(subject, body);
}

function parseMimeMessage(raw: string): ParsedEmail {
	try {
		const lines = raw.split(/\r?\n/);
		const headers: Record<string, string> = {};
		let currentHeader = "";
		let bodyStartIndex = lines.length;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === "") {
				bodyStartIndex = i + 1;
				break;
			}
			if (/^\s+/.test(line) && currentHeader) {
				headers[currentHeader] += " " + line.trim();
			} else {
				const colonIdx = line.indexOf(":");
				if (colonIdx > 0) {
					currentHeader = line.substring(0, colonIdx).toLowerCase();
					headers[currentHeader] = line.substring(colonIdx + 1).trim();
				}
			}
		}

		const rawBody = lines.slice(bodyStartIndex).join("\n");
		const fromRaw = headers["from"] || "";
		let fromName = "";
		let fromEmail = "";

		const angleMatch = fromRaw.match(/^(.*)<([^>]+)>/);
		if (angleMatch) {
			fromName = decodeHeader(angleMatch[1].trim().replace(/^"|"$/g, ""));
			fromEmail = angleMatch[2].trim();
		} else {
			fromEmail = fromRaw.trim();
		}

		let dateStr = "";
		if (headers["date"]) {
			try {
				const d = new Date(headers["date"]);
				if (!isNaN(d.getTime())) {
					dateStr = d.toISOString().split("T")[0];
				}
			} catch (e) {}
		}

		const subject = decodeHeader(headers["subject"] || "");
		const messageId = decodeHeader(headers["message-id"] || "").trim();
		const inReplyTo = decodeHeader(headers["in-reply-to"] || "").trim();
		const references = decodeHeader(headers["references"] || "").trim();

		const { body, attachments } = extractMimeWithAttachments(raw);

		return {
			messageId,
			inReplyTo,
			references,
			fromName,
			fromEmail,
			subject,
			body,
			date: dateStr,
			attachments,
		};
	} catch (err) {
		console.error("[InboxService] Error parsing MIME message:", err);
		return {
			messageId: "",
			inReplyTo: "",
			references: "",
			fromName: "",
			fromEmail: "",
			subject: "",
			body: cleanMimeRemnants(raw).substring(0, 150000),
			date: "",
			attachments: [],
		};
	}
}

class SimpleImapClient {
	private client: tls.TLSSocket | null = null;
	private buffer: string = "";
	private tagIndex: number = 1;

	constructor(
		private host: string,
		private port: number,
	) {}

	public isConnected(): boolean {
		return Boolean(this.client && !this.client.destroyed && this.client.writable);
	}

	public async connect(): Promise<void> {
		if (this.client) {
			try {
				if (!this.client.destroyed) this.client.destroy();
			} catch (e) {}
		}
		this.buffer = "";
		return new Promise((resolve, reject) => {
			let isResolved = false;
			const timeout = setTimeout(() => {
				if (!isResolved) {
					isResolved = true;
					if (this.client) this.client.destroy();
					reject(new Error("IMAP connection timeout (15s)"));
				}
			}, 15000);

			this.client = tls.connect(
				this.port,
				this.host,
				{ rejectUnauthorized: false },
				() => {
					if (!isResolved) {
						isResolved = true;
						clearTimeout(timeout);
						resolve();
					}
				},
			);

			this.client.on("data", (chunk) => {
				this.buffer += chunk.toString("utf8");
			});

			this.client.on("error", (err) => {
				if (!isResolved) {
					isResolved = true;
					clearTimeout(timeout);
					reject(err);
				}
			});
		});
	}

	public async ensureConnected(user: string, pass: string, mailbox: string): Promise<void> {
		if (!this.isConnected()) {
			console.log(`[InboxService] Re-establishing IMAP connection to mailbox "${mailbox}"...`);
			await this.connect();
			await this.sendCommand(`LOGIN "${user}" "${pass}"`);
			await this.sendCommand(`SELECT "${mailbox}"`);
		}
	}

	public async sendCommand(cmd: string, timeoutMs = 60000): Promise<string> {
		const tag = `A${this.tagIndex++}`;
		const fullCmd = `${tag} ${cmd}\r\n`;
		this.buffer = "";

		return new Promise((resolve, reject) => {
			if (!this.client || this.client.destroyed || !this.client.writable) {
				return reject(new Error("IMAP Client not connected"));
			}

			let isFinished = false;

			const timer = setTimeout(() => {
				if (!isFinished) {
					isFinished = true;
					clearInterval(checkInterval);
					if (this.client) {
						this.client.removeListener("error", onError);
						this.client.removeListener("close", onClose);
					}
					reject(new Error(`IMAP command timeout (${cmd.substring(0, 30)})`));
				}
			}, timeoutMs);

			const onError = (err: Error) => {
				if (!isFinished) {
					isFinished = true;
					clearTimeout(timer);
					clearInterval(checkInterval);
					if (this.client) this.client.removeListener("close", onClose);
					reject(err);
				}
			};

			const onClose = () => {
				if (!isFinished) {
					isFinished = true;
					clearTimeout(timer);
					clearInterval(checkInterval);
					if (this.client) this.client.removeListener("error", onError);
					reject(new Error("IMAP connection closed by server"));
				}
			};

			this.client.once("error", onError);
			this.client.once("close", onClose);

			this.client.write(fullCmd, (err) => {
				if (err && !isFinished) {
					isFinished = true;
					clearTimeout(timer);
					clearInterval(checkInterval);
					if (this.client) {
						this.client.removeListener("error", onError);
						this.client.removeListener("close", onClose);
					}
					reject(err);
				}
			});

			const checkInterval = setInterval(() => {
				if (isFinished) {
					clearInterval(checkInterval);
					return;
				}
				// Safety Memory Guard: Abort single message fetch if raw payload exceeds 50MB
				if (this.buffer.length > 50 * 1024 * 1024) {
					isFinished = true;
					clearTimeout(timer);
					clearInterval(checkInterval);
					if (this.client) {
						this.client.removeListener("error", onError);
						this.client.removeListener("close", onClose);
					}
					this.buffer = "";
					return reject(
						new Error("IMAP message payload exceeds max size limit (50MB)"),
					);
				}

				const trimmedEnd = this.buffer.trimEnd();
				const tailStr =
					trimmedEnd.length > 1000
						? trimmedEnd.substring(trimmedEnd.length - 1000)
						: trimmedEnd;

				// Strictly match tagged completion line (e.g., "\r\nA1 OK ...") at the END of the response
				const endStatusRegex = new RegExp(
					`(?:^|\\r?\\n)${tag}\\s+(OK|NO|BAD)\\b[^\\r\\n]*$`,
					"i",
				);

				if (endStatusRegex.test(tailStr) || endStatusRegex.test(trimmedEnd)) {
					isFinished = true;
					clearTimeout(timer);
					clearInterval(checkInterval);
					if (this.client) {
						this.client.removeListener("error", onError);
						this.client.removeListener("close", onClose);
					}

					const response = this.buffer;
					this.buffer = "";

					const tagOkEndRegex = new RegExp(
						`(?:^|\\r?\\n)${tag}\\s+OK\\b[^\\r\\n]*$`,
						"i",
					);
					if (tagOkEndRegex.test(tailStr) || tagOkEndRegex.test(trimmedEnd)) {
						resolve(response);
					} else {
						reject(new Error(`IMAP Error: ${response.substring(0, 300)}`));
					}
				}
			}, 100);
		});
	}

	public close() {
		if (this.client) {
			try {
				if (!this.client.destroyed) {
					this.sendCommand("LOGOUT", 2000).catch(() => {});
					this.client.end();
					this.client.destroy();
				}
			} catch (e) {}
		}
	}
}

export class InboxService {
	private static lastIngestStats: IngestStats = {
		mailbox: "INBOX",
		includeRead: false,
		matched: 0,
		downloaded: 0,
		skippedKnown: 0,
		skippedNoise: 0,
		created: 0,
		threaded: 0,
	};

	public static isConfigured(): boolean {
		const hasImap = Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD);
		const hasOAuth = Boolean(
			process.env.GMAIL_OAUTH_REFRESH_TOKEN &&
			process.env.GMAIL_OAUTH_CLIENT_ID &&
			process.env.GMAIL_OAUTH_CLIENT_SECRET,
		);
		return hasImap || hasOAuth;
	}

	public static getLastIngestStats(): IngestStats {
		return this.lastIngestStats;
	}

	public static async cleanDbEmailBodies(): Promise<number> {
		const enquiries: any[] = await Enquiry.find({ emailBody: { $ne: "" } })
			.select("_id emailBody")
			.lean();
		let cleanedCount = 0;
		for (const e of enquiries) {
			if (e.emailBody) {
				const cleaned = extractCleanEmailBody(e.emailBody);
				if (cleaned !== e.emailBody) {
					await Enquiry.findByIdAndUpdate(e._id, { emailBody: cleaned });
					cleanedCount++;
				}
			}
		}
		return cleanedCount;
	}

	public static async ingest(): Promise<number> {
		if (!this.isConfigured()) {
			return 0;
		}

		await this.cleanDbEmailBodies().catch(() => {});

		const host = (process.env.IMAP_HOST || "imap.gmail.com").trim();
		const port = parseInt(process.env.IMAP_PORT || "993", 10);
		const user = (process.env.IMAP_USER || "").trim();
		const password = process.env.IMAP_PASSWORD || "";
		const mailbox = (process.env.IMAP_MAILBOX || "INBOX").trim();

		console.log(
			`✉️ [InboxService] Starting email ingest... Host=${host}:${port}, User=${user || "NOT_SET"}, Mailbox=${mailbox}`,
		);

		const ignore = ignoreSubstrings();
		let created = 0;
		let threaded = 0;
		let skippedKnown = 0;
		let skippedNoise = 0;

		const processedDb: any[] = await ProcessedMessage.find()
			.select("messageId")
			.lean();
		const enquiriesDb: any[] = await Enquiry.find({ sourceMessageId: { $ne: "" } })
			.select("sourceMessageId")
			.lean();

		const knownIds = new Set<string>([
			...processedDb.map((p) => p.messageId),
			...enquiriesDb.map((e) => e.sourceMessageId),
		]);

		const fetchedEmails: ParsedEmail[] = [];

		const imap = new SimpleImapClient(host, port);
		try {
			console.log(
				`[InboxService] Connecting to IMAP server ${host}:${port}...`,
			);
			await imap.connect();
			console.log(`[InboxService] IMAP connected. Logging in user ${user}...`);
			await imap.sendCommand(`LOGIN "${user}" "${password}"`);
			console.log(
				`[InboxService] LOGIN successful. Selecting mailbox "${mailbox}"...`,
			);
			await imap.sendCommand(`SELECT "${mailbox}"`);

			// Always SEARCH ALL — we deduplicate against DB using Message-ID envelopes
			// before downloading any full bodies, so read/unread state doesn't matter.
			const searchCmd = "SEARCH ALL";
			console.log(`[InboxService] Running search command: ${searchCmd}...`);
			const searchRes = await imap.sendCommand(searchCmd);
			const allMsgNums: string[] = [];
			const searchMatches = [...searchRes.matchAll(/\*\s+SEARCH\s+([^\r\n]+)/gi)];
			for (const m of searchMatches) {
				if (m[1]) {
					const lineNums = m[1].trim().split(/\s+/).filter((n) => /^\d+$/.test(n));
					allMsgNums.push(...lineNums);
				}
			}

			const defaultLimit = curatedMailbox() ? 0 : 50;
			const fetchLimit =
				process.env.IMAP_FETCH_LIMIT !== undefined
					? parseInt(process.env.IMAP_FETCH_LIMIT, 10)
					: defaultLimit;

			// Work newest-first so recent emails are always processed first
			const candidateNums =
				fetchLimit > 0 && allMsgNums.length > fetchLimit
					? allMsgNums.slice(-fetchLimit)
					: allMsgNums;

			console.log(
				`[InboxService] Found ${allMsgNums.length} total message(s). Candidate batch: ${candidateNums.length} (Limit: ${fetchLimit === 0 ? "UNLIMITED" : fetchLimit})`,
			);

			// ── Phase 1: Fetch envelopes in bulk to get Message-IDs cheaply ──────────
			// Batch into groups of 50 to avoid a single giant IMAP command
			const ENVELOPE_BATCH = 50;
			const newMsgNums: string[] = [];

			for (let b = 0; b < candidateNums.length; b += ENVELOPE_BATCH) {
				const batch = candidateNums.slice(b, b + ENVELOPE_BATCH);
				const setSpec = batch.join(",");
				try {
					await imap.ensureConnected(user, password, mailbox);
					const envRes = await imap.sendCommand(
						`FETCH ${setSpec} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])`,
						15000,
					);
					// Build a list of (seqNum → messageId) from this batch response
					const seqMids: Array<{ seq: string; mid: string }> = [];
					const lines = envRes.split(/\r?\n/);
					let currentSeq = "";
					for (const line of lines) {
						const seqMatch = /^\*\s+(\d+)\s+FETCH/i.exec(line);
						if (seqMatch) {
							currentSeq = seqMatch[1];
							continue;
						}
						const midMatch = /^Message-ID:\s*(.+)$/i.exec(line.trim());
						if (midMatch && currentSeq) {
							seqMids.push({ seq: currentSeq, mid: midMatch[1].trim() });
							currentSeq = "";
						}
					}

					for (const { seq, mid } of seqMids) {
						if (!mid || knownIds.has(mid)) {
							if (mid && knownIds.has(mid)) skippedKnown++;
							// No Message-ID means we can't deduplicate — include it to be safe
						} else {
							newMsgNums.push(seq);
						}
					}

					// For messages where we got no Message-ID in envelope, include them
					for (const seq of batch) {
						const alreadyHandled = seqMids.some((s) => s.seq === seq);
						if (!alreadyHandled) newMsgNums.push(seq);
					}
				} catch (envErr: any) {
					// If envelope fetch fails for a batch, fall back to including all of them
					console.warn(
						`⚠️ [InboxService] Envelope fetch failed for batch, will download all: ${envErr?.message}`,
					);
					newMsgNums.push(...batch);
				}
			}

			const uniqueNewNums = [...new Set(newMsgNums)];
			console.log(
				`[InboxService] After envelope dedup: ${uniqueNewNums.length} new message(s) to download (skipped ${skippedKnown} already known).`,
			);

			const maxMb = parseInt(process.env.IMAP_MAX_FILE_SIZE_MB || "15", 10);
			const maxAllowedBytes = maxMb * 1024 * 1024;
			const threadsMap = new Map<string, any>();
			let downloaded = 0;

			for (let i = 0; i < uniqueNewNums.length; i++) {
				const num = uniqueNewNums[i];
				try {
					await imap.ensureConnected(user, password, mailbox);

					let sizeRes = "";
					try {
						sizeRes = await imap.sendCommand(`FETCH ${num} (RFC822.SIZE)`);
					} catch (szErr) {
						await imap.ensureConnected(user, password, mailbox);
						sizeRes = await imap.sendCommand(`FETCH ${num} (RFC822.SIZE)`).catch(() => "");
					}

					const sizeMatch = sizeRes.match(/RFC822\.SIZE\s+(\d+)/i);
					const messageSizeBytes = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;

					let parsed: ParsedEmail | null = null;

					if (messageSizeBytes > maxAllowedBytes) {
						const sizeMb = (messageSizeBytes / (1024 * 1024)).toFixed(1);
						console.warn(
							`⚠️ [InboxService] Message ${num} (${i + 1}/${uniqueNewNums.length}) size (${sizeMb} MB) exceeds ${maxMb} MB limit. Fetching header only (omitting large attachments)...`,
						);
						try {
							await imap.ensureConnected(user, password, mailbox);
							const rawFetch = await imap.sendCommand(
								`FETCH ${num} (BODY.PEEK[HEADER])`,
							);
							parsed = parseMimeMessage(rawFetch);
							if (parsed) {
								parsed.attachments = [];
								const note = `[RFQ Email Received from ${parsed.fromEmail || parsed.fromName || "Email Sender"}]\nSubject: ${parsed.subject || "(no subject)"}\n\n⚠️ [System Note: Attachments were not auto-downloaded because the total email size (${sizeMb} MB) exceeded the ${maxMb} MB limit. You can manually upload attachment files to this RFQ.]`;
								parsed.body = note;
							}
						} catch (lightErr: any) {
							console.error(
								`❌ [InboxService] Error fetching header content for message ${num}:`,
								lightErr?.message || lightErr,
							);
						}
					} else {
						console.log(
							`[InboxService] Downloading message ${num} (${i + 1}/${uniqueNewNums.length}) [${messageSizeBytes ? (messageSizeBytes / 1024).toFixed(0) + "KB" : "size unknown"}]...`,
						);

						let rawFetch = "";
						try {
							rawFetch = await imap.sendCommand(`FETCH ${num} (BODY.PEEK[])`, 90000);
						} catch (fetchErr) {
							await imap.ensureConnected(user, password, mailbox);
							rawFetch = await imap.sendCommand(`FETCH ${num} (BODY.PEEK[])`, 90000);
						}

						parsed = parseMimeMessage(rawFetch);
					}

					if (parsed) {
						downloaded++;
						const res = await this._processSingleEmail(parsed, knownIds, threadsMap, ignore);
						if (res.created) created++;
						if (res.threaded) threaded++;
						if (res.skippedNoise) skippedNoise++;

						parsed.attachments = [];
						parsed = null;
					}
				} catch (e: any) {
					console.error(
						`❌ [InboxService] Error fetching IMAP message ${num}:`,
						e?.message || e,
					);
				}
			}

			this.lastIngestStats = {
				mailbox,
				includeRead: includeRead(),
				matched: candidateNums.length,
				downloaded,
				skippedKnown,
				skippedNoise,
				created,
				threaded,
				lastRunAt: new Date().toISOString(),
			};

			console.log("[InboxService] Ingest completed:", this.lastIngestStats);
			return created;
		} catch (err: any) {
			console.error(
				"❌ [InboxService] IMAP Connection / Command Error:",
				err?.stack || err?.message || err,
			);
			this.lastIngestStats = {
				...this.lastIngestStats,
				mailbox,
				includeRead: includeRead(),
				error: err?.message || String(err),
				lastRunAt: new Date().toISOString(),
			};
			imap.close();
			return 0;
		} finally {
			imap.close();
		}
	}

	private static async _processSingleEmail(
		m: ParsedEmail,
		knownIds: Set<string>,
		threadsMap: Map<string, any>,
		ignore: string[],
	): Promise<{ created: boolean; threaded: boolean; skippedNoise: boolean }> {
		const mid = m.messageId;
		if (mid && knownIds.has(mid)) {
			return { created: false, threaded: false, skippedNoise: false };
		}

		if ((m.subject || "").startsWith(LABEL_REMINDER_SUBJECT)) {
			return { created: false, threaded: false, skippedNoise: true };
		}

		if (isNoise(m.fromEmail, m.subject, m.body, ignore)) {
			return { created: false, threaded: false, skippedNoise: true };
		}

		const [finalSub, finalName, finalEmail] = resolveSender(
			m.subject,
			m.fromName,
			m.fromEmail,
			m.body,
		);

		const cleanSub = (finalSub || m.subject || "")
			.replace(/^\s*(re|fwd|fw|\[fwd\])\s*:\s*/gi, "")
			.replace(/^\s*(re|fwd|fw|\[fwd\])\s*:\s*/gi, "")
			.trim()
			.toLowerCase();

		let root = mid;
		if (m.references) {
			const refs = m.references.match(/<[^>]+>/g);
			if (refs && refs[0]) root = refs[0];
		} else if (m.inReplyTo) {
			const inR = m.inReplyTo.match(/<[^>]+>/g);
			if (inR && inR[0]) root = inR[0];
		}

		let existingTarget: any = null;
		if (root && threadsMap.has(root)) {
			existingTarget = threadsMap.get(root);
		}
		if (!existingTarget && cleanSub && threadsMap.has(cleanSub)) {
			existingTarget = threadsMap.get(cleanSub);
		}

		if (!existingTarget && root) {
			existingTarget = await Enquiry.findOne({
				$or: [
					{ threadId: root },
					{ sourceMessageId: root },
					...(m.inReplyTo ? [{ sourceMessageId: m.inReplyTo.trim() }] : []),
				],
			});
		}

		const tenderRef = extractTenderRef(`${m.subject}\n${m.body}`);
		if (!existingTarget) {
			const recentEnquiries: any[] = await Enquiry.find()
				.sort({ _id: -1 })
				.limit(250)
				.lean();

			existingTarget = recentEnquiries.find((e) => {
				if (tenderRef && tenderRef.length >= 5) {
					const eTenderRef = extractTenderRef(
						`${e.itemDescription}\n${e.remarks || ""}\n${e.emailBody || ""}`,
					);
					if (eTenderRef && eTenderRef === tenderRef) {
						return true;
					}
				}

				const existingCleanSub = (e.itemDescription || "")
					.replace(/^\s*(re|fwd|fw|\[fwd\])\s*:\s*/gi, "")
					.replace(/^\s*(re|fwd|fw|\[fwd\])\s*:\s*/gi, "")
					.trim()
					.toLowerCase();

				if (!existingCleanSub) return false;

				const subMatches =
					existingCleanSub === cleanSub ||
					(cleanSub.length >= 8 && existingCleanSub.includes(cleanSub)) ||
					(existingCleanSub.length >= 8 &&
						cleanSub.includes(existingCleanSub));

				if (!subMatches) return false;

				const emailMatches =
					!finalEmail ||
					!e.email ||
					e.email.toLowerCase() === finalEmail.toLowerCase() ||
					e.email.toLowerCase() === m.fromEmail.toLowerCase() ||
					existingCleanSub === cleanSub;

				return emailMatches;
			});
		}

		if (existingTarget) {
			let newBody = existingTarget.emailBody || "";
			if (!newBody) {
				newBody = m.body;
			} else if (
				m.body &&
				!newBody.includes(m.body.substring(0, Math.min(m.body.length, 80)))
			) {
				newBody = `${newBody}\n\n--- Thread Update (${m.date || "Received"}) from ${m.fromName || m.fromEmail} ---\n\n${m.body}`;
			}

			await Enquiry.findByIdAndUpdate(existingTarget._id, {
				emailBody: newBody,
				dateReceived: m.date || existingTarget.dateReceived,
			});

			for (const att of m.attachments) {
				try {
					const existingAtt = await Attachment.findOne({
						enquiryId: existingTarget._id,
						filename: att.filename,
						size: att.data.length,
					});
					if (existingAtt) continue;

					const relObjectKey = `enquiries/${existingTarget._id}/${att.filename}`;

					await Attachment.create({
						enquiryId: existingTarget._id,
						filename: att.filename,
						contentType: att.contentType,
						size: att.data.length,
						objectKey: relObjectKey,
						kind: "email",
						uploadedBy: m.fromEmail || "Email",
						data: att.data,
					});

					mirrorAttachmentToDrive(
						existingTarget._id.toString(),
						att.filename,
						att.contentType,
						att.data,
						"email",
					).catch(() => {});
				} catch (e) {}
			}

			if (mid) {
				await ProcessedMessage.findOneAndUpdate(
					{ messageId: mid },
					{ messageId: mid },
					{ upsert: true },
				).catch(() => {});
				knownIds.add(mid);
			}
			threadsMap.set(root || mid, existingTarget);
			if (cleanSub) threadsMap.set(cleanSub, existingTarget);
			return { created: false, threaded: true, skippedNoise: false };
		}

		if (isInternalAddr(finalEmail) && isInternalAddr(m.fromEmail)) {
			if (mid) {
				await ProcessedMessage.findOneAndUpdate(
					{ messageId: mid },
					{ messageId: mid },
					{ upsert: true },
				).catch(() => {});
				knownIds.add(mid);
			}
			return { created: false, threaded: false, skippedNoise: true };
		}

		let company = companyFromEmail(finalEmail);
		if (
			!company &&
			finalName &&
			!GENERIC_NAMES.has(finalName.toLowerCase())
		) {
			company = finalName;
		}
		company = company || finalName || "Email enquiry";

		const dateReceived = m.date || new Date().toISOString().split("T")[0];

		const year = new Date().getFullYear().toString();
		const counter: any = await RfqCounter.findOneAndUpdate(
			{ year },
			{ $inc: { lastSeq: 1 } },
			{ upsert: true, new: true },
		);
		const seqStr = String(counter.lastSeq).padStart(3, "0");
		const rfqId = `ENC/RFQ/${year}/${seqStr}`;

		const newEnquiry: any = await Enquiry.create({
			rfqId,
			dateReceived,
			receivedOn: dateReceived,
			companyName: company,
			contactPerson: finalName,
			mobile: extractPhone(m.body),
			email: finalEmail,
			itemDescription: finalSub || "(no subject)",
			status: "Open",
			sourceMessageId: mid,
			threadId: root || mid,
			emailBody: m.body,
			followupRemarks: "Received by email to the RFQ inbox.",
		});

		for (const att of m.attachments) {
			try {
				const existingAtt = await Attachment.findOne({
					enquiryId: newEnquiry._id,
					filename: att.filename,
					size: att.data.length,
				});
				if (existingAtt) continue;

				const relObjectKey = `enquiries/${newEnquiry._id}/${att.filename}`;

				await Attachment.create({
					enquiryId: newEnquiry._id,
					filename: att.filename,
					contentType: att.contentType,
					size: att.data.length,
					objectKey: relObjectKey,
					kind: "email",
					uploadedBy: "Email",
					data: att.data,
				});

				mirrorAttachmentToDrive(
					newEnquiry._id.toString(),
					att.filename,
					att.contentType,
					att.data,
					"email",
				).catch(() => {});
			} catch (e) {}
		}

		if (mid) {
			await ProcessedMessage.findOneAndUpdate(
				{ messageId: mid },
				{ messageId: mid },
				{ upsert: true },
			).catch(() => {});
			knownIds.add(mid);
		}

		threadsMap.set(root || mid, newEnquiry);
		if (cleanSub) threadsMap.set(cleanSub, newEnquiry);
		return { created: true, threaded: false, skippedNoise: false };
	}
}
