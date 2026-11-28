import axios from 'axios';
import { RFQ_DRIVE_ROLES } from '../config/capabilities';
import { Enquiry } from '../models/Enquiry';
import '../models/Role';
import { User } from '../models/User';

// Subfolder names for clean organisation
const FOLDER_CLIENT_DOCS = 'Client documents';
const FOLDER_COSTING_TECHNICAL = 'Technical Calc & Costing Sheet';
const FOLDER_OFFER_DOCS = 'Offer Documents';

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let cachedParentFolder: { id: string; url: string } | null = null;
let cachedDriveAuthError: string | null = null;
const FULL_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/**
 * Helper to get Google Drive configuration from environment variables
 */
export function getGDriveConfig() {
  const clientId = (process.env.GDRIVE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GDRIVE_OAUTH_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GDRIVE_OAUTH_REFRESH_TOKEN || '').trim();
  let parentFolderId = (process.env.GDRIVE_PARENT_FOLDER_ID || '').trim();
  if (parentFolderId === '.' || !/^[a-zA-Z0-9_-]+$/.test(parentFolderId)) {
    parentFolderId = '';
  }
  const parentFolderName = (process.env.GDRIVE_PARENT_FOLDER_NAME || 'RFQ_Dev').trim();

  const isConfigured = Boolean(clientId && clientSecret && refreshToken) || Boolean(parentFolderId);

  return {
    clientId,
    clientSecret,
    refreshToken,
    parentFolderId,
    parentFolderName,
    isConfigured,
  };
}

/**
 * Retrieve a valid OAuth access token for Google Drive API
 */
async function getAccessToken(): Promise<string | null> {
  const config = getGDriveConfig();
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    cachedDriveAuthError = 'Google Drive OAuth credentials are not configured.';
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
    const tokenInfo = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
      params: { access_token: accessToken },
    });
    const grantedScopes = new Set(
      String(tokenInfo.data.scope || '').split(/\s+/).filter(Boolean)
    );
    if (!grantedScopes.has(FULL_DRIVE_SCOPE)) {
      cachedDriveAuthError = `Google Drive OAuth is missing the full Drive scope. Run "npm run drive:authorize" and authorize ${FULL_DRIVE_SCOPE}.`;
      console.error(`⚠️ ${cachedDriveAuthError}`);
      return null;
    }

    cachedDriveAuthError = null;
    cachedAccessToken = {
      token: accessToken,
      expiresAt: now + expiresIn * 1000,
    };

    return accessToken;
  } catch (err: any) {
    cachedDriveAuthError = 'Could not refresh or validate the Google Drive OAuth token.';
    console.error('⚠️ Google Drive OAuth Token Error:', err.response?.data || err.message);
    return null;
  }
}

/** Find an existing folder without creating anything. */
async function findFolder(
  folderName: string,
  parentId: string,
  accessToken: string
): Promise<{ id: string; url: string } | null> {
  const safeName = folderName.replace(/'/g, "\\'");
  const query = `name = '${safeName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
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

  const folder = searchRes.data.files?.[0];
  if (!folder) return null;
  return {
    id: folder.id,
    url: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
  };
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
  const existing = await findFolder(folderName, parentId, accessToken);
  if (existing) return existing;

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

const folderSharePromises = new Map<string, Promise<boolean>>();
const allowedDriveRoles = new Set(RFQ_DRIVE_ROLES.map((role) => role.toUpperCase()));

interface FolderReconciliationResult {
  success: boolean;
  removed: number;
  added: number;
  updated: number;
  failed: number;
}

export interface DriveAccessReconciliationResult {
  success: boolean;
  dryRun: boolean;
  allowedUsers: number;
  folders: number;
  removed: number;
  added: number;
  updated: number;
  failed: number;
  message?: string;
}

async function getAllowedDriveEmails(): Promise<Set<string>> {
  const dbUsers: any[] = await User.find({ status: 'ACTIVE' })
    .populate('roleId', 'name')
    .select('email roleId')
    .lean();
  const targetEmails = new Set<string>();
  for (const user of dbUsers) {
    const roleName = String(user.roleId?.name || '').toUpperCase().trim();
    const email = String(user.email || '').trim().toLowerCase();
    if (email && allowedDriveRoles.has(roleName)) {
      targetEmails.add(email);
    }
  }
  return targetEmails;
}

async function listFolderPermissions(folderId: string, accessToken: string): Promise<any[]> {
  const permissions: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${folderId}/permissions`,
      {
        params: {
          fields: 'nextPageToken,permissions(id,type,role,emailAddress,permissionDetails)',
          pageSize: 100,
          pageToken,
          supportsAllDrives: true,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    permissions.push(...(response.data.permissions || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return permissions;
}

async function listChildFolders(folderId: string, accessToken: string): Promise<string[]> {
  const childIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: {
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken,files(id)',
        pageSize: 100,
        pageToken,
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    childIds.push(...(response.data.files || []).map((folder: any) => String(folder.id)));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return childIds;
}

/**
 * Enforce a strict direct-permission allowlist. Owners are preserved; public,
 * domain, group and unrecognised user grants are removed. In dry-run mode the
 * required changes are counted without making any Google Drive writes.
 */
async function reconcileFolderPermissions(
  folderId: string,
  accessToken: string,
  targetEmails: Set<string>,
  dryRun = false,
  ensureAllowedAccess = true
): Promise<FolderReconciliationResult> {
  const result: FolderReconciliationResult = {
    success: true,
    removed: 0,
    added: 0,
    updated: 0,
    failed: 0,
  };

  try {
    const permissions = await listFolderPermissions(folderId, accessToken);
    const existingByEmail = new Map<string, any>();

    for (const permission of permissions) {
      const inherited = Array.isArray(permission.permissionDetails)
        && permission.permissionDetails.some((detail: any) => detail?.inherited);
      if (inherited) continue;

      const email = String(permission.emailAddress || '').trim().toLowerCase();
      if (permission.role === 'owner') {
        if (email && targetEmails.has(email)) existingByEmail.set(email, permission);
        continue;
      }

      const isAllowedUser = permission.type === 'user' && email && targetEmails.has(email);
      if (!isAllowedUser) {
        if (dryRun || !permission.id) {
          if (!permission.id && !dryRun) result.failed++;
          else result.removed++;
          continue;
        }
        try {
          await axios.delete(
            `https://www.googleapis.com/drive/v3/files/${folderId}/permissions/${encodeURIComponent(String(permission.id))}`,
            {
              params: { supportsAllDrives: true },
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );
          result.removed++;
        } catch (err: any) {
          result.failed++;
          console.error(`⚠️ Could not remove Drive permission ${permission.id} from ${folderId}:`, err.response?.data || err.message);
        }
        continue;
      }

      existingByEmail.set(email, permission);
    }

    // Child folders inherit access from the app parent. Only revoke direct
    // grants there; do not create redundant permissions on every RFQ folder.
    if (!ensureAllowedAccess) {
      result.success = result.failed === 0;
      return result;
    }

    for (const email of targetEmails) {
      const existing = existingByEmail.get(email);
      if (!existing) {
        if (dryRun) {
          result.added++;
          continue;
        }
        try {
          await axios.post(
            `https://www.googleapis.com/drive/v3/files/${folderId}/permissions`,
            { type: 'user', role: 'writer', emailAddress: email },
            {
              // Some staff addresses need a Google Account invitation.
              params: { sendNotificationEmail: true, supportsAllDrives: true },
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );
          result.added++;
        } catch (err: any) {
          result.failed++;
          console.error(`⚠️ Could not grant Drive access to ${email} on ${folderId}:`, err.response?.data || err.message);
        }
      } else if (!['owner', 'organizer'].includes(existing.role)) {
        if (dryRun) {
          result.updated++;
          continue;
        }
        try {
          await axios.patch(
            `https://www.googleapis.com/drive/v3/files/${folderId}/permissions/${encodeURIComponent(String(existing.id))}`,
            { role: 'writer' },
            {
              params: { supportsAllDrives: true },
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );
          result.updated++;
        } catch (err: any) {
          result.failed++;
          console.error(`⚠️ Could not update Drive permission for ${email} on ${folderId}:`, err.response?.data || err.message);
        }
      }
    }
  } catch (err: any) {
    result.failed++;
    console.error('⚠️ Could not reconcile Google Drive folder permissions:', err.response?.data || err.message);
  }

  result.success = result.failed === 0;
  return result;
}

/** Reconcile one folder, coalescing concurrent requests for the same folder. */
async function shareFolder(
  folderId: string,
  accessToken: string,
  ensureAllowedAccess = true
): Promise<boolean> {
  if (!folderId) return false;
  const pending = folderSharePromises.get(folderId);
  if (pending) return pending;

  const promise = (async () => {
    try {
      // Never revoke grants when the role lookup itself failed.
      const targetEmails = await getAllowedDriveEmails();
      const result = await reconcileFolderPermissions(
        folderId,
        accessToken,
        targetEmails,
        false,
        ensureAllowedAccess
      );
      return result.success;
    } catch (err) {
      console.error('⚠️ Could not resolve allowed Google Drive users:', err);
      return false;
    } finally {
      folderSharePromises.delete(folderId);
    }
  })();

  folderSharePromises.set(folderId, promise);
  return promise;
}

/**
 * Ensure the main app-managed "RFQ" parent folder exists.
 */
async function ensureParentFolder(accessToken: string): Promise<{ id: string; url: string }> {
  const config = getGDriveConfig();
  if (config.parentFolderId) {
    const result = {
      id: config.parentFolderId,
      url: `https://drive.google.com/drive/folders/${config.parentFolderId}`,
    };
    const reconciled = await shareFolder(result.id, accessToken);
    if (!reconciled) {
      throw new Error('Could not enforce the allowed-user list on the RFQ parent Drive folder.');
    }
    return result;
  }

  if (cachedParentFolder) {
    const reconciled = await shareFolder(cachedParentFolder.id, accessToken);
    if (!reconciled) {
      throw new Error('Could not enforce the allowed-user list on the cached RFQ parent Drive folder.');
    }
    return cachedParentFolder;
  }

  const result = await ensureFolder(config.parentFolderName, 'root', accessToken);
  const reconciled = await shareFolder(result.id, accessToken);
  if (!reconciled) {
    throw new Error('Could not enforce the allowed-user list on the new RFQ parent Drive folder.');
  }
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
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc':
      return 'application/msword';
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
  const boundary = `-------boundary_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const finalMime = resolveMimeType(filename, mimeType);

  const metadataStr = JSON.stringify({
    name: filename,
    parents: [folderId],
  });

  const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n\r\n--${boundary}\r\nContent-Type: ${finalMime}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const multipartRequestBody = Buffer.concat([
    Buffer.from(header, 'utf8'),
    buffer,
    Buffer.from(footer, 'utf8'),
  ]);

  const resp = await axios.post('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', multipartRequestBody, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    params: { supportsAllDrives: true, ignoreDefaultVisibility: true },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  // Return the created Drive file id so callers can store it as a pointer and
  // stop keeping the bytes in MongoDB.
  return resp?.data?.id ? String(resp.data.id) : '';
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

const enquiryFolderPromises = new Map<string, Promise<{ id: string; url: string }>>();

/**
 * Single-threaded helper to ensure per-RFQ Google Drive folder exists without creating duplicates.
 */
async function getOrEnsureRfqFolder(
  enquiryId: string,
  accessToken: string
): Promise<{ id: string; url: string }> {
  const enquiry: any = await Enquiry.findById(enquiryId).lean();
  if (!enquiry) return { id: '', url: '' };

  const parentFolder = await ensureParentFolder(accessToken);
  if (enquiry.driveFolderId && enquiry.driveFolderUrl) {
    const reconciled = await shareFolder(enquiry.driveFolderId, accessToken, false);
    if (!reconciled) {
      throw new Error('Could not remove disallowed direct access from the existing RFQ Drive folder.');
    }
    return { id: enquiry.driveFolderId, url: enquiry.driveFolderUrl };
  }

  if (enquiryFolderPromises.has(enquiryId)) {
    return enquiryFolderPromises.get(enquiryId)!;
  }

  const promise = (async () => {
    try {
      const rfqFolderName = enquiry.rfqId || `enquiry-${enquiry._id}`;
      const rfqFolder = await ensureFolder(rfqFolderName, parentFolder.id, accessToken);
      const reconciled = await shareFolder(rfqFolder.id, accessToken, false);
      if (!reconciled) {
        throw new Error('Could not enforce the allowed-user list on the new RFQ Drive folder.');
      }

      // Create default subfolders
      await ensureFolder(FOLDER_CLIENT_DOCS, rfqFolder.id, accessToken);
      await ensureFolder(FOLDER_COSTING_TECHNICAL, rfqFolder.id, accessToken);
      await ensureFolder(FOLDER_OFFER_DOCS, rfqFolder.id, accessToken);

      await Enquiry.findByIdAndUpdate(enquiryId, {
        driveFolderId: rfqFolder.id,
        driveFolderUrl: rfqFolder.url,
      });

      return { id: rfqFolder.id, url: rfqFolder.url };
    } finally {
      enquiryFolderPromises.delete(enquiryId);
    }
  })();

  enquiryFolderPromises.set(enquiryId, promise);
  return promise;
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
): Promise<{ success: boolean; driveFileId?: string; driveFolderUrl?: string }> {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return { success: false };
    }

    const rfqFolder = await getOrEnsureRfqFolder(enquiryId, accessToken);
    if (!rfqFolder.id) return { success: false };

    // 3. Ensure Subfolder (Client documents | Technical Calculations | Costing & Offer)
    const subfolderName = getSubfolderName(kind, filename);
    const subfolder = await ensureFolder(subfolderName, rfqFolder.id, accessToken);

    // 4. Upload file buffer into subfolder
    const driveFileId = await uploadFileToFolder(subfolder.id, filename, mimeType, buffer, accessToken);

    console.log(`✅ Mirrored file "${filename}" to Google Drive folder "${subfolderName}"`);
    return { success: true, driveFileId: driveFileId || undefined, driveFolderUrl: rfqFolder.url };
  } catch (err: any) {
    console.error('⚠️ Google Drive Mirror Error (non-blocking):', err.response?.data || err.message);
    return { success: false };
  }
}

/**
 * Download a file's bytes from Google Drive by its file id.
 * Returns null when the token is unavailable or the file cannot be fetched,
 * so callers can fall back to a locally stored copy.
 */
export async function downloadFileFromDrive(fileId: string): Promise<Buffer | null> {
  if (!fileId) return null;
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return null;

    const resp = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { alt: 'media', supportsAllDrives: true },
      responseType: 'arraybuffer',
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    return Buffer.from(resp.data);
  } catch (err: any) {
    console.error('⚠️ Google Drive Download Error:', err.response?.status || err.message);
    return null;
  }
}

/**
 * Find the Drive file id for an already-mirrored attachment, without uploading.
 * Resolves the RFQ folder -> subfolder for the enquiry and matches by name.
 * Returns '' when nothing matches, so callers can fall back to uploading.
 */
export async function resolveDriveFileId(
  enquiryId: string,
  filename: string,
  kind: string = ''
): Promise<string> {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return '';

    const rfqFolder = await getOrEnsureRfqFolder(enquiryId, accessToken);
    if (!rfqFolder.id) return '';

    const subfolderName = getSubfolderName(kind, filename);
    const subfolder = await ensureFolder(subfolderName, rfqFolder.id, accessToken);

    const safeName = filename.replace(/'/g, "\\'");
    const q = `name = '${safeName}' and '${subfolder.id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
    const searchRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: {
        q,
        fields: 'files(id)',
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const files = searchRes.data.files || [];
    return files.length > 0 ? String(files[0].id) : '';
  } catch (err: any) {
    console.error('⚠️ Google Drive resolve error:', err.response?.status || err.message);
    return '';
  }
}

/**
 * Ensure an RFQ Google Drive folder exists and return its webViewLink URL.
 */
export async function ensureEnquiryDriveFolder(enquiryId: string): Promise<string> {
  const accessToken = await getAccessToken();
  if (!accessToken) return '';
  try {
    const rfqFolder = await getOrEnsureRfqFolder(enquiryId, accessToken);
    return rfqFolder.url;
  } catch (err: any) {
    console.error('⚠️ Failed to ensure Google Drive folder:', err.message);
    return '';
  }
}

/**
 * Reconcile the app parent, every stored RFQ folder and all descendant folders.
 * Dry-run is the default for the command-line wrapper so existing access can be
 * inspected before any permission is removed.
 */
export async function reconcileRfqDriveAccess(
  dryRun = true
): Promise<DriveAccessReconciliationResult> {
  const result: DriveAccessReconciliationResult = {
    success: false,
    dryRun,
    allowedUsers: 0,
    folders: 0,
    removed: 0,
    added: 0,
    updated: 0,
    failed: 0,
  };

  console.log('🔑 Refreshing Google Drive access token...');
  const accessToken = await getAccessToken();
  if (!accessToken) {
    result.message = cachedDriveAuthError || 'Google Drive OAuth credentials are not configured.';
    return result;
  }

  let targetEmails: Set<string>;
  try {
    targetEmails = await getAllowedDriveEmails();
    result.allowedUsers = targetEmails.size;
    console.log(`👥 Resolved ${result.allowedUsers} active user(s) in allowed Drive roles.`);
  } catch (err) {
    result.message = 'Could not resolve active users and their roles.';
    result.failed = 1;
    console.error('⚠️ Could not resolve allowed Google Drive users:', err);
    return result;
  }

  const config = getGDriveConfig();
  let parentFolderId = config.parentFolderId || cachedParentFolder?.id || '';
  if (!parentFolderId) {
    if (dryRun) {
      const existingParent = await findFolder(config.parentFolderName, 'root', accessToken);
      parentFolderId = existingParent?.id || '';
    } else {
      const parentFolder = await ensureParentFolder(accessToken);
      parentFolderId = parentFolder.id;
    }
  }

  const folderIds = new Set<string>();
  if (parentFolderId) folderIds.add(parentFolderId);
  const storedFolderIds = await Enquiry.distinct('driveFolderId', {
    driveFolderId: { $type: 'string', $ne: '' },
  });
  for (const folderId of storedFolderIds) {
    if (folderId) folderIds.add(String(folderId));
  }

  const queue = Array.from(folderIds);
  const visited = new Set<string>();
  console.log(`📁 Found ${folderIds.size} root folder(s); scanning descendants...`);

  const worker = async () => {
    while (queue.length > 0) {
      const folderId = queue.shift()!;
      if (visited.has(folderId)) continue;
      visited.add(folderId);
      result.folders++;

      const folderResult = await reconcileFolderPermissions(
        folderId,
        accessToken,
        targetEmails,
        dryRun,
        folderId === parentFolderId
      );
      result.removed += folderResult.removed;
      result.added += folderResult.added;
      result.updated += folderResult.updated;
      result.failed += folderResult.failed;

      try {
        const childIds = await listChildFolders(folderId, accessToken);
        for (const childId of childIds) {
          if (!visited.has(childId)) queue.push(childId);
        }
      } catch (err: any) {
        result.failed++;
        console.error(`⚠️ Could not list child Drive folders for ${folderId}:`, err.response?.data || err.message);
      }

      if (result.folders % 25 === 0) {
        console.log(`   Checked ${result.folders} folder(s)...`);
      }
    }
  };

  await Promise.all(Array.from({ length: 8 }, () => worker()));

  result.success = result.failed === 0 && result.folders > 0;
  if (result.folders === 0) {
    result.message = 'No app-managed RFQ Drive folders were found.';
  }
  return result;
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
