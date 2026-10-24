import bcrypt from "bcryptjs";
import { Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { User } from "../models/User";
import { Office } from "../models/Office";
import { sendWelcomeUserEmail } from "../services/emailService";
import { logActivity } from "../utils/auditLogger";

const employeeFields = {
	employeeCode: z.string().optional(),
	officeId: z.string().nullable().optional(),
	designation: z.string().optional(),
	department: z.string().optional(),
	mobile: z.string().optional(),
	employmentType: z.string().optional(),
	joiningDate: z.string().nullable().optional(),
};

const createSchema = z.object({
	name: z.string().min(2, "Name must be at least 2 characters"),
	email: z.string().email(),
	password: z.string().min(6, "Password must be at least 6 characters"),
	roleId: z.string(),
	...employeeFields,
});

const updateSchema = z.object({
	name: z.string().min(2).optional(),
	email: z.string().email().optional(),
	roleId: z.string().optional(),
	status: z.enum(["ACTIVE", "DISABLED"]).optional(),
	...employeeFields,
});

function formatEmployee(u: any) {
	return {
		id: u._id.toString(),
		name: u.name,
		email: u.email,
		mobile: u.mobile || "",
		department: u.department || "",
		status: u.status,
		role: u.roleId?.name || "USER",
		roleId: u.roleId?._id?.toString() || u.roleId?.toString() || "",
		employeeCode: u.employeeCode || "",
		designation: u.designation || "",
		employmentType: u.employmentType || "",
		joiningDate: u.joiningDate || null,
		officeId: u.officeId?._id?.toString() || u.officeId?.toString() || null,
		office: u.officeId ? { id: u.officeId._id?.toString(), name: u.officeId.name, city: u.officeId.city } : null,
		lastLoginAt: u.lastLoginAt,
		createdAt: u.createdAt,
	};
}

export const getEmployees = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { officeId, status, search } = req.query;
		const where: any = {};
		if (officeId) where.officeId = String(officeId);
		if (status) where.status = String(status);
		if (search) {
			const q = String(search);
			where.$or = [
				{ name: { $regex: q, $options: "i" } },
				{ email: { $regex: q, $options: "i" } },
				{ employeeCode: { $regex: q, $options: "i" } },
			];
		}
		const users: any[] = await User.find(where)
			.populate("roleId")
			.populate("officeId")
			.sort({ name: 1 });
		return res.json({ success: true, data: users.map(formatEmployee) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const getEmployee = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const user: any = await User.findById(req.params.id)
			.populate("roleId")
			.populate("officeId");
		if (!user)
			return res.status(404).json({ success: false, message: "Employee not found" });
		return res.json({ success: true, data: formatEmployee(user) });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const createEmployee = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const body = createSchema.parse(req.body);

		const existing = await User.findOne({ email: body.email.toLowerCase() });
		if (existing) {
			return res.status(400).json({
				success: false,
				message: "User with this email already exists",
			});
		}

		if (body.officeId) {
			const office = await Office.findById(body.officeId);
			if (!office)
				return res.status(400).json({ success: false, message: "Office not found" });
		}

		const passwordHash = await bcrypt.hash(body.password, 10);
		const created: any = await User.create({
			name: body.name,
			email: body.email.toLowerCase(),
			passwordHash,
			roleId: body.roleId,
			mobile: body.mobile || "",
			department: body.department || "",
			employeeCode: body.employeeCode || "",
			designation: body.designation || "",
			employmentType: body.employmentType || "FULL_TIME",
			joiningDate: body.joiningDate ? new Date(body.joiningDate) : null,
			officeId: body.officeId || null,
		});

		await created.populate("roleId");
		await created.populate("officeId");

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "EMPLOYEE_CREATED",
			details: { employeeId: created._id.toString(), email: created.email },
		});

		sendWelcomeUserEmail({
			toEmail: created.email,
			userName: created.name,
			roleName: created.roleId?.name || "USER",
			temporaryPassword: body.password,
			createdByAdminEmail: req.user?.email || "Administrator",
		}).catch((e) => console.error("Error sending welcome employee email:", e.message));

		return res.status(201).json({ success: true, data: formatEmployee(created) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const updateEmployee = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { id } = req.params;
		const body = updateSchema.parse(req.body);

		const existing: any = await User.findById(id);
		if (!existing)
			return res.status(404).json({ success: false, message: "Employee not found" });

		const update: any = {};
		if (body.name) update.name = body.name;
		if (body.email) {
			const clash = await User.findOne({ email: body.email.toLowerCase(), _id: { $ne: id } });
			if (clash)
				return res.status(400).json({ success: false, message: "Another user already uses this email" });
			update.email = body.email.toLowerCase();
		}
		if (body.roleId) update.roleId = body.roleId;
		if (body.status) update.status = body.status;
		if (body.employeeCode !== undefined) update.employeeCode = body.employeeCode;
		if (body.designation !== undefined) update.designation = body.designation;
		if (body.department !== undefined) update.department = body.department;
		if (body.mobile !== undefined) update.mobile = body.mobile;
		if (body.employmentType !== undefined) update.employmentType = body.employmentType;
		if (body.joiningDate !== undefined) update.joiningDate = body.joiningDate ? new Date(body.joiningDate) : null;
		if (body.officeId !== undefined) {
			if (body.officeId) {
				const office = await Office.findById(body.officeId);
				if (!office)
					return res.status(400).json({ success: false, message: "Office not found" });
			}
			update.officeId = body.officeId || null;
		}

		const updated: any = await User.findByIdAndUpdate(id, update, { new: true })
			.populate("roleId")
			.populate("officeId");

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "EMPLOYEE_UPDATED",
			details: { employeeId: id, updates: update },
		});

		return res.json({ success: true, data: formatEmployee(updated) });
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};
