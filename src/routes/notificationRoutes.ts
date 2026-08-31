import { Router } from 'express';
import {
  getNotifications,
  markNotificationRead,
  createAnnouncement,
} from '../controllers/notificationController';
import { authenticateToken, requireRoles } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getNotifications);
router.patch('/:id/read', markNotificationRead);
router.post('/announcement', requireRoles(['ADMIN', 'CO', 'GM', 'PRODUCTION_HEAD']), createAnnouncement);

export default router;
