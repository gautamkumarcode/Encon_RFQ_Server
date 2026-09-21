import mongoose, { Schema, Document } from 'mongoose';
import { ITEM_TYPE_PREFIX, ItemType } from '../pricing.types';

export interface IPricingCounter extends Document {
  key: string;
  seq: number;
}

const PricingCounterSchema = new Schema<IPricingCounter>(
  {
    key: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { collection: 'pricing_counters' }
);

PricingCounterSchema.index({ key: 1 }, { unique: true });

export const PricingCounter =
  mongoose.models.PricingCounter ||
  mongoose.model<IPricingCounter>('PricingCounter', PricingCounterSchema);

/**
 * Atomically reserves the next sequential number for an item type prefix
 * (e.g. COMPONENT -> CMP-00042). Never reuses numbers, so codes stay
 * permanently unique even if an item is later deactivated or deleted.
 */
export async function reserveNextSequence(prefix: string): Promise<number> {
  const counter = await PricingCounter.findOneAndUpdate(
    { key: prefix },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

export function prefixForItemType(itemType: ItemType): string {
  return ITEM_TYPE_PREFIX[itemType] || 'ITM';
}
