/**
 * Maintenance: reconcile enquiry assignee LABELS with the User accounts they link
 * to, and adopt links for rows whose label still matches a known user by name.
 *
 * Exists because renames used to update one side only, leaving RFQs labelled with
 * a name that matches no account (the renamed person then sees an empty list and a
 * ghost assignee appears in workload counts).
 *
 * Dry run by default - nothing is written without --force.
 *   npm run repair-assignee-labels            # report only
 *   npm run repair-assignee-labels -- --force # apply
 *
 * Note the label repair only helps rows that already carry a User link. The
 * renamed person's own list does NOT depend on it: enquiry scoping matches on the
 * link, so their RFQs are visible again as soon as this code is deployed.
 *
 * One person holding several accounts under the same name is a supported setup, so
 * rows that carry only a shared name are reported and left alone - the name does
 * not say which account they belong to, and guessing would reassign real queues.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { Enquiry } from '../models/Enquiry';
import { User } from '../models/User';
import { applyAssigneeIdentityChange, ASSIGNEE_FIELDS } from '../utils/assigneeIdentity';

dotenv.config();

const FORCE_FLAG = '--force';

/** Labels that still contain a NAMED token belonging to no live account. */
async function reportOrphans() {
  const users: any[] = await User.find().select('name email').lean();
  const known = new Set<string>();
  users.forEach((u) => {
    known.add(String(u.name).trim().toLowerCase());
    known.add(String(u.email).trim().toLowerCase());
  });

  const rows: any[] = await Enquiry.find({}).select(ASSIGNEE_FIELDS.map((f) => f.value).join(' ')).lean();
  const orphans = new Map<string, number>();

  for (const row of rows) {
    for (const field of ASSIGNEE_FIELDS) {
      const value = String(row[field.value] || '').trim();
      if (!value) continue;
      for (const token of value.split('/').map((t) => t.trim()).filter(Boolean)) {
        if (token.toLowerCase().includes('@') || known.has(token.toLowerCase())) continue;
        orphans.set(token, (orphans.get(token) || 0) + 1);
      }
    }
  }

  if (!orphans.size) {
    console.log('  No assignee labels point at an unknown person.');
    return;
  }
  console.log('  Labels that match no live account (these need a human decision):');
  for (const [label, count] of Array.from(orphans.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`    - "${label}"  on ${count} enquiry field value(s)`);
  }
}

/** Accounts sharing one name: expected here, but it limits what a label can prove. */
async function reportSharedNames() {
  const users: any[] = await User.find().select('name email').lean();
  const byName = new Map<string, any[]>();
  users.forEach((u) => {
    const key = String(u.name || '').trim().toLowerCase();
    byName.set(key, [...(byName.get(key) || []), u]);
  });
  const shared = Array.from(byName.values()).filter((list) => list.length > 1);
  if (!shared.length) return;

  console.log('  Names held by more than one account (kept as-is, work link-only):');
  for (const list of shared) {
    console.log(`    - ${list[0].name}: ` + list.map((u: any) => `<${u.email}>`).join(' '));
  }
  console.log('');
}

async function main() {
  const apply = process.argv.includes(FORCE_FLAG);

  await connectDB();
  const conn = mongoose.connection;
  console.log('');
  console.log('-'.repeat(64));
  console.log(`  REPAIR SCRIPT : repair-assignee-labels`);
  console.log(`  Target database: ${conn.name}  (${conn.host}:${conn.port})`);
  console.log(`  Mode          : ${apply ? 'APPLYING WRITES' : 'dry run (nothing is written)'}`);
  console.log('-'.repeat(64));

  const users: any[] = await User.find().select('name email').lean();
  await reportSharedNames();

  // Re-derive each account's labels from its own id link. Idempotent: rows that
  // already agree are untouched by the helper.
  let total = 0;
  let deferred = 0;
  for (const u of users) {
    const res = await applyAssigneeIdentityChange({
      userId: String(u._id),
      oldName: String(u.name || '').trim(),
      newName: String(u.name || '').trim(),
      oldEmail: String(u.email || '').trim(),
      dryRun: !apply,
    });
    // A sweep is not a rename: the shared-name explanation is reported once, below,
    // as a count rather than repeated per account.
    deferred += res.deferred;
    if (res.enquiries) {
      total += res.enquiries;
      console.log(`  ${u.name}: ${res.enquiries} enquiry row(s) ${apply ? 'relabelled' : 'need relabelling'}`);
    }
  }
  if (!total) console.log('  Every linked enquiry already carries the correct label.');
  if (deferred) {
    console.log('');
    console.log(`  ${deferred} enquiry assignee value(s) carry only a shared name, so no account was inferred for them.`);
    console.log('  They keep their current label and remain visible to every account that name resolves to.');
    console.log('  To settle one, open the RFQ and pick the assignee; that writes the account link.');
  }

  console.log('');
  await reportOrphans();

  console.log('');
  if (!apply) {
    console.log('DRY RUN: no changes written. Re-run with --force to apply:');
    console.log('  npm run repair-assignee-labels -- --force');
    console.log('');
  } else {
    console.log(`Done. ${total} enquiry row(s) relabelled from their User links.`);
    console.log('');
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('Repair failed:', e.message);
  process.exit(1);
});
