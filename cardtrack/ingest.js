// Gmail → Supabase order ingestion.
//
// Connects to Gmail over IMAP, pulls every unprocessed message from the
// allowed senders, asks Claude Haiku to parse it into a structured order,
// and inserts the result into `inventory`. Every processed message-id is
// recorded in `email_ingestions` so re-runs are idempotent.

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const {
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ANTHROPIC_API_KEY,
} = process.env;

for (const [k, v] of Object.entries({
  GMAIL_USER, GMAIL_APP_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
})) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Domain allowlist. Match by from-address suffix; reply-to is checked as a
// fallback for senders (like Topps via Shopify) whose `from` carries a
// per-message alias.
const ALLOWED_DOMAINS = [
  't.shopifyemail.com',       // Topps store confirmations
  'official.topps.com',       // Topps reply-to
  // Add more later as you confirm what other senders look like:
  // 'pokemoncenter.com',
  // 'ebay.co.uk',
];

function emailAddressFrom(parsed) {
  return parsed.from?.value?.[0]?.address?.toLowerCase() || '';
}
function emailReplyTo(parsed) {
  return parsed.replyTo?.value?.[0]?.address?.toLowerCase() || '';
}
function isAllowedSender(parsed) {
  const candidates = [emailAddressFrom(parsed), emailReplyTo(parsed)].filter(Boolean);
  return candidates.some(addr => ALLOWED_DOMAINS.some(d => addr.endsWith(`@${d}`) || addr.endsWith(`.${d}`)));
}

// Ask Haiku to extract a structured order. The tool_use schema gives us
// type-safe JSON back without prose-wrangling.
const ORDER_TOOL = {
  name: 'record_order',
  description: 'Record the order details extracted from an order-confirmation email.',
  input_schema: {
    type: 'object',
    properties: {
      is_order:        { type: 'boolean', description: 'true if this email is an order confirmation (not marketing, shipping update, refund, etc.)' },
      item:            { type: 'string',  description: 'Short product name. Combine multiple line items with " + " if more than one.' },
      category:        { type: 'string',  enum: ['Topps', 'Pokémon', ''], description: 'Topps or Pokémon if you can tell, empty string otherwise.' },
      cost:            { type: 'number',  description: 'Total paid in GBP including any shipping the buyer paid. 0 if unknown.' },
      quantity:        { type: 'integer', description: 'Total items. Default 1.' },
      order_reference: { type: 'string',  description: 'Order number from the email (e.g. UK-1208767-S). Empty if not found.' },
      date_ordered:    { type: 'string',  description: 'ISO date the order was placed (YYYY-MM-DD). Empty if not found.' },
      carrier:         { type: 'string',  enum: ['royal_mail', 'evri', 'dpd', 'yodel', 'parcelforce', ''], description: 'Carrier if explicitly mentioned. Empty otherwise.' },
      tracking_ref:    { type: 'string',  description: 'Tracking number if present in the email. Empty otherwise.' },
    },
    required: ['is_order', 'item', 'category', 'cost', 'quantity', 'order_reference', 'date_ordered', 'carrier', 'tracking_ref'],
  },
};

async function parseEmailWithClaude({ subject, fromName, text }) {
  // Trim email body to keep token cost negligible.
  const body = String(text || '').slice(0, 12000);
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    tools: [ORDER_TOOL],
    tool_choice: { type: 'tool', name: 'record_order' },
    messages: [{
      role: 'user',
      content:
        `Extract order details from this email. If it's not an actual order ` +
        `confirmation (marketing, shipping notification on its own, refund, ` +
        `password reset, etc.), set is_order=false and leave the other fields empty.\n\n` +
        `From: ${fromName}\nSubject: ${subject}\n\n${body}`,
    }],
  });
  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a tool_use block');
  return toolUse.input;
}

function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

async function recordIngestion(row) {
  const { error } = await supabase
    .from('email_ingestions')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('  ✗ failed to record ingestion:', error.message);
}

async function alreadyProcessed(messageId) {
  const { data, error } = await supabase
    .from('email_ingestions')
    .select('id')
    .eq('id', messageId)
    .maybeSingle();
  if (error) { console.error('  · check error:', error.message); return false; }
  return !!data;
}

async function ingest() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });

  await client.connect();
  await client.mailboxOpen('INBOX');

  // Pull the last 30 days of mail. Cheap, and we dedupe by message-id so
  // repeat passes cost nothing in the DB.
  const since = new Date(Date.now() - 30 * 86400000);
  const uids = await client.search({ since });
  console.log(`Found ${uids.length} message(s) in the last 30 days.`);

  let inserted = 0, skipped = 0, failed = 0;

  for await (const msg of client.fetch(uids, { source: true, envelope: true })) {
    const parsed = await simpleParser(msg.source);
    const messageId = parsed.messageId || `gen_${msg.uid}@cardtrack`;
    const subject   = parsed.subject || '(no subject)';
    const from      = emailAddressFrom(parsed) || '(unknown)';

    if (await alreadyProcessed(messageId)) continue;

    if (!isAllowedSender(parsed)) {
      // Don't even record off-allowlist mail — it'd swamp the table.
      continue;
    }

    console.log(`→ ${from} · ${subject}`);

    let parsedOrder;
    try {
      parsedOrder = await parseEmailWithClaude({
        subject,
        fromName: parsed.from?.value?.[0]?.name || from,
        text: parsed.text || parsed.html || '',
      });
    } catch (err) {
      console.log(`  ✗ parse failed: ${err.message}`);
      failed++;
      await recordIngestion({
        id: messageId, sender: from, subject,
        received_at: parsed.date?.toISOString() || null,
        status: 'failed', reason: `Claude: ${err.message}`,
      });
      continue;
    }

    if (!parsedOrder.is_order) {
      skipped++;
      await recordIngestion({
        id: messageId, sender: from, subject,
        received_at: parsed.date?.toISOString() || null,
        status: 'skipped', reason: 'not an order confirmation',
      });
      continue;
    }

    const inventoryId = newId('inv');
    const inventoryRow = {
      id: inventoryId,
      item: parsedOrder.item || subject,
      category: parsedOrder.category || '',
      quantity: parsedOrder.quantity || 1,
      order_reference: parsedOrder.order_reference || '',
      date_ordered: parsedOrder.date_ordered || null,
      cost: parsedOrder.cost || 0,
      carrier: parsedOrder.carrier || '',
      tracking_ref: parsedOrder.tracking_ref || '',
      acquisition_status: 'pending',
      recipient_address_id: null,
    };

    const { error: insErr } = await supabase.from('inventory').insert(inventoryRow);
    if (insErr) {
      console.log(`  ✗ insert failed: ${insErr.message}`);
      failed++;
      await recordIngestion({
        id: messageId, sender: from, subject,
        received_at: parsed.date?.toISOString() || null,
        status: 'failed', reason: `Supabase: ${insErr.message}`,
      });
      continue;
    }

    inserted++;
    console.log(`  ✓ inserted ${inventoryId} — ${inventoryRow.item}`);
    await recordIngestion({
      id: messageId, sender: from, subject,
      received_at: parsed.date?.toISOString() || null,
      inventory_id: inventoryId,
      status: 'inserted', reason: '',
    });
  }

  await client.logout();
  console.log(`\nDone. inserted=${inserted} skipped=${skipped} failed=${failed}`);
}

ingest().catch(err => {
  console.error('Ingest run crashed:', err);
  process.exit(1);
});
