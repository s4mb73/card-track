#!/usr/bin/env node
/**
 * checker.js
 * ──────────────────────────────────────────────────────────────────────────────
 * CardTrack hourly order checker.
 * 
 * Run manually:    node checker.js
 * Run via cron:    0 * * * * cd /path/to/cardtrack && node checker.js >> logs/checker.log 2>&1
 * Run via npm:     npm start
 * 
 * What it does:
 *   1. Reads orders.json
 *   2. For each active order, checks the carrier tracking status
 *   3. If the status has changed, sends SMS/WhatsApp via Twilio
 *   4. Writes updated statuses back to orders.json
 *   5. Appends a run summary to logs/checker.log
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync }                 from 'fs';
import { createWriteStream }          from 'fs';
import path                           from 'path';
import { fileURLToPath }              from 'url';
import 'dotenv/config';

import { checkTracking, STATUS }      from './carriers.js';
import { notifyRecipient }            from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const LOGS_DIR    = path.join(__dirname, 'logs');

// ── Statuses we actively track (skip already-delivered/failed) ────────────────
const ACTIVE_STATUSES = ['pending', 'in_transit', 'out_for_delivery'];

// ── Which status transitions should trigger a notification ───────────────────
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

// ── Load / save orders ────────────────────────────────────────────────────────
async function loadOrders() {
  const raw = await readFile(ORDERS_FILE, 'utf8');
  return JSON.parse(raw);
}

async function saveOrders(data) {
  await writeFile(ORDERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Append run summary to log file ────────────────────────────────────────────
async function writeSummaryLog(lines) {
  if (!existsSync(LOGS_DIR)) await mkdir(LOGS_DIR, { recursive: true });
  const logFile = path.join(LOGS_DIR, 'checker.log');
  const content = lines.join('\n') + '\n';
  await writeFile(logFile, content, { flag: 'a', encoding: 'utf8' });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const runLines = [];
  const record   = (msg, level = 'INFO') => {
    const line = log(msg, level);
    runLines.push(line);
  };

  record('─'.repeat(60));
  record('CardTrack checker starting');

  // Load orders
  let data;
  try {
    data = await loadOrders();
  } catch (err) {
    record(`Failed to load orders.json: ${err.message}`, 'ERROR');
    process.exit(1);
  }

  const orders = data.orders ?? [];
  const active = orders.filter(o => ACTIVE_STATUSES.includes(o.status));

  record(`Loaded ${orders.length} orders, ${active.length} active`);

  if (active.length === 0) {
    record('No active orders to check — done');
    await writeSummaryLog(runLines);
    return;
  }

  let changed  = 0;
  let notified = 0;
  let errors   = 0;

  for (const order of active) {
    // Skip if no tracking ref yet
    if (!order.tracking?.ref) {
      record(`  SKIP  ${order.item} — no tracking ref yet`);
      continue;
    }

    record(`  CHECK ${order.item} (${order.tracking.carrier} · ${order.tracking.ref})`);

    let newStatus;
    try {
      newStatus = await checkTracking(order.tracking.carrier, order.tracking.ref);
    } catch (err) {
      record(`  ERROR ${order.item}: ${err.message}`, 'ERROR');
      errors++;
      continue;
    }

    const oldStatus = order.status;
    order.lastChecked = new Date().toISOString();

    if (newStatus === STATUS.UNKNOWN) {
      record(`  SKIP  ${order.item} — status unknown (tracking may not be live yet)`);
      continue;
    }

    if (newStatus === oldStatus) {
      record(`  SAME  ${order.item} — ${oldStatus} (no change)`);
      continue;
    }

    // Status changed!
    record(`  CHNG  ${order.item} — ${oldStatus} → ${newStatus}`, 'WARN');
    order.status = newStatus;
    changed++;

    // Notify if this transition warrants it and we haven't already notified
    const shouldNotify = NOTIFY_ON_TRANSITION[newStatus] && order.lastNotified !== newStatus;

    if (shouldNotify) {
      record(`  NTFY  Sending notification to ${order.recipient.name}`);
      try {
        await notifyRecipient(order, newStatus);
        order.lastNotified = newStatus;
        notified++;
      } catch (err) {
        record(`  ERROR Notification failed: ${err.message}`, 'ERROR');
        errors++;
      }
    }
  }

  // Save updated statuses
  try {
    await saveOrders(data);
    record(`Saved updated orders.json`);
  } catch (err) {
    record(`Failed to save orders.json: ${err.message}`, 'ERROR');
  }

  record(`Done — ${active.length} checked, ${changed} changed, ${notified} notified, ${errors} errors`);
  record('─'.repeat(60));

  await writeSummaryLog(runLines);
}

main().catch(err => {
  console.error(`[${timestamp()}] [FATAL] ${err.message}`);
  process.exit(1);
});
