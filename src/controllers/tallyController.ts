import { Response } from 'express';
import { TallyVoucher } from '../models/TallyVoucher';
import { TallyBook } from '../models/TallyBook';
import { TallyBankTxn } from '../models/TallyBankTxn';
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

/**
 * GET /api/tally/books
 * Query params:
 *   category - Debtors | Creditors | Bank | Cash | SalesOrder | PurchaseOrder (required)
 *   search   - optional case-insensitive name filter
 *   limit    - optional max rows (default 500)
 *
 * Returns one category's rows (largest amount first) + total + last sync.
 */
export const getBooks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { category, search, limit = 500 } = req.query;
    if (!category) {
      return res.status(400).json({ success: false, message: 'category is required' });
    }

    const where: any = { category: String(category) };
    if (search) where.name = { $regex: String(search), $options: 'i' };

    const records = await TallyBook.find(where)
      .sort({ amount: -1 })
      .limit(Number(limit))
      .lean();

    const total = records.reduce((sum, r) => sum + (r.amount || 0), 0);
    const lastSynced = records.length > 0 ? records[0].syncedAt : null;

    const formatted = records.map((r: any) => ({
      id: r._id.toString(),
      company: r.company,
      category: r.category,
      name: r.name,
      ref: r.ref,
      date: r.date,
      amount: r.amount,
      opening: r.opening ?? 0,
      syncedAt: r.syncedAt,
    }));

    return res.json({
      success: true,
      category: String(category),
      count: formatted.length,
      total,
      lastSynced,
      data: formatted,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/tally/books/summary
 * Per-category { count, total } for the summary cards. Orders in Hand is the
 * combined SalesOrder + PurchaseOrder value.
 */
export const getBooksSummary = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    // count reflects only ledgers with a non-zero closing balance, so dormant
    // accounts (kept in the DB for the "Show nil-balance" toggle) don't inflate
    // the summary — it matches the list's default (nil-hidden) view.
    // totalPositive = sum of Dr-positive balances, used for the Bank card so an
    // overdraft (credit balance) isn't netted into "funds in bank".
    const grouped: { _id: string; count: number; total: number; totalPositive: number; totalOpening: number }[] = await TallyBook.aggregate([
      { $group: {
        _id: '$category',
        count: { $sum: { $cond: [{ $gte: [{ $abs: '$amount' }, 0.5] }, 1, 0] } },
        total: { $sum: '$amount' },
        totalPositive: { $sum: { $cond: [{ $gt: ['$amount', 0] }, '$amount', 0] } },
        totalOpening: { $sum: '$opening' },
      } },
    ]);

    const byCat: Record<string, { count: number; total: number; totalPositive: number; totalOpening: number }> = {};
    for (const g of grouped) byCat[g._id] = { count: g.count, total: g.total, totalPositive: g.totalPositive, totalOpening: g.totalOpening || 0 };

    const zero = { count: 0, total: 0, totalPositive: 0, totalOpening: 0 };
    const lastAgg: any[] = await TallyBook.aggregate([{ $sort: { syncedAt: -1 } }, { $limit: 1 }, { $project: { syncedAt: 1 } }]);

    return res.json({
      success: true,
      lastSynced: lastAgg.length ? lastAgg[0].syncedAt : null,
      data: {
        Debtors: byCat['Debtors'] || zero,
        Creditors: byCat['Creditors'] || zero,
        // Bank card = funds in bank (Dr-positive balances only); the overdraft
        // (credit balance) is excluded here but still shown in the Bank list.
        Bank: { ...(byCat['Bank'] || zero), total: byCat['Bank']?.totalPositive ?? 0 },
        Cash: byCat['Cash'] || zero,
        SalesOrder: byCat['SalesOrder'] || zero,
        PurchaseOrder: byCat['PurchaseOrder'] || zero,
        OrdersInHand: {
          count: (byCat['SalesOrder']?.count || 0) + (byCat['PurchaseOrder']?.count || 0),
          total: (byCat['SalesOrder']?.total || 0) + (byCat['PurchaseOrder']?.total || 0),
        },
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/tally/banks/transactions
 * Query params:
 *   bank    - the bank/cash ledger name (required)
 *   company - optional company filter
 *
 * Returns the account's transaction ledger (oldest first) with a running
 * balance seeded from the account's opening balance, plus opening/closing.
 */
export const getBankTransactions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { bank, company, from, to } = req.query;
    if (!bank) return res.status(400).json({ success: false, message: 'bank is required' });
    const bankName = String(bank);
    const companyFilter = company ? { company: String(company) } : {};

    // Optional date window (YYYY-MM-DD). Stored dates are UTC midnight.
    const fromDate = from ? new Date(String(from)) : null;
    const toDate = to ? new Date(String(to)) : null;
    const validFrom = fromDate && !isNaN(fromDate.getTime()) ? fromDate : null;
    const validTo = toDate && !isNaN(toDate.getTime()) ? new Date(toDate.getTime() + 86400000 - 1) : null;

    const txnWhere: any = { bank: bankName, ...companyFilter };
    if (validFrom || validTo) {
      txnWhere.date = {};
      if (validFrom) txnWhere.date.$gte = validFrom;
      if (validTo) txnWhere.date.$lte = validTo;
    }
    const txns = await TallyBankTxn.find(txnWhere).sort({ date: 1, voucherNumber: 1 }).lean();

    const bookWhere: any = { name: bankName, category: { $in: ['Bank', 'Cash'] }, ...(company ? { company: String(company) } : {}) };
    const book: any = await TallyBook.findOne(bookWhere).lean();
    const fyOpening = book?.opening ?? 0;

    // Balance carried forward to the start of the window = FY opening plus every
    // posting strictly BEFORE it, so the running balance stays exact when filtered.
    let periodOpening = fyOpening;
    if (validFrom) {
      const prior = await TallyBankTxn.aggregate([
        { $match: { bank: bankName, ...companyFilter, date: { $lt: validFrom } } },
        { $group: { _id: null, dr: { $sum: '$debit' }, cr: { $sum: '$credit' } } },
      ]);
      const p = prior[0] || { dr: 0, cr: 0 };
      periodOpening = Math.round((fyOpening + (p.dr || 0) - (p.cr || 0)) * 100) / 100;
    }

    let running = periodOpening;
    let totalDebit = 0, totalCredit = 0;
    const data = txns.map((t: any) => {
      running = Math.round((running + (t.debit || 0) - (t.credit || 0)) * 100) / 100;
      totalDebit += t.debit || 0; totalCredit += t.credit || 0;
      return {
        id: t._id.toString(),
        date: t.date,
        voucherType: t.voucherType,
        voucherNumber: t.voucherNumber,
        party: t.party,
        narration: t.narration,
        debit: t.debit || 0,
        credit: t.credit || 0,
        balance: running,
      };
    });

    // Full-account context (independent of the window): total rows, the list of
    // months that have activity (for the month picker), and the FY closing.
    const [totalCount, monthDocs] = await Promise.all([
      TallyBankTxn.countDocuments({ bank: bankName, ...companyFilter }),
      TallyBankTxn.aggregate([
        { $match: { bank: bankName, ...companyFilter } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } } } },
        { $sort: { _id: -1 } },
      ]),
    ]);

    return res.json({
      success: true,
      bank: bankName,
      company: book?.company ?? (txns[0] as any)?.company ?? '',
      opening: periodOpening,
      closing: running,
      computedClosing: running,
      fyClosing: book?.amount ?? 0,
      count: data.length,
      totalCount,
      totalDebit: Math.round(totalDebit * 100) / 100,
      totalCredit: Math.round(totalCredit * 100) / 100,
      months: monthDocs.map((d: any) => d._id),
      data,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
