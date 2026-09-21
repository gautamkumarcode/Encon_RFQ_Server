/**
 * One-off repair: enforce global uniqueness of (source, value) legacy
 * references. The first Phase-2 run added the same provenance ref to two
 * same-named items (per-vendor duplicates from Phase 1); the migration script
 * is fixed, this cleans the data. The OLDEST item keeps the ref.
 *
 * Usage: npm run fix-phase2-dup-refs
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { PricingItem } from '../modules/pricing/models';

async function main() {
  await connectDB();
  const items: any[] = await PricingItem.find({ 'legacyReferences.0': { $exists: true } })
    .select('name legacyReferences createdAt')
    .sort({ createdAt: 1 })
    .lean<any>();

  const firstHolder = new Map<string, string>();
  let removed = 0;
  for (const it of items) {
    const keep: any[] = [];
    for (const ref of it.legacyReferences || []) {
      const key = `${ref.source}||${ref.value}`;
      const holder = firstHolder.get(key);
      if (!holder) {
        firstHolder.set(key, it._id.toString());
        keep.push(ref);
      } else if (holder !== it._id.toString()) {
        console.log(`Removing dup ref from ${it.code} (${it.name}): ${key}`);
        removed++;
      } else {
        keep.push(ref);
      }
    }
    if (keep.length !== (it.legacyReferences || []).length) {
      await PricingItem.updateOne({ _id: it._id }, { $set: { legacyReferences: keep } });
    }
  }
  console.log(removed === 0 ? 'No duplicate references found.' : `Removed ${removed} duplicate reference(s).`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Repair failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
