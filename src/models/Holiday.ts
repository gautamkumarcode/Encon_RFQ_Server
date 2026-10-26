import mongoose, { Schema, Document } from 'mongoose';

/**
 * A company or branch-specific holiday. Shown in the attendance calendars
 * (admin register + employee app) so non-working days are self-explanatory.
 * `officeId = null` means the holiday applies to ALL branches.
 * `date` is normalized to UTC midnight, same convention as Attendance.date.
 */
export interface IHoliday extends Document {
  name: string;
  date: Date;
  officeId: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const HolidaySchema = new Schema<IHoliday>(
  {
    name: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    officeId: { type: Schema.Types.ObjectId, ref: 'Office', default: null },
  },
  { timestamps: true }
);

HolidaySchema.index({ date: 1 });
HolidaySchema.index({ officeId: 1, date: 1 });

export const Holiday =
  mongoose.models.Holiday ||
  mongoose.model<IHoliday>('Holiday', HolidaySchema);
