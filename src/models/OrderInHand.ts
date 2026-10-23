import mongoose, { Schema, Document } from 'mongoose';

/**
 * OrderInHand — the operational order / production-planning book.
 *
 * Mirrors the "Order in Hand & Production Planning Position" register: one
 * document per customer PO, with multiple line items (a client can hold many
 * orders, and one order many items). Created when an enquiry reaches
 * "PO Received" (client + items prefilled from the enquiry/client master) and
 * then maintained here. The "Orders in Hand" value = sum of orderValueINR for
 * orders not yet dispatched/closed.
 */
export interface IOrderLineItem {
  description: string;
  qty: number;
  value: number;   // in the order currency
}

export interface IOrderInHand extends Document {
  client: mongoose.Types.ObjectId | null;   // ref Client
  clientName: string;                        // snapshot for fast listing
  enquiry: mongoose.Types.ObjectId | null;  // originating Enquiry (RFQ)
  jobNo: string;
  rfqId: string;
  poNumber: string;
  poDate: Date | null;
  orderReceivedDate: Date | null;
  lineItems: IOrderLineItem[];
  currency: string;               // 'INR' | 'USD' | ...
  orderValue: number;             // total in `currency` (sum of lineItems.value)
  orderValueINR: number;          // INR equivalent (for the chip total)
  termsOfPayment: string;
  advanceAmount: number;
  advanceReceivedDate: Date | null;
  dispatchAsPerPo: Date | null;
  expectedDespatch: Date | null;
  piNumber: string;
  piDate: Date | null;
  status: string;                 // Received / Waiting for PI / PO HOLD / ...
  currentStatusNote: string;
  createdAt: Date;
  updatedAt: Date;
}

const LineItemSchema = new Schema<IOrderLineItem>(
  {
    description: { type: String, default: '' },
    qty:         { type: Number, default: 0 },
    value:       { type: Number, default: 0 },
  },
  { _id: false }
);

const OrderInHandSchema = new Schema<IOrderInHand>(
  {
    client:              { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    clientName:          { type: String, default: '', trim: true, index: true },
    enquiry:             { type: Schema.Types.ObjectId, ref: 'Enquiry', default: null },
    jobNo:               { type: String, default: '', trim: true },
    rfqId:               { type: String, default: '', trim: true },
    poNumber:            { type: String, default: '', trim: true },
    poDate:              { type: Date,   default: null },
    orderReceivedDate:   { type: Date,   default: null },
    lineItems:           { type: [LineItemSchema], default: [] },
    currency:            { type: String, default: 'INR', trim: true },
    orderValue:          { type: Number, default: 0 },
    orderValueINR:       { type: Number, default: 0 },
    termsOfPayment:      { type: String, default: '' },
    advanceAmount:       { type: Number, default: 0 },
    advanceReceivedDate: { type: Date,   default: null },
    dispatchAsPerPo:     { type: Date,   default: null },
    expectedDespatch:    { type: Date,   default: null },
    piNumber:            { type: String, default: '', trim: true },
    piDate:              { type: Date,   default: null },
    status:              { type: String, default: 'Received', trim: true, index: true },
    currentStatusNote:   { type: String, default: '' },
  },
  { timestamps: true, collection: 'orders_in_hand' }
);

// Recompute orderValue from line items on every save so the TOTAL can't drift.
OrderInHandSchema.pre('validate', function (next) {
  const sum = (this.lineItems || []).reduce((s, li) => s + (Number(li.value) || 0), 0);
  if (sum > 0) this.orderValue = sum;
  // For INR orders the INR total equals the order total; foreign orders keep
  // whatever orderValueINR the user entered (the sheet's "IND Rs" figure).
  if ((this.currency || 'INR').toUpperCase() === 'INR') this.orderValueINR = this.orderValue;
  next();
});

export const ORDER_STATUS_OPTIONS = [
  'Received',
  'In Progress',
  'Waiting for PI',
  'PO HOLD',
  'Dispatch under progress',
  'Dispatched',
  'On Hold',
  'Closed',
];

export const OrderInHand =
  mongoose.models.OrderInHand ||
  mongoose.model<IOrderInHand>('OrderInHand', OrderInHandSchema);
