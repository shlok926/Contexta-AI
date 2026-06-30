import { Router } from 'express';
import { requireAuth } from '../middleware/rbac';
import { memoryController } from '../controllers/memory.controller';

const router = Router({ mergeParams: true });

// GET /api/v1/workspaces/:workspace_id/memory
router.get('/', requireAuth, memoryController.getMemories.bind(memoryController));

// DELETE /api/v1/workspaces/:workspace_id/memory/:memory_id
router.delete('/:memory_id', requireAuth, memoryController.deleteMemory.bind(memoryController));

export default router;
