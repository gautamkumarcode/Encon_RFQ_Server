import { Response } from 'express';
import { ActivityLog } from '../models/ActivityLog';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export const getActivityLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, email, limit = 50 } = req.query;

    const where: any = {};
    if (action) where.action = String(action);
    if (email) where.userEmail = { $regex: String(email), $options: 'i' };

    const logs: any[] = await ActivityLog.find(where)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .populate({ path: 'userId', select: 'name roleId', populate: { path: 'roleId', select: 'name' } })
      .lean();

    const formatted = logs.map((log: any) => ({
      id: log._id.toString(),
      userId: log.userId?._id?.toString() || log.userId,
      userEmail: log.userEmail,
      action: log.action,
      details: log.details,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      createdAt: log.createdAt,
      user: log.userId
        ? {
            name: log.userId.name,
            role: { name: log.userId.roleId?.name || 'USER' },
          }
        : null,
    }));

    return res.json({ success: true, data: formatted });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
