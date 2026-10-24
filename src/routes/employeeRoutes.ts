import { Router } from "express";
import {
	getEmployees,
	getEmployee,
	createEmployee,
	updateEmployee,
} from "../controllers/employeeController";
import { authenticateToken, requirePermission } from "../middleware/authMiddleware";

const router = Router();

router.use(authenticateToken);

router.get("/", requirePermission("HR_EMPLOYEES", "READ"), getEmployees);
router.get("/:id", requirePermission("HR_EMPLOYEES", "READ"), getEmployee);
router.post("/", requirePermission("HR_EMPLOYEES", "WRITE"), createEmployee);
router.put("/:id", requirePermission("HR_EMPLOYEES", "WRITE"), updateEmployee);

export default router;
