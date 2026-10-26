import { Router } from "express";
import {
	clockIn,
	clockOut,
	myToday,
	myHistory,
	getRegister,
	exportAttendanceReport,
	updateAttendance,
	deleteAttendance,
} from "../controllers/attendanceController";
import { authenticateToken, requirePermission } from "../middleware/authMiddleware";

const router = Router();

router.use(authenticateToken);

// Self-service (any signed-in employee).
router.post("/clock-in", requirePermission("ATTENDANCE_CLOCK", "WRITE"), clockIn);
router.post("/clock-out", requirePermission("ATTENDANCE_CLOCK", "WRITE"), clockOut);
router.get("/my-today", myToday);
router.get("/my-history", myHistory);

// Management (attendance register / regularization).
router.get("/register", requirePermission("HR_ATTENDANCE", "READ"), getRegister);
router.get("/export", requirePermission("HR_ATTENDANCE", "READ"), exportAttendanceReport);
router.put("/:id", requirePermission("HR_ATTENDANCE", "WRITE"), updateAttendance);
router.delete("/:id", requirePermission("HR_ATTENDANCE", "DELETE"), deleteAttendance);

export default router;
