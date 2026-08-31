import mongoose, { Schema, Document } from 'mongoose';

export interface INotification extends Document {
  title: string;
  message: string;
  type: string;
  targetRoleId?: string | null;
  targetUserId?: mongoose.Types.ObjectId | null;
  isRead: boolean;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>({
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, default: 'SYSTEM' },
  targetRoleId: { type: String, default: null },
  targetUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

export const Notification =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema);
