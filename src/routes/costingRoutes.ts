import { Router } from "express";
import { authenticateToken } from "../middleware/authMiddleware";
import {
  getPriceMasterItems,
  createPriceMasterItem,
  updatePriceMasterItem,
  deletePriceMasterItem,
  seedPriceMasterDefaults,
  reorganizePriceMasterCodes,
  uploadPricingJson,
  syncLiveOfferGenerator,
  getCostingSheets,
  getCostingSheetById,
  createCostingSheet,
  updateCostingSheet,
  deleteCostingSheet,
  recalculateCostingSheetsEndpoint,
} from "../controllers/costingController";

const router = Router();

router.use(authenticateToken);

// Price Master Routes
router.get("/prices", getPriceMasterItems);
router.post("/prices", createPriceMasterItem);
router.put("/prices/:id", updatePriceMasterItem);
router.delete("/prices/:id", deletePriceMasterItem);
router.post("/prices/seed", seedPriceMasterDefaults);
router.post("/prices/reorganize", reorganizePriceMasterCodes);

// Live Sync, File Import & Recalculate Routes
router.post("/import-json", uploadPricingJson);
router.post("/sync-live", syncLiveOfferGenerator);
router.post("/recalculate", recalculateCostingSheetsEndpoint);

// Internal Costing Sheets Routes
router.get("/sheets", getCostingSheets);
router.get("/sheets/:id", getCostingSheetById);
router.post("/sheets", createCostingSheet);
router.put("/sheets/:id", updateCostingSheet);
router.delete("/sheets/:id", deleteCostingSheet);

export default router;
