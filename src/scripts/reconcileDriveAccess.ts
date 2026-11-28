/**
 * Reconcile Google Drive access for all app-managed RFQ folders.
 *
 *   npm run drive:reconcile           dry run (default; no Drive writes)
 *   npm run drive:reconcile -- --apply remove disallowed grants and add allowed ones
 */
import axios from 'axios';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { RFQ_DRIVE_ROLES } from '../config/capabilities';
import { reconcileRfqDriveAccess } from '../services/gdriveService';

dotenv.config();
axios.defaults.timeout = 30000;

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDB();
  const connection = mongoose.connection;
  console.log(`🔌 Target database: ${connection.name} @ ${connection.host}:${connection.port}`);
  console.log(`Allowed Drive roles: ${RFQ_DRIVE_ROLES.join(', ')}`);

  const result = await reconcileRfqDriveAccess(!APPLY);
  console.log(`Mode: ${result.dryRun ? 'DRY RUN (no changes)' : 'APPLY'}`);
  console.log(`Active allowed users: ${result.allowedUsers}`);
  console.log(`Folders checked: ${result.folders}`);
  console.log(`Permissions ${result.dryRun ? 'to remove' : 'removed'}: ${result.removed}`);
  console.log(`Permissions ${result.dryRun ? 'to add' : 'added'}: ${result.added}`);
  console.log(`Permissions ${result.dryRun ? 'to update' : 'updated'}: ${result.updated}`);
  console.log(`Failures: ${result.failed}`);
  if (result.message) console.log(result.message);

  if (!result.success) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('❌ Drive access reconciliation failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
