import bcrypt from "bcryptjs";
import { Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { UserApplication } from "../models/Application";
import { AssigneeEmail } from "../models/AssigneeEmail";
import { Enquiry } from "../models/Enquiry";
import { User } from "../models/User";
import { sendWelcomeUserEmail } from "../services/emailService";
import { logActivity } from "../utils/auditLogger";

const createUserSchema = z.object({
	name: z.string().min(2, "Name must be at least 2 characters"),
	email: z.string().email(),
	password: z.string().min(6, "Password must be at least 6 characters"),
	roleId: z.string(),
	applicationIds: z.array(z.string()).optional(),
});

const updateUserSchema = z.object({
	name: z.string().min(2).optional(),
	email: z.string().email().optional(),
	roleId: z.string().optional(),
	status: z.enum(["ACTIVE", "DISABLED"]).optional(),
	applicationIds: z.array(z.string()).optional(),
});

export const getUsers = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { roleId, status, search } = req.query;

		const where: any = {};
		if (roleId) where.roleId = String(roleId);
		if (status) where.status = String(status);
		if (search) {
			const q = String(search);
			where.$or = [
				{ name: { $regex: q, $options: "i" } },
				{ email: { $regex: q, $options: "i" } },
			];
		}

		const users: any[] = await User.find(where)
			.populate("roleId")
			.sort({ createdAt: -1 });

		const userIds = users.map((u) => u._id);
		const userApps: any[] = await UserApplication.find({
			userId: { $in: userIds },
		}).populate("applicationId");

		const appMap = new Map<string, any[]>();
		userApps.forEach((ua) => {
			const uid = ua.userId.toString();
			const list = appMap.get(uid) || [];
			if (ua.applicationId) list.push(ua.applicationId);
			appMap.set(uid, list);
		});

		const sanitizedUsers = users.map((u: any) => ({
			id: u._id.toString(),
			name: u.name,
			email: u.email,
			status: u.status,
			role: u.roleId?.name || "USER",
			roleDetails: u.roleId,
			applications: appMap.get(u._id.toString()) || [],
			lastLoginAt: u.lastLoginAt,
			createdAt: u.createdAt,
		}));

		return res.json({ success: true, data: sanitizedUsers });
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};

export const createUser = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { name, email, password, roleId, applicationIds } =
			createUserSchema.parse(req.body);

		const existing = await User.findOne({ email: email.toLowerCase() });
		if (existing) {
			return res.status(400).json({
				success: false,
				message: "User with this email already exists",
			});
		}

		const passwordHash = await bcrypt.hash(password, 10);

		const newUser: any = await User.create({
			name,
			email: email.toLowerCase(),
			passwordHash,
			roleId,
		});

		await newUser.populate("roleId");

		if (applicationIds && applicationIds.length > 0) {
			await UserApplication.insertMany(
				applicationIds.map((appId: string) => ({
					userId: newUser._id,
					applicationId: appId,
					grantedBy: req.user?.email || "ADMIN",
				})),
			);
		}

		const roleName = newUser.roleId?.name || "USER";

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "USER_CREATED",
			details: {
				createdUserId: newUser._id.toString(),
				createdUserEmail: newUser.email,
				role: roleName,
			},
		});

		sendWelcomeUserEmail({
			toEmail: newUser.email,
			userName: newUser.name,
			roleName,
			temporaryPassword: password,
			createdByAdminEmail: req.user?.email || "Administrator",
		}).catch((e) =>
			console.error("Error sending welcome user email:", e.message),
		);

		return res.status(201).json({
			success: true,
			message: "User created successfully",
			data: {
				id: newUser._id.toString(),
				name: newUser.name,
				email: newUser.email,
				role: roleName,
				status: newUser.status,
			},
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const updateUser = async (req: AuthenticatedRequest, res: Response) => {
	try {
		const { id } = req.params;
		const { name, email, roleId, status, applicationIds } =
			updateUserSchema.parse(req.body);

		const existingUser: any = await User.findById(id).lean();
		if (!existingUser) {
			return res
				.status(404)
				.json({ success: false, message: "User not found" });
		}

		const updatePayload: any = {};
		if (name) updatePayload.name = name;
		if (email) {
			const existing = await User.findOne({
				email: email.toLowerCase(),
				_id: { $ne: id },
			});
			if (existing) {
				return res.status(400).json({
					success: false,
					message: "Another user already uses this email",
				});
			}
			updatePayload.email = email.toLowerCase();
		}
		if (roleId) updatePayload.roleId = roleId;
		if (status) updatePayload.status = status;

		const updatedUser: any = await User.findByIdAndUpdate(id, updatePayload, {
			new: true,
		}).populate("roleId");
		if (!updatedUser) {
			return res
				.status(404)
				.json({ success: false, message: "User not found" });
		}

		if (applicationIds !== undefined) {
			await UserApplication.deleteMany({ userId: id });
			if (applicationIds.length > 0) {
				await UserApplication.insertMany(
					applicationIds.map((appId: string) => ({
						userId: id,
						applicationId: appId,
						grantedBy: req.user?.email || "ADMIN",
					})),
				);
			}
		}

		if (name && name.trim() !== existingUser.name.trim()) {
			const oldName = existingUser.name.trim();
			const oldEmail = existingUser.email.trim();
			const oldNameRegex = new RegExp(
				`^${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
				"i",
			);
			const oldEmailRegex = new RegExp(
				`^${oldEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
				"i",
			);
			const enquiries: any[] = await Enquiry.find({
				$or: [
					{ assignedToId: id },
					{ technicalId: id },
					{ salesResponsibilityId: id },
					{ assignedTo: oldNameRegex },
					{ technical: oldNameRegex },
					{ salesResponsibility: oldNameRegex },
					{ assignedTo: oldEmailRegex },
					{ technical: oldEmailRegex },
					{ salesResponsibility: oldEmailRegex },
				],
			});

			for (const enquiry of enquiries) {
				const changes: any = {};
				for (const field of [
					"assignedTo",
					"technical",
					"salesResponsibility",
				]) {
					const idField = `${field}Id`;
					const current = String(enquiry[field] || "")
						.trim()
						.toLowerCase();
					if (
						String(enquiry[idField] || "") === id ||
						current === oldName.toLowerCase() ||
						current === oldEmail.toLowerCase()
					) {
						changes[field] = name.trim();
						changes[idField] = id;
					}
				}
				if (Object.keys(changes).length > 0) {
					await Enquiry.updateOne({ _id: enquiry._id }, { $set: changes });
				}
			}

			await AssigneeEmail.deleteMany({
				name: new RegExp(
					`^${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
					"i",
				),
			});
		}

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "USER_UPDATED",
			details: { targetUserId: id, updates: req.body },
		});

		return res.json({
			success: true,
			message: "User updated successfully",
			data: updatedUser,
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const toggleUserStatus = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const { id } = req.params;
		const user: any = await User.findById(id);

		if (!user)
			return res
				.status(404)
				.json({ success: false, message: "User not found" });

		const newStatus = user.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
		const updated: any = await User.findByIdAndUpdate(
			id,
			{ status: newStatus },
			{ new: true },
		);

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: newStatus === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED",
			details: { targetUserId: id, targetEmail: user.email },
		});

		return res.json({
			success: true,
			message: `User status changed to ${newStatus}`,
			data: { id: updated._id.toString(), status: updated.status },
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const resetUserPassword = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const { id } = req.params;
		const { newPassword } = req.body;

		if (!newPassword || newPassword.length < 6) {
			return res.status(400).json({
				success: false,
				message: "Password must be at least 6 characters",
			});
		}

		const passwordHash = await bcrypt.hash(newPassword, 10);
		await User.findByIdAndUpdate(id, { passwordHash });

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "ADMIN_RESET_USER_PASSWORD",
			details: { targetUserId: id },
		});

		return res.json({
			success: true,
			message: "User password has been reset successfully",
		});
	} catch (error: any) {
		return res.status(400).json({ success: false, message: error.message });
	}
};

export const resendWelcomeEmail = async (
	req: AuthenticatedRequest,
	res: Response,
) => {
	try {
		const { id } = req.params;
		const user: any = await User.findById(id).populate("roleId");
		if (!user)
			return res
				.status(404)
				.json({ success: false, message: "User not found" });

		const roleName = user.roleId?.name || "USER";

		const sent = await sendWelcomeUserEmail({
			toEmail: user.email,
			userName: user.name,
			roleName,
			createdByAdminEmail: req.user?.email || "Administrator",
		});

		if (!sent) {
			return res.status(500).json({
				success: false,
				message:
					"Failed to send welcome email. Please verify SMTP credentials in environment settings.",
			});
		}

		await logActivity({
			userId: req.user?.userId,
			userEmail: req.user?.email || "SYSTEM",
			action: "WELCOME_EMAIL_RESENT",
			details: { targetUserId: id, targetEmail: user.email },
		});

		return res.json({
			success: true,
			message: `Welcome invitation email resent successfully to ${user.email}`,
		});
	} catch (error: any) {
		return res.status(500).json({ success: false, message: error.message });
	}
};
