import mongoose, { Schema, Document } from 'mongoose';
import { RULE_APPLIES_TO, RULE_TYPES, RuleAppliesTo, RuleType } from '../pricing.types';

export interface IPricingRule extends Document {
  name: string;
  appliesTo: RuleAppliesTo;
  itemId?: mongoose.Types.ObjectId | null;
  categoryId?: mongoose.Types.ObjectId | null;
  ruleType: RuleType;
  ruleValue: number;
  priority: number;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  isActive: boolean;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PricingRuleSchema = new Schema<IPricingRule>(
  {
    name: { type: String, required: true, trim: true },
    appliesTo: { type: String, enum: RULE_APPLIES_TO, required: true, default: 'GLOBAL' },
    itemId: { type: Schema.Types.ObjectId, ref: 'PricingItem', default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: 'PricingCategory', default: null },
    ruleType: { type: String, enum: RULE_TYPES, required: true },
    ruleValue: { type: Number, required: true },
    priority: { type: Number, default: 0 },
    effectiveFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'pricing_rules' }
);

PricingRuleSchema.index({ appliesTo: 1, itemId: 1 });
PricingRuleSchema.index({ appliesTo: 1, categoryId: 1 });
PricingRuleSchema.index({ isActive: 1 });

export const PricingRule =
  mongoose.models.PricingRule || mongoose.model<IPricingRule>('PricingRule', PricingRuleSchema);
