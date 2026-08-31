import { Response } from 'express';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { logActivity } from '../utils/auditLogger';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export const getNotifications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const userEmail = req.user!.email;

    const dbUser: any = await User.findOne({
      $or: [{ _id: userId }, { email: userEmail }],
    }).populate('roleId');

    const targetUserId = dbUser ? dbUser._id : userId;
    const roleId = dbUser?.roleId?._id ? dbUser.roleId._id.toString() : null;

    const orConditions: any[] = [
      { targetUserId },
      { targetUserId: userId },
      { targetRoleId: userRole },
      { targetUserId: null, targetRoleId: null },
    ];
    if (roleId) orConditions.push({ targetRoleId: roleId });

    const notifications = await Notification.find({ $or: orConditions }).sort({ createdAt: -1 }).limit(50);

    const formatted = notifications.map((n: any) => ({
      id: n._id.toString(),
      title: n.title,
      message: n.message,
      type: n.type,
      targetRoleId: n.targetRoleId,
      targetUserId: n.targetUserId?.toString(),
      isRead: n.isRead,
      createdAt: n.createdAt,
    }));

    return res.json({ success: true, data: formatted });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const markNotificationRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    await Notification.findByIdAndUpdate(id, { isRead: true });
    return res.json({ success: true, message: 'Notification marked as read' });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const createAnnouncement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, message, type = 'ANNOUNCEMENT', targetRoleId } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'Title and message required' });
    }

    const notification: any = await Notification.create({
      title,
      message,
      type,
      targetRoleId: targetRoleId || null,
    });

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || 'SYSTEM',
      action: 'ANNOUNCEMENT_CREATED',
      details: { title, type },
    });

    return res.status(201).json({
      success: true,
      data: {
        id: notification._id.toString(),
        title: notification.title,
        message: notification.message,
        type: notification.type,
      },
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};
