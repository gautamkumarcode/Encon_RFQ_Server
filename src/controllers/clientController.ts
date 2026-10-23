import { Response } from 'express';
import { Client } from '../models/Client';
import { Enquiry } from '../models/Enquiry';
import { OrderInHand } from '../models/OrderInHand';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { normalizeNameKey } from '../utils/nameKey';

/**
 * Client master CRUD + per-client roll-up stats (how many enquiries, orders,
 * dispatched, total order value) so the client list answers "what have we done
 * for this party and when".
 */

const normKey = (name: string) => normalizeNameKey(name);

// Find an existing client by name, or create one. Used so referencing a party
// on an order auto-captures it in the master without a separate "add client".
// When the client already exists, any missing contact / email / address details
// from the seed are back-filled (never overwriting data already on file).
export interface ClientSeed {
  contactPerson?: string;
  mobile?: string;
  email?: string;
  country?: string;
  address?: Partial<{ line1: string; line2: string; city: string; state: string; country: string; pincode: string }>;
}

export async function findOrCreateClient(name: string, seed: ClientSeed = {}) {
  const key = normKey(name);
  if (!key) return null;
  let client = await Client.findOne({ nameKey: key });

  // Self-heal rows created before the normalizer tightened: an exact legacy key
  // (plain trim+uppercase) is re-stamped to the normalized key on first touch,
  // so we link to the existing client instead of creating a spelling duplicate.
  if (!client) {
    const legacy = (name || '').trim().toUpperCase();
    if (legacy !== key) client = await Client.findOne({ nameKey: legacy });
    if (client) {
      await Client.findByIdAndUpdate(client._id, { $set: { nameKey: key } });
      client.nameKey = key;
    }
  }

  if (!client) {
    const addr = seed.address;
    const hasAddr = !!(addr && (addr.line1?.trim() || addr.city?.trim()));
    client = await Client.create({
      name: name.trim(),
      nameKey: key,
      contactPerson: seed.contactPerson || '',
      mobile: seed.mobile || '',
      email: seed.email || '',
      country: seed.country || 'India',
      addresses: hasAddr ? [{ type: 'Billing', line1: addr!.line1 || '', line2: addr!.line2 || '', city: addr!.city || '', state: addr!.state || '', country: addr!.country || seed.country || 'India', pincode: addr!.pincode || '' }] : [],
    });
    return client;
  }

  // Back-fill only the gaps so an order/enquiry never erases curated data.
  const upd: any = {};
  if (!client.contactPerson && seed.contactPerson) upd.contactPerson = seed.contactPerson;
  if (!client.mobile && seed.mobile) upd.mobile = seed.mobile;
  if (!client.email && seed.email) upd.email = seed.email;
  if (seed.country && seed.country !== 'India' && (!client.country || client.country === 'India')) upd.country = seed.country;

  const addr = seed.address;
  if (addr && (addr.line1?.trim() || addr.city?.trim())) {
    const exists = (client.addresses || []).some(
      (a: any) => (a.line1 || '').trim().toLowerCase() === (addr.line1 || '').trim().toLowerCase()
        && (a.city || '').trim().toLowerCase() === (addr.city || '').trim().toLowerCase(),
    );
    if (!exists) {
      upd.addresses = [...(client.addresses || []), { type: 'Billing', line1: addr.line1 || '', line2: addr.line2 || '', city: addr.city || '', state: addr.state || '', country: addr.country || seed.country || client.country || 'India', pincode: addr.pincode || '' }];
    }
  }

  if (Object.keys(upd).length) {
    await Client.findByIdAndUpdate(client._id, { $set: upd });
    client = await Client.findById(client._id);
  }
  return client;
}

/** GET /api/clients — list with stats, optional search. */
export const listClients = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { search } = req.query;
    const where: any = {};
    if (search) where.name = { $regex: String(search), $options: 'i' };

    const clients = (await Client.find(where).sort({ name: 1 }).lean()) as any[];
    const ids = clients.map((c) => c._id);

    // Enquiries per client (match by linked client id OR legacy name equality).
    // Group on the raw companyName and upper-case it in JS — $toUpperCase is an
    // aggregation expression some MongoDB versions reject ("Unrecognized expression").
    const enqAgg = await Enquiry.aggregate([
      { $match: { $or: [{ client: { $in: ids } }, { companyName: { $in: clients.map((c) => c.name) } }] } },
      { $group: { _id: '$companyName', n: { $sum: 1 } } },
    ]);
    // Orders per client.
    const ordAgg = await OrderInHand.aggregate([
      { $match: { client: { $in: ids } } },
      { $group: {
        _id: '$client',
        orders: { $sum: 1 },
        value: { $sum: '$orderValueINR' },
        dispatched: { $sum: { $cond: [{ $in: ['$status', ['Dispatched', 'Closed']] }, 1, 0] } },
      } },
    ]);

    const ordById: Record<string, any> = {};
    for (const o of ordAgg) ordById[String(o._id)] = o;
    const enqByName: Record<string, number> = {};
    for (const e of enqAgg) enqByName[normKey(String(e._id || ''))] = e.n;

    const data = clients.map((c) => {
      const o = ordById[String(c._id)] || {};
      return {
        id: c._id.toString(),
        name: c.name,
        contactPerson: c.contactPerson,
        mobile: c.mobile,
        email: c.email,
        gstin: c.gstin,
        country: c.country,
        addresses: c.addresses || [],
        enquiryCount: enqByName[normKey(c.name)] || 0,
        orderCount: o.orders || 0,
        dispatchedCount: o.dispatched || 0,
        orderValueINR: o.value || 0,
      };
    });

    return res.json({ success: true, count: data.length, data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /api/clients/:id — one client + its enquiries and orders. */
export const getClientById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const client = (await Client.findById(req.params.id).lean()) as any;
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const [enquiries, orders] = await Promise.all([
      Enquiry.find({ $or: [{ client: client._id }, { companyName: client.name }] })
        .sort({ createdAt: -1 })
        .select('rfqId companyName itemDescription status dateReceived offerNo offerNo createdAt')
        .lean(),
      OrderInHand.find({ client: client._id }).sort({ poDate: -1 }).lean(),
    ]);

    return res.json({ success: true, data: { ...client, id: client._id }, enquiries, orders });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** POST /api/clients — create or update-by-name (upsert) a client. */
export const upsertClient = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, contactPerson, mobile, email, gstin, country, addresses, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Client name is required' });
    }
    const client = await findOrCreateClient(String(name), { contactPerson, mobile, email, country });
    if (!client) return res.status(400).json({ success: false, message: 'Invalid client name' });

    const upd: any = {};
    if (contactPerson !== undefined) upd.contactPerson = contactPerson;
    if (mobile !== undefined) upd.mobile = mobile;
    if (email !== undefined) upd.email = email;
    if (gstin !== undefined) upd.gstin = gstin;
    if (country !== undefined) upd.country = country;
    if (notes !== undefined) upd.notes = notes;
    if (Array.isArray(addresses)) upd.addresses = addresses;

    const saved = Object.keys(upd).length
      ? await Client.findByIdAndUpdate(client._id, { $set: upd }, { new: true }).lean()
      : client;

    return res.json({ success: true, data: { ...saved, id: saved._id } });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** DELETE /api/clients/:id */
export const deleteClient = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const deleted = await Client.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Client not found' });
    return res.json({ success: true, message: 'Client deleted' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
