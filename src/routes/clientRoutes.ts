import { Router } from 'express';
import {
  listClients,
  getClientById,
  upsertClient,
  deleteClient,
} from '../controllers/clientController';
import { authenticateToken, requireRoles, ORDER_CLIENT_ROLES } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);
router.use(requireRoles(ORDER_CLIENT_ROLES));

router.get('/', listClients);
router.get('/:id', getClientById);
router.post('/', upsertClient);
router.delete('/:id', deleteClient);

export default router;
