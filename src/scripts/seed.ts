import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { connectDB } from '../config/db';
import { Role } from '../models/Role';
import { Permission, RolePermission } from '../models/Permission';
import { Application, UserApplication } from '../models/Application';
import { User } from '../models/User';
import { AssigneeEmail } from '../models/AssigneeEmail';

dotenv.config();

export async function seedDatabase() {
  console.log('🌱 Starting Encon Command Center Mongoose MongoDB Seeding (ADMIN USER ONLY)...');

  await connectDB();

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
    const role = await Role.findOneAndUpdate(
      { name: r.name },
      { description: r.description, isSystem: r.isSystem },
      { upsert: true, new: true }
    );
    rolesMap[r.name] = role._id;
  }
  console.log('✅ Created default Roles');

  // 2. Permissions
  const modules = ['USER_MGMT', 'ROLE_MGMT', 'APP_MGMT', 'DASHBOARD', 'ANALYTICS', 'ACTIVITY_LOGS', 'NOTIFICATIONS', 'RFQ_MGMT'];
  const actions = ['READ', 'WRITE', 'DELETE', 'MANAGE'];

  for (const mod of modules) {
    for (const act of actions) {
      await Permission.findOneAndUpdate(
        { module: mod, action: act },
        { description: `Permission to ${act} in ${mod}` },
        { upsert: true, new: true }
      );
    }
  }
  console.log('✅ Created Permissions');

  const allPermissions = await Permission.find();
  const fullPermissionRoleNames = ['ADMIN', 'CO', 'GM', 'PRODUCTION_HEAD'];

  for (const roleName of fullPermissionRoleNames) {
    if (rolesMap[roleName]) {
      for (const perm of allPermissions) {
        await RolePermission.findOneAndUpdate(
          { roleId: rolesMap[roleName], permissionId: perm._id },
          {},
          { upsert: true, new: true }
        );
      }
    }
  }

  // 3. Applications
  const appData = {
    code: 'RFQ_AUTOMATION',
    name: 'Encon RFQ & Offer Automation System',
    description: 'Unified Request For Quotation lifecycle management, costing review, and offer generator.',
    category: 'CORE',
    baseUrl: 'http://localhost:3000/rfq',
    ssoEndpoint: 'http://localhost:3000/api/auth/sso',
    icon: 'file-text',
    status: 'ACTIVE',
  };

  const app = await Application.findOneAndUpdate({ code: appData.code }, appData, { upsert: true, new: true });

  // 4. Target Users (ADMIN ONLY)
  const passwordHash = await bcrypt.hash('Password12', 10);

  const targetUsers = [
    { name: 'Puneet Mahender', email: 'pm@encon.co.in', roleName: 'ADMIN' },
  ];

  // Remove non-admin users
  const adminRoleId = rolesMap['ADMIN'];
  const nonAdminUsers = await User.find({ roleId: { $ne: adminRoleId } });
  const nonAdminUserIds = nonAdminUsers.map((u) => u._id);

  if (nonAdminUserIds.length > 0) {
    await UserApplication.deleteMany({ userId: { $in: nonAdminUserIds } });
    await User.deleteMany({ _id: { $in: nonAdminUserIds } });
    console.log(`🧹 Removed ${nonAdminUserIds.length} non-admin users.`);
  }

  await AssigneeEmail.deleteMany({});

  for (const u of targetUsers) {
    const user: any = await User.findOneAndUpdate(
      { email: u.email.toLowerCase() },
      {
        name: u.name,
        email: u.email.toLowerCase(),
        passwordHash,
        roleId: rolesMap[u.roleName],
        status: 'ACTIVE',
      },
      { upsert: true, new: true }
    );

    await UserApplication.findOneAndUpdate(
      { userId: user._id, applicationId: app._id },
      { grantedBy: 'SYSTEM_SEED' },
      { upsert: true, new: true }
    );

    await AssigneeEmail.findOneAndUpdate(
      { name: u.name },
      { email: u.email.toLowerCase() },
      { upsert: true, new: true }
    );
  }

  console.log('✅ Seeded Admin User ONLY (pm@encon.co.in) successfully into MongoDB!');
}

if (require.main === module) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
