import { Router } from 'express';
import { getDashboardSummary, getEmployeeAnalytics, getFollowupDueList } from '../controllers/dashboardController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/summary', getDashboardSummary);
router.get('/employee-analytics', getEmployeeAnalytics);
router.get('/followup-due', getFollowupDueList);

export default router;
