import { Router } from 'express';
import { authenticateToken } from '../../middleware/authMiddleware';
import * as controller from './pricing.controller';

const router = Router();

// The entire pricing module is protected — same policy as every other module
router.use(authenticateToken);

// Module meta & lookup lists (must come before /:id style routes)
router.get('/meta', controller.getMeta);
router.get('/lookup', controller.getLookup);

// Dashboard & global price history
router.get('/dashboard', controller.getDashboard);
router.get('/history', controller.getHistory);

// Calculation engine
router.post('/calculate', controller.postCalculate);

// Markup rules
router.get('/rules', controller.getRules);
router.post('/rules', controller.postRule);
router.patch('/rules/:id', controller.patchRule);

// Items
router.get('/items', controller.getItems);
router.get('/items/next-code', controller.getNextCode);
router.post('/items', controller.postItem);
router.get('/items/:id', controller.getItem);
router.patch('/items/:id', controller.patchItem);
router.delete('/items/:id', controller.deleteItem);

// Price versions per item
router.get('/items/:id/prices', controller.getItemPrices);
router.post('/items/:id/prices', controller.postItemPrice);
router.get('/items/:id/history', controller.getItemHistory);

// Cost versions per item
router.get('/items/:id/cost', controller.getItemCosts);
router.post('/items/:id/cost', controller.postItemCost);

// Import / export
router.get('/export', controller.getExport);
router.post('/import/preview', controller.postImportPreview);
router.post('/import/commit', controller.postImportCommit);

export default router;
