/**
 * RBAC seed — roles, permission rows and role grants ONLY.
 *
 * Deliberately does NOT create or modify users, passwords, application rows or the
 * assignee directory. This runs against production, where real accounts already
 * exist: the previous version upserted a named administrator with a hard-coded
 * password and forced status ACTIVE, which would have reset a live account.
 * Nothing here touches User records; re-running is safe and idempotent.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { Role } from '../models/Role';
import { Permission, RolePermission } from '../models/Permission';
import { User } from '../models/User';
import { CAPABILITIES, grantsByRole, capabilityKey } from '../config/capabilities';

dotenv.config();

export async function seedDatabase() {
  console.log('🌱 Seeding RBAC roles, permissions and grants (no users, no applications)...');

  await connectDB();

  // Name the target before anything is written, so a repointed MONGODB_URI cannot
  // silently seed the wrong database. Host and database name only - never credentials.
  const conn = mongoose.connection;
  console.log(`🔌 Target database: ${conn.name} @ ${conn.host}:${conn.port}`);

  // 1. Roles
  const rolesData = [
    { name: 'ADMIN', description: 'System Administrator with full access', isSystem: true },
    { name: 'CO', description: 'Commercial Officer (Full RFQ Access)', isSystem: true },
    { name: 'GM', description: 'General Manager (Full RFQ Access)', isSystem: true },
    { name: 'PRODUCTION_HEAD', description: 'Production Head (Full RFQ Access)', isSystem: true },
    { name: 'SALES_MARKETING', description: 'Sales & Marketing Specialist (Create/Edit RFQs, No Review)', isSystem: true },
    { name: 'TECHNICAL_PERSON', description: 'Technical Specialist (View & Upload Documents Only)', isSystem: true },
  ];

  const rolesMap: Record<string, any> = {};
  for (const r of rolesData) {
    // $setOnInsert: create the role if it is missing, but never overwrite one that
    // already exists — production descriptions may have been edited in the UI, and a
    // role you deliberately deleted must not come back on every seed.
    const role = await Role.findOneAndUpdate(
      { name: r.name },
      { $setOnInsert: { description: r.description, isSystem: r.isSystem } },
      { upsert: true, new: true }
    );
    rolesMap[r.name] = role._id;
  }
  console.log('✅ Ensured default Roles exist (existing ones left untouched)');

  // 2. Permissions — driven by the capability catalogue so the stored matrix, the
  // Roles page and the API checks can never drift apart.
  const permIdByKey = new Map<string, any>();
  for (const def of CAPABILITIES) {
    for (const act of def.actions) {
      const perm = await Permission.findOneAndUpdate(
        { module: def.module, action: act },
        { $setOnInsert: { description: `${act} on ${def.label}` } },
        { upsert: true, new: true }
      );
      permIdByKey.set(capabilityKey(def.module, act), perm._id);
    }
  }
  console.log(`✅ Created ${permIdByKey.size} permission rows from the capability catalogue`);

  // 3. Role grants — an exact per-role set, never a blanket "all permissions".
  // The previous version handed ADMIN, CO, GM and PRODUCTION_HEAD every row, which
  // made the matrix unenforceable for them and silently granted any capability added
  // later. legacyGrantTo in the catalogue encodes what each role actually could do.
  for (const [roleName, keys] of Object.entries(grantsByRole())) {
    const roleId = rolesMap[roleName];
    if (!roleId) continue;
    for (const key of keys) {
      const permissionId = permIdByKey.get(key);
      if (!permissionId) continue;
      await RolePermission.findOneAndUpdate(
        { roleId, permissionId },
        {},
        { upsert: true, new: true }
      );
    }
  }
  console.log('✅ Applied catalogue-driven role grants');

  // Read-only reassurance for whoever runs this against a live database: prove no
  // account was created or altered, and flag users whose roleId is empty (they would
  // resolve to no capabilities and see an empty interface after login).
  const userTotal = await User.countDocuments();
  const usersWithoutRole = await User.countDocuments({ $or: [{ roleId: null }, { roleId: { $exists: false } }] });
  console.log('ℹ️  Users, applications and the assignee directory were left untouched.');
  console.log(`ℹ️  Accounts in this database: ${userTotal} (${usersWithoutRole} without a role assignment).`);
  if (usersWithoutRole > 0) {
    console.log('   Those accounts need a role set on the Users page before the matrix applies to them.');
  }
}

if (require.main === module) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
