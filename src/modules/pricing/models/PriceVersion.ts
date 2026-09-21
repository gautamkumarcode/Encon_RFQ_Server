import mongoose, { Schema, Document } from 'mongoose';
import { PRICE_STATUSES, PRICE_TYPES, PriceStatus, PriceType } from '../pricing.types';

export interface IPriceVersion extends Document {
  pricingItemId: mongoose.Types.ObjectId;
  version: number;
  priceType: PriceType;
  unitPrice: number;
  currency: string;
  supplierId?: mongoose.Types.ObjectId | null;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  status: PriceStatus;
  source?: string;
  reason?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PriceVersionSchema = new Schema<IPriceVersion>(
  {
    pricingItemId: { type: Schema.Types.ObjectId, ref: 'PricingItem', required: true },
    version: { type: Number, required: true, min: 1 },
    priceType: { type: String, enum: PRICE_TYPES, required: true, default: 'COMPONENT' },
    unitPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'PricingSupplier', default: null },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    status: { type: String, enum: PRICE_STATUSES, default: 'ACTIVE' },
    source: { type: String, default: '', trim: true },
    reason: { type: String, default: '', trim: true },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'price_versions' }
);

// One row per (item, version) — version numbers are monotonic per item
PriceVersionSchema.index({ pricingItemId: 1, version: 1 }, { unique: true });
PriceVersionSchema.index({ pricingItemId: 1, status: 1, priceType: 1 });
PriceVersionSchema.index({ status: 1, effectiveFrom: 1 });
PriceVersionSchema.index({ createdAt: -1 });

export const PriceVersion =
  mongoose.models.PriceVersion ||
  mongoose.model<IPriceVersion>('PriceVersion', PriceVersionSchema);
