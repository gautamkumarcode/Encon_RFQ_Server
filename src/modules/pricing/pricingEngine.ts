/**
 * pricingEngine — the single place where price / cost / markup math happens.
 *
 * Flow:  Purchase / Material Price  →  Internal Cost  →  Markup Rule  →  Selling Price
 *
 * All lookups use pricingItemId / itemCode — never item names.
 */
import * as repo from './pricing.repository';
import {
  PRICE_TYPES,
  PriceType,
  PricingError,
  PRICING_NOT_CONFIGURED,
} from './pricing.types';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Price-type preference when deriving internal cost from prices */
const COST_PRICE_PREFERENCE: PriceType[] = ['PURCHASE', 'MATERIAL', 'COMPONENT', 'REFERENCE'];

export async function getCurrentPrice(
  ref: { itemId?: string; itemCode?: string },
  priceType?: PriceType
) {
  const result = await repo.getActivePrice(ref, priceType);
  if (!result) {
    const label = ref.itemCode || ref.itemId || 'item';
    throw new PricingError(
      PRICING_NOT_CONFIGURED,
      `Pricing is not configured for item ${label}`
    );
  }
  return result;
}

export async function getPriceVersion(itemId: string, version: number) {
  const versionDoc = await repo.getPriceVersion(itemId, version);
  if (!versionDoc) {
    throw new PricingError('PRICE_VERSION_NOT_FOUND', `Price version ${version} not found`, 404);
  }
  return versionDoc;
}

export interface CostBreakdown {
  cost: number;
  currency: string;
  source: 'COST_VERSION' | 'PRICE_VERSION';
  costVersion?: number;
  priceType?: PriceType;
}

/**
 * Internal cost of an item: the ACTIVE cost version when one exists, otherwise
 * the best available purchase/material/component price.
 */
export async function calculateCost(itemId: string): Promise<CostBreakdown> {
  const costVersion = await repo.getActiveCostVersion(itemId);
  if (costVersion) {
    return {
      cost: round2(costVersion.totalCost),
      currency: costVersion.currency,
      source: 'COST_VERSION',
      costVersion: costVersion.version,
    };
  }

  for (const priceType of COST_PRICE_PREFERENCE) {
    const result = await repo.getActivePrice({ itemId }, priceType);
    if (result) {
      return {
        cost: round2(result.price.unitPrice),
        currency: result.price.currency,
        source: 'PRICE_VERSION',
        priceType,
      };
    }
  }

  const item = await repo.getItemById(itemId);
  throw new PricingError(
    PRICING_NOT_CONFIGURED,
    `Pricing is not configured for item ${item?.code || itemId}`
  );
}

export interface MarkupBreakdown {
  ruleId: string;
  ruleName: string;
  ruleType: string;
  ruleValue: number;
  appliesTo: string;
  priority: number;
  markupAmount: number;
}

const APPLIES_TO_WEIGHT: Record<string, number> = { ITEM: 3, CATEGORY: 2, GLOBAL: 1 };

/**
 * Resolves the single best markup rule for an item:
 * ITEM beats CATEGORY beats GLOBAL, then higher priority wins.
 */
export async function resolveMarkupRule(item: any) {
  const rules = await repo.findApplicableRules(item);
  if (!rules.length) return null;

  rules.sort((a: any, b: any) => {
    const w = (APPLIES_TO_WEIGHT[b.appliesTo] || 0) - (APPLIES_TO_WEIGHT[a.appliesTo] || 0);
    if (w !== 0) return w;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.name < b.name ? -1 : 1;
  });

  return rules[0];
}

/** Markup amount for a given cost according to the rule type */
export function markupAmountFor(ruleType: string, ruleValue: number, cost: number): number {
  if (ruleType === 'PERCENTAGE') return round2((cost * ruleValue) / 100);
  if (ruleType === 'FIXED') return round2(ruleValue);
  // MULTIPLIER — e.g. 1.8 on cost 100 → selling 180 → markup 80
  return round2(cost * (ruleValue - 1));
}

export async function calculateMarkup(itemId: string, cost: number): Promise<MarkupBreakdown | null> {
  const item = await repo.getItemById(itemId);
  if (!item) {
    throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);
  }
  const rule = await resolveMarkupRule(item);
  if (!rule) return null;

  return {
    ruleId: rule._id.toString(),
    ruleName: rule.name,
    ruleType: rule.ruleType,
    ruleValue: rule.ruleValue,
    appliesTo: rule.appliesTo,
    priority: rule.priority,
    markupAmount: markupAmountFor(rule.ruleType, rule.ruleValue, cost),
  };
}

export interface SellingPriceResult {
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  currency: string;
  cost: number;
  costSource: CostBreakdown['source'];
  costVersion?: number;
  priceType?: PriceType;
  markup: MarkupBreakdown | null;
  sellingPrice: number;
  margin: number; // percentage of selling price
}

export async function calculateSellingPrice(ref: {
  itemId?: string;
  itemCode?: string;
}): Promise<SellingPriceResult> {
  const item = await repo.resolveItem(ref);
  if (!item) {
    throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);
  }

  const cost = await calculateCost(item._id.toString());
  const markup = await calculateMarkup(item._id.toString(), cost.cost);

  const sellingPrice = markup ? round2(cost.cost + markup.markupAmount) : round2(cost.cost);
  const margin = sellingPrice > 0 ? round2((markup!.markupAmount / sellingPrice) * 100) : 0;

  return {
    itemId: item._id.toString(),
    itemCode: item.code,
    itemName: item.name,
    itemType: item.itemType,
    currency: cost.currency,
    cost: cost.cost,
    costSource: cost.source,
    costVersion: cost.costVersion,
    priceType: cost.priceType,
    markup,
    sellingPrice,
    margin,
  };
}

export { PRICE_TYPES };
