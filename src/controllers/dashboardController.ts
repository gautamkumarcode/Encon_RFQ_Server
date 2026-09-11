import { Response } from 'express';
import { IntegrationService } from '../services/integrationService';
import { User } from '../models/User';
import { Application } from '../models/Application';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { canSeeFullRfqList, getUserRfqScopeWhere } from './rfqController';

async function getAuthenticatedUserInfo(req: AuthenticatedRequest) {
  if (!req.user?.userId) return null;
  const dbUser: any = await User.findById(req.user.userId).populate('roleId');
  if (!dbUser) return null;
  return {
    id: dbUser._id.toString(),
    name: dbUser.name,
    email: dbUser.email,
    roleName: dbUser.roleId?.name || 'USER',
  };
}

export const getDashboardSummary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userInfo = await getAuthenticatedUserInfo(req);
    const isFullAccess = canSeeFullRfqList(userInfo || req.user);
    const userScopeWhere = getUserRfqScopeWhere(userInfo || req.user);

    const [rfqMetrics, costingMetrics, employeeKPIs, monthlyTrends, activeUsersCount, totalAppsCount, followupDueRFQs] = await Promise.all([
      IntegrationService.getRFQMetrics(userScopeWhere),
      IntegrationService.getCostingMetrics(userScopeWhere),
      IntegrationService.getEmployeeKPIs(userScopeWhere, !isFullAccess ? userInfo?.name : undefined),
      IntegrationService.getMonthlyTrends(userScopeWhere),
      User.countDocuments({ status: 'ACTIVE' }),
      Application.countDocuments(),
      IntegrationService.getFollowupDueRFQs(userScopeWhere),
    ]);

    return res.json({
      success: true,
      data: {
        isFullAccess,
        userRole: userInfo?.roleName || req.user?.role || 'USER',
        summaryCards: {
          totalRFQs: rfqMetrics.totalRFQs,
          totalLiveRFQs: rfqMetrics.totalLiveRFQs,
          totalOffersGenerated: costingMetrics.totalOffersGenerated,
          offersSentRFQs: rfqMetrics.offersSentRFQs,
          pendingRFQs: rfqMetrics.pendingRFQs,
          pendingOffers: costingMetrics.pendingOffers,
          approvedRFQs: rfqMetrics.approvedRFQs,
          approvedOffers: costingMetrics.approvedOffers,
          totalValueINR: costingMetrics.totalValueINR,
          overallConversionRate: costingMetrics.conversionRate,
          activeUsersCount,
          totalAppsCount,
        },
        recentRFQs: rfqMetrics.recentRFQs,
        recentOffers: costingMetrics.recentOffers,
        topEmployees: employeeKPIs.slice(0, 4),
        monthlyTrends,
        followupDueRFQs,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getEmployeeAnalytics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userInfo = await getAuthenticatedUserInfo(req);
    const isFullAccess = canSeeFullRfqList(userInfo || req.user);

    const userScopeWhere = !isFullAccess && userInfo ? {
      $or: [
        { assignedTo: userInfo.name },
        { assignedTo: userInfo.email },
        { salesResponsibility: userInfo.name },
        { technical: userInfo.name },
      ],
    } : undefined;

    const employeeKPIs = await IntegrationService.getEmployeeKPIs(userScopeWhere, !isFullAccess ? userInfo?.name : undefined);
    return res.json({
      success: true,
      data: employeeKPIs,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getFollowupDueList = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userInfo = await getAuthenticatedUserInfo(req);
    const isFullAccess = canSeeFullRfqList(userInfo || req.user);
    const userScopeWhere = getUserRfqScopeWhere(userInfo || req.user);
    const followupDueRFQs = await IntegrationService.getFollowupDueRFQs(!isFullAccess ? userScopeWhere : undefined);
    return res.json({ success: true, data: followupDueRFQs });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
