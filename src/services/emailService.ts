import nodemailer from 'nodemailer';

const SMTP_USER = process.env.SMTP_USER || process.env.IMAP_USER || 'rfq@encon.co.in';
const SMTP_PASS = process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

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
    const info = await transporter.sendMail({
      from: `"ENCON Command Center" <${SMTP_USER}>`,
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

  const subject = `[ENCON Command Center] Your Account Has Been Created`;

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

      <div style="background-color: rgba(2, 132, 199, 0.1); border: 1px solid rgba(2, 132, 199, 0.3); border-radius: 12px; padding: 14px; margin: 20px 0; text-align: center;">
        <p style="margin: 0; font-size: 13px; color: #38bdf8;">
          💡 You can sign in using your temporary password or click <strong>"Sign in with Google"</strong> using your company email address!
        </p>
      </div>

      <div style="border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">
        This is an automated invitation from Encon Thermal Engineers Pvt Ltd.
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"ENCON Command Center" <${SMTP_USER}>`,
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
