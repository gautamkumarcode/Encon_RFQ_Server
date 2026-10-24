import { Router } from 'express';
import {
  login,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  updateProfile,
  getMe,
  googleLogin,
  seedData,
} from '../controllers/authController';
import { authenticateToken, requireRoles } from '../middleware/authMiddleware';

const router = Router();

// Writes RBAC rows (roles, permissions, grants). It touches no users and no
// application data, but it can hand out privileges — so ADMIN only, authenticated.
router.post('/seed', authenticateToken, requireRoles(['ADMIN']), seedData);
router.post('/login', login);
router.post('/google', googleLogin);
router.post('/refresh', refreshToken);
router.post('/logout', authenticateToken, logout);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/change-password', authenticateToken, changePassword);
router.put('/profile', authenticateToken, updateProfile);
router.get('/me', authenticateToken, getMe);

export default router;
