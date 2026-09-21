import mongoose from 'mongoose';
import {
  PricingItem,
  PriceVersion,
  CostVersion,
  PricingRule,
  PricingCategory,
  PricingUnit,
  PricingSupplier,
  PricingCounter,
  reserveNextSequence,
  prefixForItemType,
} from './models';
import {
  ITEM_TYPES,
  ItemType,
  PriceType,
  PricingError,
  PRICING_NOT_CONFIGURED,
} from './pricing.types';

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

const escapeRegex = (s: string) => s.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');

function toObjectId(value?: string | null): mongoose.Types.ObjectId | null {
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

function buildMeta(page: number, limit: number, total: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

export interface CurrentPriceInfo {
  version: number;
  priceType: PriceType;
  unitPrice: number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  status: string;
  reason?: string;
  source?: string;
  createdBy?: string;
  createdAt?: Date;
}

export interface ItemListParams {
  search?: string;
  itemType?: string;
  categoryId?: string;
  supplierId?: string;
  isActive?: string;
  priceStatus?: string;
  sort?: string;
  order?: string;
  page?: string | number;
  limit?: string | number;
}

const ITEM_SORT_FIELDS = new Set([
  'code',
  'name',
  'itemType',
  'isActive',
  'createdAt',
  'updatedAt',
]);
const PRICE_SORT_FIELDS = new Set(['unitPrice', 'version', 'effectiveFrom', 'priceStatus']);

/* ─── Lookup masters (categories / units / suppliers) ──────────────────────── */

export async function listCategories() {
  return PricingCategory.find({}).sort({ name: 1 }).lean();
}

export async function listUnits() {
  return PricingUnit.find({}).sort({ name: 1 }).lean();
}

export async function listSuppliers() {
  return PricingSupplier.find({}).sort({ name: 1 }).lean();
}

export async function findOrCreateCategory(name: string) {
  const clean = name.trim();
  if (!clean) return null;
  const existing = await PricingCategory.findOne({ name: { $regex: `^${escapeRegex(clean)}$`, $options: 'i' } });
  if (existing) return existing;
  try {
    return await PricingCategory.create({ name: clean });
  } catch {
    // Race on unique index — return the winner
    return PricingCategory.findOne({ name: { $regex: `^${escapeRegex(clean)}$`, $options: 'i' } });
  }
}

export async function findOrCreateUnit(name: string) {
  const clean = name.trim().toUpperCase();
  if (!clean) return null;
  const existing = await PricingUnit.findOne({ name: clean });
  if (existing) return existing;
  try {
    return await PricingUnit.create({ name: clean });
  } catch {
    return PricingUnit.findOne({ name: clean });
  }
}

export async function findOrCreateSupplier(name: string) {
  const clean = name.trim();
  if (!clean) return null;
  const existing = await PricingSupplier.findOne({ name: { $regex: `^${escapeRegex(clean)}$`, $options: 'i' } });
  if (existing) return existing;
  try {
    return await PricingSupplier.create({ name: clean });
  } catch {
    return PricingSupplier.findOne({ name: { $regex: `^${escapeRegex(clean)}$`, $options: 'i' } });
  }
}

/* ─── Item codes ───────────────────────────────────────────────────────────── */

export async function nextCodeForItemType(itemType: ItemType): Promise<string> {
  const prefix = prefixForItemType(itemType);
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await reserveNextSequence(prefix);
    const code = `${prefix}-${String(seq).padStart(5, '0')}`;
    const clash = await PricingItem.findOne({ code }).lean();
    if (!clash) return code;
  }
  throw new PricingError('CODE_GENERATION_FAILED', 'Unable to generate a unique item code', 500);
}

/**
 * Peek at the next code WITHOUT reserving it — used for UI previews so that
 * merely opening the Add Item form never burns a sequence number. The number
 * is only consumed when the item is actually created.
 */
export async function peekNextCodeForItemType(itemType: ItemType): Promise<string> {
  const prefix = prefixForItemType(itemType);
  const counter: any = await PricingCounter.findOne({ key: prefix }).lean();
  let seq = (counter?.seq || 0) + 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `${prefix}-${String(seq).padStart(5, '0')}`;
    const clash = await PricingItem.findOne({ code }).lean();
    if (!clash) return code;
    seq += 1;
  }
  throw new PricingError('CODE_GENERATION_FAILED', 'Unable to determine the next item code', 500);
}

/* ─── Items ────────────────────────────────────────────────────────────────── */

export async function findItemByCode(code: string): Promise<any> {
  return PricingItem.findOne({ code: code.trim().toUpperCase() }).lean();
}

export async function findItemsByCodes(codes: string[]): Promise<any[]> {
  if (!codes.length) return [];
  return PricingItem.find({ code: { $in: codes.map((c) => c.trim().toUpperCase()) } }).lean();
}

export async function findItemsByLegacyRef(source: string, value: string): Promise<any> {
  return PricingItem.findOne({
    legacyReferences: { $elemMatch: { source, value } },
  }).lean();
}

export async function getItemById(id: string): Promise<any> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return PricingItem.findById(id)
    .populate('categoryId', 'name')
    .populate('subcategoryId', 'name')
    .populate('unitId', 'name')
    .populate('supplierId', 'name')
    .lean();
}

/**
 * Resolves an item by _id or by permanent code. Code lookup is the only
 * name-independent reference the pricing module ever performs.
 */
export async function resolveItem(ref: { itemId?: string; itemCode?: string }): Promise<any> {
  if (ref.itemId) {
    const item = await getItemById(ref.itemId);
    if (item) return item;
  }
  if (ref.itemCode) {
    const item = await findItemByCode(ref.itemCode);
    if (item) return item;
  }
  return null;
}

export async function createItemDoc(data: any) {
  return PricingItem.create(data);
}

export async function updateItemDoc(id: string, data: any) {
  return PricingItem.findByIdAndUpdate(id, data, { new: true })
    .populate('categoryId', 'name')
    .populate('subcategoryId', 'name')
    .populate('unitId', 'name')
    .populate('supplierId', 'name')
    .lean();
}

export async function itemCount(filter: any = {}) {
  return PricingItem.countDocuments(filter);
}

/**
 * Fetches the "current" ACTIVE price version for a set of items.
 * Current = status ACTIVE, effectiveFrom <= now, latest effectiveFrom then
 * highest version. Optionally restricted to a single priceType.
 */
export async function getActivePricesForItems(
  itemIds: (string | mongoose.Types.ObjectId)[],
  priceType?: PriceType
): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (!itemIds.length) return map;

  const filter: any = {
    pricingItemId: { $in: itemIds },
    status: 'ACTIVE',
    effectiveFrom: { $lte: new Date() },
  };
  if (priceType) filter.priceType = priceType;

  const versions = await PriceVersion.find(filter)
    .sort({ effectiveFrom: -1, version: -1 })
    .lean();

  for (const v of versions) {
    const key = v.pricingItemId.toString();
    if (!map.has(key)) map.set(key, v); // first hit per item is the current one
  }
  return map;
}

export async function getActivePrice(
  ref: { itemId?: string; itemCode?: string },
  priceType?: PriceType
): Promise<{ item: any; price: any } | null> {
  const item: any = await resolveItem(ref);
  if (!item) return null;
  const map = await getActivePricesForItems([item._id], priceType);
  const price = map.get(item._id.toString());
  if (!price) return null;
  return { item, price };
}

/** Item ids that currently have at least one ACTIVE price version */
export async function itemIdsWithActivePrice(): Promise<Set<string>> {
  const ids = await PriceVersion.distinct('pricingItemId', {
    status: 'ACTIVE',
    effectiveFrom: { $lte: new Date() },
  });
  return new Set(ids.map((id: any) => id.toString()));
}

const VALID_SORT_PRICE_STATUS: Record<string, number> = { MISSING: 0, ACTIVE: 1 };

export async function listItems(params: ItemListParams) {
  const page = Math.max(1, parseInt(String(params.page ?? 1), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(params.limit ?? 25), 10) || 25));

  const filter: any = {};
  if (params.itemType && (ITEM_TYPES as readonly string[]).includes(params.itemType)) {
    filter.itemType = params.itemType;
  }
  const categoryId = toObjectId(params.categoryId);
  if (categoryId) filter.categoryId = categoryId;
  const supplierId = toObjectId(params.supplierId);
  if (supplierId) filter.supplierId = supplierId;
  if (params.isActive === 'true' || params.isActive === 'false') {
    filter.isActive = params.isActive === 'true';
  }
  if (params.search && params.search.trim()) {
    const rx = new RegExp(escapeRegex(params.search.trim()), 'i');
    filter.$or = [{ code: rx }, { name: rx }, { manufacturer: rx }, { model: rx }];
  }

  let items: any[] = await PricingItem.find(filter).lean();

  // "Price Status" filter — needs the set of items that hold an active price
  const pricedIds = await itemIdsWithActivePrice();
  if (params.priceStatus === 'MISSING') {
    items = items.filter((i) => !pricedIds.has(i._id.toString()));
  } else if (params.priceStatus === 'ACTIVE') {
    items = items.filter((i) => pricedIds.has(i._id.toString()));
  }

  // Attach the current price for every matched item
  const priceMap = await getActivePricesForItems(items.map((i) => i._id));
  const [categories, units, suppliers] = await Promise.all([
    listCategories(),
    listUnits(),
    listSuppliers(),
  ]);
  const categoryMap = new Map(categories.map((c: any) => [c._id.toString(), c.name]));
  const unitMap = new Map(units.map((u: any) => [u._id.toString(), u.name]));
  const supplierMap = new Map(suppliers.map((s: any) => [s._id.toString(), s.name]));

  const rows = items.map((item) => {
    const price = priceMap.get(item._id.toString()) || null;
    return {
      id: item._id.toString(),
      code: item.code,
      name: item.name,
      itemType: item.itemType,
      category: item.categoryId ? categoryMap.get(item.categoryId.toString()) || '' : '',
      unit: item.unitId ? unitMap.get(item.unitId.toString()) || '' : '',
      supplier: item.supplierId ? supplierMap.get(item.supplierId.toString()) || '' : '',
      manufacturer: item.manufacturer || '',
      model: item.model || '',
      isActive: item.isActive,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      currentPrice: price
        ? {
            version: price.version,
            priceType: price.priceType,
            unitPrice: price.unitPrice,
            currency: price.currency,
            effectiveFrom: price.effectiveFrom,
            status: price.status,
          }
        : null,
    };
  });

  // Sorting — item fields in Mongo order, price fields in-memory
  const sortField = params.sort || 'code';
  const dir = params.order === 'desc' ? -1 : 1;
  if (PRICE_SORT_FIELDS.has(sortField)) {
    rows.sort((a: any, b: any) => {
      let va: any;
      let vb: any;
      if (sortField === 'priceStatus') {
        va = a.currentPrice ? 1 : 0;
        vb = b.currentPrice ? 1 : 0;
      } else {
        va = a.currentPrice ? a.currentPrice[sortField] : null;
        vb = b.currentPrice ? b.currentPrice[sortField] : null;
      }
      if (va === null || va === undefined) va = dir === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      if (vb === null || vb === undefined) vb = dir === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      if (va === vb) return a.code < b.code ? -1 : 1;
      return (va < vb ? -1 : 1) * dir;
    });
  } else if (ITEM_SORT_FIELDS.has(sortField)) {
    rows.sort((a: any, b: any) => {
      const va = a[sortField] ?? '';
      const vb = b[sortField] ?? '';
      if (va === vb) return 0;
      return (va < vb ? -1 : 1) * dir;
    });
  }

  const total = rows.length;
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit);

  return { items: pageRows, meta: buildMeta(page, limit, total) };
}

/* ─── Price versions ───────────────────────────────────────────────────────── */

export async function maxPriceVersion(itemId: string): Promise<number> {
  const latest: any = await PriceVersion.findOne({ pricingItemId: itemId }).sort({ version: -1 }).lean();
  return latest ? latest.version : 0;
}

export async function getPriceVersions(
  itemId: string,
  page = 1,
  limit = 50
): Promise<{ versions: any[]; meta: PaginationMeta }> {
  const total = await PriceVersion.countDocuments({ pricingItemId: itemId });
  const versions = await PriceVersion.find({ pricingItemId: itemId })
    .sort({ version: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  return { versions, meta: buildMeta(page, limit, total) };
}

export async function createPriceVersionDoc(data: any) {
  return PriceVersion.create(data);
}

export async function expireActivePrices(
  itemId: string,
  priceType: PriceType,
  effectiveTo: Date
) {
  await PriceVersion.updateMany(
    { pricingItemId: itemId, priceType, status: 'ACTIVE' },
    { $set: { status: 'EXPIRED', effectiveTo } }
  );
}

export async function getPriceVersion(itemId: string, version: number): Promise<any> {
  return PriceVersion.findOne({ pricingItemId: itemId, version }).lean();
}

/* ─── Cost versions ────────────────────────────────────────────────────────── */

export async function maxCostVersion(itemId: string): Promise<number> {
  const latest: any = await CostVersion.findOne({ pricingItemId: itemId }).sort({ version: -1 }).lean();
  return latest ? latest.version : 0;
}

export async function getCostVersions(
  itemId: string,
  page = 1,
  limit = 50
): Promise<{ versions: any[]; meta: PaginationMeta }> {
  const total = await CostVersion.countDocuments({ pricingItemId: itemId });
  const versions = await CostVersion.find({ pricingItemId: itemId })
    .sort({ version: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  return { versions, meta: buildMeta(page, limit, total) };
}

export async function getActiveCostVersion(itemId: string): Promise<any> {
  return CostVersion.findOne({
    pricingItemId: itemId,
    status: 'ACTIVE',
    effectiveFrom: { $lte: new Date() },
  })
    .sort({ effectiveFrom: -1, version: -1 })
    .lean();
}

/** Case-insensitive exact-name lookup used to link BOM lines to item masters. */
export async function findItemsByExactNames(names: string[]): Promise<any[]> {
  const unique = [...new Set(names.map((n) => (n || '').trim()).filter(Boolean))];
  if (!unique.length) return [];
  return PricingItem.find(
    { name: { $in: unique }, isActive: true },
    { name: 1, code: 1, itemType: 1 }
  )
    .collation({ locale: 'en', strength: 2 })
    .lean();
}

export async function createCostVersionDoc(data: any) {
  return CostVersion.create(data);
}

export async function expireActiveCosts(itemId: string, effectiveTo: Date) {
  await CostVersion.updateMany(
    { pricingItemId: itemId, status: 'ACTIVE' },
    { $set: { status: 'EXPIRED', effectiveTo } }
  );
}

/* ─── Pricing rules ────────────────────────────────────────────────────────── */

export async function listRules(params: { isActive?: string; appliesTo?: string; search?: string }) {
  const filter: any = {};
  if (params.isActive === 'true' || params.isActive === 'false') {
    filter.isActive = params.isActive === 'true';
  }
  if (params.appliesTo && ['ITEM', 'CATEGORY', 'GLOBAL'].includes(params.appliesTo)) {
    filter.appliesTo = params.appliesTo;
  }
  if (params.search && params.search.trim()) {
    filter.name = new RegExp(escapeRegex(params.search.trim()), 'i');
  }
  const rules: any[] = await PricingRule.find(filter).sort({ priority: -1, name: 1 }).lean();

  // Attach display names for item / category targets
  const itemIds = rules.filter((r: any) => r.itemId).map((r: any) => r.itemId);
  const categoryIds = rules.filter((r: any) => r.categoryId).map((r: any) => r.categoryId);
  const [ruleItems, ruleCategories] = await Promise.all([
    itemIds.length ? PricingItem.find({ _id: { $in: itemIds } }).select('code name').lean() : [],
    categoryIds.length ? PricingCategory.find({ _id: { $in: categoryIds } }).select('name').lean() : [],
  ]);
  const itemMap = new Map(ruleItems.map((i: any) => [i._id.toString(), i]));
  const categoryMap = new Map(ruleCategories.map((c: any) => [c._id.toString(), c.name]));

  return rules.map((r: any) => ({
    id: r._id.toString(),
    name: r.name,
    appliesTo: r.appliesTo,
    itemId: r.itemId ? r.itemId.toString() : null,
    itemName: r.itemId ? itemMap.get(r.itemId.toString())?.name || '' : null,
    itemCode: r.itemId ? itemMap.get(r.itemId.toString())?.code || '' : null,
    categoryId: r.categoryId ? r.categoryId.toString() : null,
    categoryName: r.categoryId ? categoryMap.get(r.categoryId.toString()) || '' : null,
    ruleType: r.ruleType,
    ruleValue: r.ruleValue,
    priority: r.priority,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isActive: r.isActive,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function createRuleDoc(data: any) {
  return PricingRule.create(data);
}

export async function updateRuleDoc(id: string, data: any): Promise<any> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return PricingRule.findByIdAndUpdate(id, data, { new: true }).lean();
}

export async function findRuleById(id: string): Promise<any> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return PricingRule.findById(id).lean();
}

/**
 * All rules applicable to an item right now: exact item match, category match
 * or global — active and within their effective window.
 */
export async function findApplicableRules(item: any, now = new Date()): Promise<any[]> {
  const filter: any = {
    isActive: true,
    $or: [
      { appliesTo: 'GLOBAL' },
      { appliesTo: 'ITEM', itemId: item._id },
      { appliesTo: 'CATEGORY', categoryId: item.categoryId },
    ],
  };
  const rules = await PricingRule.find(filter).lean();
  return rules.filter((r: any) => {
    if (r.effectiveFrom && new Date(r.effectiveFrom) > now) return false;
    if (r.effectiveTo && new Date(r.effectiveTo) < now) return false;
    return true;
  });
}

/* ─── Price history (global) ───────────────────────────────────────────────── */

export interface HistoryParams {
  from?: string;
  to?: string;
  search?: string;
  categoryId?: string;
  user?: string;
  page?: string | number;
  limit?: string | number;
}

export interface HistoryRow {
  id: string;
  itemCode: string;
  itemName: string;
  category: string;
  itemType: string;
  previousPrice: number | null;
  newPrice: number;
  currency: string;
  version: number;
  priceType: string;
  reason: string;
  changedBy: string;
  changedAt: Date;
  effectiveFrom: Date;
  status: string;
}

export async function historyRows(params: HistoryParams) {
  const page = Math.max(1, parseInt(String(params.page || '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(params.limit || '25'), 10) || 25));

  // Step 1 — resolve the item scope when searching / filtering by category
  let scopedItemIds: mongoose.Types.ObjectId[] | null = null;
  if (params.search?.trim() || params.categoryId) {
    const itemFilter: any = {};
    const categoryId = toObjectId(params.categoryId);
    if (categoryId) itemFilter.categoryId = categoryId;
    if (params.search?.trim()) {
      const rx = new RegExp(escapeRegex(params.search.trim()), 'i');
      itemFilter.$or = [{ code: rx }, { name: rx }];
    }
    const matched = await PricingItem.find(itemFilter).select('_id').lean();
    scopedItemIds = matched.map((m: any) => m._id);
    if (!scopedItemIds.length) {
      return { rows: [] as HistoryRow[], meta: buildMeta(page, limit, 0) };
    }
  }

  // Step 2 — query price versions
  const versionFilter: any = {};
  if (scopedItemIds) versionFilter.pricingItemId = { $in: scopedItemIds };
  if (params.user && params.user.trim()) versionFilter.createdBy = params.user.trim();
  const createdAt: any = {};
  if (params.from && !Number.isNaN(new Date(params.from).getTime())) {
    createdAt.$gte = new Date(params.from);
  }
  if (params.to && !Number.isNaN(new Date(params.to).getTime())) {
    createdAt.$lte = new Date(`${params.to.slice(0, 10)}T23:59:59.999Z`);
  }
  if (createdAt.$gte || createdAt.$lte) versionFilter.createdAt = createdAt;

  const total = await PriceVersion.countDocuments(versionFilter);
  const versions = await PriceVersion.find(versionFilter)
    .sort({ createdAt: -1, version: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  // Step 3 — attach item + previous-price context
  const itemIds = [...new Set(versions.map((v: any) => v.pricingItemId.toString()))];
  const items = itemIds.length
    ? await PricingItem.find({ _id: { $in: itemIds } }).lean()
    : [];
  const itemMap = new Map(items.map((i: any) => [i._id.toString(), i]));

  const categoryIds = [
    ...new Set(
      items
        .filter((i: any) => i.categoryId)
        .map((i: any) => i.categoryId.toString())
    ),
  ];
  const categories = categoryIds.length
    ? await PricingCategory.find({ _id: { $in: categoryIds } }).lean()
    : [];
  const categoryMap = new Map(categories.map((c: any) => [c._id.toString(), c.name]));

  // All versions of the involved items, grouped for previous-price lookup
  const allVersions = itemIds.length
    ? await PriceVersion.find({ pricingItemId: { $in: itemIds } })
        .sort({ version: 1 })
        .lean()
    : [];
  const versionsByItem = new Map<string, any[]>();
  for (const v of allVersions) {
    const key = v.pricingItemId.toString();
    const list = versionsByItem.get(key) || [];
    list.push(v);
    versionsByItem.set(key, list);
  }

  const rows: HistoryRow[] = versions.map((v: any) => {
    const item = itemMap.get(v.pricingItemId.toString());
    const predecessors = (versionsByItem.get(v.pricingItemId.toString()) || []).filter(
      (p: any) => p.priceType === v.priceType && p.version < v.version
    );
    const predecessor = predecessors.length
      ? predecessors[predecessors.length - 1]
      : null;

    return {
      id: v._id.toString(),
      itemId: item?._id?.toString() || '',
      itemCode: item?.code || '',
      itemName: item?.name || '',
      category: item?.categoryId ? categoryMap.get(item.categoryId.toString()) || '' : '',
      itemType: item?.itemType || '',
      previousPrice: predecessor ? predecessor.unitPrice : null,
      newPrice: v.unitPrice,
      currency: v.currency,
      version: v.version,
      priceType: v.priceType,
      reason: v.reason || '',
      changedBy: v.createdBy || '',
      changedAt: v.createdAt,
      effectiveFrom: v.effectiveFrom,
      status: v.status,
    };
  });

  return { rows, meta: buildMeta(page, limit, total) };
}

/* ─── Dashboard ────────────────────────────────────────────────────────────── */

export async function dashboardStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalItems, activeItems, byTypeAgg, pricedIds] = await Promise.all([
    PricingItem.countDocuments({}),
    PricingItem.countDocuments({ isActive: true }),
    PricingItem.aggregate([{ $group: { _id: '$itemType', count: { $sum: 1 } } }]),
    PriceVersion.distinct('pricingItemId', {
      status: 'ACTIVE',
      effectiveFrom: { $lte: now },
    }),
  ]);

  const pricedActiveItems = await PricingItem.countDocuments({
    isActive: true,
    _id: { $in: pricedIds },
  });
  const itemsWithoutPriceCount = Math.max(0, activeItems - pricedActiveItems);

  const byType: Record<string, number> = {};
  for (const entry of byTypeAgg as any[]) {
    byType[entry._id || 'UNKNOWN'] = entry.count;
  }

  const priceChangesThisMonth = await PriceVersion.countDocuments({
    createdAt: { $gte: startOfMonth },
  });

  const missingPricingItems = await PricingItem.find({
    isActive: true,
    _id: { $nin: pricedIds },
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  const recentChanges = await historyRows({ page: 1, limit: 10 });

  return {
    cards: {
      totalItems,
      activeItems,
      inactiveItems: totalItems - activeItems,
      itemsWithoutPrice: itemsWithoutPriceCount,
      priceChangesThisMonth,
      byType,
      products: byType.PRODUCT || 0,
      components: byType.COMPONENT || 0,
      assemblies: byType.ASSEMBLY || 0,
      rawMaterials: byType.RAW_MATERIAL || 0,
      spares: byType.SPARE || 0,
      services: byType.SERVICE || 0,
    },
    recentPriceChanges: recentChanges.rows,
    itemsWithMissingPricing: missingPricingItems.map((i: any) => ({
      id: i._id.toString(),
      code: i.code,
      name: i.name,
      itemType: i.itemType,
    })),
  };
}

/* ─── Export ───────────────────────────────────────────────────────────────── */

export async function exportRows() {
  const items = await PricingItem.find({}).lean();
  const priceMap = await getActivePricesForItems(items.map((i: any) => i._id));
  const [categories, units, suppliers] = await Promise.all([
    listCategories(),
    listUnits(),
    listSuppliers(),
  ]);
  const categoryMap = new Map(categories.map((c: any) => [c._id.toString(), c.name]));
  const unitMap = new Map(units.map((u: any) => [u._id.toString(), u.name]));
  const supplierMap = new Map(suppliers.map((s: any) => [s._id.toString(), s.name]));

  return items.map((item: any) => {
    const price = priceMap.get(item._id.toString());
    return {
      code: item.code,
      name: item.name,
      itemType: item.itemType,
      category: item.categoryId ? categoryMap.get(item.categoryId.toString()) || '' : '',
      unit: item.unitId ? unitMap.get(item.unitId.toString()) || '' : '',
      supplier: item.supplierId ? supplierMap.get(item.supplierId.toString()) || '' : '',
      manufacturer: item.manufacturer || '',
      model: item.model || '',
      specification: item.specifications || '',
      unitPrice: price ? price.unitPrice : '',
      currency: price ? price.currency : '',
      priceType: price ? price.priceType : '',
      version: price ? price.version : '',
      effectiveFrom: price ? price.effectiveFrom : '',
      priceStatus: price ? price.status : 'NOT_CONFIGURED',
      itemStatus: item.isActive ? 'ACTIVE' : 'INACTIVE',
      updatedAt: item.updatedAt,
    };
  });
}

export { PricingError, PRICING_NOT_CONFIGURED };
