import mongoose, { Schema, Document } from 'mongoose';
import { ITEM_TYPES, ItemType } from '../pricing.types';

export interface ILegacyReference {
  source: string;
  value: string;
}

export interface IPricingItem extends Document {
  code: string;
  name: string;
  itemType: ItemType;
  categoryId?: mongoose.Types.ObjectId | null;
  subcategoryId?: mongoose.Types.ObjectId | null;
  unitId?: mongoose.Types.ObjectId | null;
  supplierId?: mongoose.Types.ObjectId | null;
  manufacturer?: string;
  // NOTE: the schema has a `model` string field, but mongoose's Document base
  // already declares a `model()` method, so a same-named interface field would
  // conflict (TS2353/TS2430). Access the field via (doc as any).model — the
  // repository layer works with `any`-typed lean docs anyway.
  description?: string;
  specifications?: string;
  isPurchasable: boolean;
  isSellable: boolean;
  isActive: boolean;
  legacyReferences: ILegacyReference[];
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PricingItemSchema = new Schema<IPricingItem>(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    itemType: { type: String, enum: ITEM_TYPES, required: true, default: 'COMPONENT' },
    categoryId: { type: Schema.Types.ObjectId, ref: 'PricingCategory', default: null },
    subcategoryId: { type: Schema.Types.ObjectId, ref: 'PricingCategory', default: null },
    unitId: { type: Schema.Types.ObjectId, ref: 'PricingUnit', default: null },
    supplierId: { type: Schema.Types.ObjectId, ref: 'PricingSupplier', default: null },
    manufacturer: { type: String, default: '', trim: true },
    description: { type: String, default: '', trim: true },
    specifications: { type: String, default: '', trim: true },
    isPurchasable: { type: Boolean, default: true },
    isSellable: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    legacyReferences: {
      type: [
        {
          source: { type: String, default: '' },
          value: { type: String, default: '' },
        },
      ],
      default: [],
    },
    createdBy: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'pricing_items' }
);

PricingItemSchema.index({ code: 1 }, { unique: true });
PricingItemSchema.index({ name: 1 });
PricingItemSchema.index({ itemType: 1 });
PricingItemSchema.index({ categoryId: 1 });
PricingItemSchema.index({ supplierId: 1 });
PricingItemSchema.index({ isActive: 1 });
PricingItemSchema.index({ createdAt: -1 });

// `model` is a plain string field in the collection, but it cannot be declared
// inside the definition object above: IPricingItem extends Document, whose base
// already exposes a `model()` method, so mongoose's SchemaDefinition type
// filters the key out (TS2353). Registering the path via schema.add() after
// construction sidesteps the clash — queries and documents still read/write
// the field normally; typed access goes through (doc as any).model.
PricingItemSchema.add({ model: { type: String, default: '', trim: true } } as any);

export const PricingItem =
  mongoose.models.PricingItem || mongoose.model<IPricingItem>('PricingItem', PricingItemSchema);
