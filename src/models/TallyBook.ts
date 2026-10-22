import mongoose, { Schema, Document } from 'mongoose';

/**
 * TallyBook — position/outstanding rows pushed by the tally-connect agent
 * (Debtors, Creditors, Bank balances and pending Sales/Purchase Orders).
 *
 * These are NOT transactions — they come from a custom Tally TDL report that
 * emits one row per party/ledger (balances) or per open order (orders in hand).
 * The agent upserts by {company, category, name, ref} into this same main DB
 * (Encon_Dashboard.tally_books), so this backend only READS and serves it.
 */
export type TallyBookCategory =
  | 'Debtors'
  | 'Creditors'
  | 'Bank'
  | 'Cash'
  | 'SalesOrder'
  | 'PurchaseOrder';

export interface ITallyBook extends Document {
  company: string;
  category: TallyBookCategory | string;
  name: string;        // party / bank ledger name; for orders = counter party
  ref: string;         // order/voucher number; "" for balance rows
  date: Date | null;   // order date; null for balance rows
  amount: number;      // closing/outstanding balance or order value
  opening: number;     // opening balance (FY start); 0 for order rows
  syncedAt: Date;
}

const TallyBookSchema = new Schema<ITallyBook>(
  {
    company:  { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    name:     { type: String, required: true, trim: true },
    ref:      { type: String, default: '', trim: true },
    date:     { type: Date,   default: null },
    amount:   { type: Number, required: true, default: 0 },
    opening:  { type: Number, default: 0 },
    syncedAt: { type: Date,   default: Date.now },
  },
  { collection: 'tally_books' }
);

// Balance rows have ref="" so uniqueness is company+category+name; order rows
// add the order number so the same party can have several open orders.
TallyBookSchema.index({ company: 1, category: 1, name: 1, ref: 1 }, { unique: true });
TallyBookSchema.index({ category: 1, amount: -1 });

export const TallyBook =
  mongoose.models.TallyBook ||
  mongoose.model<ITallyBook>('TallyBook', TallyBookSchema);
