import mongoose, { Schema, Document } from 'mongoose';

export interface IApplication extends Document {
  code: string;
  name: string;
  description: string;
  category: string;
  baseUrl: string;
  ssoEndpoint?: string;
  icon: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const ApplicationSchema = new Schema<IApplication>(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    category: { type: String, default: 'CORE' },
    baseUrl: { type: String, required: true },
    ssoEndpoint: { type: String },
    icon: { type: String, default: 'app' },
    status: { type: String, default: 'ACTIVE' },
  },
  { timestamps: true }
);

export const Application = mongoose.models.Application || mongoose.model<IApplication>('Application', ApplicationSchema);

export interface IUserApplication extends Document {
  userId: mongoose.Types.ObjectId;
  applicationId: mongoose.Types.ObjectId;
  grantedAt: Date;
  grantedBy: string;
}

const UserApplicationSchema = new Schema<IUserApplication>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
  grantedAt: { type: Date, default: Date.now },
  grantedBy: { type: String, required: true },
});

UserApplicationSchema.index({ userId: 1, applicationId: 1 }, { unique: true });

export const UserApplication =
  mongoose.models.UserApplication || mongoose.model<IUserApplication>('UserApplication', UserApplicationSchema);
