import { Request, Response, NextFunction } from 'express';

export interface UserPayload {
  id: string;
  roles: string[];
  tenantId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  req.user = {
    id: 'placeholder-user-id',
    roles: ['Viewer'],
    tenantId: 'placeholder-tenant-id'
  };

  next();
};

export const requireRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized: User context missing' });
    }

    const hasRole = req.user.roles.some(role => allowedRoles.includes(role));
    if (!hasRole) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    next();
  };
};
