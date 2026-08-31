import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { connectDB } from '../config/db';
import { clearGoogleDriveData } from '../services/gdriveService';
import { Enquiry, Attachment, ActivityLog, Notification, User } from '../models';
import { ProcessedMessage, RfqCounter } from '../models/AssigneeEmail';

dotenv.config();

async function clearRfqData() {
  console.log('Starting complete database & Google Drive cleanup (preserving users & roles)...');

  try {
    await connectDB();

    // 1. Google Drive Cloud Cleanup
    console.log('Cleaning up Google Drive RFQ folders & files...');
    const driveRes = await clearGoogleDriveData();
    console.log(`Deleted ${driveRes.deletedCount} items from Google Drive.`);

    // 2. Database Cleanup
    const deletedAttachments = await Attachment.deleteMany({});
    console.log(`Deleted ${deletedAttachments.deletedCount} attachments.`);

    const deletedEnquiries = await Enquiry.deleteMany({});
    console.log(`Deleted ${deletedEnquiries.deletedCount} enquiries.`);

    const deletedMessages = await ProcessedMessage.deleteMany({});
    console.log(`Deleted ${deletedMessages.deletedCount} processed messages (inbox history).`);

    const deletedCounters = await RfqCounter.deleteMany({});
    console.log(`Deleted ${deletedCounters.deletedCount} RFQ counters.`);

    const deletedLogs = await ActivityLog.deleteMany({});
    console.log(`Deleted ${deletedLogs.deletedCount} activity log entries.`);

    const deletedNotifications = await Notification.deleteMany({});
    console.log(`Deleted ${deletedNotifications.deletedCount} notifications.`);

    // Clear disk files in uploads directory
    const baseUploadDir = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
    const enquiriesUploadDir = path.join(baseUploadDir, 'enquiries');
    try {
      if (fs.existsSync(enquiriesUploadDir)) {
        fs.rmSync(enquiriesUploadDir, { recursive: true, force: true });
        fs.mkdirSync(enquiriesUploadDir, { recursive: true });
        fs.writeFileSync(path.join(enquiriesUploadDir, '.gitkeep'), '# Keeps enquiries directory visible in VS Code Explorer\n');
        console.log('Cleared uploads/enquiries disk files.');
      }
    } catch (fsErr) {
      console.log('Skipped local disk file deletion (serverless environment)');
    }

    const userCount = await User.countDocuments();
    console.log(`✅ Preserved all ${userCount} users, roles, and assignee directory.`);
    console.log('Successfully cleared database operational data!');
  } catch (error) {
    console.error('Error clearing database data:', error);
  } finally {
    process.exit(0);
  }
}

clearRfqData();
