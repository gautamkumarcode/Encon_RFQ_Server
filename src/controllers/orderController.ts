import { Response } from 'express';
import * as XLSX from 'xlsx';
import { OrderInHand } from '../models/OrderInHand';
import { Enquiry } from '../models/Enquiry';
import { Client } from '../models/Client';
import { findOrCreateClient } from './clientController';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

/**
 * Order in Hand CRUD + the "PO Received" handoff.
 *
 * prefillFromEnquiry() returns the client + item data already known from an
 * enquiry, so when a PO is received the user only fills the order-specific
 * fields (PO no/date, values, terms, dispatch, PI, status) — never the whole
 * client address again.
 */

const toDateOrNull = (v: any) => (v ? new Date(v) : null);

function serialize(o: any) {
  return {
    id: o._id.toString(),
    client: o.client ? String(o.client) : null,
    clientName: o.clientName,
    enquiry: o.enquiry ? String(o.enquiry) : null,
    jobNo: o.jobNo,
    rfqId: o.rfqId,
    poNumber: o.poNumber,
    poDate: o.poDate,
    orderReceivedDate: o.orderReceivedDate,
    lineItems: o.lineItems || [],
    currency: o.currency,
    orderValue: o.orderValue,
    fxRate: o.fxRate || 0,
    orderValueINR: o.orderValueINR,
    termsOfPayment: o.termsOfPayment,
    advanceAmount: o.advanceAmount,
    advanceReceivedDate: o.advanceReceivedDate,
    payments: o.payments || [],
    totalReceived: (o.payments || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0),
    ldApplicable: !!o.ldApplicable,
    ldPercentage: o.ldPercentage || 0,
    dispatchAsPerPo: o.dispatchAsPerPo,
    expectedDespatch: o.expectedDespatch,
    piNumber: o.piNumber,
    piDate: o.piDate,
    status: o.status,
    currentStatusNote: o.currentStatusNote,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** GET /api/orders — list with totals + optional search/status filter. */
export const listOrders = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { search, status } = req.query;
    const where: any = {};
    if (status) where.status = String(status);
    if (search) {
      where.$or = [
        { clientName: { $regex: String(search), $options: 'i' } },
        { poNumber: { $regex: String(search), $options: 'i' } },
        { jobNo: { $regex: String(search), $options: 'i' } },
      ];
    }

    const rows = (await OrderInHand.find(where).sort({ poDate: -1, createdAt: -1 }).lean()) as any[];
    const data = rows.map(serialize);
    const totalINR = data.reduce((s, r) => s + (r.orderValueINR || 0), 0);
    const openINR = data
      .filter((r) => !['Dispatched', 'Closed'].includes(r.status))
      .reduce((s, r) => s + (r.orderValueINR || 0), 0);
    const openCount = data.filter((r) => !['Dispatched', 'Closed'].includes(r.status)).length;
    // Payment chips: money received vs still pending (per-order floor at 0 so
    // an overpaid order never hides another order's dues).
    const receivedINR = data.reduce((s, r) => s + (r.totalReceived || 0), 0);
    const pendingINR = data.reduce((s, r) => s + Math.max(0, (r.orderValueINR || 0) - (r.totalReceived || 0)), 0);

    return res.json({ success: true, count: data.length, totalINR, openINR, openCount, receivedINR, pendingINR, data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /api/orders/summary — { count, totalINR, openINR, receivedINR, pendingINR } for the chips. */
export const ordersSummary = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const agg: any[] = await OrderInHand.aggregate([
      { $addFields: {
        received: {
          $reduce: {
            input: { $ifNull: ['$payments', []] },
            initialValue: 0,
            in: { $add: ['$$value', { $ifNull: ['$$this.amount', 0] }] },
          },
        },
      } },
      { $group: {
        _id: null,
        count: { $sum: 1 },
        totalINR: { $sum: '$orderValueINR' },
        receivedINR: { $sum: '$received' },
        pendingINR: { $sum: { $max: [0, { $subtract: ['$orderValueINR', '$received'] }] } },
        openINR: { $sum: { $cond: [{ $not: { $in: ['$status', ['Dispatched', 'Closed']] } }, '$orderValueINR', 0] } },
        openCount: { $sum: { $cond: [{ $not: { $in: ['$status', ['Dispatched', 'Closed']] } }, 1, 0] } },
      } },
    ]);
    const s = agg[0] || { count: 0, totalINR: 0, receivedINR: 0, pendingINR: 0, openINR: 0, openCount: 0 };
    return res.json({
      success: true,
      data: {
        count: s.count,
        totalINR: s.totalINR,
        receivedINR: s.receivedINR,
        pendingINR: s.pendingINR,
        openINR: s.openINR,
        openCount: s.openCount,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /api/orders/prefill/:enquiryId — client + items to seed a new order. */
export const prefillFromEnquiry = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const enq: any = await Enquiry.findById(req.params.enquiryId).lean();
    if (!enq) return res.status(404).json({ success: false, message: 'Enquiry not found' });

    // Copy the enquiry's known client details (contact + address) into the master,
    // back-filling anything missing, so the order only needs the order-specific fields.
    const enqAddress = enq.address || null;
    const client = enq.companyName ? await findOrCreateClient(enq.companyName, {
      contactPerson: enq.contactPerson, mobile: enq.mobile, email: enq.email,
      country: enqAddress?.country, address: enqAddress || undefined,
    }) : null;
    const clientDoc: any = client ? await Client.findById(client._id).lean() : null;

    return res.json({
      success: true,
      data: {
        enquiryId: String(enq._id),
        jobNo: enq.rfqId || '',
        rfqId: enq.rfqId || '',
        clientId: clientDoc ? String(clientDoc._id) : null,
        clientName: enq.companyName || '',
        addresses: clientDoc?.addresses || [],
        contactPerson: enq.contactPerson || clientDoc?.contactPerson || '',
        mobile: enq.mobile || clientDoc?.mobile || '',
        email: enq.email || clientDoc?.email || '',
        country: enqAddress?.country || clientDoc?.country || 'India',
        address: (enqAddress && (enqAddress.line1 || enqAddress.city))
          ? enqAddress
          : (clientDoc?.addresses?.[0] || null),
        // One starting line item from the enquiry's description.
        lineItems: enq.itemDescription ? [{ description: enq.itemDescription, qty: 1, value: 0 }] : [],
        piNumber: enq.offerNo || '',
        currency: ((enqAddress?.country || clientDoc?.country) && (enqAddress?.country || clientDoc.country).toUpperCase() !== 'INDIA') ? 'USD' : 'INR',
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /api/orders/:id */
export const getOrderById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const o: any = await OrderInHand.findById(req.params.id).lean();
    if (!o) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.json({ success: true, data: serialize(o) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Shared body -> fields mapping for create/update.
async function mapBody(body: any) {
  const {
    clientName, clientId, enquiryId, jobNo, rfqId, poNumber, poDate, orderReceivedDate,
    lineItems, currency, orderValueINR, termsOfPayment, advanceAmount, advanceReceivedDate,
    dispatchAsPerPo, expectedDespatch, piNumber, piDate, status, currentStatusNote,
    contactPerson, mobile, email, country, address, payments, ldApplicable, ldPercentage,
  } = body || {};

  // Persist the client details typed on the order into the master (back-fills gaps).
  let clientRef: any = clientId || null;
  let resolvedName = clientName || '';
  if (clientName) {
    const c: any = await findOrCreateClient(String(clientName), { contactPerson, mobile, email, country, address });
    if (c) { clientRef = c._id; resolvedName = c.name; }
  }

  // Copy the captured address back onto the source enquiry (only if it has none),
  // so the enquiry record keeps the client's full details too.
  if (enquiryId && address && (String(address.line1 || '').trim() || String(address.city || '').trim())) {
    const enq: any = await Enquiry.findById(enquiryId).lean();
    if (enq && !(enq.address && (enq.address.line1 || enq.address.city))) {
      await Enquiry.findByIdAndUpdate(enquiryId, {
        $set: {
          client: clientRef || enq.client || null,
          address: {
            line1: address.line1 || '', line2: address.line2 || '', city: address.city || '',
            state: address.state || '', country: address.country || country || 'India', pincode: address.pincode || '',
          },
        },
      });
    }
  }

  // Derive the money fields here rather than relying on the model's pre-validate
  // hook: updateOrder uses findByIdAndUpdate, which does NOT run document
  // middleware, so without this the stored orderValue would go stale whenever a
  // line item was edited (the balance would not move). orderValue is always the
  // sum of the line items; for INR orders the INR total equals it, for foreign
  // orders we keep the user-entered INR equivalent.
  const cleanLineItems = Array.isArray(lineItems)
    ? lineItems.map((li: any) => ({ description: li.description || '', qty: Number(li.qty) || 0, value: Number(li.value) || 0 }))
    : [];
  const lineSum = cleanLineItems.reduce((s: number, li: any) => s + (li.value || 0), 0);
  const cur = (currency || 'INR').toUpperCase();
  const orderValue = lineSum > 0 ? lineSum : (Number(body.orderValue) || 0);
  const orderValueINRFinal = cur === 'INR' ? orderValue : (Number(orderValueINR) || 0);
  // Rate the user typed for this order (INR per 1 foreign unit); 0 for INR.
  const fxRate = cur === 'INR' ? 0 : Number(body.fxRate) || 0;

  return {
    client: clientRef || null,
    clientName: resolvedName,
    enquiry: enquiryId || null,
    jobNo: jobNo || '',
    rfqId: rfqId || '',
    poNumber: poNumber || '',
    poDate: toDateOrNull(poDate),
    orderReceivedDate: toDateOrNull(orderReceivedDate),
    lineItems: cleanLineItems,
    currency: currency || 'INR',
    orderValue,
    fxRate,
    orderValueINR: orderValueINRFinal,
    termsOfPayment: termsOfPayment || '',
    advanceAmount: Number(advanceAmount) || 0,
    advanceReceivedDate: toDateOrNull(advanceReceivedDate),
    payments: Array.isArray(payments)
      ? payments
          .map((p: any) => ({
            type: String(p?.type || 'Advance').trim() || 'Advance',
            amount: Number(p?.amount) || 0,
            date: p?.date ? toDateOrNull(p.date) : null,
            note: String(p?.note || ''),
          }))
          // Drop blank rows (no amount and no note) so the ledger stays clean.
          .filter((p: any) => p.amount > 0 || p.note.trim())
      : [],
    ldApplicable: !!ldApplicable,
    // Store a rate only when LD applies; a blank/zero stays 0.
    ldPercentage: ldApplicable ? Number(ldPercentage) || 0 : 0,
    dispatchAsPerPo: toDateOrNull(dispatchAsPerPo),
    expectedDespatch: toDateOrNull(expectedDespatch),
    piNumber: piNumber || '',
    piDate: toDateOrNull(piDate),
    status: status || 'Received',
    currentStatusNote: currentStatusNote || '',
  };
}

/** POST /api/orders */
export const createOrder = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fields = await mapBody(req.body);
    if (!fields.clientName) {
      return res.status(400).json({ success: false, message: 'Client name is required' });
    }
    const created = await OrderInHand.create(fields);
    return res.status(201).json({ success: true, data: serialize(created.toObject()) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** PUT /api/orders/:id */
export const updateOrder = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fields = await mapBody(req.body);
    const updated: any = await OrderInHand.findByIdAndUpdate(req.params.id, { $set: fields }, { new: true }).lean();
    if (!updated) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.json({ success: true, data: serialize(updated) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** DELETE /api/orders/:id */
export const deleteOrder = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const deleted = await OrderInHand.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.json({ success: true, message: 'Order deleted' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Excel import of previous orders ("Despatch Detail" register format).
//
// The sheet records ONE order across several rows sharing the same SR NO + JOB
// NO: a main party line (client + item + qty + value), optional extra party
// lines (plant / consignee), and a final line whose PARTY NAME holds the PO
// number ("PO NO-2410300810") plus a TOTAL value. We group rows by SR|JOB and
// collapse each group into a single OrderInHand draft. `?dry=1` returns a
// preview without writing, so the user can confirm the parse first.
// ---------------------------------------------------------------------------

const normHeader = (s: any) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cellStr = (row: any[], i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
const cellNum = (row: any[], i: number) => {
  const s = cellStr(row, i);
  if (!s) return 0;
  const n = Number(s.replace(/[,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};

// Accepts a JS Date, an Excel serial number, or DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY.
function parseDateVal(v: any): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (m) {
    let day = +m[1], mon = +m[2], year = +m[3];
    if (year < 100) year += 2000;
    const d = new Date(year, mon - 1, day);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const cellDate = (row: any[], i: number) => (i >= 0 ? parseDateVal(row[i]) : null);

// Pull the PO number out of a party cell like "PO NO-2410300810".
function extractPo(party: string): string | null {
  const m = party.match(/PO\s*NO[:\-/ ]?\s*([A-Za-z0-9\-/]+)/i);
  return m ? m[1] : null;
}

// Locate the header row + column indices by fuzzy-matching normalized headers.
function locateColumns(rows: any[][]) {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const cells = rows[r].map(normHeader);
    const firstIdx = (pred: (k: string) => boolean) => {
      for (let i = 0; i < cells.length; i++) if (cells[i] && pred(cells[i])) return i;
      return -1;
    };
    const job = firstIdx((k) => k.startsWith('JOBNO'));
    const party = firstIdx((k) => k.startsWith('PARTY'));
    if (job < 0 || party < 0) continue;
    return {
      headerRow: r,
      C: {
        sr: firstIdx((k) => k.startsWith('SRNO') || k === 'SR'),
        job,
        party,
        poDate: firstIdx((k) => k.startsWith('PODATE')),
        item: firstIdx((k) => k.startsWith('ITEM')),
        qty: firstIdx((k) => k.startsWith('QTY') || k.startsWith('QUANTITY')),
        value: firstIdx((k) => k.startsWith('BASICORDERVALUE') || k.startsWith('ORDERVALUE') || k.startsWith('BASIC')),
        ordDate: firstIdx((k) => k.startsWith('ORDERRECD') || k.startsWith('ORDERREC') || k.startsWith('ORDERDATE')),
        terms: firstIdx((k) => k.startsWith('TERMS')),
        advance: firstIdx((k) => k.startsWith('ADVANCE') || k.startsWith('ADVPAY')),
        dispatch: firstIdx((k) => k.startsWith('DISPATCH')),
        expected: firstIdx((k) => k.startsWith('EXPECTED')),
        pi: firstIdx((k) => k.startsWith('PINO')),
        remarks: firstIdx((k) => k.startsWith('REMARK')),
      },
    };
  }
  return null;
}

interface OrderDraft {
  jobNo: string;
  clientName: string;
  poNumber: string;
  orderValueINR: number;
  itemCount: number;
  duplicate: boolean;
  payload: any;
}

/** POST /api/orders/import — bulk import previous orders from an Excel sheet. */
export const importOrdersExcel = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const file = (req as any).file;
    if (!file) return res.status(400).json({ success: false, message: 'No Excel file provided' });
    const dryRun = String(req.query.dry ?? '') === '1';

    const workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

    const located = locateColumns(rows);
    if (!located) {
      return res.status(400).json({ success: false, message: 'Could not find the order header row (needs JOB NO and PARTY NAME columns).' });
    }
    const { headerRow, C } = located;

    // Group consecutive rows by SR|JOB (carry the last non-empty SR/JOB forward).
    const groups = new Map<string, any[][]>();
    let lastSr = '';
    let lastJob = '';
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r];
      const party = cellStr(row, C.party);
      const item = cellStr(row, C.item);
      const value = cellStr(row, C.value);
      const sr = cellStr(row, C.sr);
      const job = cellStr(row, C.job);
      if (!party && !item && !value && !job && !sr) continue;
      const curSr = sr || lastSr;
      const curJob = job || lastJob;
      if (sr) lastSr = sr;
      if (job) lastJob = job;
      const key = `${curSr}#${curJob}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    // Collapse each group into one order draft.
    const drafts: OrderDraft[] = [];
    for (const [, grp] of groups) {
      let clientName = '';
      let poNumber = '';
      let terms = '';
      let remarks = '';
      let pi = '';
      let poDate: Date | null = null;
      let ordDate: Date | null = null;
      let dispatch: Date | null = null;
      let expected: Date | null = null;
      let advance = 0;
      let totalValue = 0;
      const lineItems: { description: string; qty: number; value: number }[] = [];

      for (const row of grp) {
        const party = cellStr(row, C.party);
        const po = party ? extractPo(party) : null;
        if (po && !poNumber) poNumber = po;
        else if (party && !po && !clientName) clientName = party;

        const item = cellStr(row, C.item);
        const qty = cellNum(row, C.qty);
        const val = cellNum(row, C.value);
        if (item && normHeader(item) !== 'TOTAL') lineItems.push({ description: item, qty, value: val });
        if (normHeader(item) === 'TOTAL' && val) totalValue = val;

        if (!poDate) poDate = cellDate(row, C.poDate);
        if (!ordDate) ordDate = cellDate(row, C.ordDate);
        if (!terms) terms = cellStr(row, C.terms);
        if (!advance) advance = cellNum(row, C.advance);
        if (!dispatch) dispatch = cellDate(row, C.dispatch);
        if (!expected) expected = cellDate(row, C.expected);
        if (!pi) pi = cellStr(row, C.pi);
        if (!remarks) remarks = cellStr(row, C.remarks);
      }

      if (!clientName && !poNumber) continue;
      const jobNo = cellStr(grp[0], C.job);
      // The register's authoritative figure is the TOTAL row. When it differs
      // from the sum of the parsed item rows (e.g. the item row carries only the
      // basic value while TOTAL includes GST/charges), trust the TOTAL and align
      // a single line item to it — so the stored order value matches the sheet
      // and stays consistent with the orderValue == sum(lineItems) invariant.
      const lineSum = lineItems.reduce((s, li) => s + li.value, 0);
      if (totalValue > 0 && totalValue !== lineSum && lineItems.length === 1) {
        lineItems[0].value = totalValue;
      }
      const orderValueINR = totalValue || lineSum;
      const payload = {
        clientName,
        jobNo,
        poNumber,
        poDate: poDate ? poDate.toISOString() : null,
        orderReceivedDate: ordDate ? ordDate.toISOString() : null,
        lineItems,
        currency: 'INR',
        orderValueINR,
        termsOfPayment: terms,
        advanceAmount: advance,
        dispatchAsPerPo: dispatch ? dispatch.toISOString() : null,
        expectedDespatch: expected ? expected.toISOString() : null,
        piNumber: pi,
        status: 'Received',
        currentStatusNote: remarks,
      };
      drafts.push({ jobNo, clientName, poNumber, orderValueINR, itemCount: lineItems.length, duplicate: false, payload });
    }

    // Flag rows whose PO number already exists so we neither preview nor write dupes.
    const pos = drafts.map((d) => d.poNumber).filter(Boolean);
    if (pos.length) {
      const existing = new Set(
        (await OrderInHand.find({ poNumber: { $in: pos } }).select('poNumber').lean()).map((o: any) => o.poNumber),
      );
      for (const d of drafts) if (d.poNumber && existing.has(d.poNumber)) d.duplicate = true;
    }

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        total: drafts.length,
        orders: drafts.map((d) => ({
          jobNo: d.jobNo,
          clientName: d.clientName,
          poNumber: d.poNumber,
          orderValueINR: d.orderValueINR,
          itemCount: d.itemCount,
          duplicate: d.duplicate,
        })),
      });
    }

    let created = 0;
    let skipped = 0;
    for (const d of drafts) {
      if (d.duplicate) { skipped++; continue; }
      const fields = await mapBody(d.payload);
      if (!fields.clientName) { skipped++; continue; }
      await OrderInHand.create(fields);
      created++;
    }
    return res.json({ success: true, dryRun: false, total: drafts.length, created, skipped });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Excel export of the order book ("Despatch Detail" register format).
//
// Mirrors the importer so an export can be reviewed, shared, or re-imported.
// Each order is emitted as its line-item rows (main party) followed by a final
// "PO NO-<po>" TOTAL row — exactly the grouping `importOrdersExcel` collapses.
// Honors the same search/status filters as the list, so the file matches what
// the user sees on screen. Dates use DD.MM.YYYY like the source register.
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtDateCell = (v: any): string => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
};

/** GET /api/orders/export — download the (filtered) order book as .xlsx. */
export const exportOrdersExcel = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { search, status } = req.query;
    const where: any = {};
    if (status) where.status = String(status);
    if (search) {
      where.$or = [
        { clientName: { $regex: String(search), $options: 'i' } },
        { poNumber: { $regex: String(search), $options: 'i' } },
        { jobNo: { $regex: String(search), $options: 'i' } },
      ];
    }

    const rows = (await OrderInHand.find(where).sort({ poDate: -1, createdAt: -1 }).lean()) as any[];
    const orders = rows.map(serialize);

    const TITLE = ['Despatch Detail'];
    const HEADER = [
      'SR. NO', 'JOB NO.', 'PARTY NAME', 'P.O. DATE', 'ITEM DESCRIPTION', 'QTY.',
      'BASIC ORDER VALUE', 'ORDER RECD. DATE', 'TERMS OF PAYMENT', 'ADVANCE PAYMENT',
      'DISPATCH - AS PER PO', 'EXPECTED DESPATCH', 'P.I. NO. & DATE', 'REMARKS',
    ];
    const aoa: any[][] = [TITLE, HEADER];

    orders.forEach((o: any, idx: number) => {
      const sr = idx + 1;
      const items = Array.isArray(o.lineItems) && o.lineItems.length
        ? o.lineItems
        : [{ description: '', qty: 0, value: o.orderValueINR || 0 }];
      // One row per line item under the main party (client) name.
      items.forEach((li: any, liIdx: number) => {
        aoa.push([
          liIdx === 0 ? sr : '',
          liIdx === 0 ? o.jobNo : '',
          o.clientName,
          fmtDateCell(o.poDate),
          li.description || '',
          li.qty || '',
          li.value || 0,
          fmtDateCell(o.orderReceivedDate),
          o.termsOfPayment || '',
          liIdx === 0 ? (o.advanceAmount || '') : '',
          fmtDateCell(o.dispatchAsPerPo),
          fmtDateCell(o.expectedDespatch),
          liIdx === 0 ? (o.piNumber || '') : '',
          liIdx === 0 ? (o.currentStatusNote || '') : '',
        ]);
      });
      // Closing row: PO number in the party column + TOTAL order value.
      aoa.push([
        sr,
        o.jobNo,
        o.poNumber ? `PO NO-${o.poNumber}` : '',
        fmtDateCell(o.poDate),
        'TOTAL',
        '',
        o.orderValueINR || 0,
        fmtDateCell(o.orderReceivedDate),
        o.termsOfPayment || '',
        '',
        fmtDateCell(o.dispatchAsPerPo),
        fmtDateCell(o.expectedDespatch),
        o.piNumber || '',
        o.status || '',
      ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 6 }, { wch: 9 }, { wch: 32 }, { wch: 12 }, { wch: 42 }, { wch: 6 },
      { wch: 16 }, { wch: 14 }, { wch: 36 }, { wch: 14 }, { wch: 16 }, { wch: 16 },
      { wch: 18 }, { wch: 28 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Despatch Detail');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = `encon_orders_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(buf);
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
