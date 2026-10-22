import { Router } from 'express';
import { getVouchers, getVoucherTypes, getBooks, getBooksSummary, getBankTransactions } from '../controllers/tallyController';
import { authenticateToken, requirePermission } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/vouchers', requirePermission('TALLY', 'READ'), getVouchers);
router.get('/voucher-types', requirePermission('TALLY', 'READ'), getVoucherTypes);
router.get('/books/summary', requirePermission('TALLY', 'READ'), getBooksSummary);
router.get('/books', requirePermission('TALLY', 'READ'), getBooks);
router.get('/banks/transactions', requirePermission('TALLY', 'READ'), getBankTransactions);

export default router;
