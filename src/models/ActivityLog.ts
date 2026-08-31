import mongoose, { Schema, Document } from 'mongoose';

export interface IActivityLog extends Document {
  userId?: mongoose.Types.ObjectId | null;
  userEmail: string;
  action: string;
  details?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: Date;
}

const ActivityLogSchema = new Schema<IActivityLog>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  userEmail: { type: String, required: true },
  action: { type: String, required: true },
  details: { type: String, default: null },
  ipAddress: { type: String, default: null },
  userAgent: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

export const ActivityLog =
  mongoose.models.ActivityLog || mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);
