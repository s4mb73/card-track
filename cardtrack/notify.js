/**
 * notify.js
 * Sends SMS and/or WhatsApp messages via Twilio.
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
function buildMessage(order, newStatus) {
  const name  = order.recipient.name.split(' ')[0]; // first name only
  const item  = order.item;
  const label = STATUS_LABELS[newStatus] ?? newStatus;
  const ref   = order.tracking.ref;

  switch (newStatus) {
    case 'out_for_delivery':
      return `Hi ${name}! Good news — your ${item} is out for delivery today 🚚 Ref: ${ref}`;
    case 'delivered':
      return `Hi ${name}! Your ${item} has been delivered ✅ Hope you love it!`;
    case 'failed':
      return `Hi ${name}, heads up — delivery of your ${item} was attempted but failed. Ref: ${ref}. Check Royal Mail/carrier for redelivery options.`;
    case 'in_transit':
      return `Hi ${name}! Your ${item} is on its way 📦 Track it with ref ${ref}`;
    default:
      return `Hi ${name}, update on your ${item}: ${label}. Ref: ${ref}`;
  }
}

// ── Send to one recipient ─────────────────────────────────────────────────────
async function sendSMS(to, body) {
  const client = getClient();
  const from   = process.env.TWILIO_FROM_NUMBER;
  if (!from) throw new Error('TWILIO_FROM_NUMBER not set');

  const msg = await client.messages.create({ body, from, to });
  return { channel: 'sms', sid: msg.sid, status: msg.status };
}

async function sendWhatsApp(to, body) {
  const client  = getClient();
  const from    = process.env.TWILIO_WHATSAPP_FROM;
  if (!from) throw new Error('TWILIO_WHATSAPP_FROM not set');

  const waTo  = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const msg   = await client.messages.create({ body, from, to: waTo });
  return { channel: 'whatsapp', sid: msg.sid, status: msg.status };
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function notifyRecipient(order, newStatus) {
  const body     = buildMessage(order, newStatus);
  const channels = (process.env.NOTIFY_CHANNELS ?? 'sms').split(',').map(s => s.trim());
  const results  = [];

  for (const channel of channels) {
    try {
      if (channel === 'sms') {
        const r = await sendSMS(order.recipient.phone, body);
        results.push(r);
        console.log(`  ✓ SMS sent to ${order.recipient.name} (${order.recipient.phone})`);
      } else if (channel === 'whatsapp') {
        const waNum = order.recipient.whatsapp || order.recipient.phone;
        const r = await sendWhatsApp(waNum, body);
        results.push(r);
        console.log(`  ✓ WhatsApp sent to ${order.recipient.name}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to send ${channel} to ${order.recipient.name}: ${err.message}`);
      results.push({ channel, error: err.message });
    }
  }

  return results;
}
