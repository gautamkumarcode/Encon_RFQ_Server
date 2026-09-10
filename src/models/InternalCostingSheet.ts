import mongoose, { Schema, Document } from "mongoose";

export interface ICostingItem {
  _id?: string;
  sNo: number;
  itemCode?: string;
  particular: string;
  category?: string;
  qty: number;
  unit: string;
  rate: number;
  rateRef?: string;
  laborCost?: number;
  machiningCost?: number;
  totalAmount: number;
}

export interface IInternalCostingSheet extends Document {
  sheetCode: string;
  title: string;
  productType: "Burner" | "Blower" | "HPU" | "Regen" | "Custom";
  capacityKw?: string;
  variant?: string;
  items: ICostingItem[];
  materialTotal: number;
  laborTotal: number;
  totalCost: number;
  overheadPercent: number;
  markupPercent: number;
  sellingPrice: number;
  notes?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CostingItemSchema = new Schema<ICostingItem>({
  sNo: { type: Number, required: true },
  itemCode: { type: String, default: "" },
  particular: { type: String, required: true, trim: true },
  category: { type: String, default: "General" },
  qty: { type: Number, required: true, default: 1 },
  unit: { type: String, default: "Nos", trim: true },
  rate: { type: Number, required: true, default: 0 },
  rateRef: { type: String, default: "" },
  laborCost: { type: Number, default: 0 },
  machiningCost: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true, default: 0 },
});

const InternalCostingSheetSchema = new Schema<IInternalCostingSheet>(
  {
    sheetCode: { type: String, required: true, unique: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, index: true },
    productType: {
      type: String,
      required: true,
      enum: ["Burner", "Blower", "HPU", "Regen", "Custom"],
      default: "Burner",
      index: true,
    },
    capacityKw: { type: String, default: "", trim: true },
    variant: { type: String, default: "", trim: true },
    items: [CostingItemSchema],
    materialTotal: { type: Number, default: 0 },
    laborTotal: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    overheadPercent: { type: Number, default: 0 },
    markupPercent: { type: Number, default: 0 },
    sellingPrice: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

export const InternalCostingSheet =
  mongoose.models.InternalCostingSheet ||
  mongoose.model<IInternalCostingSheet>(
    "InternalCostingSheet",
    InternalCostingSheetSchema
  );
