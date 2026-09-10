import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { PriceMaster, InternalCostingSheet } from "../models";
import { logActivity } from "../utils/auditLogger";

import fs from "fs";
import path from "path";

// Helper to load full extracted Offer Generator database (555 price items, 18 costing sheets)
function loadOfferGenSeedData() {
  try {
    const filePath = path.join(__dirname, "../data/offerGenSeedData.json");
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("Error loading offerGenSeedData.json:", err);
  }
  return { priceMaster: [], costingSheets: [] };
}

// Helper to perform full cascading recalculation of all costing sheets when rates change
export async function recalculateAllCostingSheets(): Promise<number> {
  try {
    const allPrices = await PriceMaster.find({}).lean();
    const priceMapByCode = new Map<string, number>();
    const priceMapByName = new Map<string, number>();

    allPrices.forEach((p) => {
      if (p.itemCode) {
        priceMapByCode.set(p.itemCode.toUpperCase().trim(), Number(p.price) || 0);
      }
      if (p.item) {
        priceMapByName.set(p.item.toLowerCase().trim(), Number(p.price) || 0);
      }
    });

    const sheets = await InternalCostingSheet.find({});
    let updatedCount = 0;

    for (const sheet of sheets) {
      let sheetModified = false;
      let materialTotal = 0;
      let laborTotal = 0;

      sheet.items.forEach((it: any) => {
        const codeKey = (it.rateRef || it.itemCode || "").toUpperCase().trim();
        const nameKey = (it.particular || "").toLowerCase().trim();

        const masterRate = priceMapByCode.get(codeKey) ?? priceMapByName.get(nameKey);
        if (masterRate !== undefined && masterRate !== it.rate) {
          it.rate = masterRate;
          sheetModified = true;
        }

        const q = Number(it.qty) || 1;
        const r = Number(it.rate) || 0;
        const lc = Number(it.laborCost) || 0;
        const mc = Number(it.machiningCost) || 0;
        const totalAmt = q * r + lc + mc;

        if (it.totalAmount !== totalAmt) {
          it.totalAmount = totalAmt;
          sheetModified = true;
        }

        materialTotal += q * r;
        laborTotal += lc + mc;
      });

      const matLab = materialTotal + laborTotal;
      const overhead = Math.round(matLab * ((sheet.overheadPercent || 0) / 100));
      const totalCost = matLab + overhead;
      const sellingPrice = Math.round(totalCost * (1 + (sheet.markupPercent || 0) / 100));

      if (
        sheetModified ||
        sheet.materialTotal !== materialTotal ||
        sheet.laborTotal !== laborTotal ||
        sheet.totalCost !== totalCost ||
        sheet.sellingPrice !== sellingPrice
      ) {
        sheet.materialTotal = materialTotal;
        sheet.laborTotal = laborTotal;
        sheet.totalCost = totalCost;
        sheet.sellingPrice = sellingPrice;
        await sheet.save();
        updatedCount++;
      }
    }

    return updatedCount;
  } catch (err) {
    console.error("Error in recalculateAllCostingSheets:", err);
    return 0;
  }
}

// Generate clean structured code e.g. RM-MS-001 based on Category
function generateStructuredCode(category: string, count: number): string {
  const cat = (category || "RAW").toUpperCase().trim();
  let prefix = "ITEM";
  if (cat.includes("RAW")) prefix = "RM";
  else if (cat.includes("BOUGHT")) prefix = "BO";
  else if (cat.includes("BURNER")) prefix = "BRN";
  else if (cat.includes("BLOWER")) prefix = "BLW";
  else if (cat.includes("HPU")) prefix = "HPU";
  else if (cat.includes("REGEN")) prefix = "REG";
  else if (cat.includes("SPARE")) prefix = "SPR";
  else if (cat.includes("ENCON")) prefix = "EP";

  const numStr = String(count).padStart(3, "0");
  return `${prefix}-${numStr}`;
}

// ── PRICE MASTER CONTROLLERS ──────────────────────────────────────────────────

export const getPriceMasterItems = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { category, search, sort = "itemCode" } = req.query;
    const filter: any = {};

    if (category && category !== "All") {
      filter.category = category;
    }

    if (search && String(search).trim()) {
      const rawQ = String(search).trim();
      const words = rawQ.split(/\s+/).filter(Boolean);

      if (words.length > 0) {
        filter.$and = words.map((word) => {
          const escaped = word.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");

          // Match SKU codes with or without hyphens e.g. "ep053" or "bo003" -> "EP-053"
          let codePattern = escaped;
          if (/^[a-zA-Z]{2,3}\d+$/i.test(word)) {
            const match = word.match(/^([a-zA-Z]{2,3})(\d+)$/);
            if (match) {
              codePattern = `${match[1]}-?${match[2]}`;
            }
          }

          const regex = new RegExp(escaped, "i");
          const codeRegex = new RegExp(codePattern, "i");

          return {
            $or: [
              { itemCode: codeRegex },
              { item: regex },
              { vendor: regex },
              { specification: regex },
              { category: regex },
              { remarks: regex },
              { unit: regex },
            ],
          };
        });
      }
    }

    // Auto seed if database is completely empty
    const count = await PriceMaster.countDocuments();
    if (count === 0) {
      const seedData = loadOfferGenSeedData();
      if (seedData.priceMaster && seedData.priceMaster.length > 0) {
        await PriceMaster.insertMany(seedData.priceMaster);
      }
    }

    const items = await PriceMaster.find(filter).sort({ [String(sort)]: 1 }).lean();
    const categories = await PriceMaster.distinct("category");
    const changesCount = items.filter(
      (i) => i.previousPrice && Number(i.previousPrice) !== Number(i.price)
    ).length;

    return res.json({
      success: true,
      data: items,
      meta: {
        total: items.length,
        categoriesCount: categories.length,
        categories: categories.sort(),
        changesCount,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createPriceMasterItem = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { itemCode, item, category, unit, price, specification, wastagePercent, laborCost, vendor, remarks } = req.body;

    if (!item || !item.trim()) {
      return res.status(400).json({ success: false, message: "Item Name is required." });
    }

    let finalCode = (itemCode || "").trim().toUpperCase();
    if (!finalCode) {
      const totalInCat = await PriceMaster.countDocuments({ category });
      finalCode = generateStructuredCode(category, totalInCat + 1);
    }

    const existing = await PriceMaster.findOne({ itemCode: finalCode });
    if (existing) {
      return res.status(400).json({ success: false, message: `Item Code '${finalCode}' already exists.` });
    }

    const newItem = await PriceMaster.create({
      itemCode: finalCode,
      item: item.trim(),
      category: category || "Raw Material",
      unit: unit || "Nos",
      price: Number(price) || 0,
      previousPrice: Number(price) || 0,
      specification: (specification || "").trim(),
      wastagePercent: Number(wastagePercent) || 0,
      laborCost: Number(laborCost) || 0,
      vendor: (vendor || "").trim(),
      remarks: (remarks || "").trim(),
      createdBy: req.user?.email || "Admin",
    });

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || "Admin",
      action: "PRICE_MASTER_ITEM_CREATED",
      details: { itemCode: newItem.itemCode, item: newItem.item, price: newItem.price },
    });

    return res.status(201).json({ success: true, message: "Price item created successfully", data: newItem });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updatePriceMasterItem = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { itemCode, item, category, unit, price, specification, wastagePercent, laborCost, vendor, remarks } = req.body;

    const existing = await PriceMaster.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Price item not found." });
    }

    // Check code conflict
    if (itemCode && itemCode.trim().toUpperCase() !== existing.itemCode) {
      const codeConflict = await PriceMaster.findOne({ itemCode: itemCode.trim().toUpperCase(), _id: { $ne: id } });
      if (codeConflict) {
        return res.status(400).json({ success: false, message: `Item Code '${itemCode}' belongs to another item.` });
      }
      existing.itemCode = itemCode.trim().toUpperCase();
    }

    if (item) existing.item = item.trim();
    if (category) existing.category = category.trim();
    if (unit) existing.unit = unit.trim();
    if (specification !== undefined) existing.specification = String(specification).trim();
    if (wastagePercent !== undefined) existing.wastagePercent = Number(wastagePercent);
    if (laborCost !== undefined) existing.laborCost = Number(laborCost);
    if (vendor !== undefined) existing.vendor = String(vendor).trim();
    if (remarks !== undefined) existing.remarks = String(remarks).trim();

    if (price !== undefined && Number(price) !== existing.price) {
      existing.previousPrice = existing.price;
      existing.price = Number(price);
    }
    existing.updatedBy = req.user?.email || "User";

    await existing.save();

    // Automatically recalculate all dependent costing sheets system-wide
    const recalculatedSheetsCount = await recalculateAllCostingSheets();

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || "User",
      action: "PRICE_MASTER_ITEM_UPDATED",
      details: { itemCode: existing.itemCode, newPrice: existing.price, previousPrice: existing.previousPrice, recalculatedSheetsCount },
    });

    return res.json({
      success: true,
      message: `Price item updated! Recalculated ${recalculatedSheetsCount} system costing sheets & matrices.`,
      data: existing,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deletePriceMasterItem = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await PriceMaster.findByIdAndDelete(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Price item not found." });
    }

    const recalculatedSheetsCount = await recalculateAllCostingSheets();

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || "User",
      action: "PRICE_MASTER_ITEM_DELETED",
      details: { itemCode: existing.itemCode, item: existing.item, recalculatedSheetsCount },
    });

    return res.json({ success: true, message: `Price item deleted! Recalculated ${recalculatedSheetsCount} system costing sheets & matrices.` });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const seedPriceMasterDefaults = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const seedData = loadOfferGenSeedData();
    let seededPriceCount = 0;
    let seededSheetCount = 0;

    if (seedData.priceMaster && Array.isArray(seedData.priceMaster)) {
      for (const item of seedData.priceMaster) {
        await PriceMaster.findOneAndUpdate(
          { itemCode: item.itemCode },
          { ...item, createdBy: "Offer Generator Import" },
          { upsert: true, new: true }
        );
        seededPriceCount++;
      }
    }

    if (seedData.costingSheets && Array.isArray(seedData.costingSheets)) {
      for (const sheet of seedData.costingSheets) {
        await InternalCostingSheet.findOneAndUpdate(
          { sheetCode: sheet.sheetCode },
          { ...sheet, createdBy: "Offer Generator Import" },
          { upsert: true, new: true }
        );
        seededSheetCount++;
      }
    }

    return res.json({
      success: true,
      message: `Seeded ${seededPriceCount} Price Master items and ${seededSheetCount} Internal Costing Sheets directly from Offer Generator database.`,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const reorganizePriceMasterCodes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const categories = await PriceMaster.distinct("category");
    let updatedCount = 0;

    for (const cat of categories) {
      const items = await PriceMaster.find({ category: cat }).sort({ createdAt: 1 });
      let seq = 1;
      for (const item of items) {
        const newCode = generateStructuredCode(cat, seq++);
        if (item.itemCode !== newCode) {
          const oldCode = item.itemCode;
          item.itemCode = newCode;
          await item.save();
          updatedCount++;

          // Update references in costing sheets
          await InternalCostingSheet.updateMany(
            { "items.rateRef": oldCode },
            { $set: { "items.$[elem].rateRef": newCode, "items.$[elem].itemCode": newCode } },
            { arrayFilters: [{ "elem.rateRef": oldCode }] }
          );
        }
      }
    }

    return res.json({
      success: true,
      message: `Reorganized ${updatedCount} item codes into structured format e.g. RM-001, BO-001`,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── INTERNAL COSTING SHEET CONTROLLERS ───────────────────────────────────────

export const getCostingSheets = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { productType, search } = req.query;
    const filter: any = {};

    if (productType && productType !== "All") {
      filter.productType = productType;
    }

    if (search && String(search).trim()) {
      const rawQ = String(search).trim();
      const words = rawQ.split(/\s+/).filter(Boolean);

      if (words.length > 0) {
        filter.$and = words.map((word) => {
          const escaped = word.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
          const regex = new RegExp(escaped, "i");
          return {
            $or: [
              { sheetCode: regex },
              { title: regex },
              { capacityKw: regex },
              { productType: regex },
              { variant: regex },
              { notes: regex },
              { "items.particular": regex },
              { "items.itemCode": regex },
              { "items.category": regex },
            ],
          };
        });
      }
    }

    const count = await InternalCostingSheet.countDocuments();
    if (count === 0) {
      const seedData = loadOfferGenSeedData();
      if (seedData.costingSheets && seedData.costingSheets.length > 0) {
        await InternalCostingSheet.insertMany(seedData.costingSheets);
      }
    }

    const sheets = await InternalCostingSheet.find(filter).sort({ title: 1 }).lean();
    return res.json({ success: true, data: sheets });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getCostingSheetById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const sheet = await InternalCostingSheet.findById(id).lean();
    if (!sheet) {
      return res.status(404).json({ success: false, message: "Costing sheet not found." });
    }
    return res.json({ success: true, data: sheet });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createCostingSheet = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sheetCode, title, productType, capacityKw, variant, items = [], overheadPercent = 0, markupPercent = 0, notes } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: "Sheet Title is required." });
    }

    let code = (sheetCode || "").trim().toUpperCase();
    if (!code) {
      const count = await InternalCostingSheet.countDocuments({ productType });
      const p = (productType || "BRN").substring(0, 3).toUpperCase();
      code = `COST-${p}-${count + 101}`;
    }

    // Calculate BOM totals
    let materialTotal = 0;
    let laborTotal = 0;
    const formattedItems = (items || []).map((it: any, idx: number) => {
      const q = Number(it.qty) || 1;
      const r = Number(it.rate) || 0;
      const lc = Number(it.laborCost) || 0;
      const mc = Number(it.machiningCost) || 0;
      const amt = q * r + lc + mc;
      materialTotal += q * r;
      laborTotal += lc + mc;
      return {
        sNo: idx + 1,
        itemCode: (it.itemCode || "").trim(),
        particular: (it.particular || "").trim(),
        category: (it.category || "General").trim(),
        qty: q,
        unit: it.unit || "Nos",
        rate: r,
        rateRef: (it.rateRef || "").trim(),
        laborCost: lc,
        machiningCost: mc,
        totalAmount: amt,
      };
    });

    const matLab = materialTotal + laborTotal;
    const overhead = Math.round(matLab * (Number(overheadPercent) / 100));
    const totalCost = matLab + overhead;
    const sellingPrice = Math.round(totalCost * (1 + Number(markupPercent) / 100));

    const newSheet = await InternalCostingSheet.create({
      sheetCode: code,
      title: title.trim(),
      productType: productType || "Burner",
      capacityKw: (capacityKw || "").trim(),
      variant: (variant || "").trim(),
      items: formattedItems,
      materialTotal,
      laborTotal,
      totalCost,
      overheadPercent: Number(overheadPercent) || 0,
      markupPercent: Number(markupPercent) || 0,
      sellingPrice,
      notes: (notes || "").trim(),
      createdBy: req.user?.email || "User",
    });

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || "User",
      action: "COSTING_SHEET_CREATED",
      details: { sheetCode: newSheet.sheetCode, title: newSheet.title, totalCost: newSheet.totalCost },
    });

    return res.status(201).json({ success: true, message: "Costing sheet created", data: newSheet });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateCostingSheet = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { title, productType, capacityKw, variant, items, overheadPercent, markupPercent, notes } = req.body;

    const existing = await InternalCostingSheet.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Costing sheet not found." });
    }

    if (title) existing.title = title.trim();
    if (productType) existing.productType = productType;
    if (capacityKw !== undefined) existing.capacityKw = String(capacityKw).trim();
    if (variant !== undefined) existing.variant = String(variant).trim();
    if (overheadPercent !== undefined) existing.overheadPercent = Number(overheadPercent);
    if (markupPercent !== undefined) existing.markupPercent = Number(markupPercent);
    if (notes !== undefined) existing.notes = String(notes).trim();

    if (Array.isArray(items)) {
      let materialTotal = 0;
      let laborTotal = 0;
      existing.items = items.map((it: any, idx: number) => {
        const q = Number(it.qty) || 1;
        const r = Number(it.rate) || 0;
        const lc = Number(it.laborCost) || 0;
        const mc = Number(it.machiningCost) || 0;
        const amt = q * r + lc + mc;
        materialTotal += q * r;
        laborTotal += lc + mc;
        return {
          sNo: idx + 1,
          itemCode: (it.itemCode || "").trim(),
          particular: (it.particular || "").trim(),
          category: (it.category || "General").trim(),
          qty: q,
          unit: it.unit || "Nos",
          rate: r,
          rateRef: (it.rateRef || "").trim(),
          laborCost: lc,
          machiningCost: mc,
          totalAmount: amt,
        };
      });

      const matLab = materialTotal + laborTotal;
      const overhead = Math.round(matLab * (existing.overheadPercent / 100));
      existing.materialTotal = materialTotal;
      existing.laborTotal = laborTotal;
      existing.totalCost = matLab + overhead;
      existing.sellingPrice = Math.round(existing.totalCost * (1 + existing.markupPercent / 100));
    }

    existing.updatedBy = req.user?.email || "User";
    await existing.save();

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || "User",
      action: "COSTING_SHEET_UPDATED",
      details: { sheetCode: existing.sheetCode, title: existing.title, sellingPrice: existing.sellingPrice },
    });

    return res.json({ success: true, message: "Costing sheet updated", data: existing });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteCostingSheet = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await InternalCostingSheet.findByIdAndDelete(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Costing sheet not found." });
    }

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || "User",
      action: "COSTING_SHEET_DELETED",
      details: { sheetCode: existing.sheetCode, title: existing.title },
    });

    return res.json({ success: true, message: "Costing sheet deleted" });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const uploadPricingJson = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { priceMaster, costingSheets } = req.body;
    if (!Array.isArray(priceMaster) && !Array.isArray(costingSheets)) {
      return res.status(400).json({ success: false, message: "Invalid payload format. Expected 'priceMaster' or 'costingSheets' array." });
    }

    let seededPriceCount = 0;
    let seededSheetCount = 0;

    if (Array.isArray(priceMaster)) {
      for (const item of priceMaster) {
        if (!item.itemCode || !item.item) continue;
        await PriceMaster.findOneAndUpdate(
          { itemCode: item.itemCode },
          { ...item, updatedBy: req.user?.email || "File Upload" },
          { upsert: true, new: true }
        );
        seededPriceCount++;
      }
    }

    if (Array.isArray(costingSheets)) {
      for (const sheet of costingSheets) {
        if (!sheet.sheetCode || !sheet.title) continue;
        await InternalCostingSheet.findOneAndUpdate(
          { sheetCode: sheet.sheetCode },
          { ...sheet, updatedBy: req.user?.email || "File Upload" },
          { upsert: true, new: true }
        );
        seededSheetCount++;
      }
    }

    await recalculateAllCostingSheets();

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || "User",
      action: "PRICING_FILE_UPLOADED",
      details: { seededPriceCount, seededSheetCount },
    });

    return res.json({
      success: true,
      message: `Successfully imported ${seededPriceCount} Price Items and ${seededSheetCount} Costing Sheets with system recalculation.`,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const syncLiveOfferGenerator = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const urlsToTry = [

      "https://automation.encon.co.in"
    ].filter(Boolean) as string[];

    let data: any = null;
    let successfulUrl = "";

    for (const baseUrl of urlsToTry) {
      try {
        const endpoint = `${baseUrl.replace(/\/$/, "")}/api/export/price-master-json`;
        const fetchRes = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
        if (fetchRes.ok) {
          data = await fetchRes.json();
          successfulUrl = endpoint;
          break;
        }
      } catch (e) {
        // Try next fallback URL
      }
    }

    if (!data) {
      return res.status(502).json({
        success: false,
        message: `Could not connect to Offer Generator at https://automation.encon.co.in or http://127.0.0.1:8000. Please download JSON directly from https://automation.encon.co.in/price-master and use 'Upload Pricing JSON'.`,
      });
    }

    const { priceMaster = [], costingSheets = [] } = data;

    let seededPriceCount = 0;
    let seededSheetCount = 0;

    for (const item of priceMaster) {
      if (!item.itemCode || !item.item) continue;
      await PriceMaster.findOneAndUpdate(
        { itemCode: item.itemCode },
        { ...item, updatedBy: "Live Sync" },
        { upsert: true, new: true }
      );
      seededPriceCount++;
    }

    for (const sheet of costingSheets) {
      if (!sheet.sheetCode || !sheet.title) continue;
      await InternalCostingSheet.findOneAndUpdate(
        { sheetCode: sheet.sheetCode },
        { ...sheet, updatedBy: "Live Sync" },
        { upsert: true, new: true }
      );
      seededSheetCount++;
    }

    await recalculateAllCostingSheets();

    await logActivity({
      userId: req.user?.userId,
      userEmail: req.user?.email || "User",
      action: "OFFER_GENERATOR_LIVE_SYNCED",
      details: { seededPriceCount, seededSheetCount, successfulUrl },
    });

    return res.json({
      success: true,
      message: `Live Synced ${seededPriceCount} Price Items & ${seededSheetCount} Costing Sheets from Offer Generator!`,
      data: { seededPriceCount, seededSheetCount },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: `Live sync error: ${error.message}` });
  }
};

export const recalculateCostingSheetsEndpoint = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updatedCount = await recalculateAllCostingSheets();
    return res.json({
      success: true,
      message: `System-wide price recalculation completed! ${updatedCount} costing models & matrices updated.`,
      data: { updatedCount },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
