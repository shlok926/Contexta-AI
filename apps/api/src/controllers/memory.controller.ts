import { Request, Response } from 'express';
import { memoryService } from '../services/memory.service';

export class MemoryController {
  async getMemories(req: Request, res: Response) {
    try {
      const { workspace_id } = req.params;
      const userId = req.user?.id || 'unknown';

      const memories = await memoryService.getUserMemories(workspace_id, userId);
      res.json(memories);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to fetch memories', details: error.message });
    }
  }

  async deleteMemory(req: Request, res: Response) {
    try {
      const { workspace_id, memory_id } = req.params;
      const userId = req.user?.id || 'unknown';

      await memoryService.deleteUserMemory(workspace_id, userId, memory_id);
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to delete memory', details: error.message });
    }
  }
}

export const memoryController = new MemoryController();
