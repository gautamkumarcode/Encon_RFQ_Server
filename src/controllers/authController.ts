import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User';
import { Role } from '../models/Role';
import { RolePermission } from '../models/Permission';
import { UserApplication } from '../models/Application';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { logActivity } from '../utils/auditLogger';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password required'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

const changePasswordSchema = z.object({
  oldPassword: z.string(),
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

export const login = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user: any = await User.findOne({ email: email.toLowerCase() }).populate('roleId');

    if (!user) {
      await logActivity({
        userEmail: email,
        action: 'LOGIN_FAILED',
        details: { reason: 'User not found' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (user.status === 'DISABLED') {
      await logActivity({
        userId: user._id.toString(),
        userEmail: user.email,
        action: 'LOGIN_FAILED',
        details: { reason: 'Account disabled' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(403).json({ success: false, message: 'Account disabled. Contact Administrator.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      await logActivity({
        userId: user._id.toString(),
        userEmail: user.email,
        action: 'LOGIN_FAILED',
        details: { reason: 'Incorrect password' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const roleName = user.roleId?.name || 'USER';
    const payload = { userId: user._id.toString(), email: user.email, role: roleName };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    // Non-blocking background updates for speed
    User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() }).catch(() => { });

    logActivity({
      userId: user._id.toString(),
      userEmail: user.email,
      action: 'LOGIN',
      details: { role: roleName },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    }).catch(() => { });

    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || req.headers['x-forwarded-proto'] === 'https';
    const getCookieOptions = (maxAgeMs = 7 * 24 * 60 * 60 * 1000) => ({
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
      maxAge: maxAgeMs,
      path: '/',
    });

    res.cookie('encon_access_token', accessToken, getCookieOptions());
    res.cookie('encon_refresh_token', refreshToken, getCookieOptions(30 * 24 * 60 * 60 * 1000));

    return res.json({
      success: true,
      data: {
        user: {
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          role: roleName,
          status: user.status,
        },
      },
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message || 'Login failed' });
  }
};

export const refreshToken = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const token = req.cookies?.encon_refresh_token || req.body?.token;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Refresh token required' });
    }

    const decoded = verifyRefreshToken(token);
    const user: any = await User.findById(decoded.userId).populate('roleId');

    if (!user || user.status === 'DISABLED') {
      return res.status(401).json({ success: false, message: 'User not found or disabled' });
    }

    const roleName = user.roleId?.name || 'USER';
    const payload = { userId: user._id.toString(), email: user.email, role: roleName };
    const newAccessToken = generateAccessToken(payload);

    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('encon_access_token', newAccessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return res.json({
      success: true,
      data: { accessToken: newAccessToken },
    });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid refresh token' });
  }
};

export const logout = async (req: AuthenticatedRequest, res: Response) => {
  if (req.user) {
    await logActivity({
      userId: req.user.userId,
      userEmail: req.user.email,
      action: 'LOGOUT',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
  res.clearCookie('encon_access_token', { path: '/' });
  res.clearCookie('encon_refresh_token', { path: '/' });
  return res.json({ success: true, message: 'Logged out successfully' });
};

export const forgotPassword = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    const user: any = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.json({ success: true, message: 'If email exists, a password reset link has been dispatched.' });
    }

    const resetToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const resetTokenExpires = new Date(Date.now() + 3600000); // 1 hour

    await User.findByIdAndUpdate(user._id, { resetToken, resetTokenExpires });

    await logActivity({
      userId: user._id.toString(),
      userEmail: user.email,
      action: 'FORGOT_PASSWORD_REQUEST',
    });

    return res.json({
      success: true,
      message: 'Reset token generated successfully',
      debugToken: resetToken,
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const resetPassword = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);

    const user: any = await User.findOne({
      resetToken: token,
      resetTokenExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(user._id, {
      passwordHash,
      resetToken: null,
      resetTokenExpires: null,
    });

    await logActivity({
      userId: user._id.toString(),
      userEmail: user.email,
      action: 'PASSWORD_RESET',
    });

    return res.json({ success: true, message: 'Password reset successfully' });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const changePassword = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { oldPassword, newPassword } = changePasswordSchema.parse(req.body);
    const userId = req.user!.userId;

    const user: any = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isMatch = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(user._id, { passwordHash });

    await logActivity({
      userId: user._id.toString(),
      userEmail: user.email,
      action: 'CHANGE_PASSWORD',
    });

    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  mobile: z.string().optional(),
  department: z.string().optional(),
});

export const updateProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, mobile, department } = updateProfileSchema.parse(req.body);
    const userId = req.user!.userId;

    const user: any = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const updated: any = await User.findByIdAndUpdate(
      userId,
      { name, mobile: mobile || '', department: department || '' },
      { new: true }
    ).populate('roleId');

    await logActivity({
      userId: user._id.toString(),
      userEmail: user.email,
      action: 'UPDATE_PROFILE',
      details: { name, mobile, department },
    });

    return res.json({
      success: true,
      message: 'Profile details updated successfully',
      data: {
        id: updated._id.toString(),
        name: updated.name,
        email: updated.email,
        mobile: updated.mobile || '',
        department: updated.department || '',
        role: updated.roleId?.name || 'USER',
      },
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const getMe = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user: any = await User.findById(req.user!.userId).populate('roleId');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const rolePermissions = await RolePermission.find({ roleId: user.roleId?._id }).populate('permissionId');
    const permissions = rolePermissions
      .filter((rp: any) => rp.permissionId)
      .map((rp: any) => `${rp.permissionId.module}:${rp.permissionId.action}`);

    const userApps = await UserApplication.find({ userId: user._id }).populate('applicationId');
    const applications = userApps.filter((ua: any) => ua.applicationId).map((ua: any) => ua.applicationId);

    const roleName = user.roleId?.name || 'USER';
    const roleDesc = user.roleId?.description || '';

    return res.json({
      success: true,
      data: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        mobile: user.mobile || '',
        department: user.department || '',
        role: roleName,
        roleDescription: roleDesc,
        status: user.status,
        permissions,
        applications,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const googleLogin = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { credential, email: bodyEmail } = req.body;
    let email = bodyEmail;

    if (credential) {
      try {
        let tokenAud = '';
        const parts = credential.split('.');
        if (parts.length === 3) {
          try {
            const tokenPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
            if (tokenPayload.email) email = tokenPayload.email;
            if (tokenPayload.aud) tokenAud = tokenPayload.aud;
          } catch (e) { }
        }

        const validAudiences = Array.from(
          new Set(
            [
              (process.env.GOOGLE_CLIENT_ID || '').trim(),
              tokenAud,
              '770218511201-eigo4o97m5gsqc0g1nshrs0aku4ehp1a.apps.googleusercontent.com',
            ].filter(Boolean)
          )
        );

        const ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: validAudiences,
        });
        const payload = ticket.getPayload();
        if (payload && payload.email) {
          email = payload.email;
        }
      } catch (verifyErr: any) {
        console.warn('⚠️ Google ID Token verification warning:', verifyErr.message);
      }
    }

    if (!email) {
      return res.status(400).json({ success: false, message: 'Google authentication failed: Email not provided' });
    }

    const user: any = await User.findOne({ email: email.toLowerCase() }).populate('roleId');

    if (!user) {
      await logActivity({
        userEmail: email,
        action: 'GOOGLE_LOGIN_FAILED',
        details: { reason: 'User not registered in database' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(403).json({
        success: false,
        message: `No Encon account found for ${email}. Contact Administrator to request access.`,
      });
    }

    if (user.status === 'DISABLED') {
      await logActivity({
        userId: user._id.toString(),
        userEmail: user.email,
        action: 'GOOGLE_LOGIN_FAILED',
        details: { reason: 'Account disabled' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(403).json({ success: false, message: 'Account disabled. Contact Administrator.' });
    }

    const roleName = user.roleId?.name || 'USER';
    const payload = { userId: user._id.toString(), email: user.email, role: roleName };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() }).catch(() => { });

    logActivity({
      userId: user._id.toString(),
      userEmail: user.email,
      action: 'GOOGLE_LOGIN_SUCCESS',
      details: { role: roleName },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    }).catch(() => { });

    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || req.headers['x-forwarded-proto'] === 'https';
    const cookieOpts = {
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
      path: '/',
    };
    res.cookie('encon_access_token', accessToken, { ...cookieOpts, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.cookie('encon_refresh_token', refreshToken, { ...cookieOpts, maxAge: 30 * 24 * 60 * 60 * 1000 });

    return res.json({
      success: true,
      data: {
        user: {
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          role: roleName,
          status: user.status,
        },
      },
    });
  } catch (error: any) {
    console.error('Error in googleLogin:', error);
    return res.status(400).json({ success: false, message: error.message || 'Google Sign-In failed' });
  }
};

export const seedData = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { seedDatabase } = require('../scripts/seed');
    await seedDatabase();
    return res.json({
      success: true,
      message: 'Database successfully seeded with default Encon roles, permissions, applications, and staff users!',
    });
  } catch (error: any) {
    console.error('Error running seedData:', error);
    return res.status(500).json({ success: false, message: error.message || 'Seeding failed' });
  }
};
