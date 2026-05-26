#!/usr/bin/env node
/**
 * checker.js
 * ──────────────────────────────────────────────────────────────────────────────
 * CardTrack hourly inventory checker.
 *
 * Run manually:    node checker.js
 * Run via cron:    0 * * * * cd /path/to/cardtrack && node checker.js >> logs/checker.log 2>&1
 * Run via npm:     npm start
 *
 * What it does:
 *   1. Reads inventory.json (items) and addresses.json (recipients)
 *   2. For each active item, polls the carrier's tracking page
 *   3. If the acquisition status has changed, sends SMS/WhatsApp via Twilio
 *      to the recipient address (resolved by recipientAddressId)
 *   4. Writes updated statuses back to inventory.json
 *   5. Appends a run summary to logs/checker.log
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync }                 from 'fs';
import path                           from 'path';
import { fileURLToPath }              from 'url';
import 'dotenv/config';

import { checkTracking, STATUS }      from './carriers.js';
import { notifyRecipient }            from './notify.js';

const __dirname       = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY_FILE  = path.join(__dirname, 'inventory.json');
const ADDRESSES_FILE  = path.join(__dirname, 'addresses.json');
const LOGS_DIR        = path.join(__dirname, 'logs');

// Statuses where we keep polling. Anything else is a terminal state.
const ACTIVE_STATUSES = ['pending', 'in_transit', 'out_for_delivery'];

// Which status transitions warrant a notification.
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

// ── Load / save ───────────────────────────────────────────────────────────────
async function loadData() {
  const [invRaw, addrRaw] = await Promise.all([
    readFile(INVENTORY_FILE, 'utf8'),
    readFile(ADDRESSES_FILE, 'utf8'),
  ]);
  return {
    inventory: JSON.parse(invRaw),
    addresses: JSON.parse(addrRaw),
  };
}

async function saveInventory(inventory) {
  await writeFile(INVENTORY_FILE, JSON.stringify(inventory, null, 2), 'utf8');
}

async function writeSummaryLog(lines) {
  if (!existsSync(LOGS_DIR)) await mkdir(LOGS_DIR, { recursive: true });
  const logFile = path.join(LOGS_DIR, 'checker.log');
  await writeFile(logFile, lines.join('\n') + '\n', { flag: 'a', encoding: 'utf8' });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const runLines = [];
  const record   = (msg, level = 'INFO') => {
    runLines.push(log(msg, level));
  };

  record('─'.repeat(60));
  record('CardTrack checker starting');

  let inventory, addresses;
  try {
    ({ inventory, addresses } = await loadData());
  } catch (err) {
    record(`Failed to load data: ${err.message}`, 'ERROR');
    process.exit(1);
  }

  const items   = inventory.items   ?? [];
  const addrMap = new Map((addresses.addresses ?? []).map(a => [a.id, a]));
  const active  = items.filter(i => ACTIVE_STATUSES.includes(i.acquisitionStatus));

  record(`Loaded ${items.length} items, ${active.length} active`);

  if (active.length === 0) {
    record('No active items to check — done');
    await writeSummaryLog(runLines);
    return;
  }

  let changed = 0, notified = 0, errors = 0;

  for (const item of active) {
    if (!item.trackingRef) {
      record(`  SKIP  ${item.item} — no tracking ref yet`);
      continue;
    }

    record(`  CHECK ${item.item} (${item.carrier} · ${item.trackingRef})`);

    let newStatus;
    try {
      newStatus = await checkTracking(item.carrier, item.trackingRef);
    } catch (err) {
      record(`  ERROR ${item.item}: ${err.message}`, 'ERROR');
      errors++;
      continue;
    }

    const oldStatus = item.acquisitionStatus;
    item.lastChecked = new Date().toISOString();

    if (newStatus === STATUS.UNKNOWN) {
      record(`  SKIP  ${item.item} — status unknown (tracking may not be live yet)`);
      continue;
    }

    if (newStatus === oldStatus) {
      record(`  SAME  ${item.item} — ${oldStatus} (no change)`);
      continue;
    }

    record(`  CHNG  ${item.item} — ${oldStatus} → ${newStatus}`, 'WARN');
    item.acquisitionStatus = newStatus;
    if (newStatus === STATUS.DELIVERED && !item.dateReceived) {
      item.dateReceived = new Date().toISOString().slice(0, 10);
    }
    changed++;

    const shouldNotify = NOTIFY_ON_TRANSITION[newStatus] && item.lastNotified !== newStatus;
    if (!shouldNotify) continue;

    const addr = addrMap.get(item.recipientAddressId);
    if (!addr) {
      record(`  ERROR no address ${item.recipientAddressId} for ${item.item}`, 'ERROR');
      errors++;
      continue;
    }

    record(`  NTFY  Notifying ${addr.fullName}`);
    try {
      await notifyRecipient(item, addr, newStatus);
      item.lastNotified = newStatus;
      notified++;
    } catch (err) {
      record(`  ERROR Notification failed: ${err.message}`, 'ERROR');
      errors++;
    }
  }

  try {
    await saveInventory(inventory);
    record('Saved updated inventory.json');
  } catch (err) {
    record(`Failed to save inventory.json: ${err.message}`, 'ERROR');
  }

  record(`Done — ${active.length} checked, ${changed} changed, ${notified} notified, ${errors} errors`);
  record('─'.repeat(60));

  await writeSummaryLog(runLines);
}

main().catch(err => {
  console.error(`[${timestamp()}] [FATAL] ${err.message}`);
  process.exit(1);
});
