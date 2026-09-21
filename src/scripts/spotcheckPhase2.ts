/** Spot-check Phase-2 associations. Usage: npm run spotcheck-phase2 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { PricingItem, PriceVersion, CostVersion } from '../modules/pricing/models';

async function show(nameRegex: RegExp, label: string) {
  const item: any = await PricingItem.findOne({ name: nameRegex }).lean<any>();
  if (!item) return console.log(`${label}: NOT FOUND`);
  const price: any = await PriceVersion.findOne({ pricingItemId: item._id, status: 'ACTIVE' }).lean<any>();
  const cost: any = await CostVersion.findOne({ pricingItemId: item._id, status: 'ACTIVE' }).lean<any>();
  const versions = await CostVersion.countDocuments({ pricingItemId: item._id });
  console.log(
    `${label}\n  ${item.code} ${item.name} [${item.itemType}]  refs=${JSON.stringify(item.legacyReferences.map((r: any) => r.source))}` +
      `\n  active price: ${price ? price.unitPrice + ' ' + price.priceType : 'none (cost-only BOM)'}` +
      `\n  active cost: ${cost ? `${cost.totalCost} (${cost.components.length} BOM lines, v${cost.version} of ${versions})` : 'none'}` +
      `\n  first lines: ${cost ? cost.components.slice(0, 3).map((c: any) => `${c.name} ${c.quantity}${c.unit}×${c.rate}`).join(' | ') : '-'}`
  );
}

async function main() {
  await connectDB();
  await show(/^HPU 3kW Simplex/, 'HPU (BOM linked to Phase-1 sell-price item)');
  await show(/^Regen 500 kW$|^RBS/, 'Regen 500 kW (link by category+spec)');
  await show(/VLPH/, 'VLPH 10 ton (new cost-only BOM item)');
  await show(/^Recuperator 10 F/, 'Recuperator 10 F (new priced BOM item)');
  await show(/^Oil Burner 7A/, 'Oil Burner 7A internal BOM');
  const regen: any[] = await PricingItem.find({ 'legacyReferences.source': 'vlph.db/regen_costing_items' }).lean<any>();
  console.log(`Regen link check: ${regen.length} items carry the regen_costing_items ref`);
  for (const r of regen.slice(0, 8)) {
    const c: any = await CostVersion.findOne({ pricingItemId: r._id, status: 'ACTIVE' }).lean<any>();
    console.log(`  ${r.code} ${r.name} — cost ${c ? `${c.totalCost} (${c.components?.length} lines)` : 'none'}`);
  }
  await show(/pressure switch low/i, 'Pressure Switch Low (spare linked to existing component)');
  const counts = {
    items: await PricingItem.countDocuments(),
    withBomCost: (await CostVersion.distinct('pricingItemId', { status: 'ACTIVE' })).length,
    multiRefItems: await PricingItem.countDocuments({ 'legacyReferences.1': { $exists: true } }),
  };
  console.log('\nTotals:', counts);
  await mongoose.disconnect();
}
main().catch(() => process.exit(1));
