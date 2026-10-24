import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { Attachment } from '../models';
import {
  mirrorAttachmentToDrive,
  resolveDriveFileId,
} from '../services/gdriveService';

dotenv.config();

/**
 * Backfill Drive pointers for legacy attachments.
 *
 * Older attachment rows store the full file bytes in MongoDB (`data`) and have
 * no `driveFileId`. New writes already mirror to Drive, record the pointer and
 * drop the bytes. This script brings the old rows up to the same shape:
 *
 *   1. Resolve the file's existing Google Drive id by name (no re-upload).
 *   2. If it was never mirrored, upload the stored bytes and take the new id.
 *   3. Record `driveFileId` and `$unset` the Mongo `data` to reclaim storage.
 *
 * It is DRY RUN by default - nothing is mutated unless you pass --force.
 * A row is only stripped of its `data` once a Drive id is confirmed, so a
 * failure to reach Drive can never lose a file.
 */

function isForce(): boolean {
  return process.argv.includes('--force');
}

function isDry(): boolean {
  return process.argv.includes('--dry');
}

async function backfill() {
  await connectDB();

  const apply = isForce() && !isDry();

  // Rows that still carry bytes and have no Drive pointer yet.
  const candidates = await Attachment.find({
    data: { $exists: true, $ne: null },
    $or: [
      { driveFileId: { $exists: false } },
      { driveFileId: null },
      { driveFileId: '' },
    ],
  })
    .select('enquiryId filename contentType size kind data')
    .lean();

  const totalBytes = candidates.reduce((s, a: any) => s + (a.data?.length || 0), 0);
  console.log(
    `Found ${candidates.length} legacy attachment(s) holding ${(totalBytes / 1024 / 1024).toFixed(2)} MB in MongoDB.`,
  );

  if (candidates.length === 0) {
    console.log('Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  if (!apply) {
    console.log('DRY RUN - pass --force to actually migrate and free storage.\n');
  }

  let linked = 0;
  let uploaded = 0;
  let freedBytes = 0;
  let skipped = 0;

  for (const att of candidates as any[]) {
    const enquiryId = att.enquiryId?.toString() || '';
    if (!enquiryId || !att.filename) {
      skipped++;
      continue;
    }

    try {
      // 1. Prefer matching an already-mirrored Drive file (no duplicate upload).
      let driveFileId = await resolveDriveFileId(enquiryId, att.filename, att.kind || '');

      // 2. Not in Drive yet - upload the stored bytes and take the new id.
      if (!driveFileId && att.data) {
        const res = await mirrorAttachmentToDrive(
          enquiryId,
          att.filename,
          att.contentType || 'application/octet-stream',
          Buffer.from(att.data),
          att.kind || '',
        );
        if (res?.success && res.driveFileId) {
          driveFileId = res.driveFileId;
          uploaded++;
        }
      }

      if (!driveFileId) {
        console.warn(`  ! Could not obtain a Drive id for "${att.filename}" (enquiry ${enquiryId}) - keeping Mongo copy.`);
        skipped++;
        continue;
      }

      // 3. Confirmed in Drive - store the pointer and drop the bytes.
      if (apply) {
        await Attachment.findByIdAndUpdate(att._id, {
          $set: { driveFileId },
          $unset: { data: '' },
        });
      }
      freedBytes += att.data?.length || 0;
      linked++;
    } catch (err: any) {
      console.error(`  ! Error migrating "${att.filename}":`, err?.message || err);
      skipped++;
    }
  }

  console.log('\n----- Backfill summary -----');
  console.log(`  Linked to Drive : ${linked}`);
  console.log(`  Newly uploaded  : ${uploaded}`);
  console.log(`  Skipped         : ${skipped}`);
  console.log(
    `  Storage ${apply ? 'freed' : 'to free'} : ${(freedBytes / 1024 / 1024).toFixed(2)} MB`,
  );
  if (!apply) {
    console.log('  (dry run - no changes written; re-run with --force)');
  }

  await mongoose.disconnect();
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
