import dotenv from 'dotenv';
import { connectDB } from '../config/db';
import '../models';
import { ActivityLog } from '../models/ActivityLog';
import { Enquiry } from '../models/Enquiry';
import { User } from '../models/User';
import { Role } from '../models/Role';
import { AssigneeEmail } from '../models/AssigneeEmail';
import bcrypt from 'bcryptjs';

dotenv.config();

async function recoverUsers() {
  await connectDB();

  const passwordHash = await bcrypt.hash('Password12', 10);

  // Fetch Roles
  const roles = await Role.find().lean();
  const rolesMap: Record<string, any> = {};
  roles.forEach((r: any) => {
    rolesMap[r.name] = r._id;
  });

  const adminRoleId = rolesMap['ADMIN'];
  const salesRoleId = rolesMap['SALES_MARKETING'] || rolesMap['SALES'] || adminRoleId;
  const techRoleId = rolesMap['TECHNICAL_PERSON'] || adminRoleId;
  const coRoleId = rolesMap['CO'] || adminRoleId;
  const gmRoleId = rolesMap['GM'] || adminRoleId;

  const usersToRestore = [
    { name: 'Vijay Prasad', email: 'vp@encon.co.in', roleId: gmRoleId },
    { name: 'Shikha Sharma', email: 'shikha@encon.co.in', roleId: coRoleId },
    { name: 'Nutan Kumari', email: 'mdo@encon.co.in', roleId: adminRoleId },
    { name: 'RFQ Mailbox Account', email: 'rfq@encon.co.in', roleId: adminRoleId },
    { name: 'KK', email: 'kk@encon.co.in', roleId: techRoleId },
    { name: 'Dhananjay', email: 'fbd@encon.co.in', roleId: techRoleId },
    { name: 'Rajendran Krup', email: 'gr@encon.co.in', roleId: salesRoleId },
    { name: "B. Prasad ", email: "bp@encon.co.in", roleId: salesRoleId },
    { name: "Gautam Kumar", email: "software@encon.in", roleId: techRoleId }

  ];

  console.log('--- RESTORING USER ACCOUNTS INTO MONGO DB ---');

  for (const u of usersToRestore) {
    const user: any = await User.findOneAndUpdate(
      { email: u.email.toLowerCase() },
      {
        name: u.name,
        email: u.email.toLowerCase(),
        passwordHash,
        roleId: u.roleId,
        status: 'ACTIVE',
      },
      { upsert: true, new: true }
    );

    await AssigneeEmail.findOneAndUpdate(
      { name: u.name },
      { email: u.email.toLowerCase() },
      { upsert: true, new: true }
    );

    console.log(`✅ Restored user: ${user.name} (${user.email})`);
  }

  const finalUsers = await User.find().populate('roleId').lean();
  console.log(`\n🎉 Total users now in DB: ${finalUsers.length}`);

  process.exit(0);
}

recoverUsers().catch((e) => {
  console.error(e);
  process.exit(1);
});
