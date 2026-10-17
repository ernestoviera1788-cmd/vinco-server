import { query } from '../db.js';
import { biz, INVALID_ARGS } from '../errors.js';
import { reqString } from '../validation.js';
import { registerAction, type ActionContext } from '../rpc.js';

function requireUser(ctx: ActionContext): string {
  if (!ctx.user?.id) biz(INVALID_ARGS);
  return ctx.user.id;
}

function validateExpoToken(token: string): void {
  if (!/^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/.test(token)) {
    biz(INVALID_ARGS, 'arg expoPushToken');
  }
}

async function registerPushDevice(args: any, ctx: ActionContext) {
  const userId = requireUser(ctx);
  const token = reqString(args, 'expoPushToken', 1, 200);
  const platform = reqString(args, 'platform', 1, 16);
  validateExpoToken(token);
  if (platform !== 'ios' && platform !== 'android') biz(INVALID_ARGS, 'arg platform');

  await query(
    `INSERT INTO push_devices (user_id, expo_push_token, platform, updated_at, last_seen_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (expo_push_token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       platform = EXCLUDED.platform,
       updated_at = now(),
       last_seen_at = now()`,
    [userId, token, platform]
  );
  return { ok: true };
}

async function unregisterPushDevice(args: any, ctx: ActionContext) {
  const userId = requireUser(ctx);
  const token = reqString(args, 'expoPushToken', 1, 200);
  validateExpoToken(token);
  await query(
    'DELETE FROM push_devices WHERE user_id = $1 AND expo_push_token = $2',
    [userId, token]
  );
  return { ok: true };
}

registerAction('registerpushdevice', registerPushDevice, { auth: 'user' });
registerAction('unregisterpushdevice', unregisterPushDevice, { auth: 'user' });
