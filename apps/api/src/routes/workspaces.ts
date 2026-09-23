import { Router } from 'express';
import { createWorkspace } from '../controllers/workspace.controller.js';

const router = Router();

// POST /v1/workspaces
router.post('/', createWorkspace);

export default router;
