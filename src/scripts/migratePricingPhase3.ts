/**
 * Phase-3 pricing migration — burner-set bills of materials.
 *
 * The legacy burner pricelist priced every "… — BURNER SET" as the exact sum
 * of its sibling component rows. Phase 1 migrated those as flat PRODUCT
 * prices; this pass attaches the component breakdown as an ACTIVE
 * CostVersion, retypes the set item to ASSEMBLY, and adds the provenance
 * legacy reference.
 *
 * Finally, ASSEMBLY items that ended up with no ACTIVE cost version are
 * reverted to PRODUCT — the legacy sheets carry only a flat internal price
 * for them (ENCON 28/40 blowers, IAPL gas trains, ARE accessories/spares,
 * NIRMAL oxygen skids), so calling them assemblies would be misleading.
 *
 * Re-runnable: entries whose legacyReference already exists are skipped.
 *
 * Usage (from backend/):
 *   npm run migrate-pricing-phase3 -- --dry-run
 *   npm run migrate-pricing-phase3
 */
import * as fs from 'fs';
import * as path from 'path';
import { connectDB } from '../config/db';
import * as pricing from '../modules/pricing/pricing.service';
import { PricingItem, CostVersion } from '../modules/pricing/models';
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

interface ManifestEntry {
  name: string;
  itemType: string;
  categoryName?: string | null;
  unitName: string;
  supplierName?: string | null;
  specifications?: string | null;
  legacy: { source: string; value: string };
  link?: { exactNames?: string[] };
  cost?: { components: ManifestComponent[]; effectiveFrom: string; notes?: string } | null;
}

interface Manifest {
  generatedAt: string;
  equipments: ManifestEntry[];
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
    path.resolve(process.cwd(), 'scripts/pricing_phase3_manifest.json'),
    path.resolve(__dirname, '../../scripts/pricing_phase3_manifest.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as Manifest;
  }
  throw new Error(`Phase-3 manifest not found — run extract_pricing_phase3_manifest.py first (looked in ${candidates.join(', ')})`);
}

const legacyKey = (ref: { source: string; value: string }) => `${ref.source}||${ref.value}`;
const normName = (s: string) => s.trim().toLowerCase();

async function main() {
  const args = parseArgs();
  await connectDB();

  const manifest = loadManifest();
  console.log(`Phase-3 manifest generated at: ${manifest.generatedAt} (${manifest.equipments.length} burner-set BOMs)`);

  const items: any[] = await PricingItem.find().lean<any>();
  const existingKeys = new Set<string>();
  const byName = new Map<string, any[]>();
  for (const it of items) {
    for (const ref of it.legacyReferences || []) existingKeys.add(legacyKey(ref));
    const key = normName(it.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(it);
  }

  const results = {
    linked: 0,
    created: 0,
    notFound: [] as string[],
    retyped: 0,
    revertedToProduct: 0,
    skippedExisting: 0,
    errors: [] as { name: string; message: string }[],
  };

  let pending = manifest.equipments.filter((e) => !existingKeys.has(legacyKey(e.legacy)));
  results.skippedExisting = manifest.equipments.length - pending.length;
  if (args.limit) pending = pending.slice(0, args.limit);
  console.log(`Already migrated: ${results.skippedExisting}; pending: ${pending.length}${args.dryRun ? ' (DRY RUN)' : ''}\n`);

  for (const e of pending) {
    try {
      if (args.dryRun) {
        const target = (byName.get(normName(e.name)) || [])[0];
        console.log(`  would ${target ? 'link' : 'create'}: ${e.name} (${e.cost?.components.length} lines)`);
        continue;
      }

      let target = (byName.get(normName(e.name)) || []).slice().sort((a, b) => String(a.code).localeCompare(String(b.code)))[0];
      if (target) {
        // provenance ref (globally unique — first matching item only)
        await PricingItem.updateOne({ _id: target._id }, { $addToSet: { legacyReferences: { source: e.legacy.source, value: e.legacy.value } } as any });
        if (target.itemType !== 'ASSEMBLY') {
          await PricingItem.updateOne({ _id: target._id }, { $set: { itemType: 'ASSEMBLY' } });
          results.retyped++;
        }
        results.linked++;
      } else {
        const input: CreateItemInput = {
          name: e.name,
          itemType: 'ASSEMBLY',
          categoryName: e.categoryName || undefined,
          unitName: e.unitName,
          supplierName: e.supplierName || undefined,
          specifications: e.specifications || undefined,
          isPurchasable: true,
          isSellable: true,
          isActive: true,
          legacyReferences: [{ source: e.legacy.source, value: e.legacy.value }],
        };
        const created = await pricing.createItem(input, MIGRATION_USER, { skipActivityLog: true });
        target = created.item;
        results.created++;
      }

      if (e.cost?.components?.length) {
        await pricing.createCostVersion(
          target._id.toString(),
          {
            components: e.cost.components.map((c) => ({
              type: c.type || 'Buy',
              name: c.name,
              quantity: c.quantity,
              unit: c.unit || 'NOS',
              rate: c.rate,
            })),
            currency: 'INR',
            effectiveFrom: e.cost.effectiveFrom,
            status: 'ACTIVE',
          },
          MIGRATION_USER
        );
      }
      console.log(`  ✓ ${target.code} ${e.name} (${e.cost?.components.length} lines)`);
    } catch (err: any) {
      results.errors.push({ name: e.name, message: err.message });
      console.error(`  ✗ ${e.name}: ${err.message}`);
    }
  }

  // ── Honesty pass: an ASSEMBLY without a BOM is just a priced product ──────
  if (!args.dryRun) {
    const assemblies: any[] = await PricingItem.find({ itemType: 'ASSEMBLY' }).select('code name').lean();
    for (const it of assemblies) {
      const hasCost = await CostVersion.exists({ pricingItemId: it._id, status: 'ACTIVE' });
      if (!hasCost) {
        await PricingItem.updateOne({ _id: it._id }, { $set: { itemType: 'PRODUCT' } });
        results.revertedToProduct++;
      }
    }
  }

  console.log(
    `\nSummary: linked=${results.linked} created=${results.created} retyped-to-ASSEMBLY=${results.retyped} ` +
      `skipped-existing=${results.skippedExisting} reverted-to-PRODUCT=${results.revertedToProduct} errors=${results.errors.length}`
  );
  if (results.errors.length) console.log('Errors:', JSON.stringify(results.errors, null, 2));
  if (!args.dryRun) {
    await logActivity({
      userEmail: MIGRATION_USER.email,
      action: 'PRICING_LEGACY_MIGRATION_PHASE3_COMPLETED',
      details: { ...results, manifestGeneratedAt: manifest.generatedAt },
    });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
