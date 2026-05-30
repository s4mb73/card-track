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
import { parseShopifyEmail } from './parseShopifyEmail.js';
import { notifyDiscord, autoNotifyEnabled } from './discord.js';

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
      cost:            { type: 'number',  description: 'Final amount paid in GBP, read from the explicit "Total" line at the bottom of the order summary (e.g. "Total: £220.00 GBP"). UK Shopify emails list Subtotal + Shipping + Taxes for breakdown, but the Taxes amount is already INCLUDED in the Subtotal (UK prices are VAT-inclusive). Never sum Subtotal + Taxes — that double-counts VAT. If no Total line exists, use the Subtotal. 0 unless email_type=order_confirmation.' },
      quantity:        { type: 'integer', description: 'Total items. 1 by default for order_confirmation, 0 otherwise.' },
      date_ordered:    { type: 'string',  description: 'YYYY-MM-DD the order was placed. Empty unless email_type=order_confirmation.' },
      recipient_name:  { type: 'string',  description: 'Full name on the shipping address. Empty unless email_type=order_confirmation.' },
      recipient_postcode: { type: 'string', description: 'Postcode of the shipping address (e.g. "WA3 5NU"). Empty unless email_type=order_confirmation.' },
      carrier:         { type: 'string',  enum: ['royal_mail', 'evri', 'dpd', 'yodel', 'parcelforce', ''], description: 'Carrier mentioned in the shipping email. Empty unless email_type=shipment.' },
      tracking_ref:    { type: 'string',  description: 'Tracking number from the shipping email. Empty unless email_type=shipment.' },
    },
    required: ['email_type', 'order_reference', 'item', 'category', 'cost', 'quantity', 'date_ordered', 'recipient_name', 'recipient_postcode', 'carrier', 'tracking_ref'],
  },
};

async function classifyEmailWithClaude({ subject, fromName, text }) {
  // Topps emails are ~80% boilerplate (huge tracking links, CSS, footers).
  // The order ref, item, cost, address, and tracking number all fit in
  // the first ~2KB of plain text. 4KB is a comfortable margin and ~3x
  // fewer input tokens per call than the old 12KB cap → faster
  // responses + lower API cost.
  const body = String(text || '').slice(0, 4000);
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'classify_email' },
    messages: [{
      role: 'user',
      content:
        `Classify this email and extract any relevant fields.\n\n` +
        `Important: when extracting "cost" for order_confirmation emails, ` +
        `read the explicit Total line at the bottom of the order summary ` +
        `(e.g. "Total: £220.00 GBP"). UK prices are VAT-inclusive — Taxes ` +
        `are already part of the Subtotal, never add them on top.\n\n` +
        `From: ${fromName}\nSubject: ${subject}\n\n${body}`,
    }],
  });
  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a tool_use block');
  return toolUse.input;
}

// Map a deterministic parseShopifyEmail() result onto the same shape the
// Claude classifier returns, so the dispatch logic downstream doesn't care
// which produced it. `date_ordered` is left empty on purpose — the email's
// Date header wins over any body-extracted date (see the insert below).
function inferCategory(item) {
  const s = String(item || '').toLowerCase();
  if (/pok[eé]mon/.test(s)) return 'Pokémon';
  if (/topps/.test(s))      return 'Topps';
  return '';
}
function parserResultToCls(p) {
  return {
    email_type:         p.emailType,
    order_reference:    p.orderReference,
    item:               p.item || '',
    category:           inferCategory(p.item),
    cost:               p.cost || 0,
    quantity:           p.quantity || (p.emailType === 'order_confirmation' ? 1 : 0),
    date_ordered:       '',
    recipient_name:     p.recipient?.name || '',
    recipient_postcode: p.recipient?.postcode || '',
    carrier:            p.carrier || '',
    tracking_ref:       p.trackingRef || '',
  };
}

function newId(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 10)}`; }

// Sanitise anything we're about to send to Postgres' `date` type. Claude
// sometimes returns the literal string "<UNKNOWN>" instead of an empty
// string when it can't extract a date from the body, which PG then
// rejects mid-insert. Accept only strict YYYY-MM-DD; everything else
// becomes null.
function safeDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

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

// Address auto-matcher. Loaded once per run; matches a recipient
// name + postcode against the existing `addresses` table.
//   1. Exact (case + whitespace insensitive) match on postcode + name → that ID
//   2. Single postcode match, no name match → still link (sole occupant)
//   3. Multiple postcode matches with no name match → leave null (ambiguous)
const normPostcode = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
const normName     = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function buildAddressMatcher(addresses) {
  return function findMatch(name, postcode) {
    if (!postcode) return null;
    const pc = normPostcode(postcode);
    const nm = normName(name);
    const pcMatches = addresses.filter(a => normPostcode(a.postcode) === pc);
    if (!pcMatches.length) return null;
    if (nm) {
      const named = pcMatches.find(a => normName(a.full_name) === nm);
      if (named) return named.id;
    }
    return pcMatches.length === 1 ? pcMatches[0].id : null;
  };
}

// Minimal concurrency limiter — `claudeLimit(() => fetch(...))` queues
// the work and lets at most CLAUDE_CONCURRENCY tasks run at once. Avoids
// pulling in p-limit just for this. Default 4 plays nicely with
// Anthropic Tier 1; bump via env on higher tiers.
const CLAUDE_CONCURRENCY = Number(process.env.CLAUDE_CONCURRENCY || 4);
function createLimit(concurrency) {
  let active = 0;
  const queue = [];
  const drain = () => {
    if (active >= concurrency || !queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    active++;
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active--;
      drain();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}
const claudeLimit = createLimit(CLAUDE_CONCURRENCY);

async function ingest() {
  const account = await loadAccount(accountId);
  const site    = await loadSite(siteId);
  console.log(`Account: ${account.label || account.address} <${account.address}>`);
  console.log(`Site:    ${site.label || site.from_domain} (@${site.from_domain})`);

  await supabase.from('ingest_runs').insert({
    id: runId, account_id: accountId, site_id: siteId, status: 'running',
  });

  const { data: addrs, error: addrErr } = await supabase
    .from('addresses').select('id, full_name, postcode');
  if (addrErr) console.warn(`  · couldn't load addresses for matching: ${addrErr.message}`);
  const findAddress = buildAddressMatcher(addrs || []);
  console.log(`Loaded ${addrs?.length || 0} address(es) for auto-matching.`);

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
  const notifyIds = []; // shipment/cancellation rows to ping Discord about

  // Phase 1 — download + locally filter. Sequential because ImapFlow's
  // streaming fetch is fastest in-order, and the filter work is cheap.
  const items = [];
  for await (const msg of client.fetch(uids, { source: true, envelope: true })) {
    const parsed = await simpleParser(msg.source);
    const messageId = parsed.messageId || `gen_${msg.uid}@cardtrack`;
    if (await alreadyProcessed(messageId)) continue;
    if (!matchesSite(parsed, site))        continue;
    items.push({
      messageId, parsed,
      baseRow: {
        id: messageId,
        sender: emailAddressFrom(parsed) || '(unknown)',
        subject: parsed.subject || '(no subject)',
        received_at: parsed.date?.toISOString() || null,
      },
    });
  }
  await client.logout();
  console.log(`${items.length} of ${uids.length} matched the local filter; classifying (deterministic parser first, Claude fallback @ concurrency=${CLAUDE_CONCURRENCY})…`);

  // Phase 2 — classify. The deterministic parseShopifyEmail() runs first and
  // costs zero tokens; Claude is only invoked for emails the parser can't
  // fully handle (unknown sender, template change, or a missing required
  // field → `needsAI`). The progress bar ticks as each result lands.
  const classified = await Promise.all(items.map(item => (async () => {
    const subject  = item.parsed.subject || '';
    const fromName = item.parsed.from?.value?.[0]?.name || item.baseRow.sender;
    const text     = item.parsed.text || item.parsed.html || '';
    try {
      const parsed = parseShopifyEmail({ subject, text });
      if (!parsed.needsAI) {
        return { item, cls: parserResultToCls(parsed), source: 'parser', err: null };
      }
      // Fall back to Claude only here; this is the only path that spends tokens.
      const cls = await claudeLimit(() => classifyEmailWithClaude({ subject, fromName, text }));
      return { item, cls, source: 'claude', err: null };
    } catch (err) {
      return { item, cls: null, source: null, err };
    } finally {
      processed++;
      if (processed === items.length || processed % Math.max(1, Math.ceil(items.length / 100)) === 0) {
        patchRun({ processed, inserted, skipped, failed }).catch(() => { /* fire-and-forget */ });
      }
    }
  })()));

  const viaParser = classified.filter(r => r.source === 'parser').length;
  const viaClaude = classified.filter(r => r.source === 'claude').length;
  console.log(`Classified ${classified.length}: ${viaParser} by parser (0 tokens), ${viaClaude} by Claude fallback.`);

  // Phase 3 — apply serially. Order_confirmations first so any
  // shipment/cancellation in the same batch finds its target row,
  // regardless of which Claude call finished first.
  classified.sort((a, b) =>
    (a.cls?.email_type === 'order_confirmation' ? 0 : 1) -
    (b.cls?.email_type === 'order_confirmation' ? 0 : 1)
  );

  for (const result of classified) {
    const { item, cls, err, source } = result;
    const { parsed, baseRow } = item;
    const subject = baseRow.subject;
    const from    = baseRow.sender;

    if (err) {
      console.log(`  ✗ classify failed for ${subject}: ${err.message}`);
      failed++;
      await recordIngestion({ ...baseRow, status: 'failed', reason: `Classify: ${err.message}` });
      continue;
    }

    console.log(`→ ${from} · ${subject} (via ${source})`);

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
      // Dedup against existing inventory rows so re-scrapes don't pile up
      // duplicates of the same order_reference. Uses .limit(1) instead of
      // .maybeSingle() so the dedup itself doesn't blow up when the table
      // already has multiple rows for this reference (e.g. left over from
      // an earlier no-dedup test run).
      const { data: dups } = await supabase
        .from('inventory').select('id').eq('order_reference', cls.order_reference).limit(1);
      if (dups && dups.length) {
        skipped++;
        console.log(`  · order ${cls.order_reference} already in inventory (${dups[0].id})`);
        await recordIngestion({ ...baseRow, inventory_id: dups[0].id, status: 'skipped', reason: `order ${cls.order_reference} already in inventory` });
        continue;
      }

      const matchedAddressId = findAddress(cls.recipient_name, cls.recipient_postcode);
      if (matchedAddressId) {
        console.log(`  · matched address ${matchedAddressId} for ${cls.recipient_name || '(no name)'} @ ${cls.recipient_postcode || '(no postcode)'}`);
      } else if (cls.recipient_postcode) {
        console.log(`  · no address match for ${cls.recipient_name || '(no name)'} @ ${cls.recipient_postcode}`);
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
        date_ordered: safeDate(parsed.date ? parsed.date.toISOString().slice(0, 10) : cls.date_ordered),
        cost: cls.cost || 0,
        carrier: '',
        tracking_ref: '',
        acquisition_status: 'confirmed',
        recipient_address_id: matchedAddressId,
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

    // shipment + cancellation patch the existing inventory row(s) by
    // order_reference. Uses a bulk update so we're resilient even if
    // somehow multiple rows share a reference — the previous
    // .maybeSingle() variant would silently error out in that case and
    // drop the update on the floor.
    const update = {};
    if (cls.email_type === 'shipment') {
      if (cls.carrier)      update.carrier      = cls.carrier;
      if (cls.tracking_ref) update.tracking_ref = cls.tracking_ref;
      update.acquisition_status = 'in_transit';
    } else { // cancellation
      update.acquisition_status = 'cancelled';
    }

    let q = supabase.from('inventory').update(update).eq('order_reference', cls.order_reference);
    // For shipments, never downgrade rows already past pre-shipment.
    // (Legacy 'pending' kept in the list for any pre-rename rows.)
    if (cls.email_type === 'shipment') {
      q = q.in('acquisition_status', ['confirmed', 'pending', '']);
    }
    const { data: hits, error: updErr } = await q.select('id');

    if (updErr) {
      console.log(`  ✗ update failed: ${updErr.message}`);
      failed++;
      await recordIngestion({ ...baseRow, status: 'failed', reason: `Supabase: ${updErr.message}` });
      continue;
    }

    if (!hits?.length) {
      // No matching row yet — confirmation might land in a later run
      // (wider window, or older than 30 days the first time). Don't
      // record in email_ingestions so the next scrape retries.
      skipped++;
      console.log(`  · no matching order ${cls.order_reference} in inventory — will retry next run`);
      continue;
    }

    inserted += hits.length;
    notifyIds.push(...hits.map(h => h.id)); // → in_transit / cancelled; notify after the loop
    const summary = cls.email_type === 'shipment'
      ? `tracking=${cls.tracking_ref || '(none)'} carrier=${cls.carrier || '(none)'}`
      : 'cancelled';
    console.log(`  ✓ ${cls.email_type} → ${hits.length} row(s) (${summary})`);
    await recordIngestion({ ...baseRow, inventory_id: hits[0].id, status: 'inserted', reason: `${cls.email_type}: ${summary} (${hits.length} row${hits.length === 1 ? '' : 's'})` });
  }

  if (autoNotifyEnabled && notifyIds.length) {
    console.log(`Notifying Discord for ${notifyIds.length} shipment/cancellation update(s)…`);
    try {
      const summary = await notifyDiscord(notifyIds);
      if (summary) console.log(`Discord: ${summary}`);
    } catch (err) {
      console.error(`Discord notify failed: ${err.message}`);
    }
  }

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
