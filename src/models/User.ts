import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
  name: string;
  mobile?: string;
  department?: string;
  passwordHash: string;
  status: 'ACTIVE' | 'DISABLED';
  roleId: mongoose.Types.ObjectId;
  // Employee attributes - all optional so existing admin/staff accounts are
  // unaffected. Turn a login into an employee that can be assigned to a branch
  // and tracked for attendance.
  employeeCode?: string;
  officeId?: mongoose.Types.ObjectId | null;
  designation?: string;
  joiningDate?: Date | null;
  employmentType?: string;
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
    employeeCode: { type: String, default: '', trim: true },
    officeId: { type: Schema.Types.ObjectId, ref: 'Office', default: null },
    designation: { type: String, default: '' },
    joiningDate: { type: Date, default: null },
    employmentType: { type: String, default: 'FULL_TIME' },
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const User = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
