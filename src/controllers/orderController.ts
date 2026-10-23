import { Response } from 'express';
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
    orderValueINR: o.orderValueINR,
    termsOfPayment: o.termsOfPayment,
    advanceAmount: o.advanceAmount,
    advanceReceivedDate: o.advanceReceivedDate,
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

    return res.json({ success: true, count: data.length, totalINR, openINR, data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /api/orders/summary — { count, totalINR, openINR } for the chip. */
export const ordersSummary = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const agg: any[] = await OrderInHand.aggregate([
      { $group: {
        _id: null,
        count: { $sum: 1 },
        totalINR: { $sum: '$orderValueINR' },
        openINR: { $sum: { $cond: [{ $not: { $in: ['$status', ['Dispatched', 'Closed']] } }, '$orderValueINR', 0] } },
        openCount: { $sum: { $cond: [{ $not: { $in: ['$status', ['Dispatched', 'Closed']] } }, 1, 0] } },
      } },
    ]);
    const s = agg[0] || { count: 0, totalINR: 0, openINR: 0, openCount: 0 };
    return res.json({ success: true, data: { count: s.count, totalINR: s.totalINR, openINR: s.openINR, openCount: s.openCount } });
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
    contactPerson, mobile, email, country, address,
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

  return {
    client: clientRef || null,
    clientName: resolvedName,
    enquiry: enquiryId || null,
    jobNo: jobNo || '',
    rfqId: rfqId || '',
    poNumber: poNumber || '',
    poDate: toDateOrNull(poDate),
    orderReceivedDate: toDateOrNull(orderReceivedDate),
    lineItems: Array.isArray(lineItems)
      ? lineItems.map((li: any) => ({ description: li.description || '', qty: Number(li.qty) || 0, value: Number(li.value) || 0 }))
      : [],
    currency: currency || 'INR',
    orderValueINR: Number(orderValueINR) || 0,
    termsOfPayment: termsOfPayment || '',
    advanceAmount: Number(advanceAmount) || 0,
    advanceReceivedDate: toDateOrNull(advanceReceivedDate),
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
