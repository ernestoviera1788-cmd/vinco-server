// Audit log helper for admin/moderation actions.
import { query } from './db.js';

export async function audit(
  actorId: string | null,
  action: string,
  targetType?: string,
  targetId?: string,
  details: Record<string, any> = {}
): Promise<void> {
  await query(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, details)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [actorId, action, targetType ?? null, targetId ?? null, JSON.stringify(details)]
  );
}
