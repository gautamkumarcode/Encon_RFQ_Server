import { Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { Holiday } from "../models/Holiday";
import { Office } from "../models/Office";
import { dayKeyToUtcDate } from "../utils/attendanceUtils";
import { logActivity } from "../utils/auditLogger";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const holidaySchema = z.object({
	name: z.string().min(1, "Name is required").max(120),
	date: z.string().regex(DATE_RE, "Date must be YYYY-MM-DD"),
	officeId: z.string().nullable().optional(), // null / absent = all branches
});

const shape = (h: any) => ({
	id: h._id.toString(),
	name: h.name,
	date: h.date,
	officeId: h.officeId?._id?.toString() || h.officeId || null,
	officeName: h.officeId?.name || "",
	allOffices: !h.officeId,
});

/** List holidays (any signed-in user - both calendars and the employee app read this). */
export const listHolidays = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { from, to, officeId } = req.query;
		const where: any = {};
		if (from || to) {
			where.date = {};
			if (from && DATE_RE.test(String(from))) where.date.$gte = dayKeyToUtcDate(String(from));
			if (to && DATE_RE.test(String(to))) where.date.$lte = dayKeyToUtcDate(String(to));
		}
		if (officeId) where.$or = [{ officeId: null }, { officeId: String(officeId) }];
		const holidays: any[] = await Holiday.find(where).populate("officeId", "name city").sort({ date: 1 });
		return res.json({ success: true, data: holidays.map(shape) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const createHoliday = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const body = holidaySchema.parse(req.body);
		const date = dayKeyToUtcDate(body.date);
		if (body.officeId) {
			const office = await Office.findById(body.officeId);
			if (!office) return res.status(400).json({ success: false, message: "Office not found" });
		}
		const dup = await Holiday.findOne({ date, name: body.name });
		if (dup) {
			return res.status(400).json({ success: false, message: "This holiday already exists on that date" });
		}
		const created: any = await Holiday.create({
			name: body.name,
			date,
			officeId: body.officeId || null,
		});
		await created.populate("officeId", "name city");
		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "HOLIDAY_CREATED",
			details: { holidayId: created._id.toString(), name: created.name, date: body.date },
		});
		return res.status(201).json({ success: true, data: shape(created) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const updateHoliday = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const body = holidaySchema.partial().parse(req.body);
		const rec: any = await Holiday.findById(req.params.id);
		if (!rec) return res.status(404).json({ success: false, message: "Holiday not found" });
		if (body.name !== undefined) rec.name = body.name;
		if (body.date !== undefined) rec.date = dayKeyToUtcDate(body.date);
		if (body.officeId !== undefined) rec.officeId = body.officeId || null;
		await rec.save();
		await rec.populate("officeId", "name city");
		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "HOLIDAY_UPDATED",
			details: { holidayId: rec._id.toString(), updates: body },
		});
		return res.json({ success: true, data: shape(rec) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const deleteHoliday = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const deleted: any = await Holiday.findByIdAndDelete(req.params.id);
		if (!deleted) return res.status(404).json({ success: false, message: "Holiday not found" });
		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "HOLIDAY_DELETED",
			details: { holidayId: req.params.id, name: deleted.name },
		});
		return res.json({ success: true, message: "Holiday deleted" });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};
