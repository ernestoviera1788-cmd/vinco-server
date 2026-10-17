// RPC registry + envelope handling.
// Single endpoint POST /actions with body {action, args, actionCallId}.
// Success:        200 {"data": <payload>}
// Business error: 200 {"data": {"ok": false, "error": "CODE"}}
// Transport error: non-2xx {"error": "..."}
import type { Request, Response } from 'express';
import { RpcBusinessError, INTERNAL_ERROR } from './errors.js';
import { AuthUser } from './auth.js';

export type ActionContext = {
  user: AuthUser | null; // null when action does not require auth
  ip: string | null;
  userAgent: string | null;
  actionCallId: string | null;
};

export type ActionHandler = (args: any, ctx: ActionContext) => Promise<any>;

type Registration = {
  handler: ActionHandler;
  auth: 'none' | 'user' | 'admin';
  roles?: string[];
};

const registry = new Map<string, Registration>();

export function registerAction(name: string, handler: ActionHandler, opts: { auth?: 'none' | 'user' | 'admin'; roles?: string[] } = {}): void {
  registry.set(name, { handler, auth: opts.auth ?? 'user', roles: opts.roles });
}

export function actionNames(): string[] {
  return [...registry.keys()].sort();
}

// Lazy import to avoid a hard cycle between rpc.ts and auth.ts.
async function resolveUser(args: any): Promise<AuthUser> {
  const { requireAuth } = await import('./auth.js');
  return requireAuth(args);
}

export async function handleRpc(req: Request, res: Response): Promise<void> {
  const body = req.body ?? {};
  const { action, args, actionCallId } = body;

  if (typeof action !== 'string' || !action) {
    res.status(400).json({ error: 'missing action' });
    return;
  }
  const reg = registry.get(action);
  if (!reg) {
    res.status(404).json({ error: `unknown action: ${action}` });
    return;
  }
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    res.status(400).json({ error: 'args must be an object' });
    return;
  }

  const ctx: ActionContext = {
    user: null,
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string) ?? null,
    actionCallId: typeof actionCallId === 'string' ? actionCallId : null,
  };

  try {
    if (reg.auth === 'user' || reg.auth === 'admin') {
      ctx.user = await resolveUser(args ?? {});
    }
    if (reg.auth === 'admin') {
      const roles = reg.roles ?? ['ADMIN', 'SUPER_ADMIN', 'MODERATOR'];
      if (!ctx.user || !roles.includes(ctx.user.role)) {
        const { biz, ADMIN_ONLY } = await import('./errors.js');
        biz(ADMIN_ONLY);
      }
    }
    const data = await reg.handler(args ?? {}, ctx);
    res.status(200).json({ data: data ?? { ok: true } });
  } catch (e: any) {
    if (e instanceof RpcBusinessError) {
      res.status(200).json({ data: { ok: false, error: e.code } });
      return;
    }
    console.error(`[rpc:${action}]`, e);
    res.status(500).json({ error: INTERNAL_ERROR });
  }
}
