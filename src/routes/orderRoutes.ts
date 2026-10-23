import { Router } from 'express';
import {
  listOrders,
  ordersSummary,
  prefillFromEnquiry,
  getOrderById,
  createOrder,
  updateOrder,
  deleteOrder,
} from '../controllers/orderController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

// Specific paths BEFORE the '/:id' param route so they aren't shadowed.
router.get('/summary', ordersSummary);
router.get('/prefill/:enquiryId', prefillFromEnquiry);

router.get('/', listOrders);
router.post('/', createOrder);
router.get('/:id', getOrderById);
router.put('/:id', updateOrder);
router.delete('/:id', deleteOrder);

export default router;
