import { Router } from 'express';
import { getVouchers, getVoucherTypes } from '../controllers/tallyController';
import { authenticateToken, requirePermission } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/vouchers', requirePermission('TALLY', 'READ'), getVouchers);
router.get('/voucher-types', requirePermission('TALLY', 'READ'), getVoucherTypes);

export default router;
