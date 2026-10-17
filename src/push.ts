import { query } from './db.js';

export async function pushToUser(userId: string, title: string, body: string, data: Record<string, string>): Promise<void> {
  try {
    const rows = await query<{ expo_push_token: string }>(
      'SELECT expo_push_token FROM push_devices WHERE user_id = $1', [userId]
    );
    if (!rows.length) return;
    const messages = rows.map((row) => ({
      to: row.expo_push_token, title, body, data, sound: 'default',
      channelId: 'messages', priority: 'high',
    }));
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const result = await response.json() as { data?: Array<{ status?: string; details?: { error?: string } }> };
      const invalid = (result.data ?? []).flatMap((ticket, index) =>
        ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered'
          ? [batch[index]?.to] : []
      ).filter((token): token is string => !!token);
      if (invalid.length) await query('DELETE FROM push_devices WHERE expo_push_token = ANY($1::text[])', [invalid]);
    }
  } catch (error) {
    console.warn('[push] Delivery failed:', error instanceof Error ? error.message : 'unknown error');
  }
}
