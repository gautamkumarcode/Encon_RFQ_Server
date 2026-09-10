import mongoose, { Schema, Document } from "mongoose";

export interface IPriceMaster extends Document {
  itemCode: string;
  item: string;
  category: string;
  unit: string;
  price: number;
  previousPrice?: number;
  specification?: string;
  wastagePercent?: number;
  laborCost?: number;
  vendor?: string;
  remarks?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PriceMasterSchema = new Schema<IPriceMaster>(
  {
    itemCode: { type: String, required: true, unique: true, trim: true, index: true },
    item: { type: String, required: true, trim: true, index: true },
    category: { type: String, required: true, default: "Raw Material", index: true },
    unit: { type: String, default: "Nos", trim: true },
    price: { type: Number, required: true, default: 0 },
    previousPrice: { type: Number, default: 0 },
    specification: { type: String, default: "", trim: true },
    wastagePercent: { type: Number, default: 0 },
    laborCost: { type: Number, default: 0 },
    vendor: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

// Helper method or pre-save to calculate code if missing
PriceMasterSchema.pre("validate", function (next) {
  if (!this.itemCode && this.item) {
    const catPrefix = (this.category || "RM")
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .substring(0, 3);
    const randomSuffix = Math.floor(100 + Math.random() * 900);
    this.itemCode = `${catPrefix}-${randomSuffix}`;
  }
  next();
});

export const PriceMaster =
  mongoose.models.PriceMaster ||
  mongoose.model<IPriceMaster>("PriceMaster", PriceMasterSchema);
