import { Request, Response } from 'express';
import { workspaceService } from '../services/workspace.service.js';

export const createWorkspace = async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Workspace name is required' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'UNAUTHENTICATED: Valid JWT session required' });
    }

    const token = authHeader.split(' ')[1];

    const result = await workspaceService.bootstrapWorkspace(name, token);
    return res.status(201).json(result);
  } catch (error: any) {
    if (error?.code === '42501') {
      return res.status(403).json({ error: error.message });
    }
    if (error?.code === '22023') {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};
