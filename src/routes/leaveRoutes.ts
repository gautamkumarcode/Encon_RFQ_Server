import { Router } from "express";
import {
	applyLeave,
	myLeaves,
	leaveBalances,
	cancelLeave,
	listLeaves,
	decideLeave,
} from "../controllers/leaveController";
import { authenticateToken, requirePermission } from "../middleware/authMiddleware";

const router = Router();

router.use(authenticateToken);

// Self-service (any signed-in employee).
router.post("/apply", requirePermission("LEAVE_REQUEST", "WRITE"), applyLeave);
router.get("/my", requirePermission("LEAVE_REQUEST", "READ"), myLeaves);
router.get("/balances", requirePermission("LEAVE_REQUEST", "READ"), leaveBalances);
router.patch("/:id/cancel", requirePermission("LEAVE_REQUEST", "WRITE"), cancelLeave);

// Approvals & register (HR_LEAVE holders).
router.get("/", requirePermission("HR_LEAVE", "READ"), listLeaves);
router.patch("/:id/decide", requirePermission("HR_LEAVE", "WRITE"), decideLeave);

export default router;
