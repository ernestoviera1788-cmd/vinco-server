// In-app notification helper. Honors the recipient's notification settings.
import { query } from './db.js';

const SETTING_FOR_TYPE: Record<string, string> = {
  like: 'likes',
  match: 'matches',
  message: 'messages',
  security: 'security',
  subscription: 'marketing',
  boost: 'marketing',
  system: 'marketing',
  report: 'security',
};

export async function notifyUser(
  userId: string,
  type: string,
  title: string,
  body: string,
  data: Record<string, any> = {}
): Promise<void> {
  const settingKey = SETTING_FOR_TYPE[type] ?? 'marketing';
  const s: any = (await query(`SELECT * FROM notification_settings WHERE user_id = $1`, [userId]))[0];
  if (s && s[settingKey] === false) return; // user opted out
  await query(
    `INSERT INTO notifications (id, user_id, type, title, body, data)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [userId, type, title, body, JSON.stringify(data)]
  );
}
