import mongoose, { Document, Schema } from "mongoose";

export interface IFollowup {
	_id?: string;
	type: string;
	note: string;
	author?: string;
	authorEmail?: string;
	createdAt?: string;
	nextActionDate?: string;
}

export interface IEnquiryAddress {
	line1: string;
	line2: string;
	city: string;
	state: string;
	country: string;
	pincode: string;
}

export interface IEnquiry extends Document {
	rfqId: string;
	dateReceived: string;
	receivedOn: string;
	type: string;
	companyName: string;
	client?: mongoose.Types.ObjectId | null;
	address?: IEnquiryAddress;
	contactPerson: string;
	mobile: string;
	email: string;
	itemDescription: string;
	assignedTo: string;
	assignedToId?: mongoose.Types.ObjectId;
	assignedDate: string;
	tat: string;
	salesResponsibility: string;
	salesResponsibilityId?: mongoose.Types.ObjectId;
	technical: string;
	technicalId?: mongoose.Types.ObjectId;
	status: string;
	remarks: string;
	pendingRemarks: string;
	followupRemarks: string;
	followups: IFollowup[];
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
		rfqId: { type: String, default: "", index: true },
		dateReceived: { type: String, default: "" },
		receivedOn: { type: String, default: "" },
		type: { type: String, default: "" },
		companyName: { type: String, default: "", index: true },
		client: {
			type: Schema.Types.ObjectId,
			ref: "Client",
			default: null,
		},
		address: {
			line1: { type: String, default: "" },
			line2: { type: String, default: "" },
			city: { type: String, default: "" },
			state: { type: String, default: "" },
			country: { type: String, default: "India" },
			pincode: { type: String, default: "" },
		},
		contactPerson: { type: String, default: "" },
		mobile: { type: String, default: "" },
		email: { type: String, default: "" },
		itemDescription: { type: String, default: "" },
		assignedTo: { type: String, default: "", index: true },
		assignedToId: {
			type: Schema.Types.ObjectId,
			ref: "User",
			default: null,
			index: true,
		},
		assignedDate: { type: String, default: "" },
		tat: { type: String, default: "30" },
		salesResponsibility: { type: String, default: "" },
		salesResponsibilityId: {
			type: Schema.Types.ObjectId,
			ref: "User",
			default: null,
			index: true,
		},
		technical: { type: String, default: "" },
		technicalId: {
			type: Schema.Types.ObjectId,
			ref: "User",
			default: null,
			index: true,
		},
		status: { type: String, default: "Open", index: true },
		remarks: { type: String, default: "" },
		pendingRemarks: { type: String, default: "" },
		followupRemarks: { type: String, default: "" },
		followups: {
			type: [
				{
					type: { type: String, default: "Followup" },
					note: { type: String, default: "" },
					author: { type: String, default: "" },
					authorEmail: { type: String, default: "" },
					createdAt: { type: String, default: "" },
					nextActionDate: { type: String, default: "" },
				},
			],
			default: [],
		},
		nextActionDate: { type: String, default: "" },
		lastCallDate: { type: String, default: "" },
		proposedOfferDate: { type: String, default: "" },
		offerNo: { type: String, default: "", index: true },
		offerDate: { type: String, default: "" },
		doc: { type: String, default: "" },
		costing: { type: String, default: "" },
		timeline: { type: String, default: "" },
		costingNotified: { type: String, default: "" },
		reminderSent: { type: String, default: "" },
		driveFolderId: { type: String, default: "" },
		driveFolderUrl: { type: String, default: "" },
		sourceMessageId: { type: String, default: "" },
		threadId: { type: String, default: "" },
		emailBody: { type: String, default: "" },
		verifiedBy: { type: String, default: "" },
		verifiedAt: { type: String, default: "" },
		approvedBy: { type: String, default: "" },
		approvedAt: { type: String, default: "" },
	},
	{ timestamps: true },
);

EnquirySchema.index({ createdAt: -1 });

export const Enquiry =
	mongoose.models.Enquiry || mongoose.model<IEnquiry>("Enquiry", EnquirySchema);
