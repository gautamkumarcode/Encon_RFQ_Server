/**
 * rbac:sync — bring the permission matrix in line with the code catalogue.
 *
 * Safe by default: it only ADDS. It creates any missing Permission rows and grants
 * each role the capabilities it effectively holds today. It never revokes anything
 * unless you pass --revoke deliberately.
 *
 *   npm run rbac:sync           additive only (recommended first run)
 *   npm run rbac:sync -- --dry  print the plan, write nothing
 *   npm run rbac:sync -- --revoke  also drop grants the catalogue no longer gives
 *                                  a role (this removes access — read the diff first)
 *
 * Idempotent: re-running produces the same end state.
 */
import dotenv from 'dotenv';
import { connectDB } from '../config/db';
import { Role } from '../models/Role';
import { Permission, RolePermission } from '../models/Permission';
import {
  CAPABILITIES,
  grantsByRole,
  capabilityKey,
} from '../config/capabilities';

dotenv.config();

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const REVOKE = ARGS.includes('--revoke');

/** Modules the catalogue owns. --revoke only ever touches rows for these. */
const CATALOGUE_MODULES = new Set(CAPABILITIES.map((c) => c.module));

export async function syncCapabilities() {
  await connectDB();
  console.log(
    `🔐 RBAC sync — ${DRY ? 'DRY RUN (nothing will be written)' : 'applying'}${
      REVOKE ? ' incl. revocations' : ''
    }`,
  );

  // 1. Every capability key -> a Permission row.
  // A null id means "this row does not exist yet" — in --dry it stays null, so it
  // must never be passed to a query (mongoose casts permissionId to ObjectId and
  // throws on anything else).
  const permIds = new Map<string, any | null>();
  let created = 0;
  for (const def of CAPABILITIES) {
    for (const action of def.actions) {
      const key = capabilityKey(def.module, action);
      const existing = await Permission.findOne({ module: def.module, action });
      if (existing) {
        permIds.set(key, existing._id);
        continue;
      }
      created++;
      if (DRY) {
        permIds.set(key, null);
      } else {
        const row = await Permission.findOneAndUpdate(
          { module: def.module, action },
          { $setOnInsert: { description: `${action} on ${def.label}` } },
          { upsert: true, new: true },
        );
        permIds.set(key, row._id);
      }
    }
  }
  console.log(
    `   ${permIds.size} capability keys in catalogue, ${created} new Permission rows ${DRY ? 'would be ' : ''}created`,
  );

  // 2. Grants per role.
  const target = grantsByRole();
  let granted = 0;
  let revoked = 0;
  const missingRoles: string[] = [];

  for (const [roleName, keys] of Object.entries(target)) {
    const role = await Role.findOne({ name: roleName });
    if (!role) {
      // Custom roles created in the UI are intentionally left alone.
      missingRoles.push(roleName);
      continue;
    }

    const wantedIds = keys
      .map((k) => permIds.get(k))
      .filter((id: any) => !!id)
      .map((id: any) => String(id));
    const wantedIdSet = new Set(wantedIds);

    for (const key of keys) {
      const id = permIds.get(key);
      if (!id) {
        // Row will be created by this run; in --dry count it as a pending grant.
        granted++;
        continue;
      }
      const already = await RolePermission.findOne({ roleId: role._id, permissionId: id });
      if (!already) {
        if (!DRY) await RolePermission.create({ roleId: role._id, permissionId: id });
        granted++;
      }
    }

    if (REVOKE && roleName !== 'ADMIN') {
      const held = await RolePermission.find({ roleId: role._id }).populate('permissionId');
      for (const rp of held as any[]) {
        const p = rp.permissionId;
        if (!p || !CATALOGUE_MODULES.has(p.module)) continue; // never touch unknown modules
        if (wantedIdSet.has(String(p._id))) continue;
        if (!DRY) await RolePermission.deleteOne({ _id: rp._id });
        revoked++;
        console.log(`   − ${roleName}: ${p.module}:${p.action}`);
      }
    }

    console.log(`   ${roleName}: ${keys.length} capabilities targeted`);
  }

  if (missingRoles.length) {
    console.log(`   ⚠ skipped roles not found in the Role collection: ${missingRoles.join(', ')}`);
    console.log('     (create them on the Roles page, or check the exact spelling/case of the name)');
  }

  console.log(
    `✅ ${DRY ? 'Plan' : 'Sync'} complete — ${granted} grant${granted === 1 ? '' : 's'} added` +
      (REVOKE ? `, ${revoked} revoked` : ', nothing revoked'),
  );
  if (DRY) console.log('   Re-run without --dry to apply.');

  return { created, granted, revoked, missingRoles };
}

// Run only when invoked directly (so the API can import it too if needed).
if (require.main === module) {
  syncCapabilities()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('❌ RBAC sync failed:', e);
      process.exit(1);
    });
}
