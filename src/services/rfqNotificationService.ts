import { Enquiry } from '../models/Enquiry';
import { User } from '../models/User';
import { AssigneeEmail } from '../models/AssigneeEmail';
import { Notification } from '../models/Notification';
import { sendTatExpiredReminderEmail } from './emailService';

// Track sent reminder timestamps in-memory to prevent spamming emails on every poll
const lastReminderSentMap = new Map<string, number>();
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

async function resolveEmailForAssignee(nameOrEmail?: string): Promise<string> {
  if (!nameOrEmail) return '';
  const trimmed = nameOrEmail.trim();
  if (trimmed.includes('@')) return trimmed;

  const user: any = await User.findOne({ name: { $regex: new RegExp(`^${trimmed}$`, 'i') } }).lean();
  if (user && user.email) return user.email;

  const assignee: any = await AssigneeEmail.findOne({ name: { $regex: new RegExp(`^${trimmed}$`, 'i') } }).lean();
  if (assignee && assignee.email) return assignee.email;

  return '';
}

export class RfqNotificationService {
  /**
   * Scan MongoDB for RFQs where TAT deadline has expired or is due today,
   * send reminder emails to assigned technical/sales leads, and create in-app notifications.
   */
  public static async checkAndSendTatReminders(): Promise<number> {
    try {
      const activeEnquiries: any[] = await Enquiry.find({
        status: { $nin: ['Approved', 'Offer Sent', 'PO Received', 'Closed', 'REGRET'] },
      }).lean();

      let remindersCount = 0;
      const now = Date.now();

      for (const e of activeEnquiries) {
        const baseDateStr = e.assignedDate || e.dateReceived || e.receivedOn || e.createdAt;
        if (!baseDateStr) continue;

        const baseDate = new Date(baseDateStr);
        if (isNaN(baseDate.getTime())) continue;

        const diffTime = Math.max(0, now - baseDate.getTime());
        const daysOpen = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        const tat = parseInt(e.tat || '30', 10);

        if (daysOpen >= tat) {
          const cacheKey = `tat_${e._id.toString()}`;
          const lastSent = lastReminderSentMap.get(cacheKey) || 0;

          // Only send reminder if 24 hours have elapsed since last email
          if (now - lastSent > TWENTY_FOUR_HOURS_MS) {
            const techEmail = await resolveEmailForAssignee(e.technical || e.assignedTo);
            const salesEmail = await resolveEmailForAssignee(e.salesResponsibility || e.assignedTo);

            const recipients = Array.from(new Set([techEmail, salesEmail].filter((em) => em && em.includes('@'))));

            for (const recipient of recipients) {
              const assigneeName = e.technical || e.assignedTo || 'Team Lead';
              await sendTatExpiredReminderEmail({
                toEmail: recipient,
                assigneeName,
                enquiry: {
                  id: e._id.toString(),
                  rfqId: e.rfqId,
                  companyName: e.companyName || 'Customer Enquiry',
                  itemDescription: e.itemDescription,
                  tat: String(tat),
                  daysOpen,
                  status: e.status,
                },
              });

              // Create in-app Notification
              const targetUser: any = await User.findOne({ email: recipient.toLowerCase() }).lean();
              await Notification.create({
                title: `⚠️ URGENT TAT Overdue: ${e.rfqId || 'RFQ'}`,
                message: `RFQ for ${e.companyName || 'Customer'} has exceeded TAT (${daysOpen}/${tat} Days). Please complete costing & offer.`,
                type: 'SYSTEM',
                targetUserId: targetUser?._id || null,
              });
            }

            if (recipients.length > 0) {
              lastReminderSentMap.set(cacheKey, now);
              remindersCount++;
            }
          }
        }
      }

      if (remindersCount > 0) {
        console.log(`🔔 Sent automated TAT expired reminders for ${remindersCount} RFQ(s).`);
      }
      return remindersCount;
    } catch (err: any) {
      console.error('[RfqNotificationService] Error scanning TAT reminders:', err.message);
      return 0;
    }
  }
}
