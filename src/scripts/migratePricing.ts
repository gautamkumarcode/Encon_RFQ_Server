/**
 * Phase-1 pricing migration — IMPORT.
 *
 * Reads scripts/pricing_migration_manifest.json (produced by the read-only
 * Python extractor over the legacy vlph.db) and loads it into MongoDB through
 * the pricing module service layer, so every row gets the same validation,
 * versioning and audit trail as a manual entry through the UI.
 *
 * Re-runnable: items whose legacyReferences already exist in the database are
 * skipped, so the script can be interrupted and resumed safely.
 *
 * Usage (from backend/):
 *   npm run migrate-pricing -- --dry-run       # report only, writes nothing
 *   npm run migrate-pricing -- --limit 20      # sample run (first 20 new items)
 *   npm run migrate-pricing                    # full run
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import * as pricing from '../modules/pricing/pricing.service';
import { PricingItem, PricingRule, PriceVersion, CostVersion } from '../modules/pricing/models';
import { logActivity } from '../utils/auditLogger';
import { CreateItemInput } from '../modules/pricing/pricing.types';

const MIGRATION_USER = { email: 'MIGRATION' };

interface ManifestPrice {
  priceType: string;
  unitPrice: number;
  currency: string;
  effectiveFrom: string;
  reason: string;
  previousPrice?: number;
  previousEffectiveFrom?: string;
}

interface ManifestCost {
  components: { type: string; name: string; quantity: number; unit: string; rate: number }[];
  effectiveFrom: string;
  notes?: string;
}

interface ManifestItem {
  name: string;
  itemType: string;
  categoryName?: string | null;
  unitName: string;
  supplierName?: string | null;
  specifications?: string | null;
  legacy: { source: string; value: string };
  price?: ManifestPrice;
  cost?: ManifestCost;
}

interface ManifestRule {
  name: string;
  ruleType: string;
  ruleValue: number;
  appliesTo: string;
  priority: number;
  isActive: boolean;
  legacy: string;
}

interface Manifest {
  generatedAt: string;
  counts: Record<string, number>;
  items: ManifestItem[];
  rules: ManifestRule[];
  duplicates: unknown[];
  skipped: unknown[];
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
    path.resolve(process.cwd(), 'scripts/pricing_migration_manifest.json'),
    path.resolve(__dirname, '../../scripts/pricing_migration_manifest.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as Manifest;
  }
  throw new Error(`Manifest not found — run the Python extractor first (looked in ${candidates.join(', ')})`);
}

const legacyKey = (ref: { source: string; value: string }) => `${ref.source}||${ref.value}`;

async function main() {
  const args = parseArgs();
  await connectDB();

  const manifest = loadManifest();
  console.log(`Manifest generated at: ${manifest.generatedAt} (${manifest.counts.items} items, ${manifest.counts.rules} rules)`);

  // ── Idempotency: legacy references already imported ────────────────────────
  const migrated = await PricingItem.find({ 'legacyReferences.0': { $exists: true } })
    .select('legacyReferences')
    .lean();
  const existingKeys = new Set<string>();
  for (const it of migrated) {
    for (const ref of (it as any).legacyReferences || []) existingKeys.add(legacyKey(ref));
  }
  const existingRuleNames = new Set<string>(
    (await PricingRule.find().select('name').lean()).map((r: any) => r.name)
  );

  const pending = manifest.items.filter((it) => !existingKeys.has(legacyKey(it.legacy)));
  console.log(`Items already migrated: ${manifest.items.length - pending.length}; pending: ${pending.length}`);
  if (args.limit > 0) {
    console.log(`Sample mode — limiting to ${args.limit} items`);
  }
  if (args.dryRun) console.log('DRY RUN — nothing will be written\n');

  const results = {
    created: 0,
    createdWithHistory: 0,
    createdWithCost: 0,
    skippedExisting: manifest.items.length - pending.length,
    errors: [] as { name: string; message: string }[],
    rulesCreated: 0,
    rulesSkipped: 0,
  };

  const batch = args.limit > 0 ? pending.slice(0, args.limit) : pending;

  for (let i = 0; i < batch.length; i++) {
    const m = batch[i];
    const no = `${i + 1}/${batch.length}`;
    try {
      const input: CreateItemInput = {
        name: m.name,
        itemType: m.itemType as CreateItemInput['itemType'],
        categoryName: m.categoryName || undefined,
        unitName: m.unitName,
        supplierName: m.supplierName || undefined,
        specifications: m.specifications || undefined,
        isPurchasable: true,
        isSellable: true,
        isActive: true,
        legacyReferences: [{ source: m.legacy.source, value: m.legacy.value }],
      };

      // With a preserved previous price, create the item unpriced and add both
      // versions after — v1 (historical) then v2 (current, expires v1).
      const hasHistory = !!(m.price && m.price.previousPrice !== undefined && m.price.previousEffectiveFrom);
      const initialPrice = m.price
        ? {
            unitPrice: m.price.unitPrice,
            priceType: m.price.priceType as any,
            currency: m.price.currency,
            effectiveFrom: m.price.effectiveFrom,
            reason: m.price.reason,
          }
        : undefined;

      if (args.dryRun) {
        results.created++;
        if (hasHistory) results.createdWithHistory++;
        if (m.cost) results.createdWithCost++;
        continue;
      }

      const created = await pricing.createItem(
        hasHistory ? input : { ...input, initialPrice },
        MIGRATION_USER,
        { skipActivityLog: true }
      );
      const itemId = created.item._id.toString();

      if (hasHistory && m.price) {
        await pricing.createPriceVersion(
          itemId,
          {
            unitPrice: m.price.previousPrice!,
            priceType: m.price.priceType as any,
            currency: m.price.currency,
            effectiveFrom: m.price.previousEffectiveFrom!,
            status: 'ACTIVE',
            reason: 'Migrated historical price (v1)',
          },
          MIGRATION_USER,
          { skipActivityLog: true }
        );
        await pricing.createPriceVersion(
          itemId,
          {
            unitPrice: m.price.unitPrice,
            priceType: m.price.priceType as any,
            currency: m.price.currency,
            effectiveFrom: m.price.effectiveFrom,
            status: 'ACTIVE',
            reason: m.price.reason,
          },
          MIGRATION_USER,
          { skipActivityLog: true }
        );
        results.createdWithHistory++;
      }

      if (m.cost) {
        await pricing.createCostVersion(
          itemId,
          {
            components: m.cost.components.map((c) => ({
              type: c.type,
              name: c.name,
              quantity: c.quantity,
              unit: c.unit,
              rate: c.rate,
            })),
            currency: 'INR',
            effectiveFrom: m.cost.effectiveFrom,
            status: 'ACTIVE',
          } as any,
          MIGRATION_USER
        );
        results.createdWithCost++;
      }

      results.created++;
      if ((i + 1) % 100 === 0) console.log(`  … ${no} done`);
    } catch (err: any) {
      results.errors.push({ name: m.name, message: err.message });
      console.error(`  ✗ ${no} ${m.name}: ${err.message}`);
    }
  }

  // ── Rules (idempotent by name) ─────────────────────────────────────────────
  for (const r of manifest.rules) {
    if (existingRuleNames.has(r.name)) {
      results.rulesSkipped++;
      continue;
    }
    if (args.dryRun) {
      results.rulesCreated++;
      continue;
    }
    try {
      await pricing.createRule(
        {
          name: r.name,
          appliesTo: 'GLOBAL',
          ruleType: r.ruleType as any,
          ruleValue: r.ruleValue,
          priority: r.priority,
          isActive: r.isActive,
        },
        MIGRATION_USER
      );
      results.rulesCreated++;
    } catch (err: any) {
      results.errors.push({ name: `RULE ${r.name}`, message: err.message });
      console.error(`  ✗ rule ${r.name}: ${err.message}`);
    }
  }

  // ── Validation snapshot (real counts from the database) ────────────────────
  const [itemCount, pricedCount, ruleCount, priceVersionCount, costVersionCount] = args.dryRun
    ? [0, 0, 0, 0, 0]
    : await Promise.all([
        PricingItem.countDocuments(),
        PricingItem.countDocuments({ isActive: true }),
        PricingRule.countDocuments(),
        PriceVersion.countDocuments(),
        CostVersion.countDocuments(),
      ]);

  console.log('\n──────── Migration summary ────────');
  console.log(JSON.stringify(results, null, 2));
  if (!args.dryRun) {
    console.log('\n──────── Database after migration ────────');
    console.log(`pricing_items:        ${itemCount}`);
    console.log(`price_versions:      ${priceVersionCount}`);
    console.log(`cost_versions:       ${costVersionCount}`);
    console.log(`pricing_rules:       ${ruleCount}`);
    console.log(
      `items missing price: ${Math.max(itemCount - pricedCount, 0)} (unpriced items correctly return PRICING_NOT_CONFIGURED)`
    );

    await logActivity({
      userEmail: 'MIGRATION',
      action: 'PRICING_LEGACY_MIGRATION_COMPLETED',
      details: { ...results, dryRun: false, manifestGeneratedAt: manifest.generatedAt },
    });
  }

  await mongoose.disconnect();
  process.exit(results.errors.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
