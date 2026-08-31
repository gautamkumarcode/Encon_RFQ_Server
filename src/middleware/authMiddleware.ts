import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../utils/jwt';
import { User } from '../models/User';
import { RolePermission } from '../models/Permission';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token && req.cookies && req.cookies.encon_access_token) {
    token = req.cookies.encon_access_token;
  }

  if (!token && req.query.token) {
    token = String(req.query.token);
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token missing' });
  }

  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired access token' });
  }
}

export function requireRoles(roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Requires one of the following roles: ${roles.join(', ')}`,
      });
    }

    next();
  };
}

export function requirePermission(module: string, action: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    if (req.user.role === 'ADMIN') {
      return next(); // Admin bypass
    }

    try {
      const user = await User.findById(req.user.userId).populate('roleId');
      if (!user) {
        return res.status(401).json({ success: false, message: 'User account not found' });
      }

      const rolePermissions = await RolePermission.find({ roleId: user.roleId }).populate('permissionId');
      const hasPerm = rolePermissions.some((rp: any) => {
        const perm = rp.permissionId;
        return perm && perm.module === module && (perm.action === action || perm.action === 'MANAGE');
      });

      if (!hasPerm) {
        return res.status(403).json({
          success: false,
          message: `Forbidden: Lack ${action} permission on ${module}`,
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Error checking permissions' });
    }
  };
}
