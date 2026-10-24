import { Router } from "express";
import {
	getOffices,
	getOffice,
	createOffice,
	updateOffice,
	deleteOffice,
} from "../controllers/officeController";
import { authenticateToken, requirePermission } from "../middleware/authMiddleware";

const router = Router();

router.use(authenticateToken);

router.get("/", requirePermission("HR_OFFICES", "READ"), getOffices);
router.get("/:id", requirePermission("HR_OFFICES", "READ"), getOffice);
router.post("/", requirePermission("HR_OFFICES", "WRITE"), createOffice);
router.put("/:id", requirePermission("HR_OFFICES", "WRITE"), updateOffice);
router.delete("/:id", requirePermission("HR_OFFICES", "DELETE"), deleteOffice);

export default router;
