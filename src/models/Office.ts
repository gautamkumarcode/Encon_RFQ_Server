import mongoose, { Schema, Document } from 'mongoose';

/**
 * A branch office / work location. Single-tenant (no organizationId) - Encon
 * owns all of these directly. Used by attendance for geofence validation and
 * working-hour / late-threshold rules.
 */
export interface IOffice extends Document {
  name: string;
  code: string;
  address: string;
  city: string;
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  } | null;
  geofenceRadiusMeters: number;
  timezone: string;
  workStart: string; // "HH:MM" 24h local
  workEnd: string; // "HH:MM" 24h local
  lateGraceMinutes: number;
  halfDayThresholdHours: number;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: Date;
  updatedAt: Date;
}

const OfficeSchema = new Schema<IOffice>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, default: '', uppercase: true, trim: true },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [lng, lat]
        default: undefined,
      },
    },
    geofenceRadiusMeters: { type: Number, default: 200 },
    timezone: { type: String, default: 'Asia/Kolkata' },
    workStart: { type: String, default: '09:30' },
    workEnd: { type: String, default: '18:30' },
    lateGraceMinutes: { type: Number, default: 15 },
    halfDayThresholdHours: { type: Number, default: 4 },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  },
  { timestamps: true }
);

// Only index when a location is present so offices without coordinates are fine.
OfficeSchema.index({ location: '2dsphere' }, { sparse: true });

export const Office =
  mongoose.models.Office || mongoose.model<IOffice>('Office', OfficeSchema);
