import axios from 'axios';
import { Enquiry } from '../models/Enquiry';
import { User } from '../models/User';

// Subfolder names for clean organisation
const FOLDER_CLIENT_DOCS = 'Client documents';
const FOLDER_COSTING_TECHNICAL = 'Technical Calc & Costing Sheet';
const FOLDER_OFFER_DOCS = 'Offer Documents';

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let cachedParentFolder: { id: string; url: string } | null = null;

/**
 * Helper to get Google Drive configuration from environment variables
 */
export function getGDriveConfig() {
  const clientId = (process.env.GDRIVE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GDRIVE_OAUTH_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GDRIVE_OAUTH_REFRESH_TOKEN || '').trim();
  const parentFolderId = (process.env.GDRIVE_PARENT_FOLDER_ID || '').trim();
  const parentFolderName = (process.env.GDRIVE_PARENT_FOLDER_NAME || 'RFQ Tracker').trim();
  const shareWithEmails = (process.env.GDRIVE_SHARE_WITH || '').split(',').map((e) => e.trim()).filter(Boolean);

  const isConfigured = Boolean(clientId && clientSecret && refreshToken) || Boolean(parentFolderId);

  return {
    clientId,
    clientSecret,
    refreshToken,
    parentFolderId,
    parentFolderName,
    shareWithEmails,
    isConfigured,
  };
}

/**
 * Retrieve a valid OAuth access token for Google Drive API
 */
async function getAccessToken(): Promise<string | null> {
  const config = getGDriveConfig();
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    return null;
  }

  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60000) {
    return cachedAccessToken.token;
  }

  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    });

    const accessToken = res.data.access_token;
    const expiresIn = res.data.expires_in || 3600;

    cachedAccessToken = {
      token: accessToken,
      expiresAt: now + expiresIn * 1000,
    };

    return accessToken;
  } catch (err: any) {
    console.error('⚠️ Google Drive OAuth Token Error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Ensure a folder exists under a given parent folder ID in Google Drive.
 * Returns { id, webViewLink }
 */
async function ensureFolder(
  folderName: string,
  parentId: string,
  accessToken: string
): Promise<{ id: string; url: string }> {
  const safeName = folderName.replace(/'/g, "\\'");
  const query = `name = '${safeName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  // Search existing folder
  const searchRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
    params: {
      q: query,
      fields: 'files(id, webViewLink)',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const files = searchRes.data.files || [];
  if (files.length > 0) {
    return {
      id: files[0].id,
      url: files[0].webViewLink || `https://drive.google.com/drive/folders/${files[0].id}`,
    };
  }

  // Create folder if not found
  const createRes = await axios.post(
    'https://www.googleapis.com/drive/v3/files',
    {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    {
      params: { supportsAllDrives: true },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const folderId = createRes.data.id;
  const webViewLink = createRes.data.webViewLink || `https://drive.google.com/drive/folders/${folderId}`;

  return { id: folderId, url: webViewLink };
}

/**
 * Share folder with team emails (ALL database users + configured env emails)
 */
async function shareFolder(folderId: string, accessToken: string) {
  const config = getGDriveConfig();
  const targetEmails = new Set<string>(config.shareWithEmails.map((e) => e.toLowerCase()));

  try {
    const dbUsers: any[] = await User.find({ status: 'ACTIVE' }).select('email').lean();
    for (const u of dbUsers) {
      if (u.email && u.email.trim()) {
        targetEmails.add(u.email.trim().toLowerCase());
      }
    }
  } catch (err) {
    console.error('⚠️ Could not fetch database users for Google Drive sharing:', err);
  }

  for (const email of Array.from(targetEmails)) {
    try {
      await axios.post(
        `https://www.googleapis.com/drive/v3/files/${folderId}/permissions`,
        {
          type: 'user',
          role: 'writer',
          emailAddress: email,
        },
        {
          params: { sendNotificationEmail: false, supportsAllDrives: true },
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      console.log(`🤝 Shared Google Drive folder with ${email}`);
    } catch (e: any) {
      // Ignore if already shared
    }
  }
}

/**
 * Ensure the main app-managed "RFQ" parent folder exists.
 */
async function ensureParentFolder(accessToken: string): Promise<{ id: string; url: string }> {
  const config = getGDriveConfig();
  if (config.parentFolderId) {
    return {
      id: config.parentFolderId,
      url: `https://drive.google.com/drive/folders/${config.parentFolderId}`,
    };
  }

  if (cachedParentFolder) {
    return cachedParentFolder;
  }

  const result = await ensureFolder(config.parentFolderName, 'root', accessToken);
  await shareFolder(result.id, accessToken);
  cachedParentFolder = result;
  return result;
}

function resolveMimeType(filename: string, givenMime: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'zip':
      return 'application/zip';
    case 'rar':
      return 'application/vnd.rar';
    case '7z':
      return 'application/x-7z-compressed';
    case 'pdf':
      return 'application/pdf';
    case 'xlsx':
    case 'xls':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'docx':
    case 'doc':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    default:
      return givenMime || 'application/octet-stream';
  }
}

/**
 * Upload binary file buffer to a specific Google Drive folder.
 */
async function uploadFileToFolder(
  folderId: string,
  filename: string,
  mimeType: string,
  buffer: Buffer,
  accessToken: string
) {
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const finalMime = resolveMimeType(filename, mimeType);

  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: finalMime,
  };

  const multipartRequestBody = Buffer.concat([
    Buffer.from(
      `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`
    ),
    Buffer.from(`${delimiter}Content-Type: ${finalMime}\r\n\r\n`),
    buffer,
    Buffer.from(closeDelimiter),
  ]);

  await axios.post('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', multipartRequestBody, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    params: { supportsAllDrives: true, ignoreDefaultVisibility: true },
  });
}

/**
 * Determine Google Drive subfolder based on file attachment kind.
 */
function getSubfolderName(kind: string = '', filename: string = ''): string {
  const k = (kind || '').toLowerCase();
  const fn = (filename || '').toLowerCase();

  if (
    k === 'offer' ||
    k.includes('offer') ||
    fn.includes('offer') ||
    fn.includes('proposal')
  ) {
    return FOLDER_OFFER_DOCS;
  }

  if (
    k === 'costing' ||
    k === 'technical' ||
    k.includes('tech') ||
    k.includes('calc') ||
    k.includes('cost') ||
    fn.includes('cost') ||
    fn.includes('calc') ||
    fn.includes('tech') ||
    fn.includes('price') ||
    fn.includes('estimate') ||
    fn.includes('sheet')
  ) {
    return FOLDER_COSTING_TECHNICAL;
  }

  return FOLDER_CLIENT_DOCS;
}

/**
 * Mirror a single attachment to Google Drive in the background.
 * Folder structure: RFQ / <RFQ_ID> / <Subfolder> / <file>
 */
export async function mirrorAttachmentToDrive(
  enquiryId: string,
  filename: string,
  mimeType: string,
  buffer: Buffer,
  kind: string = ''
): Promise<{ success: boolean; driveFolderUrl?: string }> {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return { success: false };
    }

    const enquiry: any = await Enquiry.findById(enquiryId).lean();
    if (!enquiry) return { success: false };

    // 1. Ensure Parent "RFQ" Folder
    const parentFolder = await ensureParentFolder(accessToken);

    // 2. Ensure per-RFQ folder "RFQ/<RFQ_ID>"
    const rfqFolderName = enquiry.rfqId || `enquiry-${enquiry._id}`;
    let rfqFolderId = enquiry.driveFolderId;
    let rfqFolderUrl = enquiry.driveFolderUrl;

    if (!rfqFolderId) {
      const rfqFolder = await ensureFolder(rfqFolderName, parentFolder.id, accessToken);
      rfqFolderId = rfqFolder.id;
      rfqFolderUrl = rfqFolder.url;
      await shareFolder(rfqFolderId, accessToken);

      // Update DB record
      await Enquiry.findByIdAndUpdate(enquiryId, {
        driveFolderId: rfqFolderId,
        driveFolderUrl: rfqFolderUrl,
      });
    }

    // 3. Ensure Subfolder (Client documents | Technical Calculations | Costing & Offer)
    const subfolderName = getSubfolderName(kind, filename);
    const subfolder = await ensureFolder(subfolderName, rfqFolderId, accessToken);

    // 4. Upload file buffer into subfolder
    await uploadFileToFolder(subfolder.id, filename, mimeType, buffer, accessToken);

    console.log(`✅ Mirrored file "${filename}" to Google Drive folder "${rfqFolderName}/${subfolderName}"`);
    return { success: true, driveFolderUrl: rfqFolderUrl };
  } catch (err: any) {
    console.error('⚠️ Google Drive Mirror Error (non-blocking):', err.response?.data || err.message);
    return { success: false };
  }
}

/**
 * Ensure an RFQ Google Drive folder exists and return its webViewLink URL.
 */
export async function ensureEnquiryDriveFolder(enquiryId: string): Promise<string> {
  const enquiry: any = await Enquiry.findById(enquiryId).lean();
  if (!enquiry) return '';

  if (enquiry.driveFolderUrl) {
    return enquiry.driveFolderUrl;
  }

  const accessToken = await getAccessToken();
  if (!accessToken) return '';

  try {
    const parentFolder = await ensureParentFolder(accessToken);
    const rfqFolderName = enquiry.rfqId || `enquiry-${enquiry._id}`;
    const rfqFolder = await ensureFolder(rfqFolderName, parentFolder.id, accessToken);
    await shareFolder(rfqFolder.id, accessToken);

    // Create default subfolders
    await ensureFolder(FOLDER_CLIENT_DOCS, rfqFolder.id, accessToken);
    await ensureFolder(FOLDER_COSTING_TECHNICAL, rfqFolder.id, accessToken);
    await ensureFolder(FOLDER_OFFER_DOCS, rfqFolder.id, accessToken);

    await Enquiry.findByIdAndUpdate(enquiryId, {
      driveFolderId: rfqFolder.id,
      driveFolderUrl: rfqFolder.url,
    });

    return rfqFolder.url;
  } catch (err: any) {
    console.error('⚠️ Failed to ensure Google Drive folder:', err.message);
    return '';
  }
}

/**
 * Trash/delete all RFQ subfolders and files inside the parent "RFQ" folder in Google Drive.
 */
export async function clearGoogleDriveData(): Promise<{ success: boolean; deletedCount: number }> {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      console.warn('⚠️ Google Drive OAuth credentials not configured. Skipping Drive cleanup.');
      return { success: false, deletedCount: 0 };
    }

    const parentFolder = await ensureParentFolder(accessToken);
    let deletedCount = 0;
    let pageToken: string | undefined = undefined;

    do {
      const searchRes: any = await axios.get('https://www.googleapis.com/drive/v3/files', {
        params: {
          q: `'${parentFolder.id}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType)',
          pageSize: 100,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const files = searchRes.data.files || [];
      for (const item of files) {
        try {
          await axios.delete(`https://www.googleapis.com/drive/v3/files/${item.id}`, {
            params: { supportsAllDrives: true },
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          console.log(`🗑️ Deleted Google Drive RFQ item: ${item.name} (${item.id})`);
          deletedCount++;
        } catch (delErr: any) {
          // Fallback to trash if delete fails
          try {
            await axios.patch(
              `https://www.googleapis.com/drive/v3/files/${item.id}`,
              { trashed: true },
              {
                params: { supportsAllDrives: true },
                headers: { Authorization: `Bearer ${accessToken}` },
              }
            );
            console.log(`🗑️ Trashed Google Drive RFQ item: ${item.name}`);
            deletedCount++;
          } catch (trashErr) { }
        }
      }

      pageToken = searchRes.data.nextPageToken;
    } while (pageToken);

    console.log(`✅ Google Drive cleanup complete. Deleted ${deletedCount} RFQ item(s).`);
    return { success: true, deletedCount };
  } catch (err: any) {
    console.error('⚠️ Google Drive cleanup error:', err.response?.data || err.message);
    return { success: false, deletedCount: 0 };
  }
}
