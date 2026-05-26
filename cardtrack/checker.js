#!/usr/bin/env node
/**
 * checker.js
 * ──────────────────────────────────────────────────────────────────────────────
 * CardTrack hourly inventory checker — Supabase-backed.
 *
 * Loads inventory + addresses from Supabase, polls active items' carrier
 * tracking pages, sends SMS/WhatsApp via Twilio on status changes, and
 * writes updates back to Supabase.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, plus Twilio vars
 * for notifications (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * TWILIO_FROM_NUMBER, optionally TWILIO_WHATSAPP_FROM).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { createClient }   from '@supabase/supabase-js';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync }     from 'fs';
import path               from 'path';
import { fileURLToPath }  from 'url';
import 'dotenv/config';

import { checkTracking, STATUS } from './carriers.js';
import { notifyRecipient }       from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR  = path.join(__dirname, 'logs');

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Statuses we still poll. Anything else is terminal.
const ACTIVE_STATUSES = ['pending', 'in_transit', 'out_for_delivery'];

const NOTIFY_ON_TRANSITION = {
  in_transit:       true,
  out_for_delivery: true,
  delivered:        true,
  failed:           true,
};

// ── Logger ────────────────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg, level = 'INFO') {
  const line = `[${timestamp()}] [${level.padEnd(5)}] ${msg}`;
  console.log(line);
  return line;
}

async function writeSummaryLog(lines) {
  if (!existsSync(LOGS_DIR)) await mkdir(LOGS_DIR, { recursive: true });
  const logFile = path.join(LOGS_DIR, 'checker.log');
  await writeFile(logFile, lines.join('\n') + '\n', { flag: 'a', encoding: 'utf8' });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const runLines = [];
  const record   = (msg, level = 'INFO') => { runLines.push(log(msg, level)); };

  record('─'.repeat(60));
  record('CardTrack checker starting');

  const [invRes, addrRes] = await Promise.all([
    supabase.from('inventory').select('*'),
    supabase.from('addresses').select('*'),
  ]);

  if (invRes.error || addrRes.error) {
    record(`Failed to load data: ${invRes.error?.message || addrRes.error?.message}`, 'ERROR');
    await writeSummaryLog(runLines);
    process.exit(1);
  }

  const items     = invRes.data  ?? [];
  const addresses = addrRes.data ?? [];
  const addrMap   = new Map(addresses.map(a => [a.id, a]));
  const active    = items.filter(i => ACTIVE_STATUSES.includes(i.acquisition_status));

  record(`Loaded ${items.length} items, ${active.length} active`);

  if (active.length === 0) {
    record('No active items to check — done');
    await writeSummaryLog(runLines);
    return;
  }

  let changed = 0, notified = 0, errors = 0;

  for (const item of active) {
    if (!item.tracking_ref) {
      record(`  SKIP  ${item.item} — no tracking ref yet`);
      continue;
    }

    record(`  CHECK ${item.item} (${item.carrier} · ${item.tracking_ref})`);

    let newStatus;
    try {
      newStatus = await checkTracking(item.carrier, item.tracking_ref);
    } catch (err) {
      record(`  ERROR ${item.item}: ${err.message}`, 'ERROR');
      errors++;
      continue;
    }

    const oldStatus = item.acquisition_status;
    const nowIso    = new Date().toISOString();
    const update    = { last_checked: nowIso };

    if (newStatus === STATUS.UNKNOWN) {
      record(`  SKIP  ${item.item} — status unknown (tracking may not be live yet)`);
      await supabase.from('inventory').update(update).eq('id', item.id);
      continue;
    }

    if (newStatus === oldStatus) {
      record(`  SAME  ${item.item} — ${oldStatus} (no change)`);
      await supabase.from('inventory').update(update).eq('id', item.id);
      continue;
    }

    record(`  CHNG  ${item.item} — ${oldStatus} → ${newStatus}`, 'WARN');
    update.acquisition_status = newStatus;
    if (newStatus === STATUS.DELIVERED && !item.date_received) {
      update.date_received = nowIso.slice(0, 10);
    }
    changed++;

    const shouldNotify = NOTIFY_ON_TRANSITION[newStatus] && item.last_notified !== newStatus;
    if (shouldNotify) {
      const addr = addrMap.get(item.recipient_address_id);
      if (!addr) {
        record(`  ERROR no address ${item.recipient_address_id} for ${item.item}`, 'ERROR');
        errors++;
      } else {
        record(`  NTFY  Notifying ${addr.full_name}`);
        try {
          await notifyRecipient(item, addr, newStatus);
          update.last_notified = newStatus;
          notified++;
        } catch (err) {
          record(`  ERROR Notification failed: ${err.message}`, 'ERROR');
          errors++;
        }
      }
    }

    const { error: upErr } = await supabase
      .from('inventory')
      .update(update)
      .eq('id', item.id);

    if (upErr) {
      record(`  ERROR DB update failed for ${item.item}: ${upErr.message}`, 'ERROR');
      errors++;
    }
  }

  record(`Done — ${active.length} checked, ${changed} changed, ${notified} notified, ${errors} errors`);
  record('─'.repeat(60));

  await writeSummaryLog(runLines);
}

main().catch(err => {
  console.error(`[${timestamp()}] [FATAL] ${err.message}`);
  process.exit(1);
});
