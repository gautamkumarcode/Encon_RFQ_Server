import { Response } from "express";
import * as XLSX from "xlsx";
import { z } from "zod";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { Attendance } from "../models/Attendance";
import { Holiday } from "../models/Holiday";
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

/** Active offices that actually have coordinates - candidates for cross-branch detection. */
async function geofencedOffices(): Promise<any[]> {
	const offices = await Office.find({ status: "ACTIVE" });
	return offices.filter((o: any) => o.location?.coordinates?.length === 2);
}

/** Nearest active branch whose geofence CONTAINS the point, or null (multi-branch auto-detect). */
async function detectOfficeByGps(lat: number, lng: number) {
	let best: { office: any; dist: number } | null = null;
	for (const o of await geofencedOffices()) {
		const [oLng, oLat] = o.location.coordinates;
		const dist = haversineMeters(oLat, oLng, lat, lng);
		if (dist <= (o.geofenceRadiusMeters ?? 200) && (!best || dist < best.dist)) {
			best = { office: o, dist };
		}
	}
	return best;
}

/** Nearest active branch regardless of radius - used for friendly rejection messages. */
async function nearestGeofencedOffice(lat: number, lng: number) {
	let best: { office: any; dist: number } | null = null;
	for (const o of await geofencedOffices()) {
		const [oLng, oLat] = o.location.coordinates;
		const dist = haversineMeters(oLat, oLng, lat, lng);
		if (!best || dist < best.dist) best = { office: o, dist };
	}
	return best;
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
		const hasGps = typeof body.lat === "number" && typeof body.lng === "number";

		// Multi-branch auto-detect: whichever branch geofence the GPS lands in owns the
		// day, so an employee deputed elsewhere for a few days needs no toggle. An
		// explicit officeId from the caller still wins over detection, and detection
		// wins over the assigned home branch.
		const detected = hasGps ? await detectOfficeByGps(body.lat!, body.lng!) : null;
		const office = await resolveOffice(userId, body.officeId || detected?.office._id?.toString());
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

		// Geofence gate: if the resolved office has coordinates, the employee must be inside
		// its radius to clock in. Offices without coordinates cannot be validated, so
		// clock-in stays allowed there. A detected match already proves the punch is inside
		// the resolved branch's radius, unless the caller explicitly picked a different one.
		const insideResolved = !!detected && String(detected.office._id) === String(office?._id);
		if (office?.location?.coordinates?.length === 2 && !insideResolved) {
			if (!hasGps) {
				return res.status(400).json({
					success: false,
					message: "Location is required to clock in at this office. Please allow GPS and try again.",
				});
			}
			const [oLng, oLat] = office.location.coordinates;
			const dist = haversineMeters(oLat, oLng, body.lat!, body.lng!);
			const radius = office.geofenceRadiusMeters ?? 200;
			if (dist > radius) {
				const near = await nearestGeofencedOffice(body.lat!, body.lng!);
				await logActivity({
					userId,
					userEmail: req.user!.email,
					action: "ATTENDANCE_CLOCK_IN_REJECTED_GEOFENCE",
					details: { officeId: office._id.toString(), distanceMeters: Math.round(dist), radius },
				});
				return res.status(403).json({
					success: false,
					message: near
						? `You are ${Math.round(near.dist)} m from ${near.office.name} - the nearest branch. No branch area matched; move to an office to clock in.`
						: `You are ${Math.round(dist)} m from ${office.name} - outside the allowed ${radius} m area. Move to the office to clock in.`,
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
			details: {
				officeId: office?._id?.toString(),
				status,
				geofenceOk: ok,
				// Audit trail: which branch GPS matched vs the employee's home branch.
				autoDetected: !body.officeId && !!detected,
			},
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
		const hasGps = typeof body.lat === "number" && typeof body.lng === "number";

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

		// The day stays tagged to the office that was clocked in at. If the out punch
		// lands inside a DIFFERENT branch's geofence (employee moved there mid-day),
		// that branch is tagged on the clock-out punch itself for audit.
		const dayOffice: any = open.officeId ? await Office.findById(open.officeId) : null;
		const detected = hasGps ? await detectOfficeByGps(body.lat!, body.lng!) : null;
		const outOffice: any =
			(body.officeId ? await Office.findById(body.officeId) : null) ||
			detected?.office ||
			dayOffice ||
			(await resolveOffice(userId));
		const ok = !!detected || geofenceOk(dayOffice, body.lat, body.lng);
		const totalWorkMinutes = open.clockIn?.time
			? diffMinutes(new Date(open.clockIn.time), now)
			: 0;

		let status = open.status;
		const hours = totalWorkMinutes / 60;
		if (dayOffice && hours < (dayOffice.halfDayThresholdHours ?? 4)) {
			status = "HALF_DAY";
		}

		if (body.officeId && outOffice) open.officeId = outOffice._id; // explicit retag only
		open.status = status;
		open.totalWorkMinutes = totalWorkMinutes;
		open.clockOut = {
			time: now,
			officeId: outOffice?._id || null,
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
			details: {
				attendanceId: open._id.toString(),
				totalWorkMinutes,
				status,
				clockOutOfficeId: outOffice?._id?.toString() || null,
			},
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
		// All active branches (with coordinates where set) so the app can preview
		// "inside which office" live, not just the home branch.
		const allOffices: any[] = await Office.find({ status: "ACTIVE" }).sort("name");
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
				offices: allOffices.map((o) => ({
					id: o._id.toString(),
					name: o.name,
					city: o.city || "",
					lat: o.location?.coordinates?.[1] ?? null,
					lng: o.location?.coordinates?.[0] ?? null,
					radius: o.geofenceRadiusMeters ?? 200,
				})),
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

// ---------------------------------------------------------------------------
// Excel export of the monthly attendance report.
//
// Three sheets: per-employee Monthly Summary, day-by-day Daily Log, and the
// Holidays that fell in the range. Honors the same from/to/officeId/userId
// filters as the register, so the file matches what is on screen. Times use
// each office's timezone; dates are DD.MM.YYYY like the order register.
// ---------------------------------------------------------------------------

const dateCell = (d: any, tz: string) => dayKeyInTz(new Date(d), tz).split("-").reverse().join(".");
const timeCell = (t: any, tz: string) => {
	if (!t) return "";
	const m = minutesOfDayInTz(new Date(t), tz);
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** GET /api/attendance/export - download the filtered monthly report as .xlsx. */
export const exportAttendanceReport = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { from, to, officeId, userId } = req.query;
		const now = new Date();
		// Default range: current month.
		const defFrom = from ? String(from) : `${now.toISOString().slice(0, 7)}-01`;
		const defTo = to ? String(to) : now.toISOString().slice(0, 10);

		const where: any = { date: { $gte: dayKeyToUtcDate(defFrom), $lte: dayKeyToUtcDate(defTo) } };
		if (officeId) where.officeId = String(officeId);
		if (userId) where.userId = String(userId);

		const [records, offices, holidays] = await Promise.all([
			Attendance.find(where)
				.populate("userId", "name email employeeCode")
				.populate("officeId", "name timezone")
				.sort({ date: 1, "clockIn.time": 1 })
				.lean(),
			Office.find({}).lean(),
			Holiday.find({ date: { $gte: dayKeyToUtcDate(defFrom), $lte: dayKeyToUtcDate(defTo) } })
				.populate("officeId", "name")
				.sort({ date: 1 })
				.lean(),
		]);
		const officeName = new Map((offices as any[]).map((o) => [String(o._id), o.name as string]));

		// --- Sheet 2: daily log, one row per punch day. ---
		const logRows = (records as any[]).map((a) => {
			const tz = a.officeId?.timezone || "Asia/Kolkata";
			return {
				Date: dateCell(a.date, tz),
				Employee: a.userId?.name || "",
				"Emp Code": a.userId?.employeeCode || "",
				Email: a.userId?.email || "",
				"Day Office": a.officeId?.name || "",
				Status: a.status,
				In: timeCell(a.clockIn?.time, tz),
				Out: timeCell(a.clockOut?.time, tz),
				"Hours": a.totalWorkMinutes != null ? Math.round((a.totalWorkMinutes / 60) * 100) / 100 : "",
				"In Branch": officeName.get(String(a.clockIn?.officeId)) || "",
				"Out Branch": officeName.get(String(a.clockOut?.officeId)) || "",
				"In GPS OK": a.clockIn?.time ? (a.clockIn?.geofenceOk ? "Yes" : "No") : "",
				Source: a.source || "",
				Remark: a.remark || "",
			};
		});

		// --- Sheet 1: per-employee summary. ---
		const byUser = new Map<string, any>();
		for (const a of records as any[]) {
			const id = String(a.userId?._id || a.userId);
			let s = byUser.get(id);
			if (!s) {
				s = {
					Employee: a.userId?.name || "", Email: a.userId?.email || "", "Emp Code": a.userId?.employeeCode || "",
					Days: 0, Present: 0, Late: 0, "Half Day": 0, Leave: 0, Absent: 0,
					minutes: 0, inMins: [] as number[], branches: new Set<string>(),
				};
				byUser.set(id, s);
			}
			const tz = a.officeId?.timezone || "Asia/Kolkata";
			s.Days++;
			if (a.status === "PRESENT") s.Present++;
			else if (a.status === "LATE") s.Late++;
			else if (a.status === "HALF_DAY") s["Half Day"]++;
			else if (a.status === "LEAVE") s.Leave++;
			else if (a.status === "ABSENT") s.Absent++;
			s.minutes += a.totalWorkMinutes || 0;
			if (a.clockIn?.time) s.inMins.push(minutesOfDayInTz(new Date(a.clockIn.time), tz));
			if (a.officeId?.name) s.branches.add(a.officeId.name);
		}
		const summaryRows = [...byUser.values()]
			.sort((x, y) => y.Days - x.Days || String(x.Employee).localeCompare(String(y.Employee)))
			.map((s) => ({
				Employee: s.Employee,
				"Emp Code": s["Emp Code"],
				Email: s.Email,
				Days: s.Days,
				Present: s.Present,
				Late: s.Late,
				"Half Day": s["Half Day"],
				Leave: s.Leave,
				Absent: s.Absent,
				"Total Hours": Math.round((s.minutes / 60) * 100) / 100,
				"Avg Clock-In": s.inMins.length
					? (() => {
						const avg = Math.round(s.inMins.reduce((a: number, b: number) => a + b, 0) / s.inMins.length);
						return `${String(Math.floor(avg / 60)).padStart(2, "0")}:${String(avg % 60).padStart(2, "0")}`;
					})()
					: "",
				"Branches Visited": [...s.branches].join(", "),
			}));

		const holidayRows = (holidays as any[]).map((h) => ({
			Date: dateCell(h.date, "Asia/Kolkata"),
			Holiday: h.name,
			"Applies To": h.officeId?.name || "All branches",
		}));

		const wb = XLSX.utils.book_new();
		const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
		wsSummary["!cols"] = [{ wch: 24 }, { wch: 10 }, { wch: 28 }, { wch: 7 }, { wch: 8 }, { wch: 6 }, { wch: 9 }, { wch: 7 }, { wch: 7 }, { wch: 11 }, { wch: 12 }, { wch: 26 }];
		const wsLog = XLSX.utils.json_to_sheet(logRows);
		wsLog["!cols"] = [{ wch: 11 }, { wch: 22 }, { wch: 10 }, { wch: 26 }, { wch: 14 }, { wch: 10 }, { wch: 6 }, { wch: 6 }, { wch: 7 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 24 }];
		const wsHolidays = XLSX.utils.json_to_sheet(holidayRows.length ? holidayRows : [{ Date: "", Holiday: "No holidays in range", "Applies To": "" }]);
		wsHolidays["!cols"] = [{ wch: 11 }, { wch: 28 }, { wch: 16 }];
		XLSX.utils.book_append_sheet(wb, wsSummary, "Monthly Summary");
		XLSX.utils.book_append_sheet(wb, wsLog, "Daily Log");
		XLSX.utils.book_append_sheet(wb, wsHolidays, "Holidays");
		const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

		const fname = `encon_attendance_${defFrom}_to_${defTo}.xlsx`;
		res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
		return res.send(buf);
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};
