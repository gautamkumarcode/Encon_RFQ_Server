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
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.all('/seed', seedData);
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
