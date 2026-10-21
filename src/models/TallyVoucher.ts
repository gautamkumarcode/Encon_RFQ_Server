import mongoose, { Schema, Document } from 'mongoose';

/**
 * TallyVoucher — vouchers pushed by the tally-connect agent running on the
 * office laptop. The agent upserts by {company, voucherType, voucherNumber}
 * into this same main database (Encon_Dashboard.tally_vouchers), so this
 * backend only needs to READ and serve the data to the frontend.
 *
 * Supports many voucher types (Credit Note, Sales, Purchase, Receipt,
 * Payment, Contra, ...) — hence voucherNumber alone is NOT unique.
 */
export interface ITallyVoucher extends Document {
  company: string;
  voucherType: string;
  voucherNumber: string;
  date: Date;
  partyName: string;
  amount: number;
  syncedAt: Date;
}

const TallyVoucherSchema = new Schema<ITallyVoucher>(
  {
    company:       { type: String, required: true, trim: true },
    voucherType:   { type: String, required: true, trim: true },
    voucherNumber: { type: String, required: true, trim: true },
    date:          { type: Date,   required: true },
    partyName:     { type: String, required: true, trim: true },
    amount:        { type: Number, required: true, default: 0 },
    syncedAt:      { type: Date,   default: Date.now },
  },
  { collection: 'tally_vouchers' }
);

TallyVoucherSchema.index({ company: 1, voucherType: 1, voucherNumber: 1 }, { unique: true });
TallyVoucherSchema.index({ date: -1 });

export const TallyVoucher =
  mongoose.models.TallyVoucher ||
  mongoose.model<ITallyVoucher>('TallyVoucher', TallyVoucherSchema);
