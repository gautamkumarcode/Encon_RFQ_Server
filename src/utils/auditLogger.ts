import { ActivityLog } from '../models/ActivityLog';

export async function logActivity({
  userId,
  userEmail,
  action,
  details,
  ipAddress,
  userAgent,
}: {
  userId?: string;
  userEmail: string;
  action: string;
  details?: Record<string, any> | string;
  ipAddress?: string;
  userAgent?: string;
}) {
  try {
    const detailsString = typeof details === 'object' ? JSON.stringify(details) : details;
    await ActivityLog.create({
      userId: userId || null,
      userEmail,
      action,
      details: detailsString,
      ipAddress: ipAddress || '127.0.0.1',
      userAgent: userAgent || 'Unknown',
    });
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}
