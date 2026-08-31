import mongoose, { Schema, Document } from 'mongoose';

export interface IEnquiry extends Document {
  rfqId: string;
  dateReceived: string;
  receivedOn: string;
  type: string;
  companyName: string;
  contactPerson: string;
  mobile: string;
  email: string;
  itemDescription: string;
  assignedTo: string;
  assignedDate: string;
  tat: string;
  salesResponsibility: string;
  technical: string;
  status: string;
  remarks: string;
  pendingRemarks: string;
  followupRemarks: string;
  nextActionDate: string;
  lastCallDate: string;
  proposedOfferDate: string;
  offerNo: string;
  offerDate: string;
  doc: string;
  costing: string;
  timeline: string;
  costingNotified: string;
  reminderSent: string;
  driveFolderId: string;
  driveFolderUrl: string;
  sourceMessageId: string;
  threadId: string;
  emailBody?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: Date;
  updatedAt: Date;
}

const EnquirySchema = new Schema<IEnquiry>(
  {
    rfqId: { type: String, default: '', index: true },
    dateReceived: { type: String, default: '' },
    receivedOn: { type: String, default: '' },
    type: { type: String, default: '' },
    companyName: { type: String, default: '', index: true },
    contactPerson: { type: String, default: '' },
    mobile: { type: String, default: '' },
    email: { type: String, default: '' },
    itemDescription: { type: String, default: '' },
    assignedTo: { type: String, default: '', index: true },
    assignedDate: { type: String, default: '' },
    tat: { type: String, default: '30' },
    salesResponsibility: { type: String, default: '' },
    technical: { type: String, default: '' },
    status: { type: String, default: 'Open', index: true },
    remarks: { type: String, default: '' },
    pendingRemarks: { type: String, default: '' },
    followupRemarks: { type: String, default: '' },
    nextActionDate: { type: String, default: '' },
    lastCallDate: { type: String, default: '' },
    proposedOfferDate: { type: String, default: '' },
    offerNo: { type: String, default: '', index: true },
    offerDate: { type: String, default: '' },
    doc: { type: String, default: '' },
    costing: { type: String, default: '' },
    timeline: { type: String, default: '' },
    costingNotified: { type: String, default: '' },
    reminderSent: { type: String, default: '' },
    driveFolderId: { type: String, default: '' },
    driveFolderUrl: { type: String, default: '' },
    sourceMessageId: { type: String, default: '' },
    threadId: { type: String, default: '' },
    emailBody: { type: String, default: '' },
    verifiedBy: { type: String, default: '' },
    verifiedAt: { type: String, default: '' },
    approvedBy: { type: String, default: '' },
    approvedAt: { type: String, default: '' },
  },
  { timestamps: true }
);

EnquirySchema.index({ createdAt: -1 });

export const Enquiry = mongoose.models.Enquiry || mongoose.model<IEnquiry>('Enquiry', EnquirySchema);
