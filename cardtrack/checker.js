#!/usr/bin/env node
/**
 * checker.js
 * Hourly carrier checker — Supabase-backed.
 *
 * Loads inventory + addresses from Supabase, polls active items' carrier
 * tracking pages, sends SMS/WhatsApp via Twilio on status changes, and
 * writes updates back to Supabase.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, plus Twilio vars
 * for notifications.
 */

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

import { checkTracking, STATUS } from './carriers.js';
import { notifyRecipient }       from './notify.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const ACTIVE_STATUSES = ['pending', 'in_transit', 'out_for_delivery'];

const NOTIFY_ON_TRANSITION = {
  in_transit:       true,
  out_for_delivery: true,
  delivered:        true,
  failed:           true,
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg, level = 'INFO') {
  console.log(`[${timestamp()}] [${level.padEnd(5)}] ${msg}`);
}

async function main() {
  log('─'.repeat(60));
  log('CardTrack checker starting');

  const [invRes, addrRes] = await Promise.all([
    supabase.from('inventory').select('*'),
    supabase.from('addresses').select('*'),
  ]);

  if (invRes.error || addrRes.error) {
    log(`Failed to load data: ${invRes.error?.message || addrRes.error?.message}`, 'ERROR');
    process.exit(1);
  }

  const items     = invRes.data  ?? [];
  const addresses = addrRes.data ?? [];
  const addrMap   = new Map(addresses.map(a => [a.id, a]));
  const active    = items.filter(i => ACTIVE_STATUSES.includes(i.acquisition_status));

  log(`Loaded ${items.length} items, ${active.length} active`);

  if (active.length === 0) {
    log('No active items to check — done');
    return;
  }

  let changed = 0, notified = 0, errors = 0;

  for (const item of active) {
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

    const shouldNotify = NOTIFY_ON_TRANSITION[newStatus] && item.last_notified !== newStatus;
    if (shouldNotify) {
      const addr = addrMap.get(item.recipient_address_id);
      if (!addr) {
        log(`  ERROR no address ${item.recipient_address_id} for ${item.item}`, 'ERROR');
        errors++;
      } else {
        log(`  NTFY  Notifying ${addr.full_name}`);
        try {
          await notifyRecipient(item, addr, newStatus);
          update.last_notified = newStatus;
          notified++;
        } catch (err) {
          log(`  ERROR Notification failed: ${err.message}`, 'ERROR');
          errors++;
        }
      }
    }

    const { error: upErr } = await supabase
      .from('inventory')
      .update(update)
      .eq('id', item.id);

    if (upErr) {
      log(`  ERROR DB update failed for ${item.item}: ${upErr.message}`, 'ERROR');
      errors++;
    }
  }

  log(`Done — ${active.length} checked, ${changed} changed, ${notified} notified, ${errors} errors`);
  log('─'.repeat(60));
}

main().catch(err => {
  console.error(`[${timestamp()}] [FATAL] ${err.message}`);
  process.exit(1);
});
