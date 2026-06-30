import { Router } from 'express';
import { requireAuth } from '../middleware/rbac';
import { runsController } from '../controllers/runs.controller';

const router = Router({ mergeParams: true });

// POST /api/v1/workspaces/:workspace_id/threads/:thread_id/runs
router.post('/', requireAuth, runsController.createRun.bind(runsController));

export default router;
