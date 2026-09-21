/**
 * Phase-2 follow-up: assembled equipment (items carrying a phase-2 equipment
 * legacy reference from pricing_phase2_manifest.json) are switched from
 * PRODUCT to ASSEMBLY so the item master reflects that they are built from a
 * bill of materials (their ACTIVE CostVersion).
 *
 * Spare items and plain products are untouched. Re-runnable (idempotent).
 *
 * Usage (from backend/):
 *   npm run set-assembly-type            # apply
 *   npm run set-assembly-type -- --dry-run
 */
import { connectDB } from '../config/db';
import { PricingItem, CostVersion } from '../modules/pricing/models';
import * as fs from 'fs';
import * as path from 'path';

interface ManifestEquipment {
  name: string;
  legacy: { source: string; value: string };
}

function loadManifest(): { equipments: ManifestEquipment[] } {
  const file = path.resolve(__dirname, '../../scripts/pricing_phase2_manifest.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await connectDB();

  const manifest = loadManifest();
  console.log(`Manifest: ${manifest.equipments.length} equipment entries${dryRun ? ' (DRY RUN)' : ''}`);

  let converted = 0;
  let alreadyAssembly = 0;
  let noBom = 0;
  for (const e of manifest.equipments) {
    const query = {
      itemType: 'PRODUCT',
      legacyReferences: { $elemMatch: { source: e.legacy.source, value: e.legacy.value } },
    };
    const count = await PricingItem.countDocuments(query);
    if (!count) {
      const isAssembly = await PricingItem.exists({
        itemType: 'ASSEMBLY',
        legacyReferences: { $elemMatch: { source: e.legacy.source, value: e.legacy.value } },
      });
      if (isAssembly) alreadyAssembly++;
      continue;
    }
    // Only an item that actually received a BOM is an assembly — legacy sheets
    // like blower_master / gas_train_master store a flat price with no parts.
    const candidate: any = await PricingItem.findOne(query).select('_id').lean();
    const hasBom = candidate && (await CostVersion.exists({ pricingItemId: candidate._id, status: 'ACTIVE' }));
    if (!hasBom) {
      noBom++;
      continue;
    }
    if (!dryRun) {
      await PricingItem.updateMany(query, { $set: { itemType: 'ASSEMBLY' } });
    }
    converted += count;
    console.log(`  ASSEMBLY: ${e.name}  (${e.legacy.source})`);
  }

  console.log(`\nConverted PRODUCT → ASSEMBLY: ${converted}`);
  console.log(`Already ASSEMBLY: ${alreadyAssembly}`);
  console.log(`Skipped (no BOM cost version in legacy): ${noBom}`);
  const totals = await PricingItem.aggregate([{ $group: { _id: '$itemType', n: { $sum: 1 } } }]);
  console.log('Item types now:', totals.map((t: any) => `${t._id}=${t.n}`).join(', '));
  if (dryRun) console.log('(dry run — nothing written)');

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
