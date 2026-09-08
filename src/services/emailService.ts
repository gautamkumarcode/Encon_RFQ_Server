import nodemailer from 'nodemailer';

function getSmtpConfig() {
  const user = (process.env.SMTP_USER || process.env.IMAP_USER || '').trim();
  const pass = (process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD || '').trim();
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = parseInt(process.env.SMTP_PORT || '465', 10);

  return { user, pass, host, port };
}

function createTransporter(config: ReturnType<typeof getSmtpConfig>) {
  const auth = config.user && config.pass ? { user: config.user, pass: config.pass } : undefined;

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    ...(auth ? { auth } : {}),
    tls: {
      rejectUnauthorized: false,
    },
  });
}

export interface SendAssignmentEmailOptions {
  toEmail: string;
  assigneeName: string;
  assignerEmail: string;
  enquiry: {
    id?: number | string;
    rfqId: string;
    companyName: string;
    contactPerson?: string;
    itemDescription?: string;
    driveFolderUrl?: string;
  };
}

/**
 * Send an email notification directly to the assigned technical person's email address.
 */
export async function sendAssignmentEmail(options: SendAssignmentEmailOptions): Promise<boolean> {
  const { toEmail, assigneeName, assignerEmail, enquiry } = options;

  if (!toEmail || !toEmail.includes('@')) {
    console.warn(`⚠️ Cannot send assignment email: Invalid recipient address "${toEmail}"`);
    return false;
  }

  const config = getSmtpConfig();
  if (!config.pass) {
    console.warn(`⚠️ Cannot send assignment email to ${toEmail}: SMTP_PASSWORD or IMAP_PASSWORD is missing in production environment variables.`);
    return false;
  }

  const subject = `[ENCON RFQ Assignment Alert] ${enquiry.rfqId || `RFQ #${enquiry.id}`} - ${enquiry.companyName || 'Customer Enquiry'}`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; padding: 24px; borderRadius: 16px;">
      <div style="border-bottom: 2px solid #06b6d4; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #38bdf8; margin: 0; font-size: 20px;">🔔 RFQ Assigned to You</h2>
        <p style="color: #94a3b8; font-size: 13px; margin: 4px 0 0 0;">Encon Command Center Notification</p>
      </div>

      <p style="font-size: 14px; color: #e2e8f0;">Hello <strong>${assigneeName}</strong>,</p>

      <p style="font-size: 14px; color: #cbd5e1;">
        You have been assigned as the <strong>Technical Lead</strong> for RFQ <strong>${enquiry.rfqId || `#${enquiry.id}`}</strong> by <strong>${assignerEmail}</strong>.
      </p>

      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1;">
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; width: 140px;"><strong>RFQ ID:</strong></td>
            <td style="padding: 6px 0; color: #38bdf8; font-weight: bold;">${enquiry.rfqId || `#${enquiry.id}`}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Customer:</strong></td>
            <td style="padding: 6px 0; color: #f8fafc; font-weight: bold;">${enquiry.companyName || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Contact Person:</strong></td>
            <td style="padding: 6px 0; color: #cbd5e1;">${enquiry.contactPerson || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; vertical-align: top;"><strong>Requirement:</strong></td>
            <td style="padding: 6px 0; color: #f1f5f9; line-height: 1.4;">${enquiry.itemDescription || 'Enquiry Requirement'}</td>
          </tr>
        </table>
      </div>

      ${enquiry.driveFolderUrl
      ? `<div style="margin: 20px 0; text-align: center;">
              <a href="${enquiry.driveFolderUrl}" target="_blank" style="background-color: #10b981; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block;">
                📁 Open Google Drive RFQ Folder ↗
              </a>
            </div>`
      : ''
    }

      <div style="border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">
        This is an automated notification from Encon RFQ Management System.
      </div>
    </div>
  `;

  try {
    const transporter = createTransporter(config);
    const info = await transporter.sendMail({
      from: `"ENCON Command Center" <${config.user}>`,
      to: toEmail,
      subject: subject,
      html: htmlContent,
    });
    console.log(`✉️ Assignment notification email sent to ${toEmail} (Message ID: ${info.messageId})`);
    return true;
  } catch (err: any) {
    console.error(`❌ Error sending assignment email to ${toEmail}:`, err.message);
    return false;
  }
}

export interface SendWelcomeEmailOptions {
  toEmail: string;
  userName: string;
  roleName: string;
  temporaryPassword?: string;
  createdByAdminEmail: string;
}

/**
 * Send an email invitation when a new user account is created by an Administrator.
 */
export async function sendWelcomeUserEmail(options: SendWelcomeEmailOptions): Promise<boolean> {
  const { toEmail, userName, roleName, temporaryPassword, createdByAdminEmail } = options;

  if (!toEmail || !toEmail.includes('@')) {
    console.warn(`⚠️ Cannot send welcome email: Invalid recipient address "${toEmail}"`);
    return false;
  }

  const config = getSmtpConfig();
  if (!config.pass) {
    console.warn(`⚠️ Cannot send welcome email to ${toEmail}: SMTP_PASSWORD or IMAP_PASSWORD is missing in production environment variables.`);
    return false;
  }

  const subject = `[ENCON Command Center] Your Account Has Been Created`;

  const portalUrl = (process.env.FRONTEND_URL || 'https://dashboard.encon.in').split(',')[0].trim() || 'https://dashboard.encon.in';

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; padding: 24px; border-radius: 16px;">
      <div style="border-bottom: 2px solid #06b6d4; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #38bdf8; margin: 0; font-size: 20px;">🎉 Welcome to ENCON Command Center</h2>
        <p style="color: #94a3b8; font-size: 13px; margin: 4px 0 0 0;">Official Staff Account Notification</p>
      </div>

      <p style="font-size: 14px; color: #e2e8f0;">Hello <strong>${userName}</strong>,</p>

      <p style="font-size: 14px; color: #cbd5e1;">
        Your account on the <strong>ENCON Command Center Portal</strong> has been created by <strong>${createdByAdminEmail}</strong>.
      </p>

      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin: 20px 0;">
        <h4 style="color: #38bdf8; margin: 0 0 12px 0; font-size: 14px;">🔑 Your Access Credentials</h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1;">
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; width: 140px;"><strong>Email Address:</strong></td>
            <td style="padding: 6px 0; color: #f8fafc; font-weight: bold;">${toEmail}</td>
          </tr>
          ${temporaryPassword
      ? `<tr>
                  <td style="padding: 6px 0; color: #94a3b8;"><strong>Temporary Password:</strong></td>
                  <td style="padding: 6px 0; color: #fbbf24; font-weight: bold; font-family: monospace;">${temporaryPassword}</td>
                </tr>`
      : ''
    }
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Assigned Role:</strong></td>
            <td style="padding: 6px 0; color: #34d399; font-weight: bold;">${roleName}</td>
          </tr>
        </table>
      </div>

      <div style="margin: 24px 0; text-align: center;">
        <a href="${portalUrl}" target="_blank" style="background-color: #06b6d4; color: #ffffff; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 14px; display: inline-block; box-shadow: 0 4px 12px rgba(6, 182, 212, 0.3);">
          🚀 Click Here to Login to ENCON Portal ↗
        </a>
        <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 10px;">
          Portal Link: <a href="${portalUrl}" target="_blank" style="color: #38bdf8; text-decoration: underline;">${portalUrl}</a>
        </p>
      </div>

      <div style="background-color: rgba(2, 132, 199, 0.1); border: 1px solid rgba(2, 132, 199, 0.3); border-radius: 12px; padding: 14px; margin: 20px 0; text-align: center;">
        <p style="margin: 0; font-size: 13px; color: #38bdf8;">
          💡 You can sign in using your credentials above or click <strong>"Sign in with Google"</strong> using your company email address!
        </p>
      </div>

      <div style="border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">
        This is an automated invitation from Encon Thermal Engineers Pvt Ltd.
      </div>
    </div>
  `;

  try {
    const transporter = createTransporter(config);
    const info = await transporter.sendMail({
      from: `"ENCON Command Center" <${config.user}>`,
      to: toEmail,
      subject: subject,
      html: htmlContent,
    });
    console.log(`✉️ Welcome user email sent to ${toEmail} (Message ID: ${info.messageId})`);
    return true;
  } catch (err: any) {
    console.error(`❌ Error sending welcome email to ${toEmail}:`, err.message);
    return false;
  }
}

export interface SendCostingApprovedEmailOptions {
  toEmail: string;
  salesPersonName: string;
  approverEmail: string;
  enquiry: {
    id?: number | string;
    rfqId: string;
    companyName: string;
    offerNo?: string;
    offerDate?: string;
    itemDescription?: string;
    driveFolderUrl?: string;
  };
}

/**
 * 1. Send notification to Sales Person when RFQ Costing & Offer is Approved by Management.
 */
export async function sendCostingApprovedEmail(options: SendCostingApprovedEmailOptions): Promise<boolean> {
  const { toEmail, salesPersonName, approverEmail, enquiry } = options;

  if (!toEmail || !toEmail.includes('@')) {
    console.warn(`⚠️ Cannot send approval email: Invalid recipient address "${toEmail}"`);
    return false;
  }

  const config = getSmtpConfig();
  if (!config.pass) {
    console.warn(`⚠️ Cannot send approval email to ${toEmail}: SMTP_PASSWORD or IMAP_PASSWORD missing.`);
    return false;
  }

  const subject = `[ENCON RFQ APPROVED] Offer ${enquiry.offerNo || enquiry.rfqId} Approved - Ready for Client (${enquiry.companyName})`;
  const portalUrl = (process.env.FRONTEND_URL || 'https://dashboard.encon.in').split(',')[0].trim();

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; padding: 24px; border-radius: 16px;">
      <div style="border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #34d399; margin: 0; font-size: 20px;">🎉 RFQ Costing & Offer Approved!</h2>
        <p style="color: #94a3b8; font-size: 13px; margin: 4px 0 0 0;">Management Approval Notification</p>
      </div>

      <p style="font-size: 14px; color: #e2e8f0;">Hello <strong>${salesPersonName}</strong>,</p>

      <p style="font-size: 14px; color: #cbd5e1;">
        Management (<strong>${approverEmail}</strong>) has <strong style="color: #34d399;">APPROVED</strong> the technical costing & offer for <strong>${enquiry.companyName}</strong>. You can now dispatch the official proposal offer to the client.
      </p>

      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1;">
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; width: 140px;"><strong>RFQ ID:</strong></td>
            <td style="padding: 6px 0; color: #38bdf8; font-weight: bold;">${enquiry.rfqId || `#${enquiry.id}`}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Offer Number:</strong></td>
            <td style="padding: 6px 0; color: #fbbf24; font-weight: bold; font-family: monospace;">${enquiry.offerNo || 'Generated Offer'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Customer:</strong></td>
            <td style="padding: 6px 0; color: #f8fafc; font-weight: bold;">${enquiry.companyName}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; vertical-align: top;"><strong>Requirement:</strong></td>
            <td style="padding: 6px 0; color: #f1f5f9; line-height: 1.4;">${enquiry.itemDescription || 'N/A'}</td>
          </tr>
        </table>
      </div>

      <div style="margin: 24px 0; text-align: center;">
        <a href="${portalUrl}/rfq/${enquiry.id}" target="_blank" style="background-color: #10b981; color: #ffffff; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 14px; display: inline-block; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);">
          🚀 View Approved RFQ & Send Offer to Client ↗
        </a>
      </div>

      <div style="border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">
        Automated notification from Encon Command Center.
      </div>
    </div>
  `;

  try {
    const transporter = createTransporter(config);
    await transporter.sendMail({
      from: `"ENCON Command Center" <${config.user}>`,
      to: toEmail,
      subject,
      html: htmlContent,
    });
    console.log(`✉️ Approval notification email sent to Sales (${toEmail})`);
    return true;
  } catch (err: any) {
    console.error(`❌ Error sending approval email to ${toEmail}:`, err.message);
    return false;
  }
}

export interface SendRfqReviewRequiredEmailOptions {
  toEmail: string;
  reviewerName?: string;
  submitterEmail?: string;
  enquiry: {
    id: number | string;
    rfqId: string;
    companyName: string;
    contactPerson?: string;
    itemDescription?: string;
    technical?: string;
    salesResponsibility?: string;
    driveFolderUrl?: string;
  };
}

/**
 * Send an email notification to Reviewers / Management when an RFQ is submitted for Review.
 */
export async function sendRfqReviewRequiredEmail(options: SendRfqReviewRequiredEmailOptions): Promise<boolean> {
  const { toEmail, reviewerName, submitterEmail, enquiry } = options;

  if (!toEmail || !toEmail.includes('@')) return false;

  const config = getSmtpConfig();
  if (!config.pass) return false;

  const subject = `[ENCON RFQ FOR REVIEW] Review Required: ${enquiry.rfqId || `RFQ #${enquiry.id}`} - ${enquiry.companyName}`;
  const portalUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
  const reviewLink = `${portalUrl}/review/${enquiry.id}`;
  const rfqLink = `${portalUrl}/rfq/${enquiry.id}`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; padding: 24px; border-radius: 16px;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #fbbf24; margin: 0; font-size: 20px;">📋 RFQ Costing Ready for Review</h2>
        <p style="color: #94a3b8; font-size: 13px; margin: 4px 0 0 0;">Management Review & Verification Action Required</p>
      </div>

      <p style="font-size: 14px; color: #e2e8f0;">Hello <strong>${reviewerName || 'Management Reviewer'}</strong>,</p>

      <p style="font-size: 14px; color: #cbd5e1;">
        The technical costing & offer for <strong>${enquiry.companyName}</strong> (${enquiry.rfqId}) has been submitted for review by <strong>${submitterEmail || 'Engineering Team'}</strong>.
      </p>

      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1;">
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; width: 140px;"><strong>RFQ ID:</strong></td>
            <td style="padding: 6px 0; color: #38bdf8; font-weight: bold;">${enquiry.rfqId || `#${enquiry.id}`}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Customer:</strong></td>
            <td style="padding: 6px 0; color: #f8fafc; font-weight: bold;">${enquiry.companyName || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Technical Assignee:</strong></td>
            <td style="padding: 6px 0; color: #cbd5e1;">${enquiry.technical || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Sales Lead:</strong></td>
            <td style="padding: 6px 0; color: #cbd5e1;">${enquiry.salesResponsibility || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; vertical-align: top;"><strong>Requirement:</strong></td>
            <td style="padding: 6px 0; color: #f1f5f9; line-height: 1.4;">${enquiry.itemDescription || 'N/A'}</td>
          </tr>
        </table>
      </div>

      <div style="margin: 24px 0; text-align: center;">
        <a href="${reviewLink}" target="_blank" style="background-color: #f59e0b; color: #000000; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 14px; display: inline-block; box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);">
          🔍 Open Review Portal & Approve Offer ↗
        </a>
      </div>

      <div style="margin: 16px 0; text-align: center;">
        <a href="${rfqLink}" target="_blank" style="color: #38bdf8; text-decoration: underline; font-size: 13px;">
          View Full RFQ Detail Page
        </a>
      </div>

      ${enquiry.driveFolderUrl
        ? `<div style="margin: 16px 0; text-align: center;">
            <a href="${enquiry.driveFolderUrl}" target="_blank" style="color: #10b981; text-decoration: underline; font-size: 13px;">
              📁 Open Google Drive Attachments & Costing Folder
            </a>
          </div>`
        : ''
      }

      <div style="border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">
        Automated review request from Encon Command Center.
      </div>
    </div>
  `;

  try {
    const transporter = createTransporter(config);
    await transporter.sendMail({
      from: `"ENCON Command Center" <${config.user}>`,
      to: toEmail,
      subject,
      html: htmlContent,
    });
    console.log(`✉️ RFQ Review request email sent to Reviewer (${toEmail})`);
    return true;
  } catch (err: any) {
    console.error(`❌ Error sending RFQ Review request email to ${toEmail}:`, err.message);
    return false;
  }
}

export interface SendTatExpiredReminderEmailOptions {
  toEmail: string;
  assigneeName: string;
  enquiry: {
    id?: number | string;
    rfqId: string;
    companyName: string;
    itemDescription?: string;
    dateReceived?: string;
    tat?: string;
    daysOpen?: number;
    status?: string;
  };
}

/**
 * 2. Send TAT Expiration / Overdue Reminder Email to assigned team.
 */
export async function sendTatExpiredReminderEmail(options: SendTatExpiredReminderEmailOptions): Promise<boolean> {
  const { toEmail, assigneeName, enquiry } = options;

  if (!toEmail || !toEmail.includes('@')) return false;

  const config = getSmtpConfig();
  if (!config.pass) return false;

  const subject = `[URGENT TAT OVERDUE] RFQ ${enquiry.rfqId || `#${enquiry.id}`} - Action Required (${enquiry.companyName})`;
  const portalUrl = (process.env.FRONTEND_URL || 'https://dashboard.encon.in').split(',')[0].trim();

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; padding: 24px; border-radius: 16px;">
      <div style="border-bottom: 2px solid #ef4444; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #f87171; margin: 0; font-size: 20px;">⚠️ TAT Expiration / Overdue Alert</h2>
        <p style="color: #94a3b8; font-size: 13px; margin: 4px 0 0 0;">Turnaround Time Deadline Notification</p>
      </div>

      <p style="font-size: 14px; color: #e2e8f0;">Hello <strong>${assigneeName}</strong>,</p>

      <p style="font-size: 14px; color: #cbd5e1;">
        The target Turnaround Time (TAT) of <strong style="color: #f87171;">${enquiry.tat || '30'} Days</strong> has passed for RFQ <strong>${enquiry.rfqId || `#${enquiry.id}`}</strong>. Please complete the technical costing and proposal offer immediately.
      </p>

      <div style="background-color: #1e293b; border: 1px solid #7f1d1d; border-radius: 12px; padding: 16px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1;">
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; width: 140px;"><strong>RFQ ID:</strong></td>
            <td style="padding: 6px 0; color: #38bdf8; font-weight: bold;">${enquiry.rfqId || `#${enquiry.id}`}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Customer:</strong></td>
            <td style="padding: 6px 0; color: #f8fafc; font-weight: bold;">${enquiry.companyName}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Current Status:</strong></td>
            <td style="padding: 6px 0; color: #fbbf24; font-weight: bold;">${enquiry.status || 'Pending'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Days Open:</strong></td>
            <td style="padding: 6px 0; color: #f87171; font-weight: bold;">${enquiry.daysOpen || 'Overdue'} Days</td>
          </tr>
        </table>
      </div>

      <div style="margin: 24px 0; text-align: center;">
        <a href="${portalUrl}/rfq/${enquiry.id}" target="_blank" style="background-color: #ef4444; color: #ffffff; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 14px; display: inline-block;">
          ⚡ Open RFQ & Complete Costing Now ↗
        </a>
      </div>

      <div style="border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">
        Automated TAT alert from Encon Command Center.
      </div>
    </div>
  `;

  try {
    const transporter = createTransporter(config);
    await transporter.sendMail({
      from: `"ENCON Command Center" <${config.user}>`,
      to: toEmail,
      subject,
      html: htmlContent,
    });
    console.log(`✉️ TAT reminder email sent to ${toEmail}`);
    return true;
  } catch (err: any) {
    console.error(`❌ Error sending TAT reminder email to ${toEmail}:`, err.message);
    return false;
  }
}

export interface SendSalesPostOfferFollowupReminderEmailOptions {
  toSalesEmail: string;
  salesPersonName: string;
  enquiry: {
    id?: number | string;
    rfqId: string;
    companyName: string;
    contactPerson?: string;
    mobile?: string;
    email?: string;
    offerNo?: string;
    offerDate?: string;
    itemDescription?: string;
    driveFolderUrl?: string;
  };
}

/**
 * Send Post-Offer Client Follow-Up Reminder email to the Sales Lead.
 */
export async function sendSalesPostOfferFollowupReminderEmail(options: SendSalesPostOfferFollowupReminderEmailOptions): Promise<boolean> {
  const { toSalesEmail, salesPersonName, enquiry } = options;

  if (!toSalesEmail || !toSalesEmail.includes('@')) return false;

  const config = getSmtpConfig();
  if (!config.pass) return false;

  const subject = `[ACTION REQUIRED] Client Follow-up Reminder: Offer ${enquiry.offerNo || enquiry.rfqId} (${enquiry.companyName})`;
  const portalUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
  const rfqLink = `${portalUrl}/rfq/${enquiry.id}`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; padding: 24px; border-radius: 16px;">
      <div style="border-bottom: 2px solid #06b6d4; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #38bdf8; margin: 0; font-size: 20px;">📞 Client Follow-up Reminder for Sales</h2>
        <p style="color: #94a3b8; font-size: 13px; margin: 4px 0 0 0;">Encon Command Center Automated Reminder</p>
      </div>

      <p style="font-size: 14px; color: #e2e8f0;">Hello <strong>${salesPersonName || 'Sales Lead'}</strong>,</p>

      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.5;">
        This is a scheduled reminder to follow up with customer <strong>${enquiry.companyName}</strong> regarding offer proposal <strong>${enquiry.offerNo || enquiry.rfqId}</strong>. Please contact the client to ask about proposal receipt and address any technical or commercial queries.
      </p>

      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin: 20px 0;">
        <h4 style="color: #38bdf8; margin: 0 0 12px 0; font-size: 14px;">🏢 Customer & Offer Details</h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1;">
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; width: 140px;"><strong>Offer Number:</strong></td>
            <td style="padding: 6px 0; color: #fbbf24; font-weight: bold; font-family: monospace;">${enquiry.offerNo || enquiry.rfqId}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Customer:</strong></td>
            <td style="padding: 6px 0; color: #f8fafc; font-weight: bold;">${enquiry.companyName}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Contact Person:</strong></td>
            <td style="padding: 6px 0; color: #e2e8f0;">${enquiry.contactPerson || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Mobile / Phone:</strong></td>
            <td style="padding: 6px 0; color: #34d399; font-weight: bold;">${enquiry.mobile || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Client Email:</strong></td>
            <td style="padding: 6px 0; color: #38bdf8;">${enquiry.email || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; vertical-align: top;"><strong>Requirement:</strong></td>
            <td style="padding: 6px 0; color: #f1f5f9; line-height: 1.4;">${enquiry.itemDescription || 'Proposal Requirement'}</td>
          </tr>
        </table>
      </div>

      <div style="margin: 24px 0; text-align: center;">
        <a href="${rfqLink}" target="_blank" style="background-color: #06b6d4; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block; margin: 4px;">
          🔗 Open RFQ Workstation & Log Call ↗
        </a>
      </div>

      <div style="border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">
        Automated reminder from Encon Command Center.
      </div>
    </div>
  `;

  try {
    const transporter = createTransporter(config);
    await transporter.sendMail({
      from: `"ENCON Command Center" <${config.user}>`,
      to: toSalesEmail,
      subject,
      html: htmlContent,
    });
    console.log(`✉️ Sales post-offer follow-up reminder sent to Sales (${toSalesEmail})`);
    return true;
  } catch (err: any) {
    console.error(`❌ Error sending sales follow-up reminder email to ${toSalesEmail}:`, err.message);
    return false;
  }
}

export async function sendClientPostOfferFollowupEmail(options: any): Promise<boolean> {
  return sendSalesPostOfferFollowupReminderEmail({
    toSalesEmail: options.salesEmail || options.toClientEmail,
    salesPersonName: options.salesName || 'Sales Lead',
    enquiry: options.enquiry,
  });
}

export interface SendTechnicalFollowupAddedEmailOptions {
  toSalesEmail: string;
  salesPersonName: string;
  authorName: string;
  authorEmail: string;
  type: string;
  note: string;
  nextActionDate?: string;
  enquiry: {
    id: string | number;
    rfqId: string;
    companyName: string;
    itemDescription?: string;
  };
}

/**
 * Send an email notification to the assigned Sales Responsibility whenever a technical person or team member logs a follow-up/remark.
 */
export async function sendTechnicalFollowupAddedEmail(options: SendTechnicalFollowupAddedEmailOptions): Promise<boolean> {
  const { toSalesEmail, salesPersonName, authorName, authorEmail, type, note, nextActionDate, enquiry } = options;

  if (!toSalesEmail || !toSalesEmail.includes('@')) return false;

  const config = getSmtpConfig();
  if (!config.pass) return false;

  const subject = `[RFQ FOLLOW-UP ALERT] New ${type} Logged on ${enquiry.rfqId} (${enquiry.companyName})`;
  const portalUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
  const rfqLink = `${portalUrl}/rfq/${enquiry.id}`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; padding: 24px; border-radius: 16px;">
      <div style="border-bottom: 2px solid #06b6d4; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #38bdf8; margin: 0; font-size: 20px;">📝 New RFQ Follow-up Logged</h2>
        <p style="color: #94a3b8; font-size: 13px; margin: 4px 0 0 0;">Technical Team Update Notification</p>
      </div>

      <p style="font-size: 14px; color: #e2e8f0;">Hello <strong>${salesPersonName || 'Sales Lead'}</strong>,</p>

      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.5;">
        A new <strong>${type}</strong> entry has been logged by <strong>${authorName}</strong> (${authorEmail}) for RFQ <strong>${enquiry.rfqId}</strong> (${enquiry.companyName}).
      </p>

      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin: 20px 0;">
        <h4 style="color: #38bdf8; margin: 0 0 12px 0; font-size: 14px;">📋 Follow-up Entry Details</h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1;">
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; width: 140px;"><strong>RFQ ID:</strong></td>
            <td style="padding: 6px 0; color: #38bdf8; font-weight: bold;">${enquiry.rfqId}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Customer:</strong></td>
            <td style="padding: 6px 0; color: #f8fafc; font-weight: bold;">${enquiry.companyName}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Log Type:</strong></td>
            <td style="padding: 6px 0; color: #fbbf24; font-weight: bold;">${type}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Logged By:</strong></td>
            <td style="padding: 6px 0; color: #34d399;">${authorName}</td>
          </tr>
          ${nextActionDate ? `
          <tr>
            <td style="padding: 6px 0; color: #94a3b8;"><strong>Next Follow-up Date:</strong></td>
            <td style="padding: 6px 0; color: #38bdf8; font-weight: bold;">${nextActionDate}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 6px 0; color: #94a3b8; vertical-align: top;"><strong>Remarks / Note:</strong></td>
            <td style="padding: 6px 0; color: #f1f5f9; line-height: 1.5; white-space: pre-wrap;">${note}</td>
          </tr>
        </table>
      </div>

      <div style="margin: 24px 0; text-align: center;">
        <a href="${rfqLink}" target="_blank" style="background-color: #06b6d4; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block;">
          🚀 Open RFQ Workstation & View History ↗
        </a>
      </div>

      <div style="border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">
        Automated notification from Encon Command Center.
      </div>
    </div>
  `;

  try {
    const transporter = createTransporter(config);
    await transporter.sendMail({
      from: `"ENCON Command Center" <${config.user}>`,
      to: toSalesEmail,
      subject,
      html: htmlContent,
    });
    console.log(`✉️ Technical follow-up notification email sent to Sales (${toSalesEmail})`);
    return true;
  } catch (err: any) {
    console.error(`❌ Error sending technical follow-up notification email to ${toSalesEmail}:`, err.message);
    return false;
  }
}
