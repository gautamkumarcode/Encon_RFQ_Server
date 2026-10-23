import { Router } from 'express';
import {
  listClients,
  getClientById,
  upsertClient,
  deleteClient,
} from '../controllers/clientController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/', listClients);
router.get('/:id', getClientById);
router.post('/', upsertClient);
router.delete('/:id', deleteClient);

export default router;
