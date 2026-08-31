import { Router } from 'express';
import { getRoles, getPermissions, updateRolePermissions, createRole, deleteRole } from '../controllers/roleController';
import { authenticateToken, requireRoles } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getRoles);
router.get('/permissions', getPermissions);
router.post('/', requireRoles(['ADMIN']), createRole);
router.put('/:id/permissions', requireRoles(['ADMIN']), updateRolePermissions);
router.delete('/:id', requireRoles(['ADMIN']), deleteRole);

export default router;
