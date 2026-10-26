import mongoose, { Schema, Document } from 'mongoose';

/**
 * One attendance record per employee per day. Clock-in creates it, clock-out
 * updates it. Geofence + device + IP are captured on each punch for audit.
 * Single-tenant: no organizationId. `date` is a normalized UTC-midnight day so
 * the { userId, date } unique index guarantees a single row per person per day.
 */
export type AttendanceStatus =
  | 'PRESENT'
  | 'LATE'
  | 'HALF_DAY'
  | 'ABSENT'
  | 'LEAVE';

export interface IPunch {
  time?: Date | null;
  /** Branch this punch physically happened at (GPS auto-detected). */
  officeId?: mongoose.Types.ObjectId | null;
  lat?: number;
  lng?: number;
  accuracy?: number;
  address?: string;
  geofenceOk?: boolean;
  ip?: string;
  userAgent?: string;
  imageUrl?: string;
}

export interface IAttendance extends Document {
  userId: mongoose.Types.ObjectId;
  officeId: mongoose.Types.ObjectId | null;
  date: Date;
  status: AttendanceStatus;
  clockIn: IPunch;
  clockOut: IPunch;
  totalWorkMinutes: number | null;
  source: 'WEB' | 'MOBILE';
  remark: string;
  createdAt: Date;
  updatedAt: Date;
}

const PunchSchema = new Schema<IPunch>(
  {
    time: { type: Date, default: null },
    officeId: { type: Schema.Types.ObjectId, ref: 'Office', default: null },
    lat: { type: Number },
    lng: { type: Number },
    accuracy: { type: Number },
    address: { type: String, default: '' },
    geofenceOk: { type: Boolean, default: false },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
  },
  { _id: false }
);

const AttendanceSchema = new Schema<IAttendance>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    officeId: { type: Schema.Types.ObjectId, ref: 'Office', default: null },
    date: { type: Date, required: true },
    status: {
      type: String,
      enum: ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE'],
      default: 'PRESENT',
    },
    clockIn: { type: PunchSchema, default: () => ({}) },
    clockOut: { type: PunchSchema, default: () => ({}) },
    totalWorkMinutes: { type: Number, default: null },
    source: { type: String, enum: ['WEB', 'MOBILE'], default: 'WEB' },
    remark: { type: String, default: '' },
  },
  { timestamps: true }
);

// One row per employee per day.
AttendanceSchema.index({ userId: 1, date: 1 }, { unique: true });
// Fast range queries for the register/report.
AttendanceSchema.index({ date: 1 });
AttendanceSchema.index({ officeId: 1, date: 1 });

export const Attendance =
  mongoose.models.Attendance ||
  mongoose.model<IAttendance>('Attendance', AttendanceSchema);
