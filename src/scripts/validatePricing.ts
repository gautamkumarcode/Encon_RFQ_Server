/**
 * Phase-1 pricing migration — VALIDATION.
 * Verifies the invariants the spec demands, straight against the database:
 *   1. every migrated item has exactly one ACTIVE price of its priceType
 *   2. history items: v1 is EXPIRED with effectiveTo = v2.effectiveFrom - 1ms
 *   3. item codes follow the type prefix + zero-padded sequence
 *   4. exactly one ACTIVE GLOBAL markup rule (legacy ×1.8)
 *   5. pricingEngine: selling price = cost basis × rule for a sample item,
 *      and PRICING_NOT_CONFIGURED for an unpriced item
 *   6. no duplicated (source, value) legacyReferences
 *
 * Usage: npm run validate-pricing
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import {
  PricingItem,
  PriceVersion,
  CostVersion,
  PricingRule,
} from '../modules/pricing/models';
import * as engine from '../modules/pricing/pricingEngine';

async function main() {
  await connectDB();

  const failures: string[] = [];
  const ok = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  };

  const items: any[] = await PricingItem.find().lean<any>();
  console.log(`\nItems in pricing_items: ${items.length}`);

  // 1 + 2. active price / expiry chain
  // Phase-2 equipment BOM items (VLPH/HLPH, burner internal BOMs, BTF) carry a
  // cost version and deliberately NO price — legacy has no sell side for them.
  // Those are valid; an item with neither price nor cost is not.
  let migrated = 0;
  let costOnly = 0;
  const refKeys = new Set<string>();
  for (const item of items) {
    if ((item.legacyReferences || []).length > 0) migrated++;
    for (const ref of item.legacyReferences || []) {
      const key = `${ref.source}||${ref.value}`;
      if (refKeys.has(key)) failures.push(`duplicate legacyReference: ${key}`);
      refKeys.add(key);
    }

    const versions: any[] = await PriceVersion.find({ pricingItemId: item._id }).sort({ version: 1 }).lean<any>();
    const active = versions.filter((v) => v.status === 'ACTIVE');
    if (active.length === 0) {
      const hasCost = await CostVersion.exists({ pricingItemId: item._id, status: 'ACTIVE' });
      if (hasCost) {
        costOnly++;
        continue;
      }
      failures.push(`${item.code}: no ACTIVE price and no ACTIVE cost version`);
      continue;
    }
    if (active.length !== 1) {
      failures.push(`${item.code}: expected exactly 1 ACTIVE price, found ${active.length}`);
      continue;
    }
    if (versions.length > 1) {
      for (let i = 0; i < versions.length - 1; i++) {
        const v = versions[i];
        const next = versions[i + 1];
        if (v.status !== 'EXPIRED') {
          failures.push(`${item.code} v${v.version}: expected EXPIRED, got ${v.status}`);
        }
        const expectedTo = new Date(new Date(next.effectiveFrom).getTime() - 1);
        if (new Date(v.effectiveTo).getTime() !== expectedTo.getTime()) {
          failures.push(
            `${item.code} v${v.version}: effectiveTo ${v.effectiveTo?.toISOString()} != ${expectedTo.toISOString()}`
          );
        }
      }
    }
  }
  console.log(`Legacy-migrated items: ${migrated}; cost-only (BOM, no legacy sell side): ${costOnly}; checked for ${items.length}`);
  ok(failures.length === 0, `All items have exactly one ACTIVE price (or an ACTIVE cost BOM) and a valid expiry chain`);

  // 3. code shape
  const badCodes = items.filter((i) => !/^(CMP|PRD|ASM|RAW|SPR|SVC)-\d{5}$/.test(i.code));
  ok(badCodes.length === 0, `Item codes match <PREFIX>-<00000> (${badCodes.map((c) => c.code).join(', ') || 'all good'})`);

  // 4. rules
  const rules: any[] = await PricingRule.find().lean<any>();
  const activeGlobal = rules.filter((r) => r.isActive && r.appliesTo === 'GLOBAL');
  console.log(`Rules: ${rules.length} total, ${activeGlobal.length} ACTIVE GLOBAL`);
  ok(activeGlobal.length === 1, `Exactly one ACTIVE GLOBAL rule (found ${activeGlobal.length})`);
  if (activeGlobal.length === 1) {
    ok(
      activeGlobal[0].ruleType === 'MULTIPLIER' && activeGlobal[0].ruleValue === 1.8,
      `Active rule is the legacy MULTIPLIER ×1.8`
    );
  }

  // 5. engine math on a migrated item (uses active price as cost basis)
  const sample = items.find((i) => (i.legacyReferences || []).length > 0);
  if (sample) {
    const active = await PriceVersion.findOne({ pricingItemId: sample._id, status: 'ACTIVE' }).lean<any>();
    const calc: any = await engine.calculateSellingPrice({ itemId: sample._id.toString() });
    console.log(`\nEngine sample — ${sample.code} ${sample.name}`);
    console.log(`  active price: ${active.unitPrice} ${active.currency} (${active.priceType})`);
    console.log(`  cost basis: ${calc.costBasis} → markup ${calc.markupRule?.ruleValue} → selling ${calc.sellingPrice} (margin ${calc.margin})`);
    ok(
      Math.abs(calc.sellingPrice - active.unitPrice * 1.8) < 0.01,
      `sellingPrice = activePrice × 1.8`
    );
  }

  // 6. cost versions for pumping units
  const costs: any[] = await CostVersion.find().lean<any>();
  console.log(`\nCost versions: ${costs.length}`);

  // 7. counters consistent with highest code per prefix
  for (const prefix of ['CMP', 'PRD', 'RAW']) {
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    const max = items.reduce((m: number, i: any) => {
      const mm = i.code.match(re);
      return mm ? Math.max(m, parseInt(mm[1], 10)) : m;
    }, 0);
    const counter: any = await mongoose.connection
      .collection('pricing_counters')
      .findOne({ key: prefix });
    ok(
      max === 0 || (counter && counter.seq === max),
      `Counter ${prefix} seq=${counter?.seq ?? 'n/a'} consistent with highest code number ${max}`
    );
  }

  // 8. item with neither price nor cost — engine must throw PRICING_NOT_CONFIGURED.
  // Cost-only BOM items (Phase 2) are correctly priced FROM the cost basis, so
  // they must be excluded here.
  const unpricedItem = await PricingItem.findOne({
    _id: {
      $nin: [
        ...(await PriceVersion.distinct('pricingItemId')),
        ...(await CostVersion.distinct('pricingItemId', { status: 'ACTIVE' })),
      ],
    },
  }).lean<any>();
  if (unpricedItem) {
    let threw = '';
    try {
      await engine.calculateSellingPrice({ itemId: unpricedItem._id.toString() });
    } catch (err: any) {
      threw = err.code || '';
    }
    ok(threw === 'PRICING_NOT_CONFIGURED', `Unpriced item ${unpricedItem.code} throws PRICING_NOT_CONFIGURED (got '${threw}')`);
  } else {
    console.log('INFO  No unpriced item present to check PRICING_NOT_CONFIGURED path');
  }

  // 9. show the pre-existing non-migrated item, if any
  const nonLegacy = items.filter((i) => (i.legacyReferences || []).length === 0);
  for (const it of nonLegacy) {
    console.log(`INFO  Non-migrated item present: ${it.code} — ${it.name} (created ${it.createdAt?.toISOString?.()})`);
  }

  console.log('\n────────────────────────────────');
  if (failures.length === 0) {
    console.log('VALIDATION PASSED');
  } else {
    console.log(`VALIDATION FAILED — ${failures.length} issue(s):`);
    for (const f of failures) console.log(`  - ${f}`);
  }

  await mongoose.disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Validation crashed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
