import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting Encon Command Center Database Seeding...');

  // 1. Roles
  const rolesData = [
    { name: 'ADMIN', description: 'System Administrator with full access', isSystem: true },
    { name: 'CO', description: 'Commercial Officer (Full RFQ Access)', isSystem: true },
    { name: 'GM', description: 'General Manager (Full RFQ Access)', isSystem: true },
    { name: 'PRODUCTION_HEAD', description: 'Production Head (Full RFQ Access)', isSystem: true },
    { name: 'SALES_MARKETING', description: 'Sales & Marketing Specialist (Create/Edit RFQs, No Review)', isSystem: true },
    { name: 'TECHNICAL_PERSON', description: 'Technical Specialist (View & Upload Documents Only)', isSystem: true },
  ];

  const rolesMap: Record<string, string> = {};
  for (const r of rolesData) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description },
      create: r,
    });
    rolesMap[r.name] = role.id;
  }
  console.log('✅ Created default Roles');

  // 2. Permissions
  const modules = ['USER_MGMT', 'ROLE_MGMT', 'APP_MGMT', 'DASHBOARD', 'ANALYTICS', 'ACTIVITY_LOGS', 'NOTIFICATIONS', 'RFQ_MGMT'];
  const actions = ['READ', 'WRITE', 'DELETE', 'MANAGE'];

  for (const mod of modules) {
    for (const act of actions) {
      await prisma.permission.upsert({
        where: { module_action: { module: mod, action: act } },
        update: {},
        create: {
          module: mod,
          action: act,
          description: `Permission to ${act} in ${mod}`,
        },
      });
    }
  }
  console.log('✅ Created Permissions');

  const allPermissions = await prisma.permission.findMany();
  
  // Map Admin, CO, GM, Production Head to all permissions
  const fullPermissionRoleNames = ['ADMIN', 'CO', 'GM', 'PRODUCTION_HEAD'];
  for (const roleName of fullPermissionRoleNames) {
    if (rolesMap[roleName]) {
      for (const perm of allPermissions) {
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: rolesMap[roleName],
              permissionId: perm.id,
            },
          },
          update: {},
          create: {
            roleId: rolesMap[roleName],
            permissionId: perm.id,
          },
        });
      }
    }
  }

  // 3. Applications
  const appsData = [
    {
      code: 'RFQ_AUTOMATION',
      name: 'Encon RFQ & Offer Automation System',
      description: 'Unified Request For Quotation lifecycle management, costing review, and offer generator.',
      category: 'CORE',
      baseUrl: 'http://localhost:3000/rfq',
      ssoEndpoint: 'http://localhost:3000/api/auth/sso',
      icon: 'file-text',
      status: 'ACTIVE',
    },
  ];

  const appsMap: Record<string, string> = {};
  for (const app of appsData) {
    const createdApp = await prisma.application.upsert({
      where: { code: app.code },
      update: { name: app.name, description: app.description, status: app.status },
      create: app,
    });
    appsMap[app.code] = createdApp.id;
  }

  // 4. Password Hash for Password12
  const passwordHash = await bcrypt.hash('Password12', 10);

  // Exact 13 Users specified by client mapped to new 6 roles
  const targetUsers = [
    { name: 'Puneet Mahender', email: 'pm@encon.co.in', roleName: 'ADMIN' },
    { name: 'Nutan Kumari', email: 'mdo@encon.co.in', roleName: 'CO' },
    { name: 'Jaswinder Pal Singh', email: 'vadodara@encon.co.in', roleName: 'GM' },
    { name: 'Dhananjay', email: 'fbd@encon.co.in', roleName: 'PRODUCTION_HEAD' },
    { name: 'Jyotirmoy Rabha', email: 'west@encon.co.in', roleName: 'SALES_MARKETING' },
    { name: 'Rajendran Krup', email: 'gr@encon.co.in', roleName: 'SALES_MARKETING' },
    { name: 'Shikha Sharma', email: 'shikha@encon.in', roleName: 'SALES_MARKETING' },
    { name: 'Akshit Personal', email: 'akshits200024@gmail.com', roleName: 'TECHNICAL_PERSON' },
    { name: 'Gautam Kumar', email: 'gkvc9696@gmail.com', roleName: 'TECHNICAL_PERSON' },
    { name: 'Krishna Kumar', email: 'kk@encon.co.in', roleName: 'TECHNICAL_PERSON' },
    { name: 'Rupanjana Mitra', email: 'process@encon.in', roleName: 'TECHNICAL_PERSON' },
    { name: 'RupaPersonal', email: 'mrupanjana@gmail.com', roleName: 'TECHNICAL_PERSON' },
    { name: 'Vijaya Prasad', email: 'vp@encon.in', roleName: 'TECHNICAL_PERSON' },
  ];

  const targetEmails = targetUsers.map((u) => u.email.toLowerCase());

  // REMOVE PREVIOUS UNRECOGNIZED USERS
  await prisma.userApplication.deleteMany({
    where: {
      user: {
        email: { notIn: targetEmails },
      },
    },
  });

  await prisma.user.deleteMany({
    where: {
      email: { notIn: targetEmails },
    },
  });
  console.log('✅ Cleaned up old demo users');

  // UPSERT TARGET USERS & ASSIGNEE DIRECTORY
  await prisma.assigneeEmail.deleteMany();

  for (const u of targetUsers) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        passwordHash,
        roleId: rolesMap[u.roleName],
        status: 'ACTIVE',
      },
      create: {
        name: u.name,
        email: u.email,
        passwordHash,
        roleId: rolesMap[u.roleName],
        status: 'ACTIVE',
      },
    });

    await prisma.userApplication.upsert({
      where: {
        userId_applicationId: {
          userId: user.id,
          applicationId: appsMap['RFQ_AUTOMATION'],
        },
      },
      update: {},
      create: {
        userId: user.id,
        applicationId: appsMap['RFQ_AUTOMATION'],
        grantedBy: 'SYSTEM_SEED',
      },
    });

    await prisma.assigneeEmail.upsert({
      where: { name: u.name },
      update: { email: u.email },
      create: { name: u.name, email: u.email },
    });
  }

  console.log('✅ Seeded 13 Encon Users successfully with Puneet Mahender as ADMIN!');
}

export async function seedDatabase() {
  await main();
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
