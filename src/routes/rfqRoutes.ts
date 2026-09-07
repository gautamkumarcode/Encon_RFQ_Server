import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import {
	addFollowup,
	approveReview,
	autoMapOfferDocApi,
	automationCallbackApi,
	bulkDeleteEnquiries,
	createEnquiry,
	deleteAttachment,
	deleteEnquiry,
	getAnalyticsDashboard,
	getAttachmentFile,
	getAutomationUrlApi,
	getDirectory,
	getEnquiries,
	getEnquiryById,
	getEnquiryListServiceApi,
	getEnquiryServiceApi,
	getInboxStatusApi,
	getOfferMapping,
	importExcel,
	inlineUpdateField,
	openDriveFolderApi,
	recordOfferApi,
	saveDirectory,
	sendForReview,
	syncDriveFolderApi,
	syncInboxApi,
	updateEnquiry,
	uploadAttachment,
	verifyReview,
} from "../controllers/rfqController";
import { authenticateToken } from "../middleware/authMiddleware";

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

// Public / Automation Token Middleware for Webhook API
const checkAutomationToken = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	const expectedToken = (
		process.env.AUTOMATION_CALLBACK_TOKEN ||
		process.env.AUTOMATION_WEBHOOK_TOKEN ||
		""
	).trim();
	if (!expectedToken) {
		return next();
	}

	const authHeader = req.headers.authorization || "";
	let token = "";
	if (authHeader.toLowerCase().startsWith("bearer ")) {
		token = authHeader.substring(7).trim();
	} else {
		token = String(req.headers["x-webhook-token"] || "").trim();
	}

	if (token === expectedToken) {
		return next();
	}

	return authenticateToken(req as any, res, next);
};

// Automation Offer & Callback APIs (Public with Token / Auth)
router.post("/offer", checkAutomationToken, recordOfferApi);
router.post(
	"/automation/callback",
	checkAutomationToken,
	upload.array("files"),
	automationCallbackApi,
);

// Service API: Offer Generator fetches client + resolved-contact details for
// a hand-off. Uses the automation service token — no user JWT needed.
router.get("/service/enquiry/:id", checkAutomationToken, getEnquiryServiceApi);
// Service API: Offer Generator fetches the full enquiry list for its RFQ dropdown.
router.get("/service/enquiries", checkAutomationToken, getEnquiryListServiceApi);

// Public Attachment File Viewer / Downloader Route (Allows direct browser <img src> & tab downloads)
router.get("/attachments/:attachmentId", getAttachmentFile);

// Protected RFQ endpoints
router.use(authenticateToken);

router.get("/", getEnquiries);
router.post("/", createEnquiry);
router.get("/analytics-dashboard", getAnalyticsDashboard);
router.get("/offer-mapping-view", getOfferMapping);
router.get("/directory", getDirectory);
router.post("/directory", saveDirectory);
router.post("/import", upload.single("file"), importExcel);
router.post("/auto-map-offer-doc", upload.single("file"), autoMapOfferDocApi);
router.post("/bulk-delete", bulkDeleteEnquiries);
router.post("/sync-inbox", syncInboxApi);
router.get("/inbox-status", getInboxStatusApi);

router.get("/:id", getEnquiryById);
router.get("/:id/automation-url", getAutomationUrlApi);
router.get("/:id/drive", openDriveFolderApi);
router.post("/:id/sync-drive", syncDriveFolderApi);
router.put("/:id", updateEnquiry);
router.patch("/:id/inline", inlineUpdateField);
router.post("/:id/followup", addFollowup);
router.post("/:id/send-review", sendForReview);
router.post("/:id/verify-review", verifyReview);
router.post("/:id/approve-review", approveReview);
router.post("/:id/attachments", upload.single("file"), uploadAttachment);
router.delete("/attachments/:attachmentId", deleteAttachment);
router.delete("/:id", deleteEnquiry);

export default router;
