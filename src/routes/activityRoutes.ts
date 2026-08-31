import { Router } from 'express';
import { getActivityLogs } from '../controllers/activityController';
import { authenticateToken, requirePermission } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/', requirePermission('ACTIVITY_LOGS', 'READ'), getActivityLogs);

export default router;
