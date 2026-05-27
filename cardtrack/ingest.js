// Gmail → Supabase order ingestion.
//
// Usage:  node ingest.js --account=<email_accounts.id> --site=<sites.id>
//
// Connects to one Gmail account, pulls the last 30 days of mail matching
// the chosen site's sender filter, asks Claude Haiku to extract a
// structured order, and inserts it into `inventory`. Every processed
// Message-ID is recorded in `email_ingestions` so re-runs are idempotent.

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY } = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY })) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

// CLI args: --account=<id> --site=<id>
function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const { account: accountId, site: siteId } = parseArgs();
if (!accountId || !siteId) {
  console.error('Usage: node ingest.js --account=<email_accounts.id> --site=<sites.id>');
  process.exit(1);
}

const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Service-role bypasses RLS, so we can fetch app_password here even
// though anon can't see it from the dashboard.
async function loadAccount(id) {
  const { data, error } = await supabase
    .from('email_accounts')
    .select('id, label, address, app_password')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Loading account ${id}: ${error.message}`);
  if (!data)  throw new Error(`No email_accounts row with id=${id}`);
  if (!data.app_password) throw new Error(`Account ${id} has no app_password set`);
  return data;
}

async function loadSite(id) {
  const { data, error } = await supabase
    .from('sites')
    .select('id, label, from_domain, subject_pattern, active')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Loading site ${id}: ${error.message}`);
  if (!data)  throw new Error(`No sites row with id=${id}`);
  if (!data.active) throw new Error(`Site ${id} is marked inactive`);
  return data;
}

function emailAddressFrom(parsed) { return parsed.from?.value?.[0]?.address?.toLowerCase() || ''; }
function emailReplyTo(parsed)     { return parsed.replyTo?.value?.[0]?.address?.toLowerCase() || ''; }

function matchesSite(parsed, site) {
  const domain = site.from_domain.toLowerCase().trim();
  const addrs  = [emailAddressFrom(parsed), emailReplyTo(parsed)].filter(Boolean);
  const domainOk = addrs.some(a => a.endsWith(`@${domain}`) || a.endsWith(`.${domain}`));
  if (!domainOk) return false;
  if (site.subject_pattern) {
    const re = new RegExp(site.subject_pattern, 'i');
    return re.test(parsed.subject || '');
  }
  return true;
}

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
      order_reference: { type: 'string',  description: 'Order number from the email. Empty if not found.' },
      date_ordered:    { type: 'string',  description: 'ISO date the order was placed (YYYY-MM-DD). Empty if not found.' },
      carrier:         { type: 'string',  enum: ['royal_mail', 'evri', 'dpd', 'yodel', 'parcelforce', ''], description: 'Carrier if explicitly mentioned. Empty otherwise.' },
      tracking_ref:    { type: 'string',  description: 'Tracking number if present in the email. Empty otherwise.' },
    },
    required: ['is_order', 'item', 'category', 'cost', 'quantity', 'order_reference', 'date_ordered', 'carrier', 'tracking_ref'],
  },
};

async function parseEmailWithClaude({ subject, fromName, text }) {
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

function newId(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 10)}`; }

async function recordIngestion(row) {
  const { error } = await supabase.from('email_ingestions').upsert(row, { onConflict: 'id' });
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

// One row per run. Live progress lives in this table so the dashboard
// can render a bar via realtime subscription, without us having to plumb
// a job id back from the fire-and-forget HTTP call.
const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
async function patchRun(fields) {
  const { error } = await supabase.from('ingest_runs').update(fields).eq('id', runId);
  if (error) console.error('  ✗ run patch failed:', error.message);
}

async function ingest() {
  const account = await loadAccount(accountId);
  const site    = await loadSite(siteId);
  console.log(`Account: ${account.label || account.address} <${account.address}>`);
  console.log(`Site:    ${site.label || site.from_domain} (@${site.from_domain})`);

  await supabase.from('ingest_runs').insert({
    id: runId, account_id: accountId, site_id: siteId, status: 'running',
  });

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: account.address, pass: account.app_password },
    logger: false,
  });

  await client.connect();
  await client.mailboxOpen('INBOX');

  const since = new Date(Date.now() - 30 * 86400000);
  const uids = await client.search({ since });
  console.log(`Found ${uids.length} message(s) in the last 30 days.`);
  await patchRun({ total: uids.length });

  let inserted = 0, skipped = 0, failed = 0, processed = 0;

  for await (const msg of client.fetch(uids, { source: true, envelope: true })) {
    processed++;
    // Reporting every message would hammer the DB on big mailboxes; tick
    // up roughly every 1% (min every message for tiny runs).
    if (processed === uids.length || processed % Math.max(1, Math.ceil(uids.length / 100)) === 0) {
      await patchRun({ processed, inserted, skipped, failed });
    }

    const parsed = await simpleParser(msg.source);
    const messageId = parsed.messageId || `gen_${msg.uid}@cardtrack`;
    const subject   = parsed.subject || '(no subject)';
    const from      = emailAddressFrom(parsed) || '(unknown)';

    if (await alreadyProcessed(messageId)) continue;
    if (!matchesSite(parsed, site))        continue;

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
  await patchRun({
    processed, inserted, skipped, failed,
    status: 'done', finished_at: new Date().toISOString(),
  });
}

ingest().catch(async (err) => {
  console.error('Ingest run crashed:', err);
  await patchRun({ status: 'failed', error: err.message, finished_at: new Date().toISOString() })
    .catch(() => { /* best-effort; row may not exist yet */ });
  process.exit(1);
});
