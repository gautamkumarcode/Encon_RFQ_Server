import { Response } from 'express';
import { Application, UserApplication } from '../models/Application';
import { User } from '../models/User';
import { logActivity } from '../utils/auditLogger';
import { generateAccessToken } from '../utils/jwt';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export const getApplications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apps: any[] = await Application.find().sort({ createdAt: 1 });

    const formatted = await Promise.all(
      apps.map(async (app: any) => {
        const activeUsersCount = await UserApplication.countDocuments({ applicationId: app._id });
        return {
          id: app._id.toString(),
          code: app.code,
          name: app.name,
          description: app.description,
          category: app.category,
          baseUrl: app.baseUrl,
          ssoEndpoint: app.ssoEndpoint,
          icon: app.icon,
          status: app.status,
          activeUsersCount,
          createdAt: app.createdAt,
        };
      })
    );

    return res.json({ success: true, data: formatted });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getUserApplications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId } = req.params;

    const userApps: any[] = await UserApplication.find({ userId }).populate('applicationId');

    return res.json({
      success: true,
      data: userApps.filter((ua: any) => ua.applicationId).map((ua: any) => ua.applicationId),
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const grantUserApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId, applicationId } = req.body;

    if (!userId || !applicationId) {
      return res.status(400).json({ success: false, message: 'userId and applicationId required' });
    }

    let appAccess: any = await UserApplication.findOne({ userId, applicationId });
    if (!appAccess) {
      appAccess = await UserApplication.create({
        userId,
        applicationId,
        grantedBy: req.user?.email || 'ADMIN',
      });
    }

    await appAccess.populate(['applicationId', 'userId']);

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || 'SYSTEM',
      action: 'APPLICATION_ACCESS_GRANTED',
      details: { targetUserEmail: appAccess.userId?.email, appCode: appAccess.applicationId?.code },
    });

    return res.json({
      success: true,
      message: `Granted access to ${appAccess.applicationId?.name}`,
      data: appAccess,
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const revokeUserApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId, applicationId } = req.body;

    const userApp: any = await UserApplication.findOne({ userId, applicationId }).populate(['applicationId', 'userId']);

    if (!userApp) {
      return res.status(404).json({ success: false, message: 'Application access record not found' });
    }

    await UserApplication.deleteOne({ userId, applicationId });

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || 'SYSTEM',
      action: 'APPLICATION_ACCESS_REVOKED',
      details: { targetUserEmail: userApp.userId?.email, appCode: userApp.applicationId?.code },
    });

    return res.json({
      success: true,
      message: `Revoked access to ${userApp.applicationId?.name}`,
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const launchApplication = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { code } = req.params;
    const userId = req.user!.userId;

    const app: any = await Application.findOne({ code });
    if (!app) return res.status(404).json({ success: false, message: 'Application not found' });

    // Check user access
    const userApp = await UserApplication.findOne({ userId, applicationId: app._id });

    if (!userApp && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: `No access rights granted for ${app.name}` });
    }

    // Generate SSO launcher token
    const ssoToken = generateAccessToken({
      userId: req.user!.userId,
      email: req.user!.email,
      role: req.user!.role,
    });

    await logActivity({
      userId: req.user!.userId,
      userEmail: req.user!.email,
      action: 'APPLICATION_LAUNCHED',
      details: { appCode: app.code, appName: app.name },
    });

    const redirectUrl = `${app.baseUrl}?sso_token=${ssoToken}`;

    return res.json({
      success: true,
      data: {
        appCode: app.code,
        appName: app.name,
        baseUrl: app.baseUrl,
        redirectUrl,
        ssoToken,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
