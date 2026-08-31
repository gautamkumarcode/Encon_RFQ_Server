import { Router } from 'express';
import {
  getApplications,
  getUserApplications,
  grantUserApplication,
  revokeUserApplication,
  launchApplication,
} from '../controllers/appController';
import { authenticateToken, requirePermission } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getApplications);
router.get('/user/:userId', getUserApplications);
router.post('/access/grant', requirePermission('APP_MGMT', 'WRITE'), grantUserApplication);
router.post('/access/revoke', requirePermission('APP_MGMT', 'WRITE'), revokeUserApplication);
router.get('/launch/:code', launchApplication);

export default router;
