import { Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { Attendance } from "../models/Attendance";
import { Office } from "../models/Office";
import { User } from "../models/User";
import {
	dayKeyInTz,
	dayKeyToUtcDate,
	diffMinutes,
	haversineMeters,
	minutesOfDayInTz,
	parseHHMMtoMinutes,
} from "../utils/attendanceUtils";
import { logActivity } from "../utils/auditLogger";

const clientIp = (req: any): string => {
	const fwd = req.headers["x-forwarded-for"];
	if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
	return req.ip || req.socket?.remoteAddress || "";
};

const punchSchema = z.object({
	officeId: z.string().optional(),
	lat: z.number().optional(),
	lng: z.number().optional(),
	accuracy: z.number().optional(),
	address: z.string().optional(),
	source: z.enum(["WEB", "MOBILE"]).optional(),
});

/** Resolve the office a punch belongs to: explicit body id, else the user's assigned office. */
async function resolveOffice(userId: string, bodyOfficeId?: string) {
	if (bodyOfficeId) {
		const o = await Office.findById(bodyOfficeId);
		if (o) return o;
	}
	const user: any = await User.findById(userId).select("officeId");
	if (user?.officeId) {
		const o = await Office.findById(user.officeId);
		if (o) return o;
	}
	return null;
}

function geofenceOk(office: any, lat?: number, lng?: number): boolean {
	if (!office?.location?.coordinates || office.location.coordinates.length !== 2) {
		return true; // office has no coordinates -> cannot validate, allow.
	}
	if (typeof lat !== "number" || typeof lng !== "number") {
		return false; // office expects a location but the punch has none.
	}
	const [oLng, oLat] = office.location.coordinates;
	const dist = haversineMeters(oLat, oLng, lat, lng);
	return dist <= (office.geofenceRadiusMeters ?? 200);
}

const shape = (a: any) => ({
	id: a._id.toString(),
	userId: a.userId?._id?.toString() || a.userId?.toString(),
	userName: a.userId?.name || "",
	userEmail: a.userId?.email || "",
	officeId: a.officeId?._id?.toString() || a.officeId?.toString() || null,
	officeName: a.officeId?.name || "",
	date: a.date,
	status: a.status,
	clockIn: a.clockIn,
	clockOut: a.clockOut,
	totalWorkMinutes: a.totalWorkMinutes,
	source: a.source,
	remark: a.remark,
});

// ---------------- Self-service (employee) ----------------

export const clockIn = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const userId = req.user!.userId;
		const body = punchSchema.parse(req.body);
		const now = new Date();
		const office = await resolveOffice(userId, body.officeId);
		const tz = office?.timezone || "Asia/Kolkata";
		const date = dayKeyToUtcDate(dayKeyInTz(now, tz));

		const existing = await Attendance.findOne({ userId, date });
		if (existing && existing.clockIn?.time) {
			return res.status(400).json({
				success: false,
				message: "You have already clocked in today",
				data: shape(existing),
			});
		}

		// Geofence gate: if the office has coordinates, the employee MUST be inside
		// its radius to clock in. Offices without coordinates cannot be validated,
		// so clock-in stays allowed there.
		if (office?.location?.coordinates?.length === 2) {
			if (typeof body.lat !== "number" || typeof body.lng !== "number") {
				return res.status(400).json({
					success: false,
					message: "Location is required to clock in at this office. Please allow GPS and try again.",
				});
			}
			const [oLng, oLat] = office.location.coordinates;
			const dist = haversineMeters(oLat, oLng, body.lat, body.lng);
			const radius = office.geofenceRadiusMeters ?? 200;
			if (dist > radius) {
				await logActivity({
					userId,
					userEmail: req.user!.email,
					action: "ATTENDANCE_CLOCK_IN_REJECTED_GEOFENCE",
					details: { officeId: office._id.toString(), distanceMeters: Math.round(dist), radius },
				});
				return res.status(403).json({
					success: false,
					message: `You are ${Math.round(dist)} m from ${office.name} - outside the allowed ${radius} m area. Move to the office to clock in.`,
				});
			}
		}

		const ok = geofenceOk(office, body.lat, body.lng);
		const lateCutoff =
			parseHHMMtoMinutes(office?.workStart || "09:30") + (office?.lateGraceMinutes ?? 15);
		const minutesNow = minutesOfDayInTz(now, tz);
		const status = minutesNow > lateCutoff ? "LATE" : "PRESENT";

		const record = await Attendance.findOneAndUpdate(
			{ userId, date },
			{
				$set: {
					officeId: office?._id || null,
					status,
					source: body.source || "WEB",
					"clockIn.time": now,
					"clockIn.lat": body.lat,
					"clockIn.lng": body.lng,
					"clockIn.accuracy": body.accuracy,
					"clockIn.address": body.address || "",
					"clockIn.geofenceOk": ok,
					"clockIn.ip": clientIp(req),
					"clockIn.userAgent": req.headers["user-agent"] || "",
				},
				$setOnInsert: { userId, date },
			},
			{ new: true, upsert: true, setDefaultsOnInsert: true },
		);

		await logActivity({
			userId,
			userEmail: req.user!.email,
			action: "ATTENDANCE_CLOCK_IN",
			details: { officeId: office?._id?.toString(), status, geofenceOk: ok },
		});

		return res.status(201).json({ success: true, data: shape(record) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const clockOut = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const userId = req.user!.userId;
		const body = punchSchema.parse(req.body);
		const now = new Date();

		// Find the open record for this user (clocked in, not yet out) - most recent.
		const open: any = await Attendance.findOne({
			userId,
			"clockIn.time": { $ne: null },
			"clockOut.time": null,
		}).sort({ date: -1 });

		if (!open) {
			return res.status(400).json({
				success: false,
				message: "No open clock-in found. Please clock in first.",
			});
		}

		const office = await resolveOffice(userId, body.officeId);
		const ok = geofenceOk(office, body.lat, body.lng);
		const totalWorkMinutes = open.clockIn?.time
			? diffMinutes(new Date(open.clockIn.time), now)
			: 0;

		let status = open.status;
		const hours = totalWorkMinutes / 60;
		if (office && hours < (office.halfDayThresholdHours ?? 4)) {
			status = "HALF_DAY";
		}

		open.officeId = office?._id || open.officeId;
		open.status = status;
		open.totalWorkMinutes = totalWorkMinutes;
		open.clockOut = {
			time: now,
			lat: body.lat,
			lng: body.lng,
			accuracy: body.accuracy,
			address: body.address || "",
			geofenceOk: ok,
			ip: clientIp(req),
			userAgent: req.headers["user-agent"] || "",
		};
		await open.save();

		await logActivity({
			userId,
			userEmail: req.user!.email,
			action: "ATTENDANCE_CLOCK_OUT",
			details: { attendanceId: open._id.toString(), totalWorkMinutes, status },
		});

		return res.json({ success: true, data: shape(open) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const myToday = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const userId = req.user!.userId;
		const user: any = await User.findById(userId).select("officeId name");
		const office = user?.officeId ? await Office.findById(user.officeId) : null;
		const tz = office?.timezone || "Asia/Kolkata";
		const date = dayKeyToUtcDate(dayKeyInTz(new Date(), tz));
		const record: any = await Attendance.findOne({ userId, date }).populate("officeId");
		return res.json({
			success: true,
			data: {
				today: dayKeyInTz(new Date(), tz),
				timezone: tz,
				office: office
					? {
							id: office._id.toString(),
							name: office.name,
							city: office.city || "",
							// Coordinates + radius let the app preview the geofence live
							// before the employee taps Clock In.
							lat: office.location?.coordinates?.[1] ?? null,
							lng: office.location?.coordinates?.[0] ?? null,
							radius: office.geofenceRadiusMeters ?? 200,
							workStart: office.workStart,
							workEnd: office.workEnd,
					  }
					: null,
				record: record ? shape(record) : null,
			},
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const myHistory = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const userId = req.user!.userId;
		const limit = Math.min(parseInt(String(req.query.limit || "30"), 10) || 30, 365);
		const records: any[] = await Attendance.find({ userId })
			.sort({ date: -1 })
			.limit(limit)
			.populate("officeId");
		return res.json({ success: true, data: records.map(shape) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

// ---------------- Management (register / regularize) ----------------

export const getRegister = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { from, to, officeId, userId } = req.query;
		const where: any = {};
		if (officeId) where.officeId = String(officeId);
		if (userId) where.userId = String(userId);
		if (from || to) {
			where.date = {};
			if (from) where.date.$gte = dayKeyToUtcDate(String(from));
			if (to) where.date.$lte = dayKeyToUtcDate(String(to));
		}
		const records: any[] = await Attendance.find(where)
			.populate("userId", "name email employeeCode")
			.populate("officeId", "name city")
			.sort({ date: -1 })
			.limit(2000);
		return res.json({ success: true, data: records.map(shape) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

const updateSchema = z.object({
	officeId: z.string().nullable().optional(),
	status: z.enum(["PRESENT", "LATE", "HALF_DAY", "ABSENT", "LEAVE"]).optional(),
	clockInTime: z.string().nullable().optional(),
	clockOutTime: z.string().nullable().optional(),
	remark: z.string().optional(),
});

export const updateAttendance = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const body = updateSchema.parse(req.body);
		const rec: any = await Attendance.findById(req.params.id);
		if (!rec) return res.status(404).json({ success: false, message: "Attendance record not found" });

		if (body.officeId !== undefined) rec.officeId = body.officeId || null;
		if (body.status !== undefined) rec.status = body.status;
		if (body.remark !== undefined) rec.remark = body.remark;
		if (body.clockInTime !== undefined) {
			rec.clockIn = rec.clockIn || {};
			rec.clockIn.time = body.clockInTime ? new Date(body.clockInTime) : null;
		}
		if (body.clockOutTime !== undefined) {
			rec.clockOut = rec.clockOut || {};
			rec.clockOut.time = body.clockOutTime ? new Date(body.clockOutTime) : null;
		}
		if (rec.clockIn?.time && rec.clockOut?.time) {
			rec.totalWorkMinutes = diffMinutes(new Date(rec.clockIn.time), new Date(rec.clockOut.time));
		}

		await rec.save();
		await rec.populate("userId", "name email employeeCode").then((r: any) => r.populate("officeId", "name city"));

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "ATTENDANCE_UPDATED",
			details: { attendanceId: rec._id.toString(), updates: body },
		});

		return res.json({ success: true, data: shape(rec) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const deleteAttendance = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const deleted = await Attendance.findByIdAndDelete(req.params.id);
		if (!deleted) return res.status(404).json({ success: false, message: "Attendance record not found" });
		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "ATTENDANCE_DELETED",
			details: { attendanceId: req.params.id },
		});
		return res.json({ success: true, message: "Attendance record deleted" });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};
