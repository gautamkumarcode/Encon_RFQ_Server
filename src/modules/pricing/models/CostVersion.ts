import mongoose, { Schema, Document } from 'mongoose';
import { PRICE_STATUSES, PriceStatus } from '../pricing.types';

export interface ICostComponent {
  type: string;
  name: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

export interface ICostVersion extends Document {
  pricingItemId: mongoose.Types.ObjectId;
  version: number;
  components: ICostComponent[];
  totalCost: number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  status: PriceStatus;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CostComponentSchema = new Schema<ICostComponent>(
  {
    type: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0, default: 1 },
    unit: { type: String, default: 'NOS', trim: true, uppercase: true },
    rate: { type: Number, required: true, min: 0, default: 0 },
    amount: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false }
);

const CostVersionSchema = new Schema<ICostVersion>(
  {
    pricingItemId: { type: Schema.Types.ObjectId, ref: 'PricingItem', required: true },
    version: { type: Number, required: true, min: 1 },
    components: { type: [CostComponentSchema], default: [] },
    totalCost: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    status: { type: String, enum: PRICE_STATUSES, default: 'ACTIVE' },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'cost_versions' }
);

CostVersionSchema.index({ pricingItemId: 1, version: 1 }, { unique: true });
CostVersionSchema.index({ pricingItemId: 1, status: 1 });
CostVersionSchema.index({ createdAt: -1 });

export const CostVersion =
  mongoose.models.CostVersion || mongoose.model<ICostVersion>('CostVersion', CostVersionSchema);
