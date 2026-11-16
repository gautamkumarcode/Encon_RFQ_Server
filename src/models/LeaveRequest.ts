import mongoose, { Schema, Document } from 'mongoose';

/**
 * A leave application raised by an employee and decided by an approver.
 * Single-tenant like the rest of the HR models. Dates follow the Attendance
 * convention: UTC-midnight day keys, so a request spanning a range maps cleanly
 * onto per-day Attendance rows when approved. `days` is the net working-day
 * count (Mon-Sat minus holidays, half days counted as 0.5) computed server-side
 * at submit time and stored so balances and reports never re-derive it.
 */
export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** Only Casual Leave is modelled today; the enum is open for future types. */
export type LeaveType = 'CASUAL';

export interface ILeaveRequest extends Document {
  userId: mongoose.Types.ObjectId;
  officeId: mongoose.Types.ObjectId | null;
  leaveType: LeaveType;
  fromDate: Date;
  toDate: Date;
  /** Specific working days within the range taken as half days (0.5 each). */
  partialDates: Date[];
  /** Net working days consumed, computed server-side (half days = 0.5). */
  days: number;
  reason: string;
  status: LeaveStatus;
  decidedById: mongoose.Types.ObjectId | null;
  decidedAt: Date | null;
  decisionRemark: string;
  createdAt: Date;
  updatedAt: Date;
}

const LeaveRequestSchema = new Schema<ILeaveRequest>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    officeId: { type: Schema.Types.ObjectId, ref: 'Office', default: null },
    leaveType: { type: String, enum: ['CASUAL'], default: 'CASUAL' },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    partialDates: { type: [{ type: Date }], default: [] },
    days: { type: Number, default: 0 },
    reason: { type: String, default: '' },
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
      default: 'PENDING',
    },
    decidedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionRemark: { type: String, default: '' },
  },
  { timestamps: true },
);

// An employee's own timeline, and the approver's pending queue.
LeaveRequestSchema.index({ userId: 1, createdAt: -1 });
LeaveRequestSchema.index({ status: 1, fromDate: 1 });
// Balance math scans a person's approved days for a year.
LeaveRequestSchema.index({ userId: 1, status: 1, fromDate: 1 });

export const LeaveRequest =
  mongoose.models.LeaveRequest ||
  mongoose.model<ILeaveRequest>('LeaveRequest', LeaveRequestSchema);
