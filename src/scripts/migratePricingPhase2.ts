/**
 * Phase-2 pricing migration — EQUIPMENT BOMS & SPARES.
 *
 * Reads scripts/pricing_phase2_manifest.json (produced by the read-only
 * Python extractor over the legacy vlph.db) and associates each equipment
 * internal-BOM with the pricing items:
 *
 *  - If a matching item already exists (exact name, name prefix — e.g. the
 *    HPU items migrated from pumping_unit_price — or category + spec prefix
 *    — e.g. the regen pricelist items matched by kW), the BOM is attached to
 *    it as a new ACTIVE CostVersion (the previous lump-sum cost version is
 *    expired by the service layer) and the phase-2 legacy reference is added
 *    to the item for provenance and idempotency.
 *  - Otherwise a new PRODUCT item is created (with its REFERENCE price when
 *    the legacy sheet carries one) plus the CostVersion.
 *  - Spares (burner parts lists, VLPH spares, burner accessories) are created
 *    as SPARE/COMPONENT items with a PURCHASE price; a name clash with an
 *    existing priced item links instead of duplicating.
 *
 * Re-runnable: entries whose legacyReference already exists are skipped.
 *
 * Usage (from backend/):
 *   npm run migrate-pricing-phase2 -- --dry-run
 *   npm run migrate-pricing-phase2 -- --limit 20
 *   npm run migrate-pricing-phase2
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import * as pricing from '../modules/pricing/pricing.service';
import { PricingItem, PriceVersion, CostVersion, PricingCategory } from '../modules/pricing/models';
import { logActivity } from '../utils/auditLogger';
import { CreateItemInput } from '../modules/pricing/pricing.types';

const MIGRATION_USER = { email: 'MIGRATION' };

interface ManifestComponent {
  type: string;
  name: string;
  quantity: number;
  unit: string;
  rate: number;
}

interface ManifestPrice {
  unitPrice: number;
  priceType: string;
  effectiveFrom: string;
  reason: string;
}

interface ManifestEquipment {
  name: string;
  itemType: string;
  categoryName?: string | null;
  unitName: string;
  supplierName?: string | null;
  specifications?: string | null;
  legacy: { source: string; value: string };
  link?: {
    exactNames?: string[];
    prefixes?: string[];
    categorySpec?: { category: string; specPrefix: string };
  };
  price?: ManifestPrice | null;
  cost?: { components: ManifestComponent[]; effectiveFrom: string; notes?: string } | null;
}

interface Manifest {
  generatedAt: string;
  counts: Record<string, number>;
  equipments: ManifestEquipment[];
  spares: ManifestEquipment[];
}

function parseArgs() {
  const args = { dryRun: false, limit: 0 };
  for (const raw of process.argv.slice(2)) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--limit=')) args.limit = parseInt(raw.slice(8), 10) || 0;
    else if (raw === '--limit') args.limit = parseInt(process.argv[process.argv.indexOf(raw) + 1] || '', 10) || 0;
  }
  return args;
}

function loadManifest(): Manifest {
  const candidates = [
    path.resolve(process.cwd(), 'scripts/pricing_phase2_manifest.json'),
    path.resolve(__dirname, '../../scripts/pricing_phase2_manifest.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as Manifest;
  }
  throw new Error(`Phase-2 manifest not found — run extract_pricing_phase2_manifest.py first (looked in ${candidates.join(', ')})`);
}

const legacyKey = (ref: { source: string; value: string }) => `${ref.source}||${ref.value}`;
const normName = (s: string) => s.trim().toLowerCase();

async function main() {
  const args = parseArgs();
  await connectDB();

  const manifest = loadManifest();
  console.log(
    `Phase-2 manifest generated at: ${manifest.generatedAt} ` +
      `(${manifest.equipments.length} equipment BOMs, ${manifest.spares.length} spares)`
  );

  // ── Index existing items: legacy keys, name lookup, spec/category lookup ───
  const items: any[] = await PricingItem.find().lean<any>();
  const existingKeys = new Set<string>();
  const byName = new Map<string, any[]>();
  for (const it of items) {
    for (const ref of it.legacyReferences || []) existingKeys.add(legacyKey(ref));
    const key = normName(it.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(it);
  }
  const categories: any[] = await PricingCategory.find().lean<any>();
  const catIdByName = new Map(categories.map((c) => [normName(c.name), c._id.toString()]));

  // Which items already carry an ACTIVE price / any cost (avoid double pricing)
  const pricedItemIds = new Set((await PriceVersion.find({ status: 'ACTIVE' }).select('pricingItemId').lean<any>()).map((p: any) => p.pricingItemId.toString()));

  const results = {
    linked: 0,
    created: 0,
    costVersionsCreated: 0,
    pricesAdded: 0,
    pricesSkippedExisting: 0,
    sparesCreated: 0,
    skippedExisting: 0,
    errors: [] as { name: string; message: string }[],
  };

  const all = [
    ...manifest.equipments.map((e) => ({ kind: 'equipment' as const, e })),
    ...manifest.spares.map((e) => ({ kind: 'spare' as const, e })),
  ];
  const pending = all.filter(({ e }) => !existingKeys.has(legacyKey(e.legacy)));
  results.skippedExisting = all.length - pending.length;
  console.log(`Already migrated: ${results.skippedExisting}; pending: ${pending.length}`);
  if (args.dryRun) console.log('DRY RUN — nothing will be written\n');

  const batch = args.limit > 0 ? pending.slice(0, args.limit) : pending;

  /** Find existing items this manifest entry should attach to. */
  function resolveTargets(e: ManifestEquipment): any[] {
    const found: any[] = [];
    const push = (list: any[] | undefined) => list && found.push(...list);
    for (const n of e.link?.exactNames || []) push(byName.get(normName(n)));
    if (found.length === 0) {
      for (const [name, list] of byName) {
        for (const p of e.link?.prefixes || []) {
          if (name.startsWith(normName(p))) push(list);
        }
      }
    }
    if (found.length === 0 && e.link?.categorySpec) {
      const catId = catIdByName.get(normName(e.link.categorySpec.category));
      if (catId) {
        const prefix = normName(e.link.categorySpec.specPrefix);
        push(items.filter((it) => it.categoryId?.toString() === catId && normName(it.specifications || '').startsWith(prefix)));
      }
    }
    if (found.length === 0 && e.itemType !== 'COMPONENT') {
      // Even without declared link hints, never duplicate an existing item name.
      push(byName.get(normName(e.name)));
    }
    // de-duplicate by _id
    const uniq = new Map<string, any>();
    for (const f of found) uniq.set(f._id.toString(), f);
    return [...uniq.values()];
  }

  async function attachCost(itemId: string, e: ManifestEquipment) {
    if (!e.cost?.components?.length) return;
    await pricing.createCostVersion(
      itemId,
      {
        components: e.cost.components.map((c) => ({
          type: c.type || 'Material',
          name: c.name,
          quantity: c.quantity,
          unit: c.unit || 'NOS',
          rate: c.rate,
        })),
        currency: 'INR',
        effectiveFrom: e.cost.effectiveFrom,
        status: 'ACTIVE',
      } as any,
      MIGRATION_USER
    );
    results.costVersionsCreated++;
  }

  async function addLegacyRef(item: any, e: ManifestEquipment) {
    const key = legacyKey(e.legacy);
    const has = (item.legacyReferences || []).some((r: any) => legacyKey(r) === key);
    if (!has) {
      await PricingItem.updateOne(
        { _id: item._id },
        { $addToSet: { legacyReferences: { source: e.legacy.source, value: e.legacy.value } } as any }
      );
      item.legacyReferences = [...(item.legacyReferences || []), e.legacy];
    }
  }

  for (let i = 0; i < batch.length; i++) {
    const { kind, e } = batch[i];
    const no = `${i + 1}/${batch.length}`;
    try {
      const targets = args.dryRun ? [] : resolveTargets(e);

      if (args.dryRun) {
        // Dry-run reports the plan without DB mutations.
        const wouldLink =
          (e.link?.exactNames?.length || e.link?.prefixes?.length || e.link?.categorySpec) ? 'maybe' : 'no';
        results.created++;
        if (e.cost) results.costVersionsCreated++;
        console.log(`  [dry] ${no} ${kind}: ${e.name} (link: ${wouldLink}${e.cost ? `, BOM ${e.cost.components.length} lines` : ''}${e.price ? ', priced' : ''})`);
        continue;
      }

      if (targets.length > 0) {
        // ── Link to existing item(s) ─────────────────────────────────────────
        for (let ti = 0; ti < targets.length; ti++) {
          const t = targets[ti];
          // legacyReference must stay globally unique — when a name maps to
          // several same-named items (per-vendor duplicates from Phase 1), only
          // the primary target carries the provenance ref; the BOM/cost itself
          // is attached to every match.
          if (ti === 0) await addLegacyRef(t, e);
          if (e.price && !pricedItemIds.has(t._id.toString())) {
            await pricing.createPriceVersion(
              t._id.toString(),
              {
                unitPrice: e.price.unitPrice,
                priceType: e.price.priceType as any,
                currency: 'INR',
                effectiveFrom: e.price.effectiveFrom,
                status: 'ACTIVE',
                reason: e.price.reason,
              },
              MIGRATION_USER,
              { skipActivityLog: true }
            );
            pricedItemIds.add(t._id.toString());
            results.pricesAdded++;
          } else if (e.price) {
            results.pricesSkippedExisting++;
          }
          await attachCost(t._id.toString(), e);
        }
        results.linked++;
        if (kind === 'spare') results.sparesCreated++;
      } else {
        // ── Create a new item ────────────────────────────────────────────────
        const input: CreateItemInput = {
          name: e.name,
          itemType: e.itemType as CreateItemInput['itemType'],
          categoryName: e.categoryName || undefined,
          unitName: e.unitName,
          supplierName: e.supplierName || undefined,
          specifications: e.specifications || undefined,
          isPurchasable: true,
          isSellable: true,
          isActive: true,
          legacyReferences: [{ source: e.legacy.source, value: e.legacy.value }],
          initialPrice: e.price
            ? {
                unitPrice: e.price.unitPrice,
                priceType: e.price.priceType as any,
                currency: 'INR',
                effectiveFrom: e.price.effectiveFrom,
                reason: e.price.reason,
              }
            : undefined,
        };
        const created = await pricing.createItem(input, MIGRATION_USER, { skipActivityLog: true });
        if (e.price) pricedItemIds.add(created.item._id.toString());
        await attachCost(created.item._id.toString(), e);
        results.created++;
        if (kind === 'spare') results.sparesCreated++;
      }
      if ((i + 1) % 50 === 0) console.log(`  … ${no} done`);
    } catch (err: any) {
      results.errors.push({ name: e.name, message: err.message });
      console.error(`  ✗ ${no} ${e.name}: ${err.message}`);
    }
  }

  // ── Validation snapshot ────────────────────────────────────────────────────
  const [itemCount, priceVersionCount, costVersionCount, itemsWithActiveCost] = args.dryRun
    ? [0, 0, 0, 0]
    : await Promise.all([
        PricingItem.countDocuments(),
        PriceVersion.countDocuments(),
        CostVersion.countDocuments(),
        CostVersion.distinct('pricingItemId', { status: 'ACTIVE' }).then((ids) => ids.length),
      ]);

  console.log('\n──────── Phase-2 migration summary ────────');
  console.log(JSON.stringify(results, null, 2));
  if (!args.dryRun) {
    console.log('\n──────── Database after migration ────────');
    console.log(`pricing_items:        ${itemCount}`);
    console.log(`price_versions:       ${priceVersionCount}`);
    console.log(`cost_versions:        ${costVersionCount}`);
    console.log(`items with ACTIVE cost (BOM/priced breakdown): ${itemsWithActiveCost}`);

    await logActivity({
      userEmail: 'MIGRATION',
      action: 'PRICING_LEGACY_MIGRATION_PHASE2_COMPLETED',
      details: { ...results, dryRun: false, manifestGeneratedAt: manifest.generatedAt },
    });
  }

  await mongoose.disconnect();
  process.exit(results.errors.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Phase-2 migration failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
