import { Router } from "express";
import {
	listHolidays,
	createHoliday,
	updateHoliday,
	deleteHoliday,
} from "../controllers/holidayController";
import { authenticateToken, requirePermission } from "../middleware/authMiddleware";

const router = Router();

router.use(authenticateToken);

// Any signed-in user can read the holiday list (admin calendar + employee app).
router.get("/", listHolidays);

// Management of the holiday calendar.
router.post("/", requirePermission("HR_HOLIDAYS", "WRITE"), createHoliday);
router.put("/:id", requirePermission("HR_HOLIDAYS", "WRITE"), updateHoliday);
router.delete("/:id", requirePermission("HR_HOLIDAYS", "DELETE"), deleteHoliday);

export default router;
