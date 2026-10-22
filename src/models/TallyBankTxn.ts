import mongoose, { Schema, Document } from 'mongoose';

/**
 * TallyBankTxn — per bank/cash ledger posting, written by the tally-connect
 * agent's syncBankTransactions() from the Contra/Payment/Receipt/Bank voucher
 * ledger entries. One row per account touched by a voucher (a Contra that moves
 * money between two banks yields two rows).
 *
 * debit  = money IN to that bank/cash account  (ISDEEMEDPOSITIVE = Yes)
 * credit = money OUT of that account           (ISDEEMEDPOSITIVE = No)
 *
 * The agent replaces the whole snapshot each run. Running balance is derived at
 * read time from the account's opening balance (see TallyBook Bank/Cash rows).
 */
export interface ITallyBankTxn extends Document {
  company: string;
  bank: string;
  date: Date;
  voucherType: string;
  voucherNumber: string;
  party: string;
  narration: string;
  debit: number;
  credit: number;
  syncedAt: Date;
}

const TallyBankTxnSchema = new Schema<ITallyBankTxn>(
  {
    company:       { type: String, required: true, trim: true },
    bank:          { type: String, required: true, trim: true },
    date:          { type: Date,   required: true },
    voucherType:   { type: String, default: '', trim: true },
    voucherNumber: { type: String, default: '', trim: true },
    party:         { type: String, default: '', trim: true },
    narration:     { type: String, default: '' },
    debit:         { type: Number, default: 0 },
    credit:        { type: Number, default: 0 },
    syncedAt:      { type: Date,   default: Date.now },
  },
  { collection: 'tally_bank_txn' }
);

TallyBankTxnSchema.index({ company: 1, bank: 1, date: 1, voucherType: 1, voucherNumber: 1 });

export const TallyBankTxn =
  mongoose.models.TallyBankTxn ||
  mongoose.model<ITallyBankTxn>('TallyBankTxn', TallyBankTxnSchema);
