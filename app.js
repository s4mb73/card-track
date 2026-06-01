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
  confirmed:        'Confirmed',
  in_transit:       'In transit',
  out_for_delivery: 'Out for delivery',
  delivered:        'Delivered',
  picked_up:        'Picked up',
  failed:           'Delivery failed',
  cancelled:        'Cancelled',
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

const ACQ_STATUSES  = ['confirmed', 'in_transit', 'out_for_delivery', 'delivered', 'picked_up', 'failed', 'cancelled'];
const CATEGORIES    = ['Topps', 'Pokémon'];
const QUANTITIES    = [1, 2, 3, 4];
const NOTIFY_TRIGGERS = ['in_transit', 'out_for_delivery', 'delivered', 'failed', 'cancelled'];
const ACTIVE_STATUSES = ['confirmed', 'in_transit', 'out_for_delivery'];
const INGEST_STATUS_LABELS = {
  inserted: 'Inserted',
  skipped:  'Skipped',
  failed:   'Failed',
};

let INGESTIONS     = [];
let EMAIL_ACCOUNTS = [];
let SITES          = [];
let WEBHOOKS       = [];
let INGEST_RUNS    = [];
let emailFilter    = 'all';     // 'all' | 'inserted' | 'skipped' — filters Recent activity table
let selectedAccount = '';       // Email tab dropdowns; persisted in localStorage
let selectedSite    = '';
let addrSearchQuery = '';       // Addresses tab search input

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
  email:         { title: 'Email scraper', sub: 'Pull order confirmations from your inbox.' },
  settings:      { title: 'Settings',      sub: 'Gmail accounts and sender sites used by the email scraper.' },
};

let ITEMS = [];
let ADDRESSES = [];
let ADDRESS_MAP = new Map();
let inventoryFilter = 'all';
let inventorySort   = 'newest';
let inventoryView   = localStorage.getItem('inv_view') || 'flat'; // 'flat' | 'grouped'
let inventorySearch = '';
let SELECTED_INV    = new Set();
let COLLAPSED_GROUPS = new Set(JSON.parse(localStorage.getItem('inv_collapsed') || '[]'));

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
  const [invRes, addrRes, ingRes, acctRes, siteRes, hookRes, runRes] = await Promise.all([
    supabase.from('inventory').select('*').order('id'),
    supabase.from('addresses').select('*').order('id'),
    supabase.from('email_ingestions').select('*').order('ingested_at', { ascending: false }).limit(50),
    supabase.from('email_accounts').select('id, label, address, created_at').order('created_at'),
    supabase.from('sites').select('*').order('label'),
    supabase.from('webhooks').select('id, label, active, created_at').order('created_at'),
    supabase.from('ingest_runs').select('*').order('started_at', { ascending: false }).limit(5),
  ]);
  if (invRes.error)  throw new Error(`Inventory: ${invRes.error.message}`);
  if (addrRes.error) throw new Error(`Addresses: ${addrRes.error.message}`);
  if (ingRes.error  && !isMissingTableError(ingRes.error))  throw new Error(`Email ingestions: ${ingRes.error.message}`);
  if (acctRes.error && !isMissingTableError(acctRes.error)) throw new Error(`Email accounts: ${acctRes.error.message}`);
  if (siteRes.error && !isMissingTableError(siteRes.error)) throw new Error(`Sites: ${siteRes.error.message}`);
  if (hookRes.error && !isMissingTableError(hookRes.error)) throw new Error(`Webhooks: ${hookRes.error.message}`);
  if (runRes.error  && !isMissingTableError(runRes.error))  throw new Error(`Ingest runs: ${runRes.error.message}`);
  ITEMS          = invRes.data  ?? [];
  ADDRESSES      = addrRes.data ?? [];
  INGESTIONS     = ingRes.data  ?? [];
  EMAIL_ACCOUNTS = acctRes.data ?? [];
  SITES          = siteRes.data ?? [];
  WEBHOOKS       = hookRes.data ?? [];
  INGEST_RUNS    = runRes.data  ?? [];
  ADDRESS_MAP    = new Map(ADDRESSES.map(a => [a.id, a]));
}

// ── KPI tiles ─────────────────────────────────────────────────────────────────
function renderSummary() {
  // Cancelled orders are refunded, so they never inflate Items/Spent. The KPIs
  // also follow the active Inventory filter: Items + Spent narrow to whatever
  // status is filtered (e.g. spend on delivered orders, or value of cancelled),
  // while the status-breakdown tiles stay as stable global context.
  const live      = ITEMS.filter(i => i.acquisition_status !== 'cancelled');
  const cancelled = ITEMS.length - live.length;
  const filtering = inventoryFilter !== 'all';
  const scope     = filtering
    ? ITEMS.filter(i => i.acquisition_status === inventoryFilter)
    : live;
  const spent     = scope.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const active    = live.filter(i => ACTIVE_STATUSES.includes(i.acquisition_status)).length;
  const delivered = live.filter(i => i.acquisition_status === 'delivered').length;
  const suffix    = filtering ? ` · ${statusLabel(inventoryFilter)}` : '';

  const tiles = [
    { label: `Items${suffix}`, value: scope.length, tint: 'purple' },
    { label: `Spent${suffix}`, value: money(spent), tint: 'green'  },
    { label: 'In transit',     value: active,       tint: 'blue'   },
    { label: 'Delivered',      value: delivered,    tint: 'amber'  },
  ];
  if (cancelled) tiles.push({ label: 'Cancelled', value: cancelled, tint: 'slate' });

  document.getElementById('summary').innerHTML = tiles.map(t => `
    <div class="kpi" data-tint="${esc(t.tint)}">
      <div class="label"><span class="dot"></span>${esc(t.label)}</div>
      <div class="value">${esc(t.value)}</div>
    </div>
  `).join('');
}

// ── Inventory ─────────────────────────────────────────────────────────────────
// Inventory sort: options for the "Sort by" dropdown + the comparator.
// Default is newest-first. `inventorySort` (declared above) holds the choice.
const SORT_OPTIONS = [
  ['newest',    'Newest first'],
  ['oldest',    'Oldest first'],
  ['status',    'Status (urgent first)'],
  ['recipient', 'Recipient (A–Z)'],
  ['item',      'Item (A–Z)'],
  ['cost_high', 'Cost (high → low)'],
  ['cost_low',  'Cost (low → high)'],
];
const STATUS_SORT_RANK = {
  out_for_delivery: 0, in_transit: 1, confirmed: 2, delivered: 3, failed: 4, cancelled: 5,
};
function itemOrderTime(i) {
  const d = i.date_ordered || i.created_at;
  const t = d ? new Date(d).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}
function itemRecipientName(i) {
  return (ADDRESS_MAP.get(i.recipient_address_id)?.full_name || '').toLowerCase();
}
function compareInventory(a, b, sort) {
  switch (sort) {
    case 'oldest':    return itemOrderTime(a) - itemOrderTime(b);
    case 'status':    return (STATUS_SORT_RANK[a.acquisition_status] ?? 9) - (STATUS_SORT_RANK[b.acquisition_status] ?? 9)
                          || itemOrderTime(b) - itemOrderTime(a);
    case 'recipient': return itemRecipientName(a).localeCompare(itemRecipientName(b)) || itemOrderTime(b) - itemOrderTime(a);
    case 'item':      return String(a.item || '').localeCompare(String(b.item || ''));
    case 'cost_high': return (Number(b.cost) || 0) - (Number(a.cost) || 0);
    case 'cost_low':  return (Number(a.cost) || 0) - (Number(b.cost) || 0);
    case 'newest':
    default:          return itemOrderTime(b) - itemOrderTime(a);
  }
}

function renderInventory() {
  const el = document.getElementById('tab-inventory');

  // Default ("all") hides cancelled orders so refunded items don't clutter the
  // list — pick "Cancelled" from the filter to see them.
  // "active" view hides anything terminal from your perspective —
  // cancelled (gone) and picked_up (already in your hands). What's
  // left needs your attention.
  const isTerminal = (s) => s === 'cancelled' || s === 'picked_up';
  const q = inventorySearch.trim().toLowerCase();
  const matchesSearch = (i) => {
    if (!q) return true;
    const a = ADDRESS_MAP.get(i.recipient_address_id);
    return [
      i.item, i.order_reference, i.category, i.carrier, i.tracking_ref,
      a?.full_name, a?.postcode, a?.town_city,
    ].some(v => String(v || '').toLowerCase().includes(q));
  };
  const filtered = (inventoryFilter === 'all'
    ? ITEMS.filter(i => !isTerminal(i.acquisition_status))
    : ITEMS.filter(i => i.acquisition_status === inventoryFilter)
  ).filter(matchesSearch);
  const cancelledHidden = inventoryFilter === 'all'
    ? ITEMS.filter(i => isTerminal(i.acquisition_status)).length
    : 0;

  filtered.sort((a, b) => compareInventory(a, b, inventorySort));

  const FILTER_KEYS = ['all', ...ACQ_STATUSES];
  const options = FILTER_KEYS.map(k => `
    <option value="${esc(k)}" ${k === inventoryFilter ? 'selected' : ''}>
      ${k === 'all' ? 'Active (excl. cancelled + picked up)' : esc(statusLabel(k))}
    </option>
  `).join('');
  const sortOpts = SORT_OPTIONS.map(([v, l]) =>
    `<option value="${esc(v)}" ${v === inventorySort ? 'selected' : ''}>${esc(l)}</option>`).join('');

  // Drop any selections whose row no longer exists in the filtered view —
  // e.g. you select two rows, change the status filter, then change back.
  const visibleIds = new Set(filtered.map(i => i.id));
  for (const id of SELECTED_INV) if (!visibleIds.has(id)) SELECTED_INV.delete(id);
  const allChecked = filtered.length > 0 && filtered.every(i => SELECTED_INV.has(i.id));

  const renderItemRow = (item) => {
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
    const subParts = [item.category, item.order_reference].map(s => String(s || '').trim()).filter(Boolean);
    const subLine  = subParts.join(' · ');
    const checked  = SELECTED_INV.has(item.id);
    const actionBtn = item.acquisition_status === 'delivered'
      ? `<button class="btn-secondary btn-sm" data-mark-pickup="${esc(item.id)}" data-stop title="Mark as picked up">Pick ✓</button>`
      : '';

    // Days-since-delivered badge — turns amber after 3 days, red after 7.
    // Nudges you toward planning a pickup before the cards sit too long.
    let ageBadge = '';
    if (item.acquisition_status === 'delivered' && item.date_received) {
      const days = Math.floor((Date.now() - new Date(item.date_received).getTime()) / 86400000);
      if (days >= 0) {
        const cls = days >= 7 ? 'urgent' : days >= 3 ? 'warn' : 'fresh';
        ageBadge = ` <span class="age-badge ${cls}" title="Delivered ${days} day${days === 1 ? '' : 's'} ago">${days}d</span>`;
      }
    }

    return `
      <tr data-kind="inv" data-id="${esc(item.id)}" class="${checked ? 'is-selected' : ''}">
        <td class="select-cell" data-stop>
          <input type="checkbox" class="row-select" data-id="${esc(item.id)}" ${checked ? 'checked' : ''}>
        </td>
        <td>
          <div class="primary">${esc(item.item)}</div>
          ${subLine ? `<span class="muted mono">${esc(subLine)}</span>` : ''}
        </td>
        <td>
          ${esc(destName)}
          ${destLoc ? `<span class="muted">${esc(destLoc)}</span>` : ''}
        </td>
        <td>${esc(carrierLabel(item.carrier))}</td>
        <td>${statusCell(item.acquisition_status)}${ageBadge}</td>
        <td>${trackHtml}</td>
        <td class="num">${esc(money(item.cost))}</td>
        <td class="action-cell" data-stop>${actionBtn}</td>
      </tr>
    `;
  };

  // Build the table body. Grouped view nests rows under a clickable
  // recipient header; the header row spans all columns.
  let rowsHtml;
  if (inventoryView === 'grouped') {
    const groups = new Map();
    for (const it of filtered) {
      const k = it.recipient_address_id || '__unassigned__';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
      const na = ADDRESS_MAP.get(a)?.full_name || 'zzz Unassigned';
      const nb = ADDRESS_MAP.get(b)?.full_name || 'zzz Unassigned';
      return na.localeCompare(nb);
    });
    rowsHtml = sortedGroups.map(([addrId, items]) => {
      const addr = ADDRESS_MAP.get(addrId);
      const name = addr?.full_name || 'Unassigned';
      const pc   = addr?.postcode || '';
      const total = items.reduce((s, i) => s + (Number(i.cost) || 0), 0);
      const counts = items.reduce((acc, i) => {
        acc[i.acquisition_status] = (acc[i.acquisition_status] || 0) + 1;
        return acc;
      }, {});
      const countSummary = Object.entries(counts)
        .map(([s, n]) => `${n} ${statusLabel(s).toLowerCase()}`)
        .join(' · ');
      const collapsed = COLLAPSED_GROUPS.has(addrId);
      const header = `
        <tr class="group-row" data-group-id="${esc(addrId)}">
          <td colspan="8">
            <span class="group-caret">${collapsed ? '▸' : '▾'}</span>
            <strong>${esc(name)}</strong>
            ${pc ? `<span class="muted mono"> · ${esc(pc)}</span>` : ''}
            <span class="muted"> · ${items.length} item${items.length === 1 ? '' : 's'} · ${esc(countSummary)} · ${esc(money(total))}</span>
          </td>
        </tr>
      `;
      const body = collapsed ? '' : items.map(renderItemRow).join('');
      return header + body;
    }).join('');
  } else {
    rowsHtml = filtered.map(renderItemRow).join('');
  }
  const rows = rowsHtml;

  const selectedDelivered = filtered.filter(i =>
    SELECTED_INV.has(i.id) && i.acquisition_status === 'delivered').length;

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
          <div class="sub">${filtered.length} item${filtered.length === 1 ? '' : 's'}${cancelledHidden ? ` · ${cancelledHidden} cancelled hidden` : ''}</div>
        </div>
        <div class="toolbar">
          ${selectedDelivered ? `<button class="btn-primary btn-add" id="bulk-pickup-inv">Mark ${selectedDelivered} picked up</button>` : ''}
          ${SELECTED_INV.size ? `<button class="btn-danger btn-add" id="bulk-delete-inv">Delete ${SELECTED_INV.size} item${SELECTED_INV.size === 1 ? '' : 's'}</button>` : ''}
          <input type="search" id="inv-search" class="search-input" placeholder="Search item, ref, recipient…" value="${esc(inventorySearch)}" aria-label="Search inventory">
          <div class="seg-control" role="tablist" aria-label="Inventory view">
            <button type="button" data-view="flat"    class="${inventoryView === 'flat' ? 'active' : ''}">List</button>
            <button type="button" data-view="grouped" class="${inventoryView === 'grouped' ? 'active' : ''}">By recipient</button>
          </div>
          <select id="status-filter" aria-label="Filter by status">${options}</select>
          <select id="inv-sort" aria-label="Sort by">${sortOpts}</select>
          <button class="btn-secondary btn-add" id="check-tracking" title="Poll carriers now (otherwise runs every 15 min)">Check tracking</button>
          <button class="btn-primary btn-add" id="add-inv">+ Add item</button>
        </div>
      </div>
      ${filtered.length ? `
        <table class="row-clickable inv-table">
          <thead>
            <tr>
              <th class="select-cell"><input type="checkbox" id="select-all-inv" ${allChecked ? 'checked' : ''}></th>
              <th>Item</th><th>Sent to</th><th>Carrier</th>
              <th>Status</th><th>Tracking</th><th>Cost</th><th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No items match this filter.</div>'}
    </div>
  `;

  document.getElementById('status-filter').addEventListener('change', e => {
    inventoryFilter = e.target.value;
    renderInventory();
    renderSummary();   // KPIs follow the active filter
  });
  document.getElementById('inv-sort').addEventListener('change', e => {
    inventorySort = e.target.value;
    renderInventory();
  });
  document.getElementById('add-inv').addEventListener('click', () => openInventoryEditor());

  el.querySelectorAll('.row-select').forEach(cb => {
    cb.addEventListener('change', e => {
      const id = e.target.dataset.id;
      if (e.target.checked) SELECTED_INV.add(id);
      else                  SELECTED_INV.delete(id);
      renderInventory();
    });
  });

  const selectAll = document.getElementById('select-all-inv');
  if (selectAll) {
    selectAll.addEventListener('change', e => {
      if (e.target.checked) filtered.forEach(i => SELECTED_INV.add(i.id));
      else                  filtered.forEach(i => SELECTED_INV.delete(i.id));
      renderInventory();
    });
  }

  const bulkBtn = document.getElementById('bulk-delete-inv');
  if (bulkBtn) bulkBtn.addEventListener('click', bulkDeleteInventory);

  const bulkPickupBtn = document.getElementById('bulk-pickup-inv');
  if (bulkPickupBtn) bulkPickupBtn.addEventListener('click', bulkMarkPickedUp);

  const searchInput = document.getElementById('inv-search');
  if (searchInput) {
    // Persist focus + caret across re-renders so typing stays smooth.
    if (document.activeElement === searchInput) {
      const pos = searchInput.selectionStart;
      requestAnimationFrame(() => {
        const el2 = document.getElementById('inv-search');
        if (el2) { el2.focus(); el2.setSelectionRange(pos, pos); }
      });
    }
    searchInput.addEventListener('input', e => {
      inventorySearch = e.target.value;
      renderInventory();
    });
  }

  const checkBtn = document.getElementById('check-tracking');
  if (checkBtn) checkBtn.addEventListener('click', triggerCarrierCheck);

  // View toggle (List ↔ By recipient). Persists choice in localStorage.
  el.querySelectorAll('.seg-control button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      inventoryView = btn.dataset.view;
      localStorage.setItem('inv_view', inventoryView);
      renderInventory();
    });
  });

  // Click a group header (anywhere outside a child input) to collapse / expand.
  el.querySelectorAll('tr.group-row').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('[data-stop]')) return;
      const id = tr.dataset.groupId;
      if (COLLAPSED_GROUPS.has(id)) COLLAPSED_GROUPS.delete(id);
      else COLLAPSED_GROUPS.add(id);
      localStorage.setItem('inv_collapsed', JSON.stringify([...COLLAPSED_GROUPS]));
      renderInventory();
    });
  });

  // Per-row "Pick ✓" button on delivered rows.
  el.querySelectorAll('[data-mark-pickup]').forEach(btn => {
    btn.addEventListener('click', () => markPickedUp([btn.dataset.markPickup]));
  });

  el.querySelectorAll('tbody tr:not(.group-row)').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('[data-stop]')) return;
      const item = ITEMS.find(i => i.id === tr.dataset.id);
      if (item) openInventoryEditor(item);
    });
  });
}

async function markPickedUp(ids) {
  if (!ids?.length) return;
  const { error } = await supabase
    .from('inventory').update({ acquisition_status: 'picked_up' }).in('id', ids);
  if (error) { alert(`Couldn't mark picked up: ${error.message}`); return; }
  SELECTED_INV.clear();
  renderInventory();
}

async function bulkMarkPickedUp() {
  const ids = [...SELECTED_INV].filter(id => {
    const it = ITEMS.find(i => i.id === id);
    return it?.acquisition_status === 'delivered';
  });
  if (!ids.length) return;
  await markPickedUp(ids);
}

async function triggerCarrierCheck() {
  const btn = document.getElementById('check-tracking');
  if (!btn) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Polling carriers…';
  try {
    const { data, error } = await supabase.functions.invoke('trigger-check', { method: 'POST' });
    if (error) throw new Error(data?.error || error.message);
    btn.textContent = 'Started ✓';
  } catch (err) {
    btn.textContent = 'Failed';
    alert(`Check tracking failed: ${err.message}`);
  } finally {
    setTimeout(() => {
      const b = document.getElementById('check-tracking');
      if (b) { b.disabled = false; b.textContent = original; }
    }, 3000);
  }
}

async function bulkDeleteInventory() {
  const ids = [...SELECTED_INV];
  if (!ids.length) return;
  const n = ids.length;
  if (!confirm(`Delete ${n} item${n === 1 ? '' : 's'}? This can't be undone.`)) return;
  const { error } = await supabase.from('inventory').delete().in('id', ids);
  if (error) { alert(`Delete failed: ${error.message}`); return; }
  SELECTED_INV.clear();
  // Realtime will re-render too, but kicking it here avoids the brief stale state.
  renderInventory();
}

// ── Addresses ─────────────────────────────────────────────────────────────────
function renderAddresses() {
  const el = document.getElementById('tab-addresses');

  const rows = ADDRESSES.map(a => {
    // Exclude cancelled (refunded) orders from each recipient's count + spend.
    const myItems   = ITEMS.filter(i => i.recipient_address_id === a.id && i.acquisition_status !== 'cancelled');
    const totalCost = myItems.reduce((s, i) => s + (Number(i.cost) || 0), 0);
    const street    = [a.line1, a.line2, a.line3].map(s => String(s || '').trim()).filter(Boolean).join(', ');
    const where     = [a.town_city, a.postcode].map(s => String(s || '').trim()).filter(Boolean).join(' · ');
    // haystack drives the search filter — everything lowercased into one string
    const haystack  = [a.full_name, a.line1, a.line2, a.line3, a.town_city, a.county, a.postcode, a.email]
      .filter(Boolean).join(' ').toLowerCase();
    return `
      <tr data-kind="addr" data-id="${esc(a.id)}" data-haystack="${esc(haystack)}">
        <td>
          <div class="cell-name">
            <span class="avatar-sm">${esc(initials(a.full_name))}</span>
            <span>${esc(a.full_name)}</span>
          </div>
        </td>
        <td>${street ? esc(street) : '<span class="muted">—</span>'}</td>
        <td>${where ? esc(where) : '<span class="muted">—</span>'}</td>
        <td class="num">${myItems.length || '<span class="muted">0</span>'}</td>
        <td class="num">${totalCost ? esc(money(totalCost)) : '<span class="muted">—</span>'}</td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="section-toolbar">
      <input type="search" id="addr-search" class="search-input" placeholder="Search name, town, postcode…" autocomplete="off">
      <span class="muted" id="addr-count">${ADDRESSES.length} address${ADDRESSES.length === 1 ? '' : 'es'}</span>
      <div class="spacer"></div>
      <button class="btn-primary btn-add" id="add-addr">+ Add address</button>
    </div>
    ${ADDRESSES.length
      ? `<table class="row-clickable addr-table">
          <thead><tr><th>Name</th><th>Address</th><th>Town · Postcode</th><th class="num">Items</th><th class="num">Spent</th></tr></thead>
          <tbody id="addr-rows">${rows}</tbody>
        </table>
        <div class="empty hidden" id="addr-empty">No addresses match.</div>`
      : '<div class="empty">No addresses yet.</div>'}
  `;

  document.getElementById('add-addr').addEventListener('click', () => openAddressEditor());
  el.querySelectorAll('tr[data-kind="addr"]').forEach(tr => {
    tr.addEventListener('click', () => {
      const a = ADDRESSES.find(x => x.id === tr.dataset.id);
      if (a) openAddressEditor(a);
    });
  });

  const search = document.getElementById('addr-search');
  if (search) {
    search.value = addrSearchQuery;
    // Filter in place rather than re-rendering — keeps focus + caret position in the input
    const applyFilter = () => {
      addrSearchQuery = search.value;
      const q = addrSearchQuery.trim().toLowerCase();
      let shown = 0;
      el.querySelectorAll('tr[data-kind="addr"]').forEach(tr => {
        const match = !q || tr.dataset.haystack.includes(q);
        tr.classList.toggle('hidden', !match);
        if (match) shown++;
      });
      const countEl = document.getElementById('addr-count');
      const emptyEl = document.getElementById('addr-empty');
      if (countEl) {
        countEl.textContent = q
          ? `${shown} of ${ADDRESSES.length}`
          : `${ADDRESSES.length} address${ADDRESSES.length === 1 ? '' : 'es'}`;
      }
      if (emptyEl) emptyEl.classList.toggle('hidden', shown > 0);
    };
    search.addEventListener('input', applyFilter);
    if (addrSearchQuery) applyFilter();
  }
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
  const queuedIds = ITEMS.filter((_, i) => states[i].cls === 'warn').map(i => i.id);

  const rows = ITEMS.map((item, i) => {
    const st   = states[i];
    const addr = ADDRESS_MAP.get(item.recipient_address_id);
    const queuedRow = st.cls === 'warn';
    return `
      <tr>
        <td><div class="primary">${esc(addr?.full_name || '—')}</div></td>
        <td>${esc(item.item)}</td>
        <td>${statusCell(item.acquisition_status)}</td>
        <td>${item.last_notified ? esc(statusLabel(item.last_notified)) : '<span class="muted">Never</span>'}</td>
        <td><span class="pill ${st.cls}">${esc(st.label)}</span></td>
        <td class="num">
          ${queuedRow ? `<button class="btn-secondary btn-sm" data-send-one="${esc(item.id)}">Post</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Notification history</h2>
          <div class="sub">${sent} sent &middot; ${queued} queued &middot; ${
            WEBHOOKS.filter(w => w.active !== false).length
              ? `posting to ${WEBHOOKS.filter(w => w.active !== false).length} Discord webhook${WEBHOOKS.filter(w => w.active !== false).length === 1 ? '' : 's'}`
              : `<a href="#" data-go-settings>add a webhook in Settings</a> to post`
          }</div>
        </div>
        <button class="btn-primary btn-add" id="send-queued" ${queuedIds.length ? '' : 'disabled'}>
          Post queued${queuedIds.length ? ` (${queuedIds.length})` : ''}
        </button>
      </div>
      <div id="send-status" class="run-status" style="display:none"></div>
      ${ITEMS.length ? `
        <table>
          <thead><tr><th>Recipient</th><th>Item</th><th>Status</th><th>Last notified</th><th>State</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No items to notify on.</div>'}
    </div>
  `;

  const sendBtn = document.getElementById('send-queued');
  if (sendBtn) sendBtn.addEventListener('click', () => sendNotifications(queuedIds));

  el.querySelectorAll('[data-send-one]').forEach(btn => {
    btn.addEventListener('click', () => sendNotifications([btn.dataset.sendOne]));
  });

  el.querySelectorAll('[data-go-settings]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); switchTab('settings'); });
  });
}

async function sendNotifications(inventoryIds) {
  if (!inventoryIds?.length) return;
  const status = document.getElementById('send-status');
  status.style.display = 'block';
  status.className = 'run-status muted';
  status.textContent = `Posting ${inventoryIds.length} update${inventoryIds.length === 1 ? '' : 's'} to Discord…`;
  try {
    const { data, error } = await supabase.functions.invoke('notify-discord', {
      method: 'POST',
      body:   { inventory_ids: inventoryIds },
    });
    if (error) throw new Error(data?.error || error.message);
    const sent   = data?.sent   ?? 0;
    const failed = data?.failed ?? 0;
    status.className = failed ? 'run-status warn' : 'run-status ok';
    status.textContent = failed
      ? `Posted ${sent}, ${failed} failed. ${(data.results || []).filter(r => !r.ok).map(r => r.error).join(' · ')}`
      : `Posted ${sent} update${sent === 1 ? '' : 's'} to Discord.`;
  } catch (err) {
    status.className = 'run-status warn';
    status.textContent = `Post failed: ${err.message}`;
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────
// Most recent run, regardless of status — used to drive the progress bar.
// If it's `running` we show a live bar; if it's `done`/`failed` and finished
// in the last 30 seconds we show the final summary, then it drops off.
function latestRun() {
  return INGEST_RUNS.length ? INGEST_RUNS[0] : null;
}

function ingestProgressHtml() {
  const run = latestRun();
  if (!run) return '';
  const isRunning = run.status === 'running';
  const finishedRecently = !isRunning
    && run.finished_at
    && (Date.now() - new Date(run.finished_at).getTime() < 30_000);
  if (!isRunning && !finishedRecently) return '';

  const total     = Math.max(0, run.total || 0);
  const processed = Math.min(total, Math.max(0, run.processed || 0));
  const pct       = total > 0 ? Math.round((processed / total) * 100) : 0;
  const indeterminate = isRunning && total === 0;

  const headline = isRunning
    ? (indeterminate ? 'Connecting to Gmail…' : `Scraping ${processed} of ${total} (${pct}%)`)
    : run.status === 'done'
      ? `Done — ${run.inserted} new, ${run.skipped} skipped, ${run.failed} failed (${run.processed}/${run.total})`
      : `Failed: ${run.error || 'unknown error'}`;

  const cls = isRunning ? '' : run.status === 'done' ? 'ok' : 'warn';
  return `
    <div class="ingest-progress ${cls}">
      <div class="ingest-progress-line">${esc(headline)}</div>
      <div class="ingest-progress-track ${indeterminate ? 'indeterminate' : ''}">
        <div class="ingest-progress-fill" style="width: ${indeterminate ? 100 : pct}%"></div>
      </div>
    </div>
  `;
}

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
          <h2>Email scraper</h2>
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
      ${ingestProgressHtml()}
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
    status.style.display = 'none';
    btn.disabled = false;
    btn.textContent = 'Run now';
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

  const webhookRows = WEBHOOKS.map(w => `
    <tr data-kind="webhook" data-id="${esc(w.id)}">
      <td><div class="primary">${esc(w.label || 'Discord webhook')}</div></td>
      <td><span class="muted">https://discord.com/api/webhooks/••••</span></td>
      <td>${w.active === false ? '<span class="pill muted">Inactive</span>' : '<span class="pill ok">Active</span>'}</td>
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

    <div class="section">
      <div class="section-head">
        <div>
          <h2>Discord webhooks</h2>
          <div class="sub">Where the Notifications tab posts status updates. URL is stored encrypted-at-rest and never sent back to the browser.</div>
        </div>
        <button class="btn-primary btn-add" id="add-webhook">+ Add webhook</button>
      </div>
      ${WEBHOOKS.length ? `
        <table class="row-clickable">
          <thead><tr><th>Webhook</th><th>URL</th><th>Status</th></tr></thead>
          <tbody>${webhookRows}</tbody>
        </table>
      ` : '<div class="empty">No webhooks yet. Add one to enable Discord notifications.</div>'}
    </div>
  `;

  document.getElementById('add-acct').addEventListener('click', () => openEmailAccountEditor());
  document.getElementById('add-site').addEventListener('click', () => openSiteEditor());
  document.getElementById('add-webhook').addEventListener('click', () => openWebhookEditor());

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
  el.querySelectorAll('tr[data-kind="webhook"]').forEach(tr => {
    tr.addEventListener('click', () => {
      const w = WEBHOOKS.find(x => x.id === tr.dataset.id);
      if (w) openWebhookEditor(w);
    });
  });
}

function webhookFormHtml(w = {}) {
  const editing = !!w.id;
  return `
    <div class="form-grid">
      ${field('Label', 'label', 'text', { value: w.label, required: true, wide: true })}
      ${field(editing ? 'New webhook URL (leave blank to keep current)' : 'Webhook URL',
              'url', 'url', { value: '', required: !editing, wide: true })}
      ${field('Active', 'active', 'select', {
        value: w.active === false ? 'false' : 'true',
        options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
        wide: true,
      })}
    </div>
    <p style="color: var(--text-muted); font-size: 12.5px; margin-top: 8px;">
      In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy URL.
      Should start with <code>https://discord.com/api/webhooks/</code>.
    </p>
  `;
}

function openWebhookEditor(existing) {
  const editing = !!existing;
  showModal({
    title: editing ? 'Edit webhook' : 'Add Discord webhook',
    body:  webhookFormHtml(existing || {}),
    submitText: editing ? 'Save changes' : 'Add webhook',
    onSubmit: async (form) => {
      const data = readForm(form);
      data.active = data.active !== 'false';
      if (data.url) data.url = data.url.trim();
      if (editing) {
        // Same pattern as email_accounts: blank URL means "don't overwrite".
        if (!data.url) delete data.url;
        const { error } = await supabase.from('webhooks').update(data).eq('id', existing.id);
        if (error) throw error;
      } else {
        if (!data.url || !/^https:\/\/discord\.com\/api\/webhooks\//.test(data.url)) {
          throw new Error('URL must start with https://discord.com/api/webhooks/');
        }
        data.id = newId('hook');
        const { error } = await supabase.from('webhooks').insert(data);
        if (error) throw error;
      }
    },
    onDelete: editing
      ? async () => {
          const { error } = await supabase.from('webhooks').delete().eq('id', existing.id);
          if (error) throw error;
        }
      : null,
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
    // Read field values *before* setBusy disables them. `new FormData(form)`
    // follows the HTML spec and skips disabled controls, so reading after
    // setBusy would silently drop every field. We stash the snapshot on
    // the form so readForm() picks it up.
    const snapshot = {};
    for (const [k, v] of new FormData(form)) {
      snapshot[k] = typeof v === 'string' ? v.trim() : v;
    }
    form.__snapshot = snapshot;
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
      ${field('Item Status', 'acquisition_status', 'select', { value: it.acquisition_status || 'confirmed', options: statusOpts })}
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
  // showModal stashes a pre-disable snapshot on __snapshot. Use it if
  // present — by the time onSubmit runs, the inputs are disabled and
  // `new FormData(form)` would skip every field.
  if (form.__snapshot) return { ...form.__snapshot };
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'webhooks' },          scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ingest_runs' },       scheduleRefresh)
    .subscribe();
}

// ── Init ──────────────────────────────────────────────────────────────────────
setupNav();
document.getElementById('refresh').addEventListener('click', refresh);
subscribeRealtime();
refresh();
