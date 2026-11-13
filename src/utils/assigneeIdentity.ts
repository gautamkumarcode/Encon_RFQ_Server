/**
 * Assignee identity: the single place that keeps the two representations of "who
 * this RFQ belongs to" in agreement.
 *
 * An enquiry stores an assignee twice - a User link (assignedToId / technicalId /
 * salesResponsibilityId) and a denormalized display string (assignedTo / technical
 * / salesResponsibility). Every filter, workload count and KPI historically grouped
 * on the STRING, so renaming a user in one place and not the other silently moved
 * whole RFQs to a name that matches no account: the renamed person's own list goes
 * empty and a ghost assignee appears in analytics.
 *
 * Rules enforced here:
 *  - the User link is authoritative; the string is a cache derived from it
 *  - a rename/email change rewrites BOTH, so the two can never disagree
 *  - combined values ("Amit / Rahul") are rewritten per token, so a co-assignee
 *    is never dropped by a rename
 */
import mongoose from 'mongoose';
import { Enquiry } from '../models';
import { AssigneeEmail } from '../models';
import { User } from '../models/User';

export const ASSIGNEE_FIELDS = [
  { value: 'assignedTo', id: 'assignedToId' },
  { value: 'technical', id: 'technicalId' },
  { value: 'salesResponsibility', id: 'salesResponsibilityId' },
] as const;

/** The separator used wherever two people share one RFQ ("Amit / Rahul"). */
const TOKEN_SEP = ' / ';

/**
 * Split a shared value into its people. Deliberately splits on a bare "/" so a
 * row saved as "Amit/Rahul" (no spaces) is still understood, and normalises back
 * to the "A / B" spacing the rest of the app writes.
 */
const splitTokens = (value: string): string[] =>
  value
    .split('/')
    .map((t) => t.trim())
    .filter(Boolean);

const sameText = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface IdentityChange {
  userId: string;
  /** The name on the User record before the change. */
  oldName?: string;
  /** The name on the User record after the change. */
  newName?: string;
  /** Email before the change, so rows labelled with an email get relabelled too. */
  oldEmail?: string;
  /** Count the rows that would change, but write nothing. */
  dryRun?: boolean;
}

/** Every label that should now resolve to this user's canonical name. */
function aliasesOf(change: IdentityChange): string[] {
  const out: string[] = [];
  const newName = (change.newName || '').trim();
  const oldName = (change.oldName || '').trim();
  const oldEmail = (change.oldEmail || '').trim();

  // Legacy rows labelled with an email keep reading as an email address, so the
  // email is its own alias; a row labelled with the old email becomes the new name.
  if (oldEmail && newName) out.push(oldEmail, newName);
  if (oldName) out.push(oldName);
  if (newName) out.push(newName);
  return Array.from(new Set(out.filter(Boolean)));
}

/**
 * Re-point every enquiry that references this user at their current identity:
 * refresh the display string from the User link, and adopt the link on legacy rows
 * that only ever carried the old name or email.
 *
 * Returns how many enquiries were touched, how many values were held back under a
 * shared name, and any warning the caller should surface. A shared name produces a
 * warning instead of a guess.
 */
export async function applyAssigneeIdentityChange(
  change: IdentityChange,
): Promise<{ enquiries: number; warnings: string[]; deferred: number }> {
  const { userId } = change;
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return { enquiries: 0, warnings: [], deferred: 0 };
  }
  if (!(change.newName || '').trim()) return { enquiries: 0, warnings: [], deferred: 0 };

  const aliases = aliasesOf(change);
  if (!aliases.length) return { enquiries: 0, warnings: [], deferred: 0 };

  // Production has live accounts that share one name (same person, two emails).
  // A label then cannot say whose RFQ it is, so renaming on the strength of the
  // label would move the other account's queue: restrict the work to rows that
  // carry this account's link and say so loudly.
  const labelFilters: any[] = [];
  for (const name of [change.oldName, change.newName]) {
    const trimmed = (name || '').trim();
    if (trimmed) {
      labelFilters.push({ name: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') });
    }
  }
  const lookalikes = labelFilters.length
    ? await User.find({ $or: labelFilters, _id: { $ne: userId } })
      .select('name email')
      .lean()
    : [];
  const nameIsShared = lookalikes.length > 0;

  // Superset scan: any row whose string merely CONTAINS an alias is worth a look,
  // which is what catches "Amit / Rahul". The decision below is exact.
  const scan: any[] = [{ $or: ASSIGNEE_FIELDS.map((f) => ({ [f.id]: userId })) }];
  if (!nameIsShared) {
    for (const alias of aliases) {
      scan.push({
        $or: ASSIGNEE_FIELDS.map((f) => ({
          [f.value]: { $regex: escapeRegex(alias), $options: 'i' },
        })),
      });
    }
  }

  const rows: any[] = await Enquiry.find({ $and: [{ $or: scan }] })
    .select(ASSIGNEE_FIELDS.flatMap((f) => [f.value, f.id]).join(' '))
    .lean();

  let touched = 0;
  let deferred = 0;
  for (const row of rows) {
    const changes: any = {};

    for (const field of ASSIGNEE_FIELDS) {
      const current = String(row[field.value] || '').trim();
      const linked = String(row[field.id] || '') === String(userId);

      // Under a shared name, an unlinked field is not attributable to anybody.
      if (nameIsShared && !linked) {
        if (splitTokens(current).some((t) => aliases.some((a) => sameText(t, a)))) deferred++;
        continue;
      }

      const tokens = splitTokens(current);

      let next: string | null = null;

      if (tokens.length > 1) {
        // Shared RFQ: swap only the token that is demonstrably this user, so a
        // co-assignee is never dropped. When nothing matches an alias we leave the
        // value alone even if the row is linked - the link still drives filtering
        // and scoping, and guessing which token is his could silently reassign.
        const replaced = tokens.map((t) =>
          aliases.some((a) => sameText(t, a)) ? (change.newName as string) : t,
        );
        const joined = replaced.join(TOKEN_SEP);
        if (joined !== current) next = joined;
      } else if (tokens.length === 1) {
        if (linked || aliases.some((a) => sameText(tokens[0], a))) {
          if (!sameText(tokens[0], change.newName as string)) next = (change.newName as string);
        }
      } else if (linked && current === '') {
        // Linked but never labelled - fill the cache in so string-based views work.
        next = (change.newName as string);
      }

      if (next !== null) {
        changes[field.value] = next;
        // Any row we just relabelled to this user is provably theirs: adopt the link.
        if (!linked) changes[field.id] = userId;
      }
    }

    if (Object.keys(changes).length) {
      if (!change.dryRun) await Enquiry.updateOne({ _id: row._id }, { $set: changes });
      touched++;
    }
  }

  const warnings: string[] = [];
  if (nameIsShared) {
    warnings.push(
      `"${(change.newName || change.oldName || '').trim()}" is held by ${lookalikes.length + 1} accounts at once (` +
      lookalikes.map((u: any) => `${u.name} <${u.email}>`).join(', ') +
      `), which is a normal setup here. RFQs carrying only that name${deferred ? ` (${deferred} value(s))` : ''} ` +
      `could belong to any of them, so this rename did not guess: those rows kept their current assignee ` +
      `and still resolve through the account they are linked to. Set the assignee on the RFQ itself to move one.`,
    );
  }

  return { enquiries: touched, warnings, deferred };
}

/**
 * Drops the directory alias left behind by a rename, but only when the old name
 * identifies exactly this account. One person legitimately holds more than one
 * account here (same name, different email), and deleting the shared alias would
 * silently de-register the other account from the assignee directory.
 *
 * Returns true when the alias was removed.
 */
export async function dropStaleDirectoryAlias(
  oldName: string,
  renamedUserId?: string,
): Promise<boolean> {
  const name = (oldName || '').trim();
  if (!name) return false;

  const nameFilter = new RegExp(`^${escapeRegex(name)}$`, 'i');
  const idFilter =
    renamedUserId && mongoose.Types.ObjectId.isValid(renamedUserId)
      ? { _id: { $ne: renamedUserId } }
      : {};
  const stillInUse = await User.countDocuments({ name: nameFilter, ...idFilter });
  if (stillInUse > 0) return false;

  await AssigneeEmail.deleteMany({ name: nameFilter });
  return true;
}

/**
 * Label-only rename, for a directory entry that has no User account behind it.
 * There is no link to trust, so the old label is matched token by token and only
 * that token is replaced - a co-assignee sharing the RFQ keeps their name.
 */
export async function renameAssigneeLabel(
  from: string,
  to: string,
): Promise<{ enquiries: number }> {
  const old = (from || '').trim();
  const next = (to || '').trim();
  if (!old || !next || sameText(old, next)) return { enquiries: 0 };

  const rows: any[] = await Enquiry.find({
    $or: ASSIGNEE_FIELDS.map((f) => ({
      [f.value]: { $regex: escapeRegex(old), $options: 'i' },
    })),
  })
    .select(ASSIGNEE_FIELDS.map((f) => f.value).join(' '))
    .lean();

  let touched = 0;
  for (const row of rows) {
    const changes: any = {};

    for (const field of ASSIGNEE_FIELDS) {
      const current = String(row[field.value] || '').trim();
      const tokens = splitTokens(current);
      if (!tokens.some((t) => sameText(t, old))) continue;

      const rebuilt = tokens.map((t) => (sameText(t, old) ? next : t)).join(TOKEN_SEP);
      if (rebuilt !== current) changes[field.value] = rebuilt;
    }

    if (Object.keys(changes).length) {
      await Enquiry.updateOne({ _id: row._id }, { $set: changes });
      touched++;
    }
  }

  return { enquiries: touched };
}

/**
 * Backfill for damage already done: walks every enquiry and re-derives the
 * assignee strings from their User links. Lets a rename that only touched the User
 * (or only the enquiries) be reconciled without knowing which user changed.
 */
export async function syncAssigneeStringsFromIds(opts: {
  dryRun?: boolean;
  report?: (line: string) => void;
}): Promise<{ scanned: number; stale: number }> {
  const dryRun = opts.dryRun !== false;
  const say = opts.report || (() => undefined);

  const users: any[] = await User.find().select('name email').lean();
  const byId = new Map<string, any>();
  users.forEach((u) => byId.set(String(u._id), u));

  const projection = ASSIGNEE_FIELDS.flatMap((f) => [f.value, f.id]);
  const rows: any[] = await Enquiry.find({}).select(projection.join(' ')).lean();

  let stale = 0;
  for (const row of rows) {
    const changes: any = {};

    for (const field of ASSIGNEE_FIELDS) {
      const id = row[field.id];
      if (!id) continue;
      const user = byId.get(String(id));
      if (!user) continue;

      const current = String(row[field.value] || '').trim();
      const tokens = splitTokens(current);
      const canonical = String(user.name).trim();

      if (tokens.length > 1) {
        // Cannot tell which token the link refers to; leave shared values alone.
        continue;
      }
      if (tokens.length === 1 && sameText(tokens[0], canonical)) continue;
      if (tokens.length === 0 && !current) {
        changes[field.value] = canonical;
        continue;
      }
      if (tokens.length === 1) changes[field.value] = canonical;
    }

    if (Object.keys(changes).length) {
      stale++;
      if (!dryRun) await Enquiry.updateOne({ _id: row._id }, { $set: changes });
    }
  }

  say(`scanned ${rows.length} enquiries, ${stale} with a stale assignee label (${dryRun ? 'dry run' : 'updated'}).`);
  return { scanned: rows.length, stale };
}
