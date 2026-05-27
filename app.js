/**
 * app.js
 * CardTrack dashboard — Supabase-backed, with auth + CRUD.
 * Reads `addresses` and `inventory`; writes require sign-in.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL      = 'https://bnhyocinlvdfpbhybtaw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJuaHlvY2lubHZkZnBiaHlidGF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2Mjg0OTEsImV4cCI6MjA5NTIwNDQ5MX0.QgpvlXD5INIp56ld_Zo2Wn15Fhu5rhG8jx6CWxtKL3k';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const STATUS_LABELS = {
  pending:          'Pending',
  in_transit:       'In transit',
  out_for_delivery: 'Out for delivery',
  delivered:        'Delivered',
  failed:           'Delivery failed',
  unknown:          'Unknown',
  sold:             'Sold',
};

const CARRIER_LABELS = {
  royal_mail:  'Royal Mail',
  evri:        'Evri',
  dpd:         'DPD',
  yodel:       'Yodel',
  parcelforce: 'ParcelForce',
};

const CARRIER_URL = {
  royal_mail:  (ref) => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(ref)}`,
  evri:        (ref) => `https://www.evri.com/track/${encodeURIComponent(ref)}`,
  dpd:         (ref) => `https://track.dpd.co.uk/tracking/parcel/${encodeURIComponent(ref)}`,
  yodel:       (ref) => `https://www.yodel.co.uk/tracking/${encodeURIComponent(ref)}`,
  parcelforce: (ref) => `https://www.parcelforce.com/track-trace?trackNumber=${encodeURIComponent(ref)}`,
};
function trackingUrl(carrier, ref) {
  if (!carrier || !ref) return '';
  return CARRIER_URL[carrier] ? CARRIER_URL[carrier](ref) : '';
}

// Reverse: parse a tracking URL the user pasted into (carrier, ref).
const TRACKING_URL_PATTERNS = [
  { carrier: 'royal_mail',  re: /royalmail\.com\/.*?tracking-results\/([^/?#&]+)/i },
  { carrier: 'evri',        re: /evri\.com\/.*?track\/([^/?#&]+)/i },
  { carrier: 'dpd',         re: /dpd\.co\.uk\/.*?tracking\/parcel\/([^/?#&]+)/i },
  { carrier: 'yodel',       re: /yodel\.co\.uk\/.*?tracking\/([^/?#&]+)/i },
  { carrier: 'parcelforce', re: /parcelforce\.com\/.*?trackNumber=([^&?#]+)/i },
];
function parseTrackingInput(input) {
  const s = String(input || '').trim();
  if (!s) return { carrier: '', ref: '' };
  for (const { carrier, re } of TRACKING_URL_PATTERNS) {
    const m = s.match(re);
    if (m) return { carrier, ref: decodeURIComponent(m[1]) };
  }
  // Bare tracking number — keep it; the checker will skip until a carrier is set.
  if (/^[A-Za-z0-9-]+$/.test(s)) return { carrier: '', ref: s };
  return { carrier: '', ref: '' };
}

const ACQ_STATUSES  = ['pending', 'in_transit', 'out_for_delivery', 'delivered', 'failed'];
const CATEGORIES    = ['Topps', 'Pokémon'];
const QUANTITIES    = [1, 2, 3, 4];
const NOTIFY_TRIGGERS = ['in_transit', 'out_for_delivery', 'delivered', 'failed'];
const ACTIVE_STATUSES = ['pending', 'in_transit', 'out_for_delivery'];
const INGEST_STATUS_LABELS = {
  inserted: 'Inserted',
  skipped:  'Skipped',
  failed:   'Failed',
};

let INGESTIONS     = [];
let EMAIL_ACCOUNTS = [];
let SITES          = [];
let emailFilter    = 'all';     // 'all' | 'inserted' | 'skipped' — filters Recent activity table
let selectedAccount = '';       // Email tab dropdowns; persisted in localStorage
let selectedSite    = '';

const NAV_ICONS = {
  inventory:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5l6-3 6 3v7l-6 3-6-3v-7z"/><path d="M2 4.5l6 3 6-3"/><path d="M8 7.5v7"/></svg>',
  addresses:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="2.75"/><path d="M2.5 14c0-2.7 2.5-5 5.5-5s5.5 2.3 5.5 5"/></svg>',
  notifications: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5a5 5 0 1 1 10 0v3l1 2H2l1-2v-3z"/><path d="M6.5 13a1.5 1.5 0 0 0 3 0"/></svg>',
  email:         '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 5l5.5 4 5.5-4"/></svg>',
  settings:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4"/></svg>',
};

const TAB_META = {
  inventory:     { title: 'Inventory',     sub: 'Cards in your collection — what you paid, where they live, and what they sold for.' },
  addresses:     { title: 'Addresses',     sub: 'Friends and customers — where cards are sent and who you ship to.' },
  notifications: { title: 'Notifications', sub: 'Who has been notified, and what is queued for the next check.' },
  email:         { title: 'Email',         sub: 'Ingest order confirmations from your inbox.' },
  settings:      { title: 'Settings',      sub: 'Gmail accounts and sender sites used by the email scraper.' },
};

let ITEMS = [];
let ADDRESSES = [];
let ADDRESS_MAP = new Map();
let inventoryFilter = 'all';

// ── Generic helpers ───────────────────────────────────────────────────────────
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
function safeUrl(url) { return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : ''; }
function money(amount) {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '£' + Math.abs(n).toLocaleString('en-GB');
}
function statusLabel(s)  { return STATUS_LABELS[s] || s || 'Unknown'; }
function carrierLabel(c) { return CARRIER_LABELS[c] || c || '—'; }
function addressLines(addr) {
  if (!addr) return [];
  return [addr.line1, addr.line2, addr.line3, addr.town_city, addr.county, addr.postcode]
    .map(s => String(s || '').trim()).filter(Boolean);
}
function shortAddress(addr) {
  return [addr?.town_city, addr?.postcode].map(s => String(s || '').trim()).filter(Boolean).join(', ');
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function statusCell(s) {
  return `<span class="status status-${esc(s)}"><span class="sd"></span>${esc(statusLabel(s))}</span>`;
}
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function isWithinDays(value, days) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return !Number.isNaN(t) && (Date.now() - t) < days * 86400000;
}

function weekSummary() {
  const delivered = ITEMS.filter(i =>
    i.acquisition_status === 'delivered' && isWithinDays(i.date_received, 7)).length;
  const added = ITEMS.filter(i => isWithinDays(i.created_at, 7)).length;
  return { delivered, added };
}

// ── Data loading ──────────────────────────────────────────────────────────────
// Match "missing table" errors from both Supabase REST and Postgres so a
// freshly-cloned database (before the migration is run) doesn't break the UI.
function isMissingTableError(err) {
  if (!err) return false;
  return (
    /relation .* does not exist/i.test(err.message || '') ||
    /could not find the table/i.test(err.message || '')   ||
    err.code === '42P01' || err.code === 'PGRST205'
  );
}

async function loadData() {
  const [invRes, addrRes, ingRes, acctRes, siteRes] = await Promise.all([
    supabase.from('inventory').select('*').order('id'),
    supabase.from('addresses').select('*').order('id'),
    supabase.from('email_ingestions').select('*').order('ingested_at', { ascending: false }).limit(50),
    // Anon can't read app_password, so we explicitly request only safe columns.
    supabase.from('email_accounts').select('id, label, address, created_at').order('created_at'),
    supabase.from('sites').select('*').order('label'),
  ]);
  if (invRes.error)  throw new Error(`Inventory: ${invRes.error.message}`);
  if (addrRes.error) throw new Error(`Addresses: ${addrRes.error.message}`);
  if (ingRes.error  && !isMissingTableError(ingRes.error))  throw new Error(`Email ingestions: ${ingRes.error.message}`);
  if (acctRes.error && !isMissingTableError(acctRes.error)) throw new Error(`Email accounts: ${acctRes.error.message}`);
  if (siteRes.error && !isMissingTableError(siteRes.error)) throw new Error(`Sites: ${siteRes.error.message}`);
  ITEMS          = invRes.data  ?? [];
  ADDRESSES      = addrRes.data ?? [];
  INGESTIONS     = ingRes.data  ?? [];
  EMAIL_ACCOUNTS = acctRes.data ?? [];
  SITES          = siteRes.data ?? [];
  ADDRESS_MAP    = new Map(ADDRESSES.map(a => [a.id, a]));
}

// ── KPI tiles ─────────────────────────────────────────────────────────────────
function renderSummary() {
  const total     = ITEMS.length;
  const spent     = ITEMS.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const active    = ITEMS.filter(i => ACTIVE_STATUSES.includes(i.acquisition_status)).length;
  const delivered = ITEMS.filter(i => i.acquisition_status === 'delivered').length;

  const tiles = [
    { label: 'Items',      value: total,            tint: 'purple' },
    { label: 'Spent',      value: money(spent),     tint: 'green'  },
    { label: 'In transit', value: active,           tint: 'blue'   },
    { label: 'Delivered',  value: delivered,        tint: 'amber'  },
  ];

  document.getElementById('summary').innerHTML = tiles.map(t => `
    <div class="kpi" data-tint="${esc(t.tint)}">
      <div class="label"><span class="dot"></span>${esc(t.label)}</div>
      <div class="value">${esc(t.value)}</div>
    </div>
  `).join('');
}

// ── Inventory ─────────────────────────────────────────────────────────────────
function renderInventory() {
  const el = document.getElementById('tab-inventory');

  const filtered = inventoryFilter === 'all'
    ? ITEMS
    : ITEMS.filter(i => i.acquisition_status === inventoryFilter);

  const FILTER_KEYS = ['all', ...ACQ_STATUSES];
  const options = FILTER_KEYS.map(k => `
    <option value="${esc(k)}" ${k === inventoryFilter ? 'selected' : ''}>
      ${k === 'all' ? 'All statuses' : esc(statusLabel(k))}
    </option>
  `).join('');

  const rows = filtered.map(item => {
    const ref = item.tracking_ref || '';
    const url = safeUrl(trackingUrl(item.carrier, ref));
    const trackHtml = ref
      ? (url
          ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="mono" data-stop>${esc(ref)}</a>`
          : `<span class="mono">${esc(ref)}</span>`)
      : '<span class="muted">—</span>';
    const addr     = ADDRESS_MAP.get(item.recipient_address_id);
    const destName = addr?.full_name || '—';
    const destLoc  = shortAddress(addr);
    const subLine  = esc(item.category || '');

    return `
      <tr data-kind="inv" data-id="${esc(item.id)}">
        <td>
          <div class="primary">${esc(item.item)}</div>
          ${subLine ? `<span class="muted">${subLine}</span>` : ''}
        </td>
        <td>
          ${esc(destName)}
          ${destLoc ? `<span class="muted">${esc(destLoc)}</span>` : ''}
        </td>
        <td>${esc(carrierLabel(item.carrier))}</td>
        <td>${statusCell(item.acquisition_status)}</td>
        <td>${trackHtml}</td>
        <td class="num">${esc(money(item.cost))}</td>
      </tr>
    `;
  }).join('');

  const w = weekSummary();
  const wkHtml = `
    <div class="week-strip">
      <span class="wk-label">Past 7 days</span>
      <span class="wk-stat"><b>${w.delivered}</b> delivered</span>
      <span class="wk-stat"><b>${w.added}</b> added</span>
    </div>
  `;

  el.innerHTML = `
    ${wkHtml}
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Items</h2>
          <div class="sub">${filtered.length} of ${ITEMS.length} item${ITEMS.length === 1 ? '' : 's'}</div>
        </div>
        <div class="toolbar">
          <select id="status-filter">${options}</select>
          <button class="btn-primary btn-add" id="add-inv">+ Add item</button>
        </div>
      </div>
      ${filtered.length ? `
        <table class="row-clickable">
          <thead>
            <tr><th>Item</th><th>Sent to</th><th>Carrier</th>
                <th>Status</th><th>Tracking</th><th>Cost</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No items match this filter.</div>'}
    </div>
  `;

  document.getElementById('status-filter').addEventListener('change', e => {
    inventoryFilter = e.target.value;
    renderInventory();
  });
  document.getElementById('add-inv').addEventListener('click', () => openInventoryEditor());
  el.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('[data-stop]')) return;
      const item = ITEMS.find(i => i.id === tr.dataset.id);
      if (item) openInventoryEditor(item);
    });
  });
}

// ── Addresses ─────────────────────────────────────────────────────────────────
function renderAddresses() {
  const el = document.getElementById('tab-addresses');

  const cards = ADDRESSES.map(a => {
    const myItems   = ITEMS.filter(i => i.recipient_address_id === a.id);
    const totalCost = myItems.reduce((s, i) => s + (Number(i.cost) || 0), 0);
    const lines     = addressLines(a);
    const addrHtml  = lines.length ? lines.map(esc).join('<br>') : '<span class="muted">No address on file</span>';
    const channel   = (a.preferred_channel || 'sms').toLowerCase();

    return `
      <div class="person clickable" data-kind="addr" data-id="${esc(a.id)}">
        <div class="head">
          <div class="avatar">${esc(initials(a.full_name))}</div>
          <div class="head-meta">
            <div class="name">${esc(a.full_name)}</div>
          </div>
        </div>
        <div class="addr">${addrHtml}</div>
        <div class="contact">
          ${a.email ? `<div><b>Email</b>${esc(a.email)}</div>` : ''}
          <div><b>Phone</b>${esc(a.phone || '—')}</div>
          <div><b>Prefers</b><span class="channel-tag">${esc(channel.toUpperCase())}</span></div>
        </div>
        <div class="meta">
          <span>${myItems.length} item${myItems.length === 1 ? '' : 's'}</span>
          <b>${esc(money(totalCost))}</b>
        </div>
        ${myItems.length ? `<div class="items">${myItems.map(i => esc(i.item)).join(', ')}</div>` : ''}
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="section-head-bare">
      <button class="btn-primary btn-add" id="add-addr">+ Add address</button>
    </div>
    ${ADDRESSES.length
      ? `<div class="person-grid">${cards}</div>`
      : '<div class="empty">No addresses yet.</div>'}
  `;

  document.getElementById('add-addr').addEventListener('click', () => openAddressEditor());
  el.querySelectorAll('.person').forEach(p => {
    p.addEventListener('click', () => {
      const a = ADDRESSES.find(x => x.id === p.dataset.id);
      if (a) openAddressEditor(a);
    });
  });
}

// ── Notifications ─────────────────────────────────────────────────────────────
function notifyState(item) {
  if (!NOTIFY_TRIGGERS.includes(item.acquisition_status)) return { label: 'No alert', cls: 'muted' };
  if (item.last_notified === item.acquisition_status)     return { label: 'Sent',     cls: 'ok' };
  return { label: 'Queued', cls: 'warn' };
}
function renderNotifications() {
  const el = document.getElementById('tab-notifications');
  const states = ITEMS.map(notifyState);
  const sent   = states.filter(s => s.cls === 'ok').length;
  const queued = states.filter(s => s.cls === 'warn').length;
  const rows = ITEMS.map((item, i) => {
    const st   = states[i];
    const addr = ADDRESS_MAP.get(item.recipient_address_id);
    return `
      <tr>
        <td><div class="primary">${esc(addr?.full_name || '—')}</div></td>
        <td>${esc(item.item)}</td>
        <td>${statusCell(item.acquisition_status)}</td>
        <td>${item.last_notified ? esc(statusLabel(item.last_notified)) : '<span class="muted">Never</span>'}</td>
        <td><span class="pill ${st.cls}">${esc(st.label)}</span></td>
      </tr>
    `;
  }).join('');
  el.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Notification history</h2>
          <div class="sub">${sent} sent &middot; ${queued} queued for the next check</div>
        </div>
      </div>
      ${ITEMS.length ? `
        <table>
          <thead><tr><th>Recipient</th><th>Item</th><th>Status</th><th>Last notified</th><th>State</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No items to notify on.</div>'}
    </div>
  `;
}

// ── Email ─────────────────────────────────────────────────────────────────────
function renderEmail() {
  const el = document.getElementById('tab-email');

  const lastRun = INGESTIONS[0]?.ingested_at
    ? new Date(INGESTIONS[0].ingested_at).toLocaleString('en-GB')
    : 'never';

  // Inserted-but-no-recipient — the one bit of manual follow-up the scraper
  // leaves you with. Pair each such ingestion with its inventory row.
  const needsAttention = INGESTIONS
    .filter(ing => ing.status === 'inserted' && ing.inventory_id)
    .map(ing => ({ ing, item: ITEMS.find(i => i.id === ing.inventory_id) }))
    .filter(({ item }) => item && !item.recipient_address_id);

  const failures = INGESTIONS.filter(i => i.status === 'failed');

  const activity = INGESTIONS
    .filter(i => i.status !== 'failed')  // failures are surfaced separately
    .filter(i => emailFilter === 'all' || i.status === emailFilter)
    .slice(0, 20);

  const insertedCount = INGESTIONS.filter(i => i.status === 'inserted').length;
  const skippedCount  = INGESTIONS.filter(i => i.status === 'skipped').length;

  const chip = (key, label, count) => `
    <button class="chip ${emailFilter === key ? 'active' : ''}" data-filter="${esc(key)}">
      ${esc(label)}<span class="chip-count">${count}</span>
    </button>
  `;

  // Initialise selections to first row if unset / invalid (e.g. row was deleted).
  if (!EMAIL_ACCOUNTS.find(a => a.id === selectedAccount)) selectedAccount = EMAIL_ACCOUNTS[0]?.id || '';
  if (!SITES.find(s => s.id === selectedSite))             selectedSite    = SITES[0]?.id || '';

  const accountOptions = EMAIL_ACCOUNTS.map(a =>
    `<option value="${esc(a.id)}" ${a.id === selectedAccount ? 'selected' : ''}>${esc(a.label || a.address)}</option>`).join('');
  const siteOptions = SITES.filter(s => s.active !== false).map(s =>
    `<option value="${esc(s.id)}" ${s.id === selectedSite ? 'selected' : ''}>${esc(s.label || s.from_domain)}</option>`).join('');

  const canRun = !!(selectedAccount && selectedSite);
  const setupHint = !EMAIL_ACCOUNTS.length || !SITES.length
    ? `<div class="empty">Add a Gmail account and a site in <a href="#" data-go-settings>Settings</a> first.</div>`
    : '';

  // 1. Header strip ---------------------------------------------------------
  const headerHtml = `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Email ingestion</h2>
          <div class="sub">Last run: ${esc(lastRun)}</div>
        </div>
        <div class="toolbar">
          <select id="run-account" ${EMAIL_ACCOUNTS.length ? '' : 'disabled'}>
            ${EMAIL_ACCOUNTS.length ? accountOptions : '<option>No accounts</option>'}
          </select>
          <select id="run-site" ${SITES.length ? '' : 'disabled'}>
            ${SITES.length ? siteOptions : '<option>No sites</option>'}
          </select>
          <button class="btn-primary btn-add" id="run-ingest" ${canRun ? '' : 'disabled'}>Run now</button>
        </div>
      </div>
      ${setupHint}
      <div id="run-ingest-status" class="run-status" style="display:none"></div>
    </div>
  `;

  // 2. Needs attention (only when non-empty) --------------------------------
  const needsHtml = needsAttention.length ? `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Needs attention</h2>
          <div class="sub">${needsAttention.length} imported item${needsAttention.length === 1 ? '' : 's'} still missing a recipient.</div>
        </div>
      </div>
      <table class="row-clickable">
        <thead><tr><th>Item</th><th>From email</th><th>Ordered</th></tr></thead>
        <tbody>
          ${needsAttention.map(({ ing, item }) => `
            <tr data-kind="needs" data-id="${esc(item.id)}">
              <td>
                <div class="primary">${esc(item.item)}</div>
                ${item.category ? `<span class="muted">${esc(item.category)}</span>` : ''}
              </td>
              <td>
                <div>${esc(ing.subject || '(no subject)')}</div>
                <span class="muted">${esc(ing.sender || '')}</span>
              </td>
              <td class="num"><span class="muted">${esc(item.date_ordered || '—')}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  // 3. Failed parses (only when non-empty) ----------------------------------
  const failedHtml = failures.length ? `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Failed parses</h2>
          <div class="sub">${failures.length} email${failures.length === 1 ? '' : 's'} Claude or Supabase couldn't process.</div>
        </div>
      </div>
      <table>
        <thead><tr><th>Email</th><th>Reason</th><th>When</th></tr></thead>
        <tbody>
          ${failures.slice(0, 20).map(f => `
            <tr>
              <td><div class="primary">${esc(f.subject || '(no subject)')}</div><span class="muted">${esc(f.sender || '')}</span></td>
              <td><span class="muted">${esc(f.reason || '—')}</span></td>
              <td class="num"><span class="muted">${esc(f.ingested_at ? new Date(f.ingested_at).toLocaleString('en-GB') : '—')}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  // 4. Recent activity ------------------------------------------------------
  const activityHtml = `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Recent activity</h2>
          <div class="sub">Last 20 inserted or skipped.</div>
        </div>
        <div class="chips">
          ${chip('all',      'All',      insertedCount + skippedCount)}
          ${chip('inserted', 'Inserted', insertedCount)}
          ${chip('skipped',  'Skipped',  skippedCount)}
        </div>
      </div>
      ${activity.length ? `
        <table>
          <thead><tr><th>Email</th><th>Status</th><th>Result</th><th>When</th></tr></thead>
          <tbody>
            ${activity.map(ing => {
              const linkedItem = ing.inventory_id ? ITEMS.find(i => i.id === ing.inventory_id) : null;
              const resultCell = linkedItem
                ? `<span class="primary">${esc(linkedItem.item)}</span>`
                : ing.reason
                  ? `<span class="muted">${esc(ing.reason)}</span>`
                  : '<span class="muted">—</span>';
              const pillClass = ing.status === 'inserted' ? 'ok' : 'muted';
              return `
                <tr>
                  <td><div class="primary">${esc(ing.subject || '(no subject)')}</div><span class="muted">${esc(ing.sender || '')}</span></td>
                  <td><span class="pill ${pillClass}">${esc(INGEST_STATUS_LABELS[ing.status] || ing.status)}</span></td>
                  <td>${resultCell}</td>
                  <td class="num"><span class="muted">${esc(ing.ingested_at ? new Date(ing.ingested_at).toLocaleString('en-GB') : '—')}</span></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      ` : `<div class="empty">${INGESTIONS.length ? 'No ingestions match this filter.' : 'No ingestions yet. Hit Run now once your secrets are set.'}</div>`}
    </div>
  `;

  el.innerHTML = headerHtml + needsHtml + failedHtml + activityHtml;

  const accountSel = document.getElementById('run-account');
  const siteSel    = document.getElementById('run-site');
  if (accountSel) accountSel.addEventListener('change', e => { selectedAccount = e.target.value; });
  if (siteSel)    siteSel.addEventListener('change',    e => { selectedSite    = e.target.value; });

  const runBtn = document.getElementById('run-ingest');
  if (runBtn) runBtn.addEventListener('click', triggerIngest);

  el.querySelectorAll('[data-go-settings]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); switchTab('settings'); });
  });

  el.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      emailFilter = c.dataset.filter;
      renderEmail();
    });
  });

  el.querySelectorAll('tr[data-kind="needs"]').forEach(tr => {
    tr.addEventListener('click', () => {
      const item = ITEMS.find(i => i.id === tr.dataset.id);
      if (item) openInventoryEditor(item);
    });
  });
}

async function triggerIngest() {
  const btn    = document.getElementById('run-ingest');
  const status = document.getElementById('run-ingest-status');
  if (!selectedAccount || !selectedSite) {
    status.style.display = 'block';
    status.className = 'run-status warn';
    status.textContent = 'Pick a Gmail account and a site first.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Running…';
  status.style.display = 'block';
  status.className = 'run-status muted';
  const acct = EMAIL_ACCOUNTS.find(a => a.id === selectedAccount);
  const site = SITES.find(s => s.id === selectedSite);
  status.textContent = `Starting workflow for ${acct?.label || acct?.address} × ${site?.label || site?.from_domain}…`;

  try {
    const { data, error } = await supabase.functions.invoke('trigger-ingest', {
      method: 'POST',
      body:   { account_id: selectedAccount, site_id: selectedSite },
    });
    if (error) {
      const detail = data?.error || error.message || 'Unknown error';
      throw new Error(detail);
    }
    status.className = 'run-status ok';
    status.textContent = 'Workflow started. New ingestions will appear here in ~30 seconds.';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Run now'; }, 5000);
  } catch (err) {
    status.className = 'run-status warn';
    status.textContent = `Failed to trigger: ${err.message}`;
    btn.disabled = false;
    btn.textContent = 'Run now';
  }
}

function switchTab(tab) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
  const meta = TAB_META[tab] || {};
  document.getElementById('page-title').textContent = meta.title || '';
  document.getElementById('page-sub').textContent   = meta.sub   || '';
}

// ── Settings ──────────────────────────────────────────────────────────────────
function renderSettings() {
  const el = document.getElementById('tab-settings');

  const accountRows = EMAIL_ACCOUNTS.map(a => `
    <tr data-kind="acct" data-id="${esc(a.id)}">
      <td><div class="primary">${esc(a.label || a.address)}</div>${a.label ? `<span class="muted">${esc(a.address)}</span>` : ''}</td>
      <td><span class="muted">••••••••</span></td>
    </tr>
  `).join('');

  const siteRows = SITES.map(s => `
    <tr data-kind="site" data-id="${esc(s.id)}">
      <td><div class="primary">${esc(s.label || s.from_domain)}</div>${s.label ? `<span class="muted mono">@${esc(s.from_domain)}</span>` : ''}</td>
      <td>${s.subject_pattern ? `<span class="mono">${esc(s.subject_pattern)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${s.active === false ? '<span class="pill muted">Inactive</span>' : '<span class="pill ok">Active</span>'}</td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Gmail accounts</h2>
          <div class="sub">Mailboxes the scraper can read. The app password is stored encrypted-at-rest and never sent back to the browser.</div>
        </div>
        <button class="btn-primary btn-add" id="add-acct">+ Add account</button>
      </div>
      ${EMAIL_ACCOUNTS.length ? `
        <table class="row-clickable">
          <thead><tr><th>Account</th><th>App password</th></tr></thead>
          <tbody>${accountRows}</tbody>
        </table>
      ` : '<div class="empty">No Gmail accounts yet. Add one to enable scraping.</div>'}
    </div>

    <div class="section">
      <div class="section-head">
        <div>
          <h2>Sites</h2>
          <div class="sub">Senders the scraper accepts. Mail from any other domain is ignored.</div>
        </div>
        <button class="btn-primary btn-add" id="add-site">+ Add site</button>
      </div>
      ${SITES.length ? `
        <table class="row-clickable">
          <thead><tr><th>Site</th><th>Subject filter</th><th>Status</th></tr></thead>
          <tbody>${siteRows}</tbody>
        </table>
      ` : '<div class="empty">No sites configured.</div>'}
    </div>
  `;

  document.getElementById('add-acct').addEventListener('click', () => openEmailAccountEditor());
  document.getElementById('add-site').addEventListener('click', () => openSiteEditor());

  el.querySelectorAll('tr[data-kind="acct"]').forEach(tr => {
    tr.addEventListener('click', () => {
      const a = EMAIL_ACCOUNTS.find(x => x.id === tr.dataset.id);
      if (a) openEmailAccountEditor(a);
    });
  });
  el.querySelectorAll('tr[data-kind="site"]').forEach(tr => {
    tr.addEventListener('click', () => {
      const s = SITES.find(x => x.id === tr.dataset.id);
      if (s) openSiteEditor(s);
    });
  });
}

function emailAccountFormHtml(a = {}) {
  const editing = !!a.id;
  return `
    <div class="form-grid">
      ${field('Label',         'label',        'text',     { value: a.label,   wide: true })}
      ${field('Gmail address', 'address',      'email',    { value: a.address, required: true, wide: true })}
      ${field(editing ? 'New app password (leave blank to keep current)' : 'App password',
              'app_password', 'password', { value: '', required: !editing, wide: true })}
    </div>
    <p style="color: var(--text-muted); font-size: 12.5px; margin-top: 8px;">
      Generate one at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>. Remove spaces before pasting.
    </p>
  `;
}

function openEmailAccountEditor(existing) {
  const editing = !!existing;
  showModal({
    title: editing ? 'Edit Gmail account' : 'Add Gmail account',
    body:  emailAccountFormHtml(existing || {}),
    submitText: editing ? 'Save changes' : 'Add account',
    onSubmit: async (form) => {
      const data = readForm(form);
      // Strip whitespace from the app password — Google shows it with spaces.
      if (data.app_password) data.app_password = data.app_password.replace(/\s+/g, '');
      if (editing) {
        // Don't overwrite the password with blank — that's the "keep current" path.
        if (!data.app_password) delete data.app_password;
        const { error } = await supabase.from('email_accounts').update(data).eq('id', existing.id);
        if (error) throw error;
      } else {
        data.id = newId('acct');
        const { error } = await supabase.from('email_accounts').insert(data);
        if (error) throw error;
      }
    },
    onDelete: editing
      ? async () => {
          const { error } = await supabase.from('email_accounts').delete().eq('id', existing.id);
          if (error) throw error;
        }
      : null,
  });
}

function siteFormHtml(s = {}) {
  return `
    <div class="form-grid">
      ${field('Label',           'label',           'text', { value: s.label, required: true, wide: true })}
      ${field('From domain',     'from_domain',    'text', { value: s.from_domain, required: true, wide: true })}
      ${field('Subject filter (optional regex)', 'subject_pattern', 'text', { value: s.subject_pattern, wide: true })}
      ${field('Active', 'active', 'select', { value: s.active === false ? 'false' : 'true', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }], wide: true })}
    </div>
    <p style="color: var(--text-muted); font-size: 12.5px; margin-top: 8px;">
      From domain matches the sender's domain suffix — e.g. <code>t.shopifyemail.com</code> matches
      <code>store+1234@t.shopifyemail.com</code>. Leave subject filter blank to accept any subject.
    </p>
  `;
}

function openSiteEditor(existing) {
  const editing = !!existing;
  showModal({
    title: editing ? 'Edit site' : 'Add site',
    body:  siteFormHtml(existing || {}),
    submitText: editing ? 'Save changes' : 'Add site',
    onSubmit: async (form) => {
      const data = readForm(form);
      data.active      = data.active !== 'false';
      data.from_domain = (data.from_domain || '').replace(/^@/, '').toLowerCase();
      if (editing) {
        const { error } = await supabase.from('sites').update(data).eq('id', existing.id);
        if (error) throw error;
      } else {
        data.id = newId('site');
        const { error } = await supabase.from('sites').insert(data);
        if (error) throw error;
      }
    },
    onDelete: editing
      ? async () => {
          const { error } = await supabase.from('sites').delete().eq('id', existing.id);
          if (error) throw error;
        }
      : null,
  });
}

// ── Modal infrastructure ──────────────────────────────────────────────────────
function showModal({ title, body, submitText = 'Save', onSubmit, onDelete, afterMount, kind = 'modal' }) {
  const isPanel    = kind === 'panel';
  const overlay    = document.createElement('div');
  overlay.className = isPanel ? 'panel-overlay' : 'modal-overlay';
  const formClass  = isPanel ? 'side-panel' : 'modal';
  overlay.innerHTML = `
    <form class="${formClass}" id="modal-form" novalidate>
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-error hidden" id="modal-error"></div>
      <div class="modal-foot">
        ${onDelete ? '<button type="button" class="btn-danger" id="modal-delete">Delete</button>' : ''}
        <div class="spacer"></div>
        <button type="button" class="btn-secondary modal-close">Cancel</button>
        <button type="submit" class="btn-primary">${esc(submitText)}</button>
      </div>
    </form>
  `;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', close));
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  const form  = overlay.querySelector('#modal-form');
  const errEl = overlay.querySelector('#modal-error');
  const setBusy = (busy) => overlay.querySelectorAll('button, input, select, textarea')
    .forEach(el => el.disabled = busy);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.add('hidden');
    setBusy(true);
    try {
      await onSubmit(form);
      close();
      await refresh();
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.classList.remove('hidden');
      setBusy(false);
    }
  });

  if (onDelete) {
    overlay.querySelector('#modal-delete').addEventListener('click', async () => {
      if (!confirm('Delete this record? This cannot be undone.')) return;
      errEl.classList.add('hidden');
      setBusy(true);
      try {
        await onDelete();
        close();
        await refresh();
      } catch (err) {
        errEl.textContent = err.message || String(err);
        errEl.classList.remove('hidden');
        setBusy(false);
      }
    });
  }

  setTimeout(() => {
    const first = overlay.querySelector('input:not([type="hidden"]), select, textarea');
    if (first) first.focus();
  }, 50);

  if (afterMount) afterMount(form);
}

// ── Form fields ───────────────────────────────────────────────────────────────
function field(label, name, type, opts = {}) {
  const v = opts.value ?? '';
  const req = opts.required ? 'required' : '';
  const wide = opts.wide ? ' wide' : '';
  const step = opts.step ? `step="${esc(opts.step)}"` : '';
  if (type === 'textarea') {
    return `<label class="field${wide}"><span>${esc(label)}</span><textarea name="${esc(name)}" ${req}>${esc(v)}</textarea></label>`;
  }
  if (type === 'select') {
    const optsHtml = opts.options.map(o => {
      const val = typeof o === 'string' || typeof o === 'number' ? o : o.value;
      const lbl = typeof o === 'string' || typeof o === 'number' ? o : o.label;
      return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lbl)}</option>`;
    }).join('');
    return `<label class="field${wide}"><span>${esc(label)}</span><select name="${esc(name)}" ${req}>${optsHtml}</select></label>`;
  }
  if (opts.prefix) {
    return `<label class="field${wide}"><span>${esc(label)}</span>
      <span class="input-wrap has-prefix">
        <span class="prefix">${esc(opts.prefix)}</span>
        <input type="${esc(type)}" name="${esc(name)}" value="${esc(v)}" ${req} ${step}>
      </span>
    </label>`;
  }
  return `<label class="field${wide}"><span>${esc(label)}</span><input type="${esc(type)}" name="${esc(name)}" value="${esc(v)}" ${req} ${step}></label>`;
}

async function lookupPostcode(postcode) {
  const clean = String(postcode || '').replace(/\s+/g, '');
  if (!clean) return null;
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.status === 200 ? data.result : null;
  } catch {
    return null;
  }
}

function wirePostcodeLookup(form) {
  const postcodeInput = form.querySelector('input[name="postcode"]');
  if (!postcodeInput) return;
  postcodeInput.addEventListener('blur', async () => {
    const r = await lookupPostcode(postcodeInput.value);
    if (!r) return;
    const town   = r.admin_district || r.parish || '';
    const county = r.admin_county   || r.region || '';
    const townEl   = form.querySelector('input[name="town_city"]');
    const countyEl = form.querySelector('input[name="county"]');
    if (town   && townEl)   townEl.value   = town;
    if (county && countyEl) countyEl.value = county;
  });
}

function addressFormHtml(a = {}) {
  return `
    <div class="form-grid">
      ${field('Full name', 'full_name', 'text', { value: a.full_name, required: true, wide: true })}
      ${field('Email', 'email', 'email', { value: a.email })}
      ${field('Phone', 'phone', 'tel', { value: a.phone })}
      ${field('Preferred channel', 'preferred_channel', 'select', { value: a.preferred_channel || 'sms', options: ['sms', 'email'], wide: true })}
      ${field('Address line 1', 'line1', 'text', { value: a.line1, wide: true })}
      ${field('Address line 2', 'line2', 'text', { value: a.line2, wide: true })}
      ${field('Address line 3', 'line3', 'text', { value: a.line3, wide: true })}
      ${field('Town / City', 'town_city', 'text', { value: a.town_city })}
      ${field('County', 'county', 'text', { value: a.county })}
      ${field('Postcode', 'postcode', 'text', { value: a.postcode })}
      ${field('Country', 'country', 'text', { value: a.country || 'UK' })}
      ${field('Notes', 'notes', 'textarea', { value: a.notes, wide: true })}
    </div>
  `;
}

function inventoryFormHtml(it = {}) {
  const addrOpts = [{ value: '', label: '—' }, ...ADDRESSES.map(a => ({ value: a.id, label: a.full_name }))];
  const categoryOpts = [{ value: '', label: '—' }, ...CATEGORIES.map(c => ({ value: c, label: c }))];
  const qtyOpts = QUANTITIES.map(n => ({ value: n, label: String(n) }));
  const statusOpts = ACQ_STATUSES.map(s => ({ value: s, label: STATUS_LABELS[s] || s }));
  const trackingLinkValue = trackingUrl(it.carrier, it.tracking_ref) || it.tracking_ref || '';
  return `
    <div class="form-section-label">Card</div>
    <div class="form-grid">
      ${field('Item', 'item', 'text', { value: it.item, required: true, wide: true })}
      ${field('Category', 'category', 'select', { value: it.category || '', options: categoryOpts })}
      ${field('Quantity', 'quantity', 'select', { value: it.quantity ?? 1, options: qtyOpts })}
    </div>
    <div class="form-section-label">Order</div>
    <div class="form-grid">
      ${field('Order Reference', 'order_reference', 'text', { value: it.order_reference })}
      ${field('Date Ordered', 'date_ordered', 'date', { value: it.date_ordered })}
      ${field('Cost', 'cost', 'number', { value: it.cost ?? '', prefix: '£', step: '0.01' })}
      ${field('Tracking link', 'tracking_link', 'url', { value: trackingLinkValue, wide: true })}
      ${field('Item Status', 'acquisition_status', 'select', { value: it.acquisition_status || 'pending', options: statusOpts })}
      ${field('Delivery Date', 'date_received', 'date', { value: it.date_received })}
      ${field('Sent to', 'recipient_address_id', 'select', { value: it.recipient_address_id || '', options: addrOpts, required: true, wide: true })}
    </div>
    <div class="form-grid">
      ${field('Notes', 'notes', 'textarea', { value: it.notes, wide: true })}
    </div>
  `;
}

// ── CRUD: address / inventory ─────────────────────────────────────────────────
function readForm(form) {
  const data = {};
  for (const [k, v] of new FormData(form)) {
    data[k] = typeof v === 'string' ? v.trim() : v;
  }
  return data;
}

function cleanInventoryPayload(data) {
  // Tracking link → (carrier, tracking_ref). The link itself isn't stored —
  // it's rebuilt from those two via trackingUrl() on read.
  const link = data.tracking_link;
  delete data.tracking_link;
  if (link != null) {
    const { carrier, ref } = parseTrackingInput(link);
    data.carrier      = carrier;
    data.tracking_ref = ref;
  }

  ['quantity', 'cost'].forEach(k => {
    if (data[k] === '' || data[k] == null) data[k] = null;
    else data[k] = Number(data[k]);
  });
  ['date_ordered', 'date_received', 'recipient_address_id'].forEach(k => {
    if (data[k] === '' || data[k] == null) data[k] = null;
  });
  return data;
}

function openAddressEditor(existing) {
  const editing = !!existing;
  showModal({
    title: editing ? 'Edit Address' : 'New Address',
    body:  addressFormHtml(existing || {}),
    submitText: editing ? 'Save changes' : 'Add address',
    afterMount: (form) => wirePostcodeLookup(form),
    onSubmit: async (form) => {
      const data = readForm(form);
      if (editing) {
        const { error } = await supabase.from('addresses').update(data).eq('id', existing.id);
        if (error) throw error;
      } else {
        data.id = newId('addr');
        const { error } = await supabase.from('addresses').insert(data);
        if (error) throw error;
      }
    },
    onDelete: editing
      ? async () => {
          // Block delete if any inventory references this address
          const refs = ITEMS.filter(i => i.recipient_address_id === existing.id);
          if (refs.length) {
            throw new Error(`${refs.length} item${refs.length === 1 ? '' : 's'} still ship here — reassign or delete those first.`);
          }
          const { error } = await supabase.from('addresses').delete().eq('id', existing.id);
          if (error) throw error;
        }
      : null,
  });
}

function openInventoryEditor(existing) {
  const editing = !!existing;
  showModal({
    kind: 'panel',
    title: editing ? 'Edit item' : 'New item',
    body:  inventoryFormHtml(existing || {}),
    submitText: editing ? 'Save changes' : 'Add item',
    onSubmit: async (form) => {
      const data = cleanInventoryPayload(readForm(form));
      if (editing) {
        const { error } = await supabase.from('inventory').update(data).eq('id', existing.id);
        if (error) throw error;
      } else {
        data.id = newId('inv');
        const { error } = await supabase.from('inventory').insert(data);
        if (error) throw error;
      }
    },
    onDelete: editing
      ? async () => {
          const { error } = await supabase.from('inventory').delete().eq('id', existing.id);
          if (error) throw error;
        }
      : null,
  });
}

// ── Nav & tabs ────────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const tab = btn.dataset.tab;
    btn.insertAdjacentHTML('afterbegin', `<span class="nav-ico">${NAV_ICONS[tab] || ''}</span>`);
  });
  document.getElementById('nav').addEventListener('click', e => {
    const btn = e.target.closest('.nav-btn');
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });
}

// ── Render all ────────────────────────────────────────────────────────────────
function renderAll() {
  renderSummary();
  renderInventory();
  renderAddresses();
  renderNotifications();
  renderEmail();
  renderSettings();
}

async function refresh() {
  const errEl = document.getElementById('error');
  try {
    await loadData();
    errEl.classList.add('hidden');
    renderAll();
    document.getElementById('loaded-at').textContent =
      `Updated ${new Date().toLocaleTimeString('en-GB')}`;
  } catch (err) {
    errEl.textContent = `Could not load data: ${err.message}`;
    errEl.classList.remove('hidden');
  }
}

// ── Realtime subscription ─────────────────────────────────────────────────────
let _pendingRefresh = null;
function scheduleRefresh() {
  // Coalesce bursts of events into one refresh.
  if (_pendingRefresh) return;
  _pendingRefresh = setTimeout(() => { _pendingRefresh = null; refresh(); }, 250);
}

function subscribeRealtime() {
  supabase
    .channel('cardtrack-db')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'addresses' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'email_ingestions' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'email_accounts' },   scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sites' },             scheduleRefresh)
    .subscribe();
}

// ── Init ──────────────────────────────────────────────────────────────────────
setupNav();
document.getElementById('refresh').addEventListener('click', refresh);
subscribeRealtime();
refresh();
