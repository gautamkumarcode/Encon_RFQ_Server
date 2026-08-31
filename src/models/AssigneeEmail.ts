import mongoose, { Schema, Document } from 'mongoose';

export interface IAssigneeEmail extends Document {
  name: string;
  email: string;
}

const AssigneeEmailSchema = new Schema<IAssigneeEmail>({
  name: { type: String, required: true, unique: true },
  email: { type: String, default: '' },
});

export const AssigneeEmail = mongoose.models.AssigneeEmail || mongoose.model<IAssigneeEmail>('AssigneeEmail', AssigneeEmailSchema);

export interface IRfqCounter extends Document {
  year: string;
  lastSeq: number;
}

const RfqCounterSchema = new Schema<IRfqCounter>({
  year: { type: String, required: true, unique: true },
  lastSeq: { type: Number, default: 0 },
});

export const RfqCounter = mongoose.models.RfqCounter || mongoose.model<IRfqCounter>('RfqCounter', RfqCounterSchema);

export interface IProcessedMessage extends Document {
  messageId: string;
  createdAt: Date;
}

const ProcessedMessageSchema = new Schema<IProcessedMessage>({
  messageId: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
});

export const ProcessedMessage = mongoose.models.ProcessedMessage || mongoose.model<IProcessedMessage>('ProcessedMessage', ProcessedMessageSchema);
