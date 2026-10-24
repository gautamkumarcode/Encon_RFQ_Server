import { Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { Office } from "../models/Office";
import { User } from "../models/User";
import { Attendance } from "../models/Attendance";
import { logActivity } from "../utils/auditLogger";

const officeSchema = z.object({
	name: z.string().min(1, "Office name is required"),
	code: z.string().optional(),
	address: z.string().optional(),
	city: z.string().optional(),
	lat: z.number().nullable().optional(),
	lng: z.number().nullable().optional(),
	geofenceRadiusMeters: z.number().min(0).optional(),
	timezone: z.string().optional(),
	workStart: z.string().optional(),
	workEnd: z.string().optional(),
	lateGraceMinutes: z.number().min(0).optional(),
	halfDayThresholdHours: z.number().min(0).optional(),
	status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const sanitize = (o: any) => ({
	id: o._id.toString(),
	name: o.name,
	code: o.code || "",
	address: o.address || "",
	city: o.city || "",
	lat: o.location?.coordinates?.[1] ?? null,
	lng: o.location?.coordinates?.[0] ?? null,
	geofenceRadiusMeters: o.geofenceRadiusMeters,
	timezone: o.timezone,
	workStart: o.workStart,
	workEnd: o.workEnd,
	lateGraceMinutes: o.lateGraceMinutes,
	halfDayThresholdHours: o.halfDayThresholdHours,
	status: o.status,
	createdAt: o.createdAt,
	updatedAt: o.updatedAt,
});

export const getOffices = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const where: any = {};
		if (req.query.status) where.status = String(req.query.status);
		const offices: any[] = await Office.find(where).sort({ name: 1 });
		return res.json({ success: true, data: offices.map(sanitize) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const getOffice = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const office: any = await Office.findById(req.params.id);
		if (!office)
			return res.status(404).json({ success: false, message: "Office not found" });
		return res.json({ success: true, data: sanitize(office) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

function buildLocation(lat?: number | null, lng?: number | null) {
	if (typeof lat === "number" && typeof lng === "number") {
		return { type: "Point" as const, coordinates: [lng, lat] };
	}
	return null;
}

export const createOffice = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const body = officeSchema.parse(req.body);
		const created: any = await Office.create({
			name: body.name,
			code: body.code || "",
			address: body.address || "",
			city: body.city || "",
			location: buildLocation(body.lat, body.lng),
			geofenceRadiusMeters: body.geofenceRadiusMeters ?? 200,
			timezone: body.timezone || "Asia/Kolkata",
			workStart: body.workStart || "09:30",
			workEnd: body.workEnd || "18:30",
			lateGraceMinutes: body.lateGraceMinutes ?? 15,
			halfDayThresholdHours: body.halfDayThresholdHours ?? 4,
			status: body.status || "ACTIVE",
		});

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "OFFICE_CREATED",
			details: { officeId: created._id.toString(), name: created.name },
		});

		return res.status(201).json({ success: true, data: sanitize(created) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const updateOffice = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const body = officeSchema.partial().parse(req.body);
		const update: any = {};
		for (const key of [
			"name",
			"code",
			"address",
			"city",
			"geofenceRadiusMeters",
			"timezone",
			"workStart",
			"workEnd",
			"lateGraceMinutes",
			"halfDayThresholdHours",
			"status",
		] as const) {
			if (body[key] !== undefined) update[key] = body[key];
		}
		if (body.lat !== undefined || body.lng !== undefined) {
			const current: any = await Office.findById(req.params.id).lean();
			const lat = body.lat ?? current?.location?.coordinates?.[1];
			const lng = body.lng ?? current?.location?.coordinates?.[0];
			update.location = buildLocation(lat, lng);
		}

		const updated: any = await Office.findByIdAndUpdate(
			req.params.id,
			update,
			{ new: true },
		);
		if (!updated)
			return res.status(404).json({ success: false, message: "Office not found" });

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "OFFICE_UPDATED",
			details: { officeId: req.params.id, updates: update },
		});

		return res.json({ success: true, data: sanitize(updated) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const deleteOffice = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const officeId = req.params.id;
		const employeeCount = await User.countDocuments({ officeId });
		const attendanceCount = await Attendance.countDocuments({ officeId });
		if (employeeCount > 0 || attendanceCount > 0) {
			return res.status(400).json({
				success: false,
				message: `Office is referenced by ${employeeCount} employee(s) and ${attendanceCount} attendance record(s). Reassign them first, or set the office to INACTIVE.`,
			});
		}
		await Office.findByIdAndDelete(officeId);
		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "OFFICE_DELETED",
			details: { officeId },
		});
		return res.json({ success: true, message: "Office deleted" });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};
