import mongoose, { Schema, Document } from 'mongoose';

export interface IPricingCategory extends Document {
  name: string;
  parentCategoryId?: mongoose.Types.ObjectId | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PricingCategorySchema = new Schema<IPricingCategory>(
  {
    name: { type: String, required: true, trim: true },
    parentCategoryId: { type: Schema.Types.ObjectId, ref: 'PricingCategory', default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'pricing_categories' }
);

PricingCategorySchema.index({ name: 1 }, { unique: true });
PricingCategorySchema.index({ isActive: 1 });

export const PricingCategory =
  mongoose.models.PricingCategory ||
  mongoose.model<IPricingCategory>('PricingCategory', PricingCategorySchema);
