import mongoose, { Schema, Document } from 'mongoose';

export interface IAttachment extends Document {
  enquiryId: mongoose.Types.ObjectId;
  filename: string;
  contentType: string;
  size: number;
  objectKey: string;
  uploadedBy: string;
  kind: string;
  data?: Buffer | null;
  createdAt: Date;
}

const AttachmentSchema = new Schema<IAttachment>({
  enquiryId: { type: Schema.Types.ObjectId, ref: 'Enquiry', required: true },
  filename: { type: String, required: true },
  contentType: { type: String, default: '' },
  size: { type: Number, default: 0 },
  objectKey: { type: String, default: '' },
  uploadedBy: { type: String, default: '' },
  kind: { type: String, default: '' },
  data: { type: Buffer, default: null },
  createdAt: { type: Date, default: Date.now },
});

export const Attachment =
  mongoose.models.Attachment || mongoose.model<IAttachment>('Attachment', AttachmentSchema);
