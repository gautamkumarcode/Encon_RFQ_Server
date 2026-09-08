import { Response } from 'express';
import mongoose from 'mongoose';
import { Role } from '../models/Role';
import { Permission, RolePermission } from '../models/Permission';
import { User } from '../models/User';
import { logActivity } from '../utils/auditLogger';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export const getRoles = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const roles: any[] = await Role.find().sort({ name: 1 });

    const formatted = await Promise.all(
      roles.map(async (r: any) => {
        const userCount = await User.countDocuments({ roleId: r._id });
        const rolePermissions = await RolePermission.find({ roleId: r._id }).populate('permissionId');
        const permissions = rolePermissions
          .filter((rp: any) => rp.permissionId)
          .map((rp: any) => ({
            id: rp.permissionId._id ? rp.permissionId._id.toString() : String(rp.permissionId),
            module: rp.permissionId.module || '',
            action: rp.permissionId.action || '',
            description: rp.permissionId.description || '',
          }));

        return {
          id: r._id.toString(),
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
          userCount,
          permissions,
          createdAt: r.createdAt,
        };
      })
    );

    return res.json({ success: true, data: formatted });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getPermissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const permissions = await Permission.find().sort({ module: 1, action: 1 });
    const formatted = permissions.map((p: any) => ({
      id: p._id.toString(),
      module: p.module,
      action: p.action,
      description: p.description,
    }));
    return res.json({ success: true, data: formatted });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateRolePermissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { permissionIds } = req.body;

    if (!Array.isArray(permissionIds)) {
      return res.status(400).json({ success: false, message: 'permissionIds must be an array of IDs' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid role ID' });
    }

    const role: any = await Role.findById(id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    const validIds = Array.from(
      new Set(
        permissionIds
          .map((p: any) => {
            if (!p) return '';
            if (typeof p === 'object') return (p.id || p._id || p.permissionId || '').toString();
            return String(p || '');
          })
          .map((p: string) => p.trim())
          .filter((pId: string) => pId.length > 0 && mongoose.Types.ObjectId.isValid(pId))
      )
    );

    // Delete existing permissions for role
    await RolePermission.deleteMany({ roleId: id });

    // Re-create assigned permissions safely
    if (validIds.length > 0) {
      const docsToInsert = validIds.map((pId: string) => ({
        roleId: new mongoose.Types.ObjectId(id),
        permissionId: new mongoose.Types.ObjectId(pId),
      }));
      await RolePermission.insertMany(docsToInsert);
    }

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || 'SYSTEM',
      action: 'ROLE_PERMISSIONS_UPDATED',
      details: { roleName: role.name, count: validIds.length },
    });

    return res.json({ success: true, message: `Permissions updated for role ${role.name}` });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const createRole = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Role name is required' });
    }

    const uppercaseName = name.trim().toUpperCase().replace(/\s+/g, '_');
    const existing = await Role.findOne({ name: uppercaseName });
    if (existing) {
      return res.status(400).json({ success: false, message: `Role "${uppercaseName}" already exists` });
    }

    const newRole: any = await Role.create({
      name: uppercaseName,
      description: description?.trim() || `Custom ${uppercaseName} role`,
      isSystem: false,
    });

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || 'SYSTEM',
      action: 'ROLE_CREATED',
      details: { roleName: uppercaseName },
    });

    return res.json({
      success: true,
      message: `Role "${uppercaseName}" created successfully`,
      data: {
        id: newRole._id.toString(),
        name: newRole.name,
        description: newRole.description,
        isSystem: newRole.isSystem,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteRole = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const role: any = await Role.findById(id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    if (role.isSystem || role.name === 'ADMIN') {
      return res.status(400).json({ success: false, message: 'System default roles cannot be deleted' });
    }

    const userCount = await User.countDocuments({ roleId: id });
    if (userCount > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete role with ${userCount} assigned users. Reassign users first.` });
    }

    await RolePermission.deleteMany({ roleId: id });
    await Role.findByIdAndDelete(id);

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || 'SYSTEM',
      action: 'ROLE_DELETED',
      details: { roleName: role.name },
    });

    return res.json({ success: true, message: `Role "${role.name}" deleted successfully` });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
