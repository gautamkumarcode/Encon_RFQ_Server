import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  getEnquiries,
  getEnquiryById,
  createEnquiry,
  updateEnquiry,
  inlineUpdateField,
  deleteEnquiry,
  bulkDeleteEnquiries,
  recordOfferApi,
  automationCallbackApi,
  getAutomationUrlApi,
  getDirectory,
  saveDirectory,
  getOfferMapping,
  getAnalyticsDashboard,
  sendForReview,
  verifyReview,
  approveReview,
  uploadAttachment,
  deleteAttachment,
  getAttachmentFile,
  importExcel,
  syncInboxApi,
  getInboxStatusApi,
  openDriveFolderApi,
  syncDriveFolderApi,
  autoMapOfferDocApi,
} from '../controllers/rfqController';
import { authenticateToken } from '../middleware/authMiddleware';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

// Public / Automation Token Middleware for Webhook API
const checkAutomationToken = (req: Request, res: Response, next: NextFunction) => {
  const expectedToken = (process.env.AUTOMATION_CALLBACK_TOKEN || process.env.AUTOMATION_WEBHOOK_TOKEN || '').trim();
  if (!expectedToken) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  let token = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.substring(7).trim();
  } else {
    token = String(req.headers['x-webhook-token'] || '').trim();
  }

  if (token === expectedToken) {
    return next();
  }

  return authenticateToken(req as any, res, next);
};

// Automation Offer & Callback APIs (Public with Token / Auth)
router.post('/offer', checkAutomationToken, recordOfferApi);
router.post('/automation/callback', checkAutomationToken, upload.array('files'), automationCallbackApi);

// Public Attachment File Viewer / Downloader Route (Allows direct browser <img src> & tab downloads)
router.get('/attachments/:attachmentId', getAttachmentFile);

// Protected RFQ endpoints
router.use(authenticateToken);

router.get('/', getEnquiries);
router.post('/', createEnquiry);
router.get('/analytics-dashboard', getAnalyticsDashboard);
router.get('/offer-mapping-view', getOfferMapping);
router.get('/directory', getDirectory);
router.post('/directory', saveDirectory);
router.post('/import', upload.single('file'), importExcel);
router.post('/auto-map-offer-doc', upload.single('file'), autoMapOfferDocApi);
router.post('/bulk-delete', bulkDeleteEnquiries);
router.post('/sync-inbox', syncInboxApi);
router.get('/inbox-status', getInboxStatusApi);

router.get('/:id', getEnquiryById);
router.get('/:id/automation-url', getAutomationUrlApi);
router.get('/:id/drive', openDriveFolderApi);
router.post('/:id/sync-drive', syncDriveFolderApi);
router.put('/:id', updateEnquiry);
router.patch('/:id/inline', inlineUpdateField);
router.post('/:id/send-review', sendForReview);
router.post('/:id/verify-review', verifyReview);
router.post('/:id/approve-review', approveReview);
router.post('/:id/attachments', upload.single('file'), uploadAttachment);
router.delete('/attachments/:attachmentId', deleteAttachment);
router.delete('/:id', deleteEnquiry);

export default router;
