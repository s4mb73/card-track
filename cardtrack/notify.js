/**
 * notify.js
 * Sends SMS and/or WhatsApp messages via Twilio.
 * Channel is picked per-recipient from address.preferredChannel.
 */

import twilio from 'twilio';
import { STATUS_LABELS } from './carriers.js';

let _client = null;

function getClient() {
  if (_client) return _client;
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || sid.startsWith('AC' + 'xxx')) {
    throw new Error('Twilio credentials not configured in .env');
  }
  _client = twilio(sid, token);
  return _client;
}

// ── Message templates ─────────────────────────────────────────────────────────
function buildMessage(item, address, newStatus) {
  const name  = address.full_name.split(' ')[0]; // first name only
  const label = STATUS_LABELS[newStatus] ?? newStatus;
  const ref   = item.tracking_ref;

  switch (newStatus) {
    case 'out_for_delivery':
      return `Hi ${name}! Good news — your ${item.item} is out for delivery today 🚚 Ref: ${ref}`;
    case 'delivered':
      return `Hi ${name}! Your ${item.item} has been delivered ✅ Hope you love it!`;
    case 'failed':
      return `Hi ${name}, heads up — delivery of your ${item.item} was attempted but failed. Ref: ${ref}. Check the carrier for redelivery options.`;
    case 'in_transit':
      return `Hi ${name}! Your ${item.item} is on its way 📦 Track it with ref ${ref}`;
    default:
      return `Hi ${name}, update on your ${item.item}: ${label}. Ref: ${ref}`;
  }
}

// ── Channels ──────────────────────────────────────────────────────────────────
async function sendSMS(to, body) {
  const client = getClient();
  const from   = process.env.TWILIO_FROM_NUMBER;
  if (!from) throw new Error('TWILIO_FROM_NUMBER not set');
  const msg = await client.messages.create({ body, from, to });
  return { channel: 'sms', sid: msg.sid, status: msg.status };
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function notifyRecipient(item, address, newStatus) {
  const body    = buildMessage(item, address, newStatus);
  const channel = (address.preferred_channel || 'sms').toLowerCase();

  try {
    if (channel === 'email') {
      // Email channel not yet implemented — skip cleanly.
      console.log(`  · Email channel not yet implemented for ${address.full_name}, skipping`);
      return { channel: 'email', skipped: true };
    }

    const r = await sendSMS(address.phone, body);
    console.log(`  ✓ SMS sent to ${address.full_name} (${address.phone})`);
    return r;
  } catch (err) {
    console.error(`  ✗ ${channel} failed for ${address.full_name}: ${err.message}`);
    throw err;
  }
}
