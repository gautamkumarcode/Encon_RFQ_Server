import mongoose, { Schema, Document } from 'mongoose';

export interface IPricingSupplier extends Document {
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PricingSupplierSchema = new Schema<IPricingSupplier>(
  {
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'pricing_suppliers' }
);

PricingSupplierSchema.index({ name: 1 }, { unique: true });

export const PricingSupplier =
  mongoose.models.PricingSupplier ||
  mongoose.model<IPricingSupplier>('PricingSupplier', PricingSupplierSchema);
