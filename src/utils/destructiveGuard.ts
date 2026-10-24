/**
 * Shared guard for the repository's destructive maintenance scripts
 * (reset-db-keep-admin, clear-rfq-data).
 *
 * These scripts delete live records with no undo, and the .env they read is the
 * same one the running server uses — so a mis-typed command can wipe production.
 * The guard refuses to run without an explicit --force flag and prints exactly
 * which database is targeted and how many rows will go, before anything is
 * deleted. Nothing here ever deletes data itself; it only blocks or informs.
 */
import mongoose from 'mongoose';

const FORCE_FLAG = '--force';

/** True when the operator explicitly opted in from the command line. */
export function isForceRequested(): boolean {
  return process.argv.includes(FORCE_FLAG);
}

/** Connection identity without credentials, so it is safe to print. */
function describeTarget(): { name: string; host: string } {
  const conn = mongoose.connection;
  const host = conn.host ? `${conn.host}:${conn.port}` : 'unknown host';
  return { name: conn.name || 'unknown database', host };
}

export interface DestructiveRunCheck {
  /** Script name as it appears in package.json, used in the retry hint. */
  script: string;
  /** Plain-English list of what this run destroys. */
  willDelete: string[];
  /** Optional: what survives, so the operator can see the blast radius. */
  keep?: string[];
  /** Counts are queried only after the guard is satisfied, never before. */
  counts: () => Promise<Array<{ label: string; count: number }>>;
}

/**
 * Aborts the process (exit code 1) when --force is missing. When it is present,
 * prints the target and row counts and returns, letting the caller delete.
 */
export async function confirmDestructiveRun(check: DestructiveRunCheck): Promise<void> {
  const { name, host } = describeTarget();

  const keep = check.keep ?? [];

  // Plain ASCII only: these scripts are run in Windows consoles, where box-drawing
  // characters arrive as mojibake and hide the warning that matters.
  const bar = '-'.repeat(64);
  const banner = [
    '',
    bar,
    `  DESTRUCTIVE SCRIPT : ${check.script}`,
    `  Target database    : ${name}  (${host})`,
    '  Will delete:',
    ...check.willDelete.map((d) => `    - ${d}`),
    ...(keep.length ? ['  Will keep:', ...keep.map((d) => `    - ${d}`)] : []),
    bar,
  ].join('\n');

  console.log(banner);

  if (!isForceRequested()) {
    console.log(
      [
        '',
        'BLOCKED: no explicit confirmation.',
        '  This deletes records permanently and cannot be undone.',
        '',
        '  If you are sure this is the database you mean, re-run with --force:',
        `    npm run ${check.script} -- --force`,
        '',
        `  Check MONGODB_URI in .env first - it currently points at "${name}".`,
        '',
      ].join('\n'),
    );
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  }

  const rows = await check.counts();
  console.log('  Rows about to be deleted:');
  for (const row of rows) {
    console.log(`    - ${row.label}: ${row.count}`);
  }
  console.log('  --force given, proceeding.\n');
}
