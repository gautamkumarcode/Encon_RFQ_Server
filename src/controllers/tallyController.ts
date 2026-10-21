import { Response } from 'express';
import { TallyVoucher } from '../models/TallyVoucher';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

/**
 * GET /api/tally/vouchers
 * Query params:
 *   type   - optional voucher type filter (e.g. "Credit Note", "Payment")
 *   party  - optional case-insensitive party name filter
 *   from   - optional ISO date (voucher date >= from)
 *   to     - optional ISO date (voucher date <= to)
 *   limit  - optional max rows (default 200)
 *
 * Returns vouchers (newest first) + summary (count, total amount, last sync).
 */
export const getVouchers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { type, party, from, to, limit = 200 } = req.query;

    const where: any = {};
    if (type) where.voucherType = String(type);
    if (party) where.partyName = { $regex: String(party), $options: 'i' };
    if (from || to) {
      where.date = {};
      if (from) where.date.$gte = new Date(String(from));
      if (to) where.date.$lte = new Date(String(to));
    }

    const records = await TallyVoucher.find(where)
      .sort({ date: -1 })
      .limit(Number(limit))
      .lean();

    const totalAmount = records.reduce((sum, r) => sum + (r.amount || 0), 0);
    const lastSynced = records.length > 0 ? records[0].syncedAt : null;

    const formatted = records.map((r: any) => ({
      id: r._id.toString(),
      company: r.company,
      voucherType: r.voucherType,
      voucherNumber: r.voucherNumber,
      date: r.date,
      partyName: r.partyName,
      amount: r.amount,
      syncedAt: r.syncedAt,
    }));

    return res.json({
      success: true,
      count: formatted.length,
      totalAmount,
      lastSynced,
      data: formatted,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/tally/voucher-types
 * Returns the distinct voucher types present in the DB (for the UI filter).
 */
export const getVoucherTypes = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const types = await TallyVoucher.distinct('voucherType');
    return res.json({ success: true, data: types.sort() });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
