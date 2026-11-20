import { NextFunction, Request, Response } from 'express';
import { Repos } from '../repositories/types';

/** Autentica só pela x-api-key (a config do gateway é buscada em cada rota). */
export function projectAuth(repos: Pick<Repos, 'projects'>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.headers['x-api-key'];
    const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    if (!key) {
      res.status(401).json({ error: 'unauthorized', message: 'Missing x-api-key header' });
      return;
    }
    const project = await repos.projects.findByApiKey(key);
    if (!project) {
      res.status(401).json({ error: 'unauthorized', message: 'Invalid API key' });
      return;
    }
    req.project = project;
    next();
  };
}
