import { Router } from 'express';
import multer from 'multer';
import {
  listOrders,
  ordersSummary,
  prefillFromEnquiry,
  getOrderById,
  createOrder,
  updateOrder,
  deleteOrder,
  importOrdersExcel,
  exportOrdersExcel,
} from '../controllers/orderController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticateToken);

// Specific paths BEFORE the '/:id' param route so they aren't shadowed.
router.get('/summary', ordersSummary);
router.get('/export', exportOrdersExcel);
router.get('/prefill/:enquiryId', prefillFromEnquiry);
router.post('/import', upload.single('file'), importOrdersExcel);

router.get('/', listOrders);
router.post('/', createOrder);
router.get('/:id', getOrderById);
router.put('/:id', updateOrder);
router.delete('/:id', deleteOrder);

export default router;
