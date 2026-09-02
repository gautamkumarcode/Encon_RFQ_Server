import { Router } from 'express';
import {
  getUsers,
  createUser,
  updateUser,
  toggleUserStatus,
  resetUserPassword,
  resendWelcomeEmail,
} from '../controllers/userController';
import { authenticateToken, requirePermission, requireRoles } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/', requirePermission('USER_MGMT', 'READ'), getUsers);
router.post('/', requirePermission('USER_MGMT', 'WRITE'), createUser);
router.put('/:id', requirePermission('USER_MGMT', 'WRITE'), updateUser);
router.patch('/:id/status', requirePermission('USER_MGMT', 'WRITE'), toggleUserStatus);
router.post('/:id/reset-password', requireRoles(['ADMIN']), resetUserPassword);
router.post('/:id/resend-welcome', requireRoles(['ADMIN']), resendWelcomeEmail);

export default router;
