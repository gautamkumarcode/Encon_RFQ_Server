import mongoose, { Schema, Document } from 'mongoose';

export interface IPermission extends Document {
  module: string;
  action: string;
  description: string;
}

const PermissionSchema = new Schema<IPermission>({
  module: { type: String, required: true },
  action: { type: String, required: true },
  description: { type: String, required: true },
});

PermissionSchema.index({ module: 1, action: 1 }, { unique: true });

export const Permission = mongoose.models.Permission || mongoose.model<IPermission>('Permission', PermissionSchema);

export interface IRolePermission extends Document {
  roleId: mongoose.Types.ObjectId;
  permissionId: mongoose.Types.ObjectId;
}

const RolePermissionSchema = new Schema<IRolePermission>({
  roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
  permissionId: { type: Schema.Types.ObjectId, ref: 'Permission', required: true },
});

RolePermissionSchema.index({ roleId: 1, permissionId: 1 }, { unique: true });

export const RolePermission = mongoose.models.RolePermission || mongoose.model<IRolePermission>('RolePermission', RolePermissionSchema);
