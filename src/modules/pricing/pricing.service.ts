/**
 * pricing.service — orchestration for the pricing module.
 * Controllers stay thin; the repository owns persistence and the
 * pricing engine owns price/cost/markup math.
 */
import * as repo from './pricing.repository';
import {
  PricingItem,
  PriceVersion,
  PricingRule,
} from './models';
import {
  COST_COMPONENT_TYPES,
  CURRENCIES,
  ITEM_TYPES,
  ITEM_TYPE_PREFIX,
  PRICE_STATUSES,
  PRICE_TYPES,
  RULE_APPLIES_TO,
  RULE_TYPES,
  ItemType,
  PriceType,
  PricingError,
  CreateItemInput,
  UpdateItemInput,
  CreatePriceInput,
  CreateCostInput,
  CreateRuleInput,
  UpdateRuleInput,
  ImportRow,
} from './pricing.types';
import * as engine from './pricingEngine';
import { logActivity } from '../../utils/auditLogger';

const round2 = (n: number) => Math.round(n * 100) / 100;

interface ActingUser {
  userId?: string;
  email?: string;
}

/* ─── Items ────────────────────────────────────────────────────────────────── */

export async function listItems(params: repo.ItemListParams) {
  return repo.listItems(params);
}

export async function getItemDetail(id: string) {
  const item = await repo.getItemById(id);
  if (!item) throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);

  const priceMap = await repo.getActivePricesForItems([item._id]);
  const currentPrice = priceMap.get(item._id.toString()) || null;

  const { versions, meta } = await repo.getPriceVersions(id, 1, 50);
  let costVersion = await repo.getActiveCostVersion(id);

  // Link free-text BOM lines back to item masters (case-insensitive exact name),
  // preferring part-like types over products/assemblies. Lines of "<prefix> — <set>"
  // items also try the sibling name "<prefix> — <line>" (e.g. burner-set BOM parts).
  if (costVersion?.components?.length) {
    const names = costVersion.components.map((c: any) => c.name);
    const dashSep = item.name.includes(' — ') ? ' — ' : item.name.includes(' - ') ? ' - ' : null;
    let derived: string[] = [];
    if (dashSep) {
      const prefix = item.name.split(dashSep)[0].trim();
      derived = names.map((n: string) => `${prefix}${dashSep}${String(n).trim()}`);
    }
    const matches = await repo.findItemsByExactNames([...names, ...derived]);
    const exact = new Map<string, any>();
    const preference: Record<string, number> = { COMPONENT: 0, SPARE: 1, RAW_MATERIAL: 2, SERVICE: 3, PRODUCT: 4, ASSEMBLY: 5 };
    const norm = (s: string) => String(s).trim().toLowerCase();
    for (const m of [...matches].sort(
      (a: any, b: any) => (preference[a.itemType] ?? 9) - (preference[b.itemType] ?? 9) || String(a.code).localeCompare(String(b.code))
    )) {
      const key = norm(m.name);
      if (!exact.has(key)) exact.set(key, { id: m._id.toString(), code: m.code, itemType: m.itemType });
    }
    const siblingPrefix = dashSep ? `${norm(item.name.split(dashSep)[0])}${dashSep}` : null;
    costVersion = {
      ...costVersion,
      components: costVersion.components.map((c: any) => ({
        ...c,
        matchedItem:
          exact.get(norm(c.name)) ||
          (siblingPrefix ? exact.get(`${siblingPrefix}${norm(c.name)}`) : null) ||
          null,
      })),
    };
  }

  let calculation: any = null;
  try {
    calculation = await engine.calculateSellingPrice({ itemId: id });
  } catch (err: any) {
    calculation = {
      error: err.code || 'CALCULATION_FAILED',
      message: err.message,
    };
  }

  return {
    item: {
      id: item._id.toString(),
      code: item.code,
      name: item.name,
      itemType: item.itemType,
      category: (item as any).categoryId?.name || '',
      categoryId: item.categoryId ? item.categoryId.toString() : null,
      unit: (item as any).unitId?.name || '',
      supplier: (item as any).supplierId?.name || '',
      manufacturer: item.manufacturer || '',
      model: item.model || '',
      description: item.description || '',
      specifications: item.specifications || '',
      isPurchasable: item.isPurchasable,
      isSellable: item.isSellable,
      isActive: item.isActive,
      legacyReferences: item.legacyReferences || [],
      createdBy: item.createdBy || '',
      updatedBy: item.updatedBy || '',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
    currentPrice: currentPrice
      ? {
          version: currentPrice.version,
          priceType: currentPrice.priceType,
          unitPrice: currentPrice.unitPrice,
          currency: currentPrice.currency,
          effectiveFrom: currentPrice.effectiveFrom,
          effectiveTo: currentPrice.effectiveTo,
          status: currentPrice.status,
          reason: currentPrice.reason || '',
          createdBy: currentPrice.createdBy || '',
        }
      : null,
    priceVersions: versions,
    priceVersionsMeta: meta,
    costVersion,
    calculation,
  };
}

export async function nextCode(itemType: string) {
  if (!(ITEM_TYPES as readonly string[]).includes(itemType as ItemType)) {
    throw new PricingError('INVALID_ITEM_TYPE', `Invalid item type '${itemType}'`, 400);
  }
  // Peek, don't reserve — the preview must not consume a sequence number.
  return { code: await repo.peekNextCodeForItemType(itemType as ItemType) };
}

async function resolveRefIds(input: {
  categoryId?: string | null;
  categoryName?: string;
  unitId?: string | null;
  unitName?: string;
  supplierId?: string | null;
  supplierName?: string;
}) {
  const resolved: any = {};

  if (input.categoryId !== undefined) resolved.categoryId = input.categoryId || null;
  if (input.categoryName) {
    const category = await repo.findOrCreateCategory(input.categoryName);
    if (category) resolved.categoryId = category._id;
  }
  if (input.categoryId === null && !input.categoryName) resolved.categoryId = null;

  if (input.unitId !== undefined) resolved.unitId = input.unitId || null;
  if (input.unitName) {
    const unit = await repo.findOrCreateUnit(input.unitName);
    if (unit) resolved.unitId = unit._id;
  }
  if (input.unitId === null && !input.unitName) resolved.unitId = null;

  if (input.supplierId !== undefined) resolved.supplierId = input.supplierId || null;
  if (input.supplierName) {
    const supplier = await repo.findOrCreateSupplier(input.supplierName);
    if (supplier) resolved.supplierId = supplier._id;
  }
  if (input.supplierId === null && !input.supplierName) resolved.supplierId = null;

  return resolved;
}

export async function createItem(
  input: CreateItemInput,
  user: ActingUser,
  options: { skipActivityLog?: boolean } = {}
) {
  const code = (input.code || '').trim().toUpperCase() || await repo.nextCodeForItemType(input.itemType);

  const existing = await repo.findItemByCode(code);
  if (existing) {
    throw new PricingError('ITEM_CODE_EXISTS', `Item code '${code}' already exists`, 400);
  }

  const refs = await resolveRefIds(input);

  const item = await repo.createItemDoc({
    code,
    name: input.name.trim(),
    itemType: input.itemType,
    ...refs,
    manufacturer: input.manufacturer || '',
    model: input.model || '',
    description: input.description || '',
    specifications: input.specifications || '',
    isPurchasable: input.isPurchasable ?? true,
    isSellable: input.isSellable ?? true,
    isActive: input.isActive ?? true,
    legacyReferences: input.legacyReferences || [],
    createdBy: user.email || 'SYSTEM',
    updatedBy: user.email || 'SYSTEM',
  });

  let priceVersion: any = null;
  if (input.initialPrice && input.initialPrice.unitPrice !== undefined) {
    priceVersion = await createPriceVersion(
      item._id.toString(),
      {
        unitPrice: input.initialPrice.unitPrice,
        priceType: input.initialPrice.priceType,
        currency: input.initialPrice.currency || 'INR',
        effectiveFrom: input.initialPrice.effectiveFrom,
        status: 'ACTIVE',
        reason: input.initialPrice.reason || 'Initial price',
      },
      user,
      { skipActivityLog: true }
    );
  }

  if (!options.skipActivityLog) {
    await logActivity({
      userId: user.userId,
      userEmail: user.email || 'SYSTEM',
      action: 'PRICING_ITEM_CREATED',
      details: { code: item.code, name: item.name, itemType: item.itemType },
    });
  }

  return { item: item.toObject(), priceVersion };
}

export async function updateItem(id: string, input: UpdateItemInput, user: ActingUser) {
  const item = await PricingItem.findById(id);
  if (!item) throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);

  if (input.code && input.code.trim().toUpperCase() !== item.code) {
    const newCode = input.code.trim().toUpperCase();
    const clash = await repo.findItemByCode(newCode);
    if (clash && clash._id.toString() !== id) {
      throw new PricingError('ITEM_CODE_EXISTS', `Item code '${newCode}' already exists`, 400);
    }
    item.code = newCode;
  }

  if (input.name) item.name = input.name.trim();
  if (input.itemType) item.itemType = input.itemType;
  if (input.manufacturer !== undefined) item.manufacturer = input.manufacturer;
  if (input.model !== undefined) item.model = input.model;
  if (input.description !== undefined) item.description = input.description;
  if (input.specifications !== undefined) item.specifications = input.specifications;
  if (input.isPurchasable !== undefined) item.isPurchasable = input.isPurchasable;
  if (input.isSellable !== undefined) item.isSellable = input.isSellable;
  if (input.isActive !== undefined) item.isActive = input.isActive;

  const refs = await resolveRefIds(input);
  if (refs.categoryId !== undefined) (item as any).categoryId = refs.categoryId;
  if (refs.unitId !== undefined) (item as any).unitId = refs.unitId;
  if (refs.supplierId !== undefined) (item as any).supplierId = refs.supplierId;

  item.updatedBy = user.email || 'SYSTEM';
  await item.save();

  await logActivity({
    userId: user.userId,
    userEmail: user.email || 'SYSTEM',
    action: 'PRICING_ITEM_UPDATED',
    details: { id, code: item.code, updates: input },
  });

  return repo.getItemById(id);
}

export async function deactivateItem(id: string, user: ActingUser) {
  const item = await PricingItem.findById(id);
  if (!item) throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);

  item.isActive = false;
  item.updatedBy = user.email || 'SYSTEM';
  await item.save();

  await logActivity({
    userId: user.userId,
    userEmail: user.email || 'SYSTEM',
    action: 'PRICING_ITEM_DEACTIVATED',
    details: { id, code: item.code, name: item.name },
  });

  return { id, code: item.code, isActive: false };
}

/* ─── Price versions ───────────────────────────────────────────────────────── */

export async function getPriceVersions(itemId: string, page = 1, limit = 50) {
  const item = await repo.getItemById(itemId);
  if (!item) throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);
  return repo.getPriceVersions(itemId, page, limit);
}

/**
 * Creates a NEW price version — the previous ACTIVE price of the same
 * priceType is expired, never overwritten.
 */
export async function createPriceVersion(
  itemId: string,
  input: CreatePriceInput,
  user: ActingUser,
  options: { skipActivityLog?: boolean } = {}
) {
  const item = await PricingItem.findById(itemId);
  if (!item) throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);

  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw new PricingError('INVALID_DATE', 'Invalid effectiveFrom date', 400);
  }

  const previous = (await repo.getActivePricesForItems([itemId], input.priceType)).get(itemId) || null;

  if (input.status === 'ACTIVE' && previous) {
    // Expire the outgoing price at the moment the new one takes over
    const effectiveTo = new Date(effectiveFrom.getTime() - 1);
    await repo.expireActivePrices(itemId, input.priceType, effectiveTo);
  }

  const version = (await repo.maxPriceVersion(itemId)) + 1;

  const created = await repo.createPriceVersionDoc({
    pricingItemId: item._id,
    version,
    priceType: input.priceType,
    unitPrice: input.unitPrice,
    currency: (input.currency || 'INR').toUpperCase(),
    supplierId: input.supplierId || (item as any).supplierId || null,
    effectiveFrom,
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
    status: input.status,
    source: input.source || '',
    reason: input.reason || '',
    createdBy: user.email || 'SYSTEM',
  });

  if (!options.skipActivityLog) {
    await logActivity({
      userId: user.userId,
      userEmail: user.email || 'SYSTEM',
      action: 'PRICING_PRICE_VERSION_CREATED',
      details: {
        itemId: item._id.toString(),
        itemCode: item.code,
        version,
        priceType: input.priceType,
        previousPrice: previous ? previous.unitPrice : null,
        newPrice: input.unitPrice,
        reason: input.reason || '',
      },
    });
  }

  return created.toObject();
}

/* ─── Cost versions ────────────────────────────────────────────────────────── */

export async function getCostVersions(itemId: string, page = 1, limit = 50) {
  const item = await repo.getItemById(itemId);
  if (!item) throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);
  return repo.getCostVersions(itemId, page, limit);
}

export async function createCostVersion(itemId: string, input: CreateCostInput, user: ActingUser) {
  const item = await PricingItem.findById(itemId);
  if (!item) throw new PricingError('ITEM_NOT_FOUND', 'Item not found', 404);

  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw new PricingError('INVALID_DATE', 'Invalid effectiveFrom date', 400);
  }

  // Server-side math is authoritative: quantity × rate = amount, Σ amount = totalCost
  const components = input.components.map((c) => ({
    type: c.type,
    name: c.name,
    quantity: c.quantity ?? 1,
    unit: (c.unit || 'NOS').toUpperCase(),
    rate: c.rate ?? 0,
    amount: round2((c.quantity ?? 1) * (c.rate ?? 0)),
  }));
  const totalCost = round2(components.reduce((sum, c) => sum + c.amount, 0));

  if (input.status === 'ACTIVE') {
    await repo.expireActiveCosts(itemId, new Date(effectiveFrom.getTime() - 1));
  }

  const version = (await repo.maxCostVersion(itemId)) + 1;
  const created = await repo.createCostVersionDoc({
    pricingItemId: item._id,
    version,
    components,
    totalCost,
    currency: (input.currency || 'INR').toUpperCase(),
    effectiveFrom,
    status: input.status,
    createdBy: user.email || 'SYSTEM',
  });

  await logActivity({
    userId: user.userId,
    userEmail: user.email || 'SYSTEM',
    action: 'PRICING_COST_VERSION_CREATED',
    details: {
      itemId: item._id.toString(),
      itemCode: item.code,
      version,
      totalCost,
      componentCount: components.length,
    },
  });

  return created.toObject();
}

/* ─── Rules ────────────────────────────────────────────────────────────────── */

export async function listRules(params: { isActive?: string; appliesTo?: string; search?: string }) {
  return repo.listRules(params);
}

export async function createRule(input: CreateRuleInput, user: ActingUser) {
  if (input.appliesTo === 'ITEM' && !input.itemId) {
    throw new PricingError('RULE_TARGET_REQUIRED', 'Item-specific rules require an item', 400);
  }
  if (input.appliesTo === 'CATEGORY' && !input.categoryId) {
    throw new PricingError('RULE_TARGET_REQUIRED', 'Category rules require a category', 400);
  }

  const rule = await repo.createRuleDoc({
    ...input,
    itemId: input.appliesTo === 'ITEM' ? input.itemId : null,
    categoryId: input.appliesTo === 'CATEGORY' ? input.categoryId : null,
    effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
    createdBy: user.email || 'SYSTEM',
  });

  await logActivity({
    userId: user.userId,
    userEmail: user.email || 'SYSTEM',
    action: 'PRICING_RULE_CREATED',
    details: { ruleId: rule._id.toString(), name: rule.name, ruleType: rule.ruleType, ruleValue: rule.ruleValue },
  });

  return rule.toObject();
}

export async function updateRule(id: string, input: UpdateRuleInput, user: ActingUser) {
  const existing = await repo.findRuleById(id);
  if (!existing) throw new PricingError('RULE_NOT_FOUND', 'Rule not found', 404);

  const appliesTo = input.appliesTo || existing.appliesTo;
  const payload: any = { ...input };
  if (input.effectiveFrom !== undefined) {
    payload.effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
  }
  if (input.effectiveTo !== undefined) {
    payload.effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
  }
  // Keep target fields consistent with the (possibly new) appliesTo scope
  if (appliesTo === 'ITEM') {
    payload.itemId = input.itemId ?? existing.itemId;
    payload.categoryId = null;
  } else if (appliesTo === 'CATEGORY') {
    payload.categoryId = input.categoryId ?? existing.categoryId;
    payload.itemId = null;
  } else {
    payload.itemId = null;
    payload.categoryId = null;
  }

  const updated = await repo.updateRuleDoc(id, { ...payload, __v: undefined });
  await logActivity({
    userId: user.userId,
    userEmail: user.email || 'SYSTEM',
    action: 'PRICING_RULE_UPDATED',
    details: { ruleId: id, updates: input },
  });

  return updated;
}

/* ─── Calculation / dashboard / history / meta ─────────────────────────────── */

export async function calculate(ref: { itemId?: string; itemCode?: string; priceType?: PriceType }) {
  if (ref.priceType) {
    return {
      price: await engine.getCurrentPrice(ref, ref.priceType),
      breakdown: await engine.calculateSellingPrice(ref),
    };
  }
  return { breakdown: await engine.calculateSellingPrice(ref) };
}

export async function dashboard() {
  return repo.dashboardStats();
}

export async function history(params: repo.HistoryParams) {
  return repo.historyRows(params);
}

export async function meta() {
  return {
    itemTypes: ITEM_TYPES,
    priceTypes: PRICE_TYPES,
    priceStatuses: PRICE_STATUSES,
    ruleTypes: RULE_TYPES,
    ruleAppliesTo: RULE_APPLIES_TO,
    costComponentTypes: COST_COMPONENT_TYPES,
    currencies: CURRENCIES,
    itemTypePrefixes: ITEM_TYPE_PREFIX,
  };
}

export async function lookup() {
  const [categories, units, suppliers] = await Promise.all([
    repo.listCategories(),
    repo.listUnits(),
    repo.listSuppliers(),
  ]);
  return { categories, units, suppliers };
}

/* ─── Export ───────────────────────────────────────────────────────────────── */

function csvEscape(value: any): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function exportCsv(): Promise<string> {
  const rows = await repo.exportRows();
  const header = [
    'itemCode',
    'name',
    'itemType',
    'category',
    'unit',
    'supplier',
    'manufacturer',
    'model',
    'specification',
    'unitPrice',
    'currency',
    'priceType',
    'version',
    'effectiveFrom',
    'priceStatus',
    'itemStatus',
    'updatedAt',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.code,
        row.name,
        row.itemType,
        row.category,
        row.unit,
        row.supplier,
        row.manufacturer,
        row.model,
        row.specification,
        row.unitPrice,
        row.currency,
        row.priceType,
        row.version,
        row.effectiveFrom ? new Date(row.effectiveFrom).toISOString().slice(0, 10) : '',
        row.priceStatus,
        row.itemStatus,
        row.updatedAt ? new Date(row.updatedAt).toISOString().slice(0, 10) : '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\r\n');
}

/* ─── Import (preview → explicit confirm → apply) ──────────────────────────── */

const ITEM_TYPE_ALIASES: Record<string, ItemType> = {
  COMPONENT: 'COMPONENT',
  PRODUCT: 'PRODUCT',
  ASSEMBLY: 'ASSEMBLY',
  RAW_MATERIAL: 'RAW_MATERIAL',
  RAWMATERIAL: 'RAW_MATERIAL',
  'RAW MATERIAL': 'RAW_MATERIAL',
  SPARE: 'SPARE',
  SERVICE: 'SERVICE',
};

function normalizeItemType(raw?: string): ItemType | null {
  if (!raw) return 'COMPONENT';
  const key = raw.trim().toUpperCase().replace(/[-]/g, ' ');
  return ITEM_TYPE_ALIASES[key] || null;
}

function normalizePriceType(raw?: string): PriceType {
  if (!raw) return 'COMPONENT';
  const key = raw.trim().toUpperCase();
  return (PRICE_TYPES as readonly string[]).includes(key) ? (key as PriceType) : 'COMPONENT';
}

export interface ImportAnalysis {
  summary: {
    totalRows: number;
    newItems: number;
    existingItems: number;
    priceChanges: number;
    duplicates: number;
    errors: number;
  };
  newItems: any[];
  existingItems: any[];
  priceChanges: any[];
  duplicates: any[];
  errors: any[];
}

/** Classifies every row — nothing is written. */
export async function analyzeImport(rows: ImportRow[]): Promise<ImportAnalysis> {
  const newItems: any[] = [];
  const existingItems: any[] = [];
  const priceChanges: any[] = [];
  const duplicates: any[] = [];
  const errors: any[] = [];

  const seenCodes = new Set<string>();
  const seenNameKeys = new Set<string>();

  const codes = rows
    .map((r) => r.itemCode?.trim().toUpperCase())
    .filter((c): c is string => Boolean(c));
  const existingItemsByCode = new Map<string, any>();
  for (const item of await repo.findItemsByCodes(codes)) {
    existingItemsByCode.set(item.code, item);
  }

  const existingIds = [...existingItemsByCode.values()].map((i) => i._id);
  const currentPriceMap = await repo.getActivePricesForItems(existingIds);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + 1;

    if (!row.name || !row.name.trim()) {
      errors.push({ row: rowNo, itemCode: row.itemCode || '', reason: 'Item name is required' });
      continue;
    }
    if (!row.unit || !row.unit.trim()) {
      errors.push({ row: rowNo, name: row.name, reason: 'Unit is required' });
      continue;
    }

    let unitPrice: number | null = null;
    if (row.unitPrice !== undefined && row.unitPrice !== null && String(row.unitPrice).trim() !== '') {
      unitPrice = Number(row.unitPrice);
      if (Number.isNaN(unitPrice) || unitPrice < 0) {
        errors.push({ row: rowNo, name: row.name, reason: `Invalid unit price '${row.unitPrice}'` });
        continue;
      }
    }

    const itemType = normalizeItemType(row.itemType);
    if (!itemType) {
      errors.push({
        row: rowNo,
        name: row.name,
        reason: `Unknown item type '${row.itemType}' (valid: ${ITEM_TYPES.join(', ')})`,
      });
      continue;
    }

    const code = row.itemCode?.trim().toUpperCase() || null;
    if (code) {
      if (seenCodes.has(code)) {
        duplicates.push({ row: rowNo, itemCode: code, reason: 'Duplicate item code in import file' });
        continue;
      }
      seenCodes.add(code);
    } else {
      const nameKey = `${row.name.trim().toLowerCase()}|${(row.category || '').trim().toLowerCase()}`;
      if (seenNameKeys.has(nameKey)) {
        duplicates.push({
          row: rowNo,
          name: row.name,
          reason: 'Duplicate item name + category in import file',
        });
        continue;
      }
      seenNameKeys.add(nameKey);
    }

    const normalized = {
      row: rowNo,
      itemCode: code,
      name: row.name.trim(),
      itemType,
      category: row.category?.trim() || '',
      unit: row.unit!.trim(),
      supplier: row.supplier?.trim() || '',
      manufacturer: row.manufacturer?.trim() || '',
      model: row.model?.trim() || '',
      specification: row.specification?.trim() || '',
      unitPrice,
      currency: (row.currency?.trim().toUpperCase()) || 'INR',
      priceType: normalizePriceType(row.priceType),
      effectiveFrom: row.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10),
      reason: row.reason?.trim() || '',
    };

    const existingItem = code ? existingItemsByCode.get(code) : null;
    if (existingItem) {
      const current = currentPriceMap.get(existingItem._id.toString()) || null;
      if (unitPrice !== null && current && current.unitPrice !== unitPrice) {
        priceChanges.push({
          ...normalized,
          existingItemId: existingItem._id.toString(),
          currentPrice: current.unitPrice,
          newPrice: unitPrice,
        });
      } else {
        existingItems.push({
          ...normalized,
          existingItemId: existingItem._id.toString(),
          currentPrice: current ? current.unitPrice : null,
          note: current ? 'No price change — will be skipped' : 'Item has no price yet — price will be added',
          willAddPrice: unitPrice !== null && !current,
        });
      }
    } else {
      newItems.push(normalized);
    }
  }

  return {
    summary: {
      totalRows: rows.length,
      newItems: newItems.length,
      existingItems: existingItems.length,
      priceChanges: priceChanges.length,
      duplicates: duplicates.length,
      errors: errors.length,
    },
    newItems,
    existingItems,
    priceChanges,
    duplicates,
    errors,
  };
}

export async function importPreview(rows: ImportRow[]) {
  return analyzeImport(rows);
}

/**
 * Applies an import. Classification is re-run server-side so the client can
 * never smuggle in an overwrite — only new items and explicit price changes
 * are written, and every write is a new version (never an update in place).
 */
export async function importCommit(rows: ImportRow[], user: ActingUser) {
  const analysis = await analyzeImport(rows);
  const results: any[] = [];

  for (const row of analysis.newItems) {
    try {
      const created = await createItem(
        {
          code: row.itemCode || undefined,
          name: row.name,
          itemType: row.itemType,
          categoryName: row.category || undefined,
          unitName: row.unit,
          supplierName: row.supplier || undefined,
          manufacturer: row.manufacturer,
          model: row.model,
          specifications: row.specification,
          isPurchasable: true,
          isSellable: true,
          isActive: true,
        },
        user
      );

      let price = null;
      if (row.unitPrice !== null && row.unitPrice !== undefined) {
        price = await createPriceVersion(
          created.item._id.toString(),
          {
            unitPrice: row.unitPrice,
            priceType: row.priceType,
            currency: row.currency,
            effectiveFrom: row.effectiveFrom,
            status: 'ACTIVE',
            reason: row.reason || 'Imported price',
          },
          user,
          { skipActivityLog: true }
        );
      }
      results.push({ row: row.row, itemCode: created.item.code, action: 'CREATED', itemId: created.item._id.toString() });
      void price;
    } catch (err: any) {
      results.push({ row: row.row, name: row.name, action: 'ERROR', message: err.message });
    }
  }

  for (const change of analysis.priceChanges) {
    try {
      const version = await createPriceVersion(
        change.existingItemId,
        {
          unitPrice: change.newPrice,
          priceType: change.priceType,
          currency: change.currency,
          effectiveFrom: change.effectiveFrom,
          status: 'ACTIVE',
          reason: change.reason || 'Imported price change',
        },
        user,
        { skipActivityLog: true }
      );
      results.push({ row: change.row, itemCode: change.itemCode, action: 'PRICE_UPDATED', version: version.version });
    } catch (err: any) {
      results.push({ row: change.row, itemCode: change.itemCode, action: 'ERROR', message: err.message });
    }
  }

  // Rows classified as "existing, add missing price" get their first price version
  for (const existing of analysis.existingItems.filter((e) => e.willAddPrice)) {
    try {
      const version = await createPriceVersion(
        existing.existingItemId,
        {
          unitPrice: existing.unitPrice,
          priceType: existing.priceType,
          currency: existing.currency,
          effectiveFrom: existing.effectiveFrom,
          status: 'ACTIVE',
          reason: existing.reason || 'Imported price',
        },
        user,
        { skipActivityLog: true }
      );
      results.push({ row: existing.row, itemCode: existing.itemCode, action: 'PRICE_ADDED', version: version.version });
    } catch (err: any) {
      results.push({ row: existing.row, itemCode: existing.itemCode, action: 'ERROR', message: err.message });
    }
  }

  const summary = {
    ...analysis.summary,
    applied: results.filter((r) => r.action !== 'ERROR').length,
    failed: results.filter((r) => r.action === 'ERROR').length,
  };

  await logActivity({
    userId: user.userId,
    userEmail: user.email || 'SYSTEM',
    action: 'PRICING_IMPORT_COMMITTED',
    details: summary,
  });

  return { summary, results, skipped: { duplicates: analysis.duplicates, errors: analysis.errors } };
}

/* Re-exported for the controller */
export { PricingRule, PriceVersion };
