import { z } from 'zod';

/* ─── Enumerations (single source of truth for the pricing module) ─────────── */

export const ITEM_TYPES = [
  'COMPONENT',
  'PRODUCT',
  'ASSEMBLY',
  'RAW_MATERIAL',
  'SPARE',
  'SERVICE',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const PRICE_TYPES = ['PURCHASE', 'MATERIAL', 'COMPONENT', 'REFERENCE'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

export const PRICE_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'CANCELLED'] as const;
export type PriceStatus = (typeof PRICE_STATUSES)[number];

export const RULE_TYPES = ['PERCENTAGE', 'FIXED', 'MULTIPLIER'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_APPLIES_TO = ['ITEM', 'CATEGORY', 'GLOBAL'] as const;
export type RuleAppliesTo = (typeof RULE_APPLIES_TO)[number];

/** Supported cost component categories — served to the frontend via /api/pricing/meta */
export const COST_COMPONENT_TYPES = [
  'Material',
  'Labour',
  'Fabrication',
  'Electrical',
  'Engineering',
  'Testing',
  'Packing',
  'Freight',
  'Overhead',
  'Other',
] as const;
export type CostComponentType = (typeof COST_COMPONENT_TYPES)[number];

export const CURRENCIES = ['INR', 'USD', 'EUR'] as const;

/** Item code prefix per item type, e.g. COMPONENT -> CMP-00001 */
export const ITEM_TYPE_PREFIX: Record<ItemType, string> = {
  COMPONENT: 'CMP',
  PRODUCT: 'PRD',
  ASSEMBLY: 'ASM',
  RAW_MATERIAL: 'RAW',
  SPARE: 'SPR',
  SERVICE: 'SVC',
};

export const PRICING_NOT_CONFIGURED = 'PRICING_NOT_CONFIGURED';

/** Domain error carrying a machine-readable code (e.g. PRICING_NOT_CONFIGURED) */
export class PricingError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 422) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/* ─── Zod request schemas ──────────────────────────────────────────────────── */

const objectIdString = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

const dateString = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');

export const createItemSchema = z.object({
  code: z.string().trim().min(1, 'Item code is required').max(40).optional(),
  name: z.string().trim().min(1, 'Item name is required').max(300),
  itemType: z.enum(ITEM_TYPES).default('COMPONENT'),
  categoryId: objectIdString.optional(),
  categoryName: z.string().trim().min(1).max(120).optional(),
  subcategoryId: objectIdString.optional(),
  unitId: objectIdString.optional(),
  unitName: z.string().trim().min(1, 'Unit is required').max(30).optional(),
  supplierId: objectIdString.optional(),
  supplierName: z.string().trim().min(1).max(160).optional(),
  manufacturer: z.string().trim().max(160).optional(),
  model: z.string().trim().max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  specifications: z.string().trim().max(4000).optional(),
  isPurchasable: z.boolean().default(true),
  isSellable: z.boolean().default(true),
  isActive: z.boolean().default(true),
  // Migration-only: provenance back-links into the legacy system
  legacyReferences: z
    .array(z.object({ source: z.string().trim().max(120), value: z.string().trim().max(300) }))
    .max(10)
    .optional(),
  initialPrice: z
    .object({
      unitPrice: z.number().min(0, 'Unit price must be >= 0'),
      priceType: z.enum(PRICE_TYPES).default('COMPONENT'),
      currency: z.string().trim().default('INR'),
      effectiveFrom: dateString.optional(),
      reason: z.string().trim().max(500).optional(),
    })
    .optional(),
});

export const updateItemSchema = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(300).optional(),
  itemType: z.enum(ITEM_TYPES).optional(),
  categoryId: objectIdString.nullable().optional(),
  categoryName: z.string().trim().min(1).max(120).optional(),
  subcategoryId: objectIdString.nullable().optional(),
  unitId: objectIdString.nullable().optional(),
  unitName: z.string().trim().min(1).max(30).optional(),
  supplierId: objectIdString.nullable().optional(),
  supplierName: z.string().trim().min(1).max(160).optional(),
  manufacturer: z.string().trim().max(160).optional(),
  model: z.string().trim().max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  specifications: z.string().trim().max(4000).optional(),
  isPurchasable: z.boolean().optional(),
  isSellable: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const createPriceSchema = z.object({
  unitPrice: z.number().min(0, 'Unit price must be >= 0'),
  priceType: z.enum(PRICE_TYPES).default('COMPONENT'),
  currency: z.string().trim().default('INR'),
  supplierId: objectIdString.nullable().optional(),
  effectiveFrom: dateString.optional(),
  effectiveTo: dateString.nullable().optional(),
  status: z.enum(PRICE_STATUSES).default('ACTIVE'),
  source: z.string().trim().max(160).optional(),
  reason: z.string().trim().max(500).optional(),
});

export const createCostSchema = z.object({
  components: z
    .array(
      z.object({
        type: z.string().trim().min(1, 'Component type is required').max(60),
        name: z.string().trim().min(1, 'Component name is required').max(300),
        quantity: z.number().min(0).default(1),
        unit: z.string().trim().max(30).default('NOS'),
        rate: z.number().min(0).default(0),
      })
    )
    .min(1, 'At least one cost component is required'),
  currency: z.string().trim().default('INR'),
  effectiveFrom: dateString.optional(),
  status: z.enum(PRICE_STATUSES).default('ACTIVE'),
});

export const createRuleSchema = z.object({
  name: z.string().trim().min(1, 'Rule name is required').max(200),
  appliesTo: z.enum(RULE_APPLIES_TO),
  itemId: objectIdString.nullable().optional(),
  categoryId: objectIdString.nullable().optional(),
  ruleType: z.enum(RULE_TYPES),
  ruleValue: z.number(),
  priority: z.number().int().default(0),
  effectiveFrom: dateString.nullable().optional(),
  effectiveTo: dateString.nullable().optional(),
  isActive: z.boolean().default(true),
});

export const updateRuleSchema = createRuleSchema.partial();

export const calculateSchema = z
  .object({
    itemId: objectIdString.optional(),
    itemCode: z.string().trim().min(1).optional(),
    priceType: z.enum(PRICE_TYPES).optional(),
  })
  .refine((v) => v.itemId || v.itemCode, {
    message: 'itemId or itemCode is required',
  });

export const importRowSchema = z.object({
  itemCode: z.string().trim().max(40).optional(),
  name: z.string().trim().max(300),
  itemType: z.string().trim().max(40).optional(),
  category: z.string().trim().max(120).optional(),
  unit: z.string().trim().max(30).optional(),
  supplier: z.string().trim().max(160).optional(),
  manufacturer: z.string().trim().max(160).optional(),
  model: z.string().trim().max(160).optional(),
  specification: z.string().trim().max(4000).optional(),
  unitPrice: z.union([z.number(), z.string()]).optional(),
  currency: z.string().trim().max(10).optional(),
  priceType: z.string().trim().max(20).optional(),
  effectiveFrom: z.string().trim().max(40).optional(),
  reason: z.string().trim().max(500).optional(),
});

export const importPreviewSchema = z.object({
  rows: z.array(importRowSchema).min(1, 'At least one row is required').max(2000),
});

export const importCommitSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(2000),
  confirmed: z.literal(true, {
    errorMap: () => ({ message: 'Import must be explicitly confirmed after preview' }),
  }),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type CreatePriceInput = z.infer<typeof createPriceSchema>;
export type CreateCostInput = z.infer<typeof createCostSchema>;
export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
export type ImportRow = z.infer<typeof importRowSchema>;
