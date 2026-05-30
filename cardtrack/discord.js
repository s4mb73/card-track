// cardtrack/discord.js
//
// Shared helper to fan a status change out to Discord. Asks the
// notify-discord Edge Function to post an embed for the given inventory
// rows. That function is duplicate-proof — it skips any row whose
// `last_notified` already equals its current status and stamps it after a
// successful post — so callers can pass any changed-row ids without
// tracking what's already been sent.
//
// Controlled by AUTO_NOTIFY (on unless set to "false"). The function URL
// defaults to ${SUPABASE_URL}/functions/v1 and can be overridden with
// SUPABASE_FUNCTIONS_URL.

const SUPABASE_URL              = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const autoNotifyEnabled = process.env.AUTO_NOTIFY !== 'false';

const FUNCTIONS_URL = process.env.SUPABASE_FUNCTIONS_URL
  || `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1`;

// POST the ids to notify-discord. Resolves to a short summary string for
// logging, or null when there's nothing to do / notify is disabled. Throws
// on a non-OK response so the caller can log it.
export async function notifyDiscord(ids) {
  if (!autoNotifyEnabled || !ids || !ids.length) return null;
  const res = await fetch(`${FUNCTIONS_URL}/notify-discord`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ inventory_ids: ids }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body.error || ''}`.trim());
  return `sent ${body.sent ?? 0}, failed ${body.failed ?? 0}`;
}
