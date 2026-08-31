import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
  name: string;
  mobile?: string;
  department?: string;
  passwordHash: string;
  status: 'ACTIVE' | 'DISABLED';
  roleId: mongoose.Types.ObjectId;
  resetToken?: string | null;
  resetTokenExpires?: Date | null;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    mobile: { type: String, default: '' },
    department: { type: String, default: '' },
    passwordHash: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'DISABLED'], default: 'ACTIVE' },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const User = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
