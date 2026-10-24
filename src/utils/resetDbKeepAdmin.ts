import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { connectDB } from '../config/db';
import {
  Role,
  User,
  UserApplication,
  Enquiry,
  Attachment,
  ActivityLog,
  Notification,
  AssigneeEmail,
  RfqCounter,
  ProcessedMessage,
} from '../models';
import { confirmDestructiveRun } from './destructiveGuard';

dotenv.config();

async function resetDbKeepAdmin() {
  console.log('🧹 Starting Mongoose MongoDB cleanup (Keeping Roles & Admin login details)...');

  try {
    await connectDB();

    // 0. Refuse to run without --force. This one deletes real user accounts, so the
    // banner shows the target database before a single record is touched.
    await confirmDestructiveRun({
      script: 'reset-db-keep-admin',
      willDelete: [
        'every user NOT in the ADMIN role (accounts cannot be recovered)',
        'all enquiries, attachments, counters, inbox history, logs, notifications',
        'non-admin entries in the assignee directory',
        'all uploads/enquiries files on local disk',
      ],
      keep: ['roles and permission grants', 'ADMIN-role users'],
      counts: async () => [
        { label: 'users (total)', count: await User.countDocuments() },
        { label: 'enquiries', count: await Enquiry.countDocuments() },
        { label: 'attachments', count: await Attachment.countDocuments() },
        { label: 'processed messages', count: await ProcessedMessage.countDocuments() },
        { label: 'activity logs', count: await ActivityLog.countDocuments() },
      ],
    });

    // 1. Find ADMIN Role
    const adminRole: any = await Role.findOne({ name: 'ADMIN' });
    if (!adminRole) {
      throw new Error('ADMIN role not found in database! Aborting cleanup.');
    }

    // 2. Identify Admin User(s)
    const adminUsers: any[] = await User.find({ roleId: adminRole._id });

    console.log(`Found ${adminUsers.length} Admin user(s) to retain:`);
    adminUsers.forEach((u) => console.log(`  - ${u.name} (${u.email})`));

    const adminUserIds = adminUsers.map((u) => u._id);
    const adminEmails = adminUsers.map((u) => u.email.toLowerCase());

    // 3. Delete Non-Admin Users & Apps
    const deletedUserApps = await UserApplication.deleteMany({ userId: { $nin: adminUserIds } });
    console.log(`Deleted ${deletedUserApps.deletedCount} non-admin user application permissions.`);

    const deletedUsers = await User.deleteMany({ _id: { $nin: adminUserIds } });
    console.log(`Deleted ${deletedUsers.deletedCount} non-admin users.`);

    // 4. Delete Operational Collections
    const deletedAttachments = await Attachment.deleteMany({});
    console.log(`Deleted ${deletedAttachments.deletedCount} attachments.`);

    const deletedEnquiries = await Enquiry.deleteMany({});
    console.log(`Deleted ${deletedEnquiries.deletedCount} enquiries.`);

    const deletedMessages = await ProcessedMessage.deleteMany({});
    console.log(`Deleted ${deletedMessages.deletedCount} processed email messages.`);

    const deletedCounters = await RfqCounter.deleteMany({});
    console.log(`Deleted ${deletedCounters.deletedCount} RFQ serial counters.`);

    const deletedLogs = await ActivityLog.deleteMany({});
    console.log(`Deleted ${deletedLogs.deletedCount} activity logs.`);

    const deletedNotifications = await Notification.deleteMany({});
    console.log(`Deleted ${deletedNotifications.deletedCount} notifications.`);

    // 5. Clean AssigneeEmail directory to keep only Admin emails
    const deletedAssignees = await AssigneeEmail.deleteMany({ email: { $nin: adminEmails } });
    console.log(`Deleted ${deletedAssignees.deletedCount} non-admin assignee directory entries.`);

    // 6. Clean local disk upload folder
    const baseUploadDir = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
    const enquiriesUploadDir = path.join(baseUploadDir, 'enquiries');
    try {
      if (fs.existsSync(enquiriesUploadDir)) {
        fs.rmSync(enquiriesUploadDir, { recursive: true, force: true });
        fs.mkdirSync(enquiriesUploadDir, { recursive: true });
        fs.writeFileSync(path.join(enquiriesUploadDir, '.gitkeep'), '# Keeps enquiries directory visible\n');
        console.log('Cleared local uploads/enquiries folder.');
      }
    } catch (fsErr) {
      console.log('Skipped local disk file deletion');
    }

    // 7. Summary
    const remainingRolesCount = await Role.countDocuments();
    const remainingUsersCount = await User.countDocuments();
    console.log('\n==================================================');
    console.log(`✅ MongoDB Cleanup Complete!`);
    console.log(`   - Retained Roles: ${remainingRolesCount}`);
    console.log(`   - Retained Admin Users: ${remainingUsersCount}`);
    console.log('==================================================\n');
  } catch (error) {
    console.error('❌ Error during database cleanup:', error);
  } finally {
    process.exit(0);
  }
}

resetDbKeepAdmin();
