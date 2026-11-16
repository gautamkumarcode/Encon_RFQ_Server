import { Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { Attendance } from "../models/Attendance";
import { Holiday } from "../models/Holiday";
import { LeaveRequest } from "../models/LeaveRequest";
import { Notification } from "../models/Notification";
import { Office } from "../models/Office";
import { Permission, RolePermission } from "../models/Permission";
import { Role } from "../models/Role";
import { User } from "../models/User";
import { dayKeyInTz, dayKeyToUtcDate } from "../utils/attendanceUtils";
import { logActivity } from "../utils/auditLogger";

// ---------------------------------------------------------------------------
// Leave application & approval.
//
// An employee raises a Casual Leave request for a date range (with optional
// half days); an approver - anyone holding the HR_LEAVE capability - decides
// it. Approving writes LEAVE into the per-day Attendance register for the
// covered working days, so the leave shows up in the attendance view and the
// end-of-day auto-absent job stops flagging those days. Balances are derived
// from approved requests against an annual entitlement. Dates follow the
// Attendance UTC-midnight day-key convention; a "working day" is Mon-Sat minus
// branch/company holidays, matching the attendance rules exactly.
// ---------------------------------------------------------------------------

/** Annual Casual Leave entitlement, overridable via env without a code change. */
function annualQuota(): number {
	const n = parseInt(String(process.env.CL_ANNUAL_QUOTA || "12"), 10);
	return Number.isFinite(n) && n >= 0 ? n : 12;
}

const leaveDateKey = (d: Date | string) => dayKeyInTz(new Date(d), "UTC");

/** Normalise an incoming "YYYY-MM-DD" (or Date) to a UTC-midnight day. */
const toDay = (v: string): Date => dayKeyToUtcDate(v);

const applySchema = z.object({
	from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	partialDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
	reason: z.string().max(1000).optional().default(""),
});

const decideSchema = z.object({
	decision: z.enum(["APPROVE", "REJECT"]),
	remark: z.string().max(1000).optional().default(""),
});

function shapeLeave(r: any) {
	return {
		id: r._id.toString(),
		userId: r.userId?._id?.toString() || r.userId?.toString?.() || "",
		userName: r.userId?.name || "",
		userEmail: r.userId?.email || "",
		officeId: r.officeId?._id?.toString() || r.officeId?.toString?.() || null,
		officeName: r.officeId?.name || "",
		leaveType: r.leaveType,
		fromDate: r.fromDate,
		toDate: r.toDate,
		partialDates: (r.partialDates || []).map(leaveDateKey),
		days: r.days,
		reason: r.reason || "",
		status: r.status,
		decidedByName: r.decidedById?.name || "",
		decidedAt: r.decidedAt,
		decisionRemark: r.decisionRemark || "",
		createdAt: r.createdAt,
	};
}

/** Set of branch + company holiday day-keys for the given office (null = company only). */
async function holidayKeySet(officeId: string | null): Promise<Set<string>> {
	const where = officeId ? { $or: [{ officeId: null }, { officeId }] } : { officeId: null };
	const holidays: any[] = await Holiday.find(where).select("date");
	return new Set(holidays.map((h) => leaveDateKey(h.date)));
}

/**
 * Working-day keys (Mon-Sat, minus holidays) from `fromKey` to `toKey`
 * inclusive. Sunday is the weekly off, same as the attendance auto-absent job.
 */
function workingDayKeys(fromKey: string, toKey: string, holidays: Set<string>): string[] {
	const out: string[] = [];
	const cur = dayKeyToUtcDate(fromKey);
	const end = dayKeyToUtcDate(toKey);
	while (cur <= end) {
		const key = leaveDateKey(cur);
		const dow = cur.getUTCDay();
		if (dow >= 1 && dow <= 6 && !holidays.has(key)) out.push(key);
		cur.setUTCDate(cur.getUTCDate() + 1);
	}
	return out;
}

/** Net leave days for a range: full working days + 0.5 per half-day key. */
function countDays(workKeys: string[], partials: Set<string>): number {
	return workKeys.reduce((sum, k) => sum + (partials.has(k) ? 0.5 : 1), 0);
}

/** Active users holding the HR_LEAVE capability (approver right) plus ADMIN. */
async function getApproverUserIds(): Promise<string[]> {
	const perms = await Permission.find({ module: "HR_LEAVE" }).select("_id");
	const rps = await RolePermission.find({ permissionId: { $in: perms.map((p: any) => p._id) } }).select("roleId");
	const roleIds = new Set(rps.map((rp: any) => String(rp.roleId)));
	const adminRole: any = await Role.findOne({ name: "ADMIN" });
	if (adminRole) roleIds.add(String(adminRole._id));
	const users: any[] = await User.find({ status: "ACTIVE", roleId: { $in: [...roleIds] } }).select("_id");
	return [...new Set(users.map((u) => String(u._id)))];
}

async function resolveUserOffice(userId: string) {
	const user: any = await User.findById(userId).select("officeId");
	if (user?.officeId) {
		const o = await Office.findById(user.officeId);
		if (o) return o;
	}
	return null;
}

/**
 * Write/remove LEAVE on the attendance days covered by a request. Approving
 * marks each covered working day LEAVE (never touching a punched day); reversing
 * deletes only the punch-less LEAVE rows we added, so the day falls back to
 * whatever the auto-absent job later decides.
 */
async function applyLeaveToAttendance(
	userId: string,
	officeId: string | null,
	workKeys: string[],
	partials: Set<string>,
	leaveId: string,
	enable: boolean,
) {
	for (const key of workKeys) {
		const date = dayKeyToUtcDate(key);
		const existing: any = await Attendance.findOne({ userId, date });
		if (enable) {
			if (existing && existing.clockIn?.time) continue; // a real punch wins
			const status = "LEAVE";
			const remark = `Casual leave (${leaveId})`;
			if (existing) {
				existing.status = status;
				existing.absent = false;
				existing.remark = remark;
				if (officeId && !existing.officeId) existing.officeId = officeId;
				await existing.save();
			} else {
				await Attendance.create({ userId, date, officeId, status, absent: false, remark });
			}
		} else {
			// Only undo our own punch-less LEAVE marker.
			if (existing && !existing.clockIn?.time && existing.status === "LEAVE") {
				await Attendance.deleteOne({ _id: existing._id });
			}
		}
	}
	void partials; // half days still land as LEAVE in the register today
}

// ---------------- Self-service (employee) ----------------

export const applyLeave = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const userId = req.user!.userId;
		const body = applySchema.parse(req.body);
		if (body.from > body.to)
			return res.status(400).json({ success: false, message: "'From' must be on or before 'To'" });

		const office = await resolveUserOffice(userId);
		const holidays = await holidayKeySet(office?._id?.toString() || null);
		const workKeys = workingDayKeys(body.from, body.to, holidays);
		if (!workKeys.length)
			return res.status(400).json({ success: false, message: "Selected range has no working days (weekends/holidays only)" });

		const partials = new Set(body.partialDates.filter((d) => workKeys.includes(d)));
		const days = countDays(workKeys, partials);
		if (days <= 0)
			return res.status(400).json({ success: false, message: "Leave must cover at least half a working day" });

		const created: any = await LeaveRequest.create({
			userId,
			officeId: office?._id || null,
			leaveType: "CASUAL",
			fromDate: toDay(body.from),
			toDate: toDay(body.to),
			partialDates: [...partials].map(toDay),
			days,
			reason: body.reason,
			status: "PENDING",
		});

		const applicant: any = await User.findById(userId).select("name email");
		const approverIds = await getApproverUserIds();
		await Promise.all(
			approverIds
				.filter((id) => id !== String(userId))
				.map((id) =>
					Notification.create({
						title: "New leave request",
						message: `${applicant?.name || "An employee"} requested ${days} day(s) Casual Leave (${body.from} to ${body.to}).`,
						type: "LEAVE",
						targetUserId: id,
					}),
				),
		);

		await logActivity({
			userId,
			userEmail: req.user!.email,
			action: "LEAVE_APPLIED",
			details: { leaveId: created._id.toString(), from: body.from, to: body.to, days },
		});

		await created.populate("userId", "name email");
		await created.populate("officeId", "name");
		return res.status(201).json({ success: true, data: shapeLeave(created) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const myLeaves = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const userId = req.user!.userId;
		const rows: any[] = await LeaveRequest.find({ userId })
			.populate("officeId", "name")
			.populate("decidedById", "name")
			.sort({ createdAt: -1 })
			.limit(200);
		return res.json({ success: true, data: rows.map(shapeLeave) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const leaveBalances = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const userId = req.user!.userId;
		const year = new Date().getUTCFullYear();
		const start = new Date(Date.UTC(year, 0, 1));
		const end = new Date(Date.UTC(year + 1, 0, 1));

		const rows: any[] = await LeaveRequest.find({
			userId,
			fromDate: { $gte: start, $lt: end },
			status: { $in: ["PENDING", "APPROVED"] },
		}).select("status days");

		const quota = annualQuota();
		const used = rows.filter((r) => r.status === "APPROVED").reduce((a, r) => a + (r.days || 0), 0);
		const pending = rows.filter((r) => r.status === "PENDING").reduce((a, r) => a + (r.days || 0), 0);
		const remaining = Math.max(0, quota - used);

		return res.json({
			success: true,
			data: { year, quota, used, pending, remaining, half: quota / 2, leaveType: "CASUAL" },
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const cancelLeave = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const userId = req.user!.userId;
		const rec: any = await LeaveRequest.findOne({ _id: req.params.id, userId });
		if (!rec) return res.status(404).json({ success: false, message: "Leave request not found" });
		if (rec.status !== "PENDING")
			return res.status(400).json({ success: false, message: "Only pending requests can be cancelled" });

		rec.status = "CANCELLED";
		await rec.save();

		await logActivity({
			userId,
			userEmail: req.user!.email,
			action: "LEAVE_CANCELLED",
			details: { leaveId: rec._id.toString() },
		});
		return res.json({ success: true, data: shapeLeave(rec) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

// ---------------- Approvals / register ----------------

export const listLeaves = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { status, officeId, userId, from, to } = req.query;
		const where: any = {};
		if (status) where.status = String(status);
		if (officeId) where.officeId = String(officeId);
		if (userId) where.userId = String(userId);
		if (from || to) {
			where.fromDate = {};
			if (from) where.fromDate.$gte = dayKeyToUtcDate(String(from));
			if (to) where.fromDate.$lte = dayKeyToUtcDate(String(to));
		}
		const rows: any[] = await LeaveRequest.find(where)
			.populate("userId", "name email employeeCode")
			.populate("officeId", "name")
			.populate("decidedById", "name")
			.sort({ status: 1, createdAt: -1 })
			.limit(2000);
		return res.json({ success: true, data: rows.map(shapeLeave) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const decideLeave = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const body = decideSchema.parse(req.body);
		const rec: any = await LeaveRequest.findById(req.params.id);
		if (!rec) return res.status(404).json({ success: false, message: "Leave request not found" });
		if (rec.status !== "PENDING")
			return res.status(400).json({ success: false, message: `Request already ${rec.status.toLowerCase()}` });

		const holidays = await holidayKeySet(rec.officeId?.toString?.() || null);
		const workKeys = workingDayKeys(leaveDateKey(rec.fromDate), leaveDateKey(rec.toDate), holidays);
		const partials = new Set<string>(((rec.partialDates || []) as any[]).map(leaveDateKey));

		rec.status = body.decision === "APPROVE" ? "APPROVED" : "REJECTED";
		rec.decidedById = req.user!.userId;
		rec.decidedAt = new Date();
		rec.decisionRemark = body.remark;
		await rec.save();

		// Approving writes LEAVE into the register; a rejection leaves days untouched
		// (auto-absent still owns them). Reversal here also clears any stale marker.
		await applyLeaveToAttendance(
			String(rec.userId),
			rec.officeId?.toString?.() || null,
			body.decision === "APPROVE" ? workKeys : [],
			partials,
			rec._id.toString(),
			body.decision === "APPROVE",
		);

		const decider = await User.findById(req.user!.userId).select("name");
		await Notification.create({
			title: `Leave ${rec.status.toLowerCase()}`,
			message: `Your leave ${leaveDateKey(rec.fromDate)} to ${leaveDateKey(rec.toDate)} (${rec.days} day(s)) was ${rec.status.toLowerCase()} by ${decider?.name || "an approver"}${body.remark ? `: ${body.remark}` : "."}`,
			type: "LEAVE",
			targetUserId: rec.userId,
		});

		await logActivity({
			userId: req.user!.userId,
			userEmail: req.user!.email,
			action: rec.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
			details: { leaveId: rec._id.toString(), applicant: String(rec.userId), days: rec.days, remark: body.remark },
		});

		await rec.populate("userId", "name email");
		await rec.populate("officeId", "name");
		await rec.populate("decidedById", "name");
		return res.json({ success: true, data: shapeLeave(rec) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};
