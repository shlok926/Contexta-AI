import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireRole } from '../middleware/rbac.js';
import { authController } from '../controllers/auth.controller.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 login requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

router.post('/login', authLimiter, authController.login);

router.post('/logout', requireAuth, authController.logout);

router.get('/admin-only', requireAuth, requireRole(['Org Admin', 'Workspace Admin']), authController.adminOnly);

export default router;
