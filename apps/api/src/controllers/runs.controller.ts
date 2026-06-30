import { Request, Response } from 'express';
import { runsService } from '../services/runs.service';

export class RunsController {
  async createRun(req: Request, res: Response) {
    try {
      const { workspace_id, thread_id } = req.params;
      const { query } = req.body;
      
      // req.user populated by rbac middleware
      const authContext = {
        user_id: req.user?.id || 'unknown',
        roles: req.user?.roles || [],
        // Layer 1 RBAC assumes the user has access to their requested workspace
        // This is typically populated by querying DB for user's workspaces
        allowed_workspaces: req.user ? [workspace_id] : [] 
      };

      const result = await runsService.executeRun(workspace_id, thread_id, query, authContext);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: 'Agent run failed', details: error.message });
    }
  }
}

export const runsController = new RunsController();
