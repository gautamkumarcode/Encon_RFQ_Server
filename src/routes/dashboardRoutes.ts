import { Router } from 'express';
import { getDashboardSummary, getEmployeeAnalytics } from '../controllers/dashboardController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/summary', getDashboardSummary);
router.get('/employee-analytics', getEmployeeAnalytics);

export default router;
