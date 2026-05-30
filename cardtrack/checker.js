#!/usr/bin/env node
/**
 * checker.js
 * Carrier-poll loop — Supabase-backed.
 *
 * Loads inventory from Supabase, polls active items'
 * carrier tracking pages, and writes status updates back. Notifications
 * (Discord) are posted separately from the dashboard via the
 * notify-discord Edge Function; this script no longer sends them.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

import { checkTracking, STATUS } from './carriers.js';
import { notifyDiscord, autoNotifyEnabled } from './discord.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Discord auto-notify is provided by ./discord.js (shared with ingest.js).

const ACTIVE_STATUSES = ['confirmed', 'in_transit', 'out_for_delivery'];

// Max age of last_checked before an item is "due" again, by status.
// Anything not listed here is not polled.
const POLL_INTERVAL_MS = {
  confirmed:        24 * 60 * 60 * 1000, // 24h — carriers don't activate tracking until dispatched
  in_transit:        4 * 60 * 60 * 1000, //  4h
  out_for_delivery:      15 * 60 * 1000, // 15 min — speed matters at the last mile
};

function isDue(item, nowMs) {
  const interval = POLL_INTERVAL_MS[item.acquisition_status];
  if (interval == null) return false;
  if (!item.last_checked) return true;
  return nowMs - new Date(item.last_checked).getTime() >= interval;
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg, level = 'INFO') {
  console.log(`[${timestamp()}] [${level.padEnd(5)}] ${msg}`);
}

async function main() {
  log('─'.repeat(60));
  log('CardTrack checker starting');

  const { data: items, error: invErr } = await supabase.from('inventory').select('*');
  if (invErr) {
    log(`Failed to load inventory: ${invErr.message}`, 'ERROR');
    process.exit(1);
  }
  const nowMs     = Date.now();
  const active    = items.filter(i => ACTIVE_STATUSES.includes(i.acquisition_status));
  const due       = active.filter(i => isDue(i, nowMs));

  log(`Loaded ${items.length} items, ${active.length} active, ${due.length} due now`);

  if (due.length === 0) {
    log('Nothing due this run — done');
    return;
  }

  let changed = 0, errors = 0;
  const changedIds = []; // rows whose status actually moved this run

  for (const item of due) {
    if (!item.tracking_ref) {
      log(`  SKIP  ${item.item} — no tracking ref yet`);
      continue;
    }

    log(`  CHECK ${item.item} (${item.carrier} · ${item.tracking_ref})`);

    let newStatus;
    try {
      newStatus = await checkTracking(item.carrier, item.tracking_ref);
    } catch (err) {
      log(`  ERROR ${item.item}: ${err.message}`, 'ERROR');
      errors++;
      continue;
    }

    const oldStatus = item.acquisition_status;
    const nowIso    = new Date().toISOString();
    const update    = { last_checked: nowIso };

    if (newStatus === STATUS.UNKNOWN) {
      log(`  SKIP  ${item.item} — status unknown (tracking may not be live yet)`);
      await supabase.from('inventory').update(update).eq('id', item.id);
      continue;
    }

    if (newStatus === oldStatus) {
      log(`  SAME  ${item.item} — ${oldStatus} (no change)`);
      await supabase.from('inventory').update(update).eq('id', item.id);
      continue;
    }

    log(`  CHNG  ${item.item} — ${oldStatus} → ${newStatus}`, 'WARN');
    update.acquisition_status = newStatus;
    if (newStatus === STATUS.DELIVERED && !item.date_received) {
      update.date_received = nowIso.slice(0, 10);
    }
    changed++;

    const { error: upErr } = await supabase
      .from('inventory')
      .update(update)
      .eq('id', item.id);

    if (upErr) {
      log(`  ERROR DB update failed for ${item.item}: ${upErr.message}`, 'ERROR');
      errors++;
    } else {
      changedIds.push(item.id);
    }
  }

  if (autoNotifyEnabled && changedIds.length) {
    log(`Notifying Discord for ${changedIds.length} status change(s)…`);
    try {
      const summary = await notifyDiscord(changedIds);
      if (summary) log(`Discord: ${summary}`);
    } catch (err) {
      log(`Discord notify failed: ${err.message}`, 'WARN');
    }
  } else if (changedIds.length) {
    log(`Auto-notify disabled — skipping Discord for ${changedIds.length} change(s)`);
  }

  log(`Done — ${due.length} checked, ${changed} changed, ${errors} errors`);
  log('─'.repeat(60));
}

main().catch(err => {
  console.error(`[${timestamp()}] [FATAL] ${err.message}`);
  process.exit(1);
});
