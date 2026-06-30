import { Request, Response } from 'express';
import { authService } from '../services/auth.service.js';

export class AuthController {
  async login(req: Request, res: Response) {
    try {
      const result = await authService.login(req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Login failed' });
    }
  }

  async logout(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const result = await authService.logout(req.user.id);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Logout failed' });
    }
  }

  adminOnly(req: Request, res: Response) {
    res.json({ message: 'Welcome Admin' });
  }
}

export const authController = new AuthController();
