import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/rbac.js';
import { authController } from '../controllers/auth.controller.js';

const router = Router();

router.post('/login', authController.login);

router.post('/logout', requireAuth, authController.logout);

router.get('/admin-only', requireAuth, requireRole(['Org Admin', 'Workspace Admin']), authController.adminOnly);

export default router;
