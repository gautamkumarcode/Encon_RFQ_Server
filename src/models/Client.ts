import mongoose, { Schema, Document } from 'mongoose';
import { normalizeNameKey } from '../utils/nameKey';

/**
 * Client — the party/customer master.
 *
 * Entered ONCE (name + address + contact) and reused across every enquiry and
 * every Order in Hand for that client, so users never retype the full address.
 * Records are created lazily (when first referenced by an order/enquiry) — we do
 * NOT bulk-seed from client_details.json yet; that import is deferred.
 */
export interface IClientAddress {
  type: string;      // 'Billing' | 'Shipping' | ''
  line1: string;
  line2: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
}

export interface IClient extends Document {
  name: string;                 // party name (unique, case-insensitive)
  nameKey: string;              // normalized lookup key (uppercased, trimmed)
  addresses: IClientAddress[];
  contactPerson: string;
  mobile: string;
  email: string;
  gstin: string;
  country: string;              // default country (drives INR vs USD)
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

const ClientAddressSchema = new Schema<IClientAddress>(
  {
    type:    { type: String, default: '' },
    line1:   { type: String, default: '' },
    line2:   { type: String, default: '' },
    city:    { type: String, default: '' },
    state:   { type: String, default: '' },
    country: { type: String, default: 'India' },
    pincode: { type: String, default: '' },
  },
  { _id: false }
);

const ClientSchema = new Schema<IClient>(
  {
    name:          { type: String, required: true, trim: true },
    nameKey:       { type: String, required: true, unique: true, uppercase: true, trim: true },
    addresses:     { type: [ClientAddressSchema], default: [] },
    contactPerson: { type: String, default: '', trim: true },
    mobile:        { type: String, default: '', trim: true },
    email:         { type: String, default: '', trim: true },
    gstin:         { type: String, default: '', trim: true },
    country:       { type: String, default: 'India', trim: true },
    notes:         { type: String, default: '' },
  },
  { timestamps: true, collection: 'clients' }
);

// nameKey is auto-derived from name so callers only ever pass a name.
ClientSchema.pre('validate', function (next) {
  if (this.name && (!this.nameKey || this.isModified('name'))) {
    this.nameKey = normalizeNameKey(this.name);
  }
  next();
});

ClientSchema.index({ name: 'text' });

export const Client =
  mongoose.models.Client || mongoose.model<IClient>('Client', ClientSchema);
