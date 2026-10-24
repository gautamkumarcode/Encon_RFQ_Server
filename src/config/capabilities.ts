/**
 * Capability catalogue — the single source of truth for the permission matrix.
 *
 * Why this exists: the Permission collection stores flat {module, action} rows and
 * the Roles UI renders whatever rows exist. Previously a module like RFQ_MGMT was
 * one coarse "WRITE" grant, which bundled creating an entry, editing client
 * details, re-assigning owners, changing status, deleting logs and deleting the
 * record — so a person could not be given one of those without all of them.
 *
 * Each entry below is therefore a SUB-MODULE: one business verb an admin can
 * reason about and tick on its own. Actions stay the existing four
 * (READ / WRITE / DELETE / MANAGE) so requirePermission() needs no signature
 * change and the { module, action } unique index is untouched.
 *
 * legacyGrantTo reproduces what the hard-coded role-name checks allowed before,
 * so switching the checks to capabilities does not remove anyone's access.
 */

export type CapabilityAction = 'READ' | 'WRITE' | 'DELETE' | 'MANAGE';

export interface CapabilityDef {
  /** Stored in Permission.module — UPPER_SNAKE, stable, never shown raw to users. */
  module: string;
  /** Human label shown on the Roles page. */
  label: string;
  /** Section heading the Roles page groups this under. */
  group: string;
  description: string;
  /** Only the actions that make sense for this verb — no meaningless cross product. */
  actions: CapabilityAction[];
  /** Roles that effectively hold this today via name-based checks. */
  legacyGrantTo: string[];
}

export const ALL_CAPABILITY_ACTIONS: CapabilityAction[] = ['READ', 'WRITE', 'DELETE', 'MANAGE'];

/**
 * The stored/compared form of a capability, e.g. "RFQ_ASSIGNMENT:WRITE".
 * Declared before the arrays below because they build keys at module load; a
 * `const` arrow defined afterwards would be in its temporal dead zone.
 */
export const capabilityKey = (module: string, action: CapabilityAction): string =>
  `${module}:${action}`;

const LEADERSHIP = ['ADMIN', 'CO', 'GM', 'PRODUCTION_HEAD'];
const SALES = ['ADMIN', 'SALES_MARKETING'];
/** Anyone the old canEdit/canChangeStatus checks let edit an RFQ. */
const ALL_RFK_USERS = ['ADMIN', 'CO', 'GM', 'PRODUCTION_HEAD', 'SALES_MARKETING', 'TECHNICAL_PERSON'];
const ADMIN_ONLY = ['ADMIN'];
/** Every staff role - used for self-service rights like clocking in. */
const ALL_STAFF = ALL_RFK_USERS;

export const RFQ_CAPABILITIES: CapabilityDef[] = [
  {
    module: 'RFQ_LIST',
    label: 'RFQ Tracker — Open & View Own',
    group: 'RFQ · Access',
    description: 'See the RFQ tracker: own and assigned enquiries, plus anything under review.',
    actions: ['READ'],
    legacyGrantTo: ALL_RFK_USERS,
  },
  {
    module: 'RFQ_VIEW_ALL',
    label: 'RFQ Tracker — View Every Record',
    group: 'RFQ · Access',
    description: 'See all enquiries in the system, not only the ones assigned to you.',
    actions: ['READ'],
    legacyGrantTo: SALES,
  },
  {
    module: 'RFQ_ENTRY',
    label: 'RFQ Entry — Create & Edit',
    group: 'RFQ · Enquiry Data',
    description: 'Create a new enquiry and edit its core fields (item, description, quantity, notes).',
    actions: ['WRITE'],
    legacyGrantTo: ALL_RFK_USERS,
  },
  {
    module: 'RFQ_CLIENT_DETAILS',
    label: 'RFQ Entry — Update Client Details',
    group: 'RFQ · Enquiry Data',
    description: 'Change the client name, contact person, mobile, email and address on an enquiry.',
    actions: ['WRITE'],
    legacyGrantTo: ALL_RFK_USERS,
  },
  {
    module: 'RFQ_SOURCE_DOC',
    label: 'RFQ Entry — Mail Source & Raw Content',
    group: 'RFQ · Enquiry Data',
    description: 'View and edit the captured enquiry mail, sender details and raw content.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: ALL_RFK_USERS,
  },
  {
    module: 'RFQ_ASSIGNMENT',
    label: 'RFQ — Change Assignment',
    group: 'RFQ · Lifecycle',
    description: 'Re-assign the sales and technical owners of an enquiry.',
    actions: ['WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_STATUS',
    label: 'RFQ — Change Status',
    group: 'RFQ · Lifecycle',
    description: 'Move an enquiry between Open, In Progress, Under Review, Closed and Regret.',
    actions: ['WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_FOLLOWUP',
    label: 'RFQ — Follow-up Log',
    group: 'RFQ · Lifecycle',
    description: 'Add follow-up entries. Deleting entries is a separate, finer-grained right.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: ALL_RFK_USERS,
  },
  {
    module: 'RFQ_FOLLOWUP_ADMIN',
    label: 'RFQ — Delete Follow-up Logs',
    group: 'RFQ · Lifecycle',
    description: 'Remove follow-up entries recorded by any user.',
    actions: ['DELETE'],
    legacyGrantTo: ALL_RFK_USERS,
  },
  {
    module: 'RFQ_CLIENT_FOLLOWUP',
    label: 'RFQ — Send Client Follow-up Mail',
    group: 'RFQ · Lifecycle',
    description: 'Send a follow-up email directly to the client from the enquiry.',
    actions: ['WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_ENTRY_DELETE',
    label: 'RFQ — Delete Enquiry',
    group: 'RFQ · Lifecycle',
    description: 'Delete a single enquiry record.',
    actions: ['DELETE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_BULK_DELETE',
    label: 'RFQ — Bulk Delete',
    group: 'RFQ · Lifecycle',
    description: 'Delete many enquiries at once from the tracker.',
    actions: ['WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_ATTACHMENT',
    label: 'RFQ — Attachments',
    group: 'RFQ · Documents',
    description: 'Upload documents against an enquiry. Deleting uploads is separate.',
    actions: ['WRITE'],
    legacyGrantTo: ALL_RFK_USERS,
  },
  {
    module: 'RFQ_ATTACHMENT_DELETE',
    label: 'RFQ — Delete Attachments',
    group: 'RFQ · Documents',
    description: 'Remove attachments uploaded by any user.',
    actions: ['DELETE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_DRIVE',
    label: 'RFQ — Google Drive Folder',
    group: 'RFQ · Documents',
    description: 'Open and sync the Drive folder created for an enquiry.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: ALL_RFK_USERS,
  },
  {
    module: 'RFQ_IMPORT',
    label: 'RFQ — Import from Excel',
    group: 'RFQ · Automation',
    description: 'Bulk-create enquiries by uploading a spreadsheet.',
    actions: ['WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_INBOX_SYNC',
    label: 'RFQ — Sync Enquiry Inbox',
    group: 'RFQ · Automation',
    description: 'Pull new enquiries from the shared mailbox and view sync status.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_OFFER_MAPPING',
    label: 'RFQ — Auto-map Offer Documents',
    group: 'RFQ · Automation',
    description: 'Attach generated offer PDFs to enquiries automatically.',
    actions: ['WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_DIRECTORY',
    label: 'RFQ — Client Directory',
    group: 'RFQ · Automation',
    description: 'Look up and save client details in the shared directory.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
  {
    module: 'RFQ_COSTING',
    label: 'RFQ — Costing Sheets',
    group: 'RFQ · Costing & Offers',
    description: 'Open costing tools (Tundish Dryer, VLPH, Ladle Dryer) and edit rate inputs.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'TECHNICAL_PERSON'],
  },
  {
    module: 'RFQ_REVIEW',
    label: 'RFQ — Review & Verification',
    group: 'RFQ · Costing & Offers',
    description: 'Send an enquiry for review and complete the verification stage checks.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: LEADERSHIP,
  },
  {
    module: 'RFQ_APPROVAL',
    label: 'RFQ — Manager Approval',
    group: 'RFQ · Costing & Offers',
    description: 'Grant the final managerial sign-off on an enquiry.',
    actions: ['READ', 'WRITE'],
    // canFinalApproveRfq() today allows ADMIN/CO/GM only — PRODUCTION_HEAD verifies
    // and recommends but cannot grant the final approval.
    legacyGrantTo: ['ADMIN', 'CO', 'GM'],
  },
  {
    module: 'RFQ_OFFERS',
    label: 'RFQ — Offer Generator',
    group: 'RFQ · Costing & Offers',
    description: 'Generate the official PDF proposal and sync with the Offer Generator.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: [...LEADERSHIP, 'SALES_MARKETING'],
  },
];

/**
 * Superseded umbrella modules. RFQ_MGMT:WRITE/MANAGE/DELETE are still read by the
 * legacy canEditRfq()/isAdmin() helpers, so its grants are kept while those checks
 * exist. Delete this array once every RFQ call site reads the sub-capabilities.
 */
export const TRANSITIONAL_CAPABILITIES: CapabilityDef[] = [
  {
    module: 'RFQ_MGMT',
    label: 'RFQ — General Management (legacy umbrella)',
    group: 'RFQ · Legacy',
    description: 'Old blanket grant kept only so the not-yet-migrated checks keep working. Superseded by the RFQ sub-capabilities; do not grant new roles through this row.',
    actions: ['READ', 'WRITE', 'DELETE', 'MANAGE'],
    // Leadership only. RFQ_MGMT:MANAGE/WRITE is also read by the not-yet-migrated
    // canReviewRfq()/canFinalApproveRfq()/isAdmin() helpers, so granting it to a
    // broader set would silently hand out review and final-approval rights. Sales and
    // technical already pass those checks by name today, so they need nothing here;
    // their real rights are carried by the explicit sub-capabilities above.
    legacyGrantTo: LEADERSHIP,
  },
];

export const SYSTEM_CAPABILITIES: CapabilityDef[] = [
  {
    module: 'DASHBOARD',
    label: 'Executive Dashboard',
    group: 'System · Insight',
    description: 'View the landing dashboard and its KPI summary.',
    actions: ['READ'],
    // The dashboard route is open to every signed-in user today, so this grant only
    // describes intent — it is not yet enforced anywhere.
    legacyGrantTo: ['ADMIN', 'CO', 'GM', 'PRODUCTION_HEAD', 'SALES_MARKETING'],
  },
  {
    module: 'ANALYTICS',
    label: 'Employee Analytics',
    group: 'System · Insight',
    description: 'View technical, commercial and performance analytics for all staff.',
    actions: ['READ'],
    legacyGrantTo: ADMIN_ONLY,
  },
  {
    module: 'ACTIVITY_LOGS',
    label: 'Audit Activity Logs',
    group: 'System · Insight',
    description: 'Inspect the system activity trail and security logs.',
    actions: ['READ'],
    legacyGrantTo: ADMIN_ONLY,
  },
  {
    module: 'USER_MGMT',
    label: 'User Management',
    group: 'System · Administration',
    description: 'Create users, change their role assignment and enable or disable accounts.',
    actions: ['READ', 'WRITE', 'DELETE', 'MANAGE'],
    legacyGrantTo: ADMIN_ONLY,
  },
  {
    module: 'ROLE_MGMT',
    label: 'Role & Permission Matrix',
    group: 'System · Administration',
    description: 'Edit which capabilities each role holds, and create or delete custom roles.',
    actions: ['READ', 'WRITE', 'DELETE', 'MANAGE'],
    legacyGrantTo: ADMIN_ONLY,
  },
  {
    module: 'APP_MGMT',
    label: 'Application Access (SSO)',
    group: 'System · Administration',
    description: 'Grant or revoke single sign-on access to connected applications.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: ADMIN_ONLY,
  },
  {
    module: 'NOTIFICATIONS',
    label: 'Notification Broadcasts',
    group: 'System · Messaging',
    description: 'Send system-wide announcement notifications.',
    actions: ['READ', 'WRITE'],
    // createAnnouncement allows ADMIN/CO/GM/PRODUCTION_HEAD by role today.
    legacyGrantTo: LEADERSHIP,
  },
];

export const ORDER_CLIENT_CAPABILITIES: CapabilityDef[] = [
  {
    module: 'ORDER_MGMT',
    label: 'Order in Hand',
    group: 'Orders & Clients',
    description: 'View the order register. WRITE creates and edits orders, plus Excel import and export.',
    actions: ['READ', 'WRITE', 'DELETE'],
    // Matches ORDER_CLIENT_ROLES so switching the routes over changes nothing.
    legacyGrantTo: ['ADMIN', 'CO'],
  },
  {
    module: 'ORDER_PAYMENT',
    label: 'Order Payments Ledger',
    group: 'Orders & Clients',
    description: 'Record and amend payments received, misc payments and other charges against an order.',
    actions: ['READ', 'WRITE'],
    legacyGrantTo: ['ADMIN', 'CO'],
  },
  {
    module: 'CLIENT_MGMT',
    label: 'Client Master',
    group: 'Orders & Clients',
    description: 'View the client directory. WRITE adds or edits client records and addresses.',
    actions: ['READ', 'WRITE', 'DELETE'],
    legacyGrantTo: ['ADMIN', 'CO'],
  },
];

export const TALLY_CAPABILITIES: CapabilityDef[] = [
  {
    module: 'TALLY',
    label: 'Tally ERP Data & Books',
    group: 'Tally',
    description: 'Read vouchers, ledgers, debtors/creditors, bank transactions and the sales/purchase registers synced from Tally.',
    actions: ['READ', 'WRITE'],
    // The module row never existed in Permission before, so only ADMIN (which
    // bypasses) could reach Tally. Granting READ here is what makes it assignable.
    legacyGrantTo: ADMIN_ONLY,
  },
];

export const HR_CAPABILITIES: CapabilityDef[] = [
  {
    module: 'HR_OFFICES',
    label: 'Office / Branch Management',
    group: 'HR · People',
    description: 'Create and manage branch offices, their location, geofence radius and working-hour rules.',
    actions: ['READ', 'WRITE', 'DELETE'],
    legacyGrantTo: ['ADMIN', 'CO'],
  },
  {
    module: 'HR_EMPLOYEES',
    label: 'Employee Directory',
    group: 'HR · People',
    description: 'Manage employee records - assign a branch, designation, join date and employment type.',
    actions: ['READ', 'WRITE', 'DELETE'],
    legacyGrantTo: ['ADMIN', 'CO'],
  },
  {
    module: 'HR_ATTENDANCE',
    label: 'Attendance Register & Reports',
    group: 'HR · Attendance',
    description: 'View every employee\'s attendance, and edit or regularize punches. Self clock-in is a separate right.',
    actions: ['READ', 'WRITE', 'DELETE'],
    legacyGrantTo: ['ADMIN', 'CO', 'GM', 'PRODUCTION_HEAD'],
  },
  {
    module: 'ATTENDANCE_CLOCK',
    label: 'Clock In / Out (Self-service)',
    group: 'HR · Attendance',
    description: 'Let a signed-in employee clock in and out for themselves from the attendance app.',
    actions: ['WRITE'],
    // Every staff role can clock themselves in - this is the everyday right.
    legacyGrantTo: ALL_STAFF,
  },
];

/** Every capability the system knows about. Add later modules to this list. */
export const CAPABILITIES: CapabilityDef[] = [
  ...RFQ_CAPABILITIES,
  ...TRANSITIONAL_CAPABILITIES,
  ...SYSTEM_CAPABILITIES,
  ...ORDER_CLIENT_CAPABILITIES,
  ...TALLY_CAPABILITIES,
  ...HR_CAPABILITIES,
];

/** Every "MODULE:ACTION" key the catalogue implies. */
export const ALL_PERMISSION_KEYS: string[] = CAPABILITIES.flatMap((c) =>
  c.actions.map((a) => capabilityKey(c.module, a)),
);

/**
 * The exact capability set each role should hold to reproduce today's behaviour.
 * Used by the seed and by the rbac:sync script.
 */
export function grantsByRole(): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const def of CAPABILITIES) {
    for (const role of def.legacyGrantTo) {
      const key = role.toUpperCase();
      if (!out[key]) out[key] = new Set<string>();
      for (const action of def.actions) out[key].add(capabilityKey(def.module, action));
    }
  }
  // ADMIN bypasses every check server-side, so give it the full catalogue anyway —
  // its matrix then reads as a truthful reflection of its power.
  out['ADMIN'] = new Set(ALL_PERMISSION_KEYS);
  const result: Record<string, string[]> = {};
  for (const [role, set] of Object.entries(out)) result[role] = [...set].sort();
  return result;
}

/**
 * Places where the legacy grants deliberately do NOT reproduce the old code, because
 * the old check was a name-substring accident rather than an intended right. Each one
 * tightens access for a role, so they are listed here for explicit sign-off rather
 * than being silently buried in a permission table.
 *
 * 1. RFQ_REVIEW — canReviewRfq() also matched any role name containing TECH, DESIGN,
 *    REVIEW, APPROV or VERIF, so TECHNICAL_PERSON could review. Not granted.
 * 2. RFQ_ENTRY_DELETE / RFQ_BULK_DELETE — isAdmin() is not admin-only either: it lets
 *    CO, GM, PRODUCTION_HEAD and any SALES/MARKETING/SELLER name through, and it also
 *    accepts the invented keys RFQ:DELETE and USER_MGMT:MANAGE (USER_MGMT:MANAGE means
 *    a user-manager could delete RFQ records). Kept as-is in legacyGrantTo so nobody
 *    loses access on switch-over, but worth narrowing once the matrix is live.
 * 3. RFQ_ATTACHMENT_DELETE — the UI hid nothing and the API had no delete-specific
 *    check, so anyone who could upload could also remove another user's file.
 * 4. canEditRfq() bundled create, edit, client details, follow-up add and follow-up
 *    delete together; they are separate capabilities now by design, so a role that
 *    held the bundle receives each of the individual grants.
 */
export const DELIBERATE_TIGHTENINGS = [
  'RFQ_REVIEW: TECHNICAL_PERSON no longer inherits review rights from the "TECH" name substring.',
  'RFQ_APPROVAL: PRODUCTION_HEAD can verify and recommend but not grant final approval (matches canFinalApproveRfq).',
];

/**
 * Resolve "MODULE:ACTION" strings down to the module names they belong to, so a
 * check for one verb can also be satisfied by a broader grant on the same module.
 */
export function modulesIn(permissions: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of permissions || []) {
    const idx = String(p).lastIndexOf(':');
    if (idx > 0) out.add(p.slice(0, idx));
  }
  return out;
}
