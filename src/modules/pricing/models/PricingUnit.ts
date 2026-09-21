import mongoose, { Schema, Document } from 'mongoose';

export interface IPricingUnit extends Document {
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PricingUnitSchema = new Schema<IPricingUnit>(
  {
    name: { type: String, required: true, trim: true, uppercase: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'pricing_units' }
);

PricingUnitSchema.index({ name: 1 }, { unique: true });

export const PricingUnit =
  mongoose.models.PricingUnit || mongoose.model<IPricingUnit>('PricingUnit', PricingUnitSchema);
