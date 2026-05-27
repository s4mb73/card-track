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

// Topps emails come in three flavours, each representing a state
// transition on the same inventory row keyed by order_reference:
//
//   order_confirmation → insert  (status: pending)
//   shipment           → update  (status: in_transit, carrier + tracking_ref)
//   cancellation       → update  (status: cancelled)
//
// Anything else (marketing, password reset, refund-only) is classified
// as `other` and skipped.
const CLASSIFY_TOOL = {
  name: 'classify_email',
  description:
    'Classify a retailer email and extract the relevant fields. Use ' +
    '"order_confirmation" only for the initial purchase receipt, ' +
    '"shipment" for "your order is on the way" / dispatch emails (these ' +
    'usually carry the tracking number), and "cancellation" for ' +
    'cancellation/refund notifications. Use "other" for everything else.',
  input_schema: {
    type: 'object',
    properties: {
      email_type: {
        type: 'string',
        enum: ['order_confirmation', 'shipment', 'cancellation', 'other'],
      },
      order_reference: {
        type: 'string',
        description: 'Order number from the email (e.g. "UK-1196937-S"). Empty if not found or email_type=other.',
      },
      item:            { type: 'string',  description: 'Short product name. Combine multiple line items with " + ". Empty unless email_type=order_confirmation.' },
      category:        { type: 'string',  enum: ['Topps', 'Pokémon', ''], description: 'Topps or Pokémon if obvious from sender or product. Empty otherwise.' },
      cost:            { type: 'number',  description: 'Total paid in GBP including shipping. 0 unless email_type=order_confirmation.' },
      quantity:        { type: 'integer', description: 'Total items. 1 by default for order_confirmation, 0 otherwise.' },
      date_ordered:    { type: 'string',  description: 'YYYY-MM-DD the order was placed. Empty unless email_type=order_confirmation.' },
      carrier:         { type: 'string',  enum: ['royal_mail', 'evri', 'dpd', 'yodel', 'parcelforce', ''], description: 'Carrier mentioned in the shipping email. Empty unless email_type=shipment.' },
      tracking_ref:    { type: 'string',  description: 'Tracking number from the shipping email. Empty unless email_type=shipment.' },
    },
    required: ['email_type', 'order_reference', 'item', 'category', 'cost', 'quantity', 'date_ordered', 'carrier', 'tracking_ref'],
  },
};

async function classifyEmailWithClaude({ subject, fromName, text }) {
  const body = String(text || '').slice(0, 12000);
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'classify_email' },
    messages: [{
      role: 'user',
      content:
        `Classify this email and extract any relevant fields.\n\n` +
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
  // Server-side filter by sender domain so Gmail does the matching
  // before we download anything. Huge speedup on big mailboxes — a
  // 1000-message inbox with 10 matching orders drops from minutes of
  // body fetches to seconds. IMAP search's `from:` is a substring
  // match (no reply-to), so a sender that only matches via reply-to
  // will be missed — acceptable trade for the speed, and matchesSite
  // still runs locally as a belt-and-braces check.
  const uids = await client.search({ since, from: site.from_domain });
  console.log(`Found ${uids.length} message(s) from @${site.from_domain} in the last 30 days.`);
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

    const baseRow = {
      id: messageId, sender: from, subject,
      received_at: parsed.date?.toISOString() || null,
    };

    let cls;
    try {
      cls = await classifyEmailWithClaude({
        subject,
        fromName: parsed.from?.value?.[0]?.name || from,
        text: parsed.text || parsed.html || '',
      });
    } catch (err) {
      console.log(`  ✗ classify failed: ${err.message}`);
      failed++;
      await recordIngestion({ ...baseRow, status: 'failed', reason: `Claude: ${err.message}` });
      continue;
    }

    if (cls.email_type === 'other') {
      skipped++;
      await recordIngestion({ ...baseRow, status: 'skipped', reason: 'not order-related' });
      continue;
    }
    if (!cls.order_reference) {
      skipped++;
      await recordIngestion({ ...baseRow, status: 'skipped', reason: `${cls.email_type} email had no order reference` });
      continue;
    }

    if (cls.email_type === 'order_confirmation') {
      // Dedupe: if we've already ingested an inventory row with this
      // order_reference (e.g. user re-ran the scrape on a wider window
      // or the same email landed twice), don't double-insert.
      const { data: dup } = await supabase
        .from('inventory').select('id').eq('order_reference', cls.order_reference).maybeSingle();
      if (dup) {
        skipped++;
        console.log(`  · order ${cls.order_reference} already in inventory (${dup.id})`);
        await recordIngestion({ ...baseRow, inventory_id: dup.id, status: 'skipped', reason: `order ${cls.order_reference} already in inventory` });
        continue;
      }

      const inventoryId  = newId('inv');
      const inventoryRow = {
        id: inventoryId,
        item: cls.item || subject,
        category: cls.category || '',
        quantity: cls.quantity || 1,
        order_reference: cls.order_reference,
        // Email's Date: header is the authoritative order timestamp —
        // trust it over whatever Claude extracted from the body. Fall back
        // to Claude only if the header is missing/malformed.
        date_ordered: (parsed.date ? parsed.date.toISOString().slice(0, 10) : cls.date_ordered) || null,
        cost: cls.cost || 0,
        carrier: '',
        tracking_ref: '',
        acquisition_status: 'confirmed',
        recipient_address_id: null,
      };
      const { error: insErr } = await supabase.from('inventory').insert(inventoryRow);
      if (insErr) {
        console.log(`  ✗ insert failed: ${insErr.message}`);
        failed++;
        await recordIngestion({ ...baseRow, status: 'failed', reason: `Supabase: ${insErr.message}` });
        continue;
      }
      inserted++;
      console.log(`  ✓ inserted ${inventoryId} — ${inventoryRow.item}`);
      await recordIngestion({ ...baseRow, inventory_id: inventoryId, status: 'inserted', reason: '' });
      continue;
    }

    // shipment + cancellation both look the order up by reference and
    // patch the existing inventory row. If we haven't ingested the
    // confirmation yet (shipment arrived first, or the order was
    // placed before our 30-day window), skip with a clear reason.
    const { data: existing } = await supabase
      .from('inventory')
      .select('id, item, acquisition_status, carrier, tracking_ref')
      .eq('order_reference', cls.order_reference)
      .maybeSingle();

    if (!existing) {
      // Don't record this in email_ingestions — if we did, next scrape
      // would short-circuit at alreadyProcessed() and never retry. The
      // confirmation might land in a later run (wider window, or the
      // order was placed outside our 30-day search the first time), and
      // we want the shipment/cancellation to apply when it does.
      skipped++;
      console.log(`  · no matching order ${cls.order_reference} in inventory — will retry next run`);
      continue;
    }

    const update = {};
    if (cls.email_type === 'shipment') {
      if (cls.carrier)      update.carrier      = cls.carrier;
      if (cls.tracking_ref) update.tracking_ref = cls.tracking_ref;
      // Don't downgrade rows that have already moved past in_transit.
      // Accept the legacy 'pending' value too so any rows still on the old
      // status from before the rename still take the shipment update.
      if (['confirmed', 'pending', '', null].includes(existing.acquisition_status)) {
        update.acquisition_status = 'in_transit';
      }
    } else { // cancellation
      update.acquisition_status = 'cancelled';
    }

    if (Object.keys(update).length === 0) {
      skipped++;
      console.log(`  · ${cls.email_type} for ${cls.order_reference} carried no new info`);
      await recordIngestion({ ...baseRow, inventory_id: existing.id, status: 'skipped', reason: `${cls.email_type} carried no new info` });
      continue;
    }

    const { error: updErr } = await supabase.from('inventory').update(update).eq('id', existing.id);
    if (updErr) {
      console.log(`  ✗ update failed: ${updErr.message}`);
      failed++;
      await recordIngestion({ ...baseRow, inventory_id: existing.id, status: 'failed', reason: `Supabase: ${updErr.message}` });
      continue;
    }
    inserted++;
    const summary = cls.email_type === 'shipment'
      ? `tracking=${cls.tracking_ref || '(none)'} carrier=${cls.carrier || '(none)'}`
      : 'cancelled';
    console.log(`  ✓ ${cls.email_type} → ${existing.id} (${summary})`);
    await recordIngestion({ ...baseRow, inventory_id: existing.id, status: 'inserted', reason: `${cls.email_type}: ${summary}` });
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
