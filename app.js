/**
 * app.js
 * CardTrack dashboard — a static SPA that reads cardtrack/inventory.json
 * and cardtrack/addresses.json and renders the Inventory, Addresses,
 * Notifications, Scheduler and Email views.
 * No build step, no framework: served straight from the repo root by Vercel.
 */

const INVENTORY_URL = 'cardtrack/inventory.json';
const ADDRESSES_URL = 'cardtrack/addresses.json';

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

const NOTIFY_TRIGGERS = ['in_transit', 'out_for_delivery', 'delivered', 'failed'];
const ACTIVE_STATUSES = ['pending', 'in_transit', 'out_for_delivery'];
const EMAIL_SOURCES   = [
  'orders@topps.com',
  'noreply@pokemoncenter.com',
  'orders@aycd.io',
  'ebay@ebay.co.uk',
];

const NAV_ICONS = {
  inventory:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5l6-3 6 3v7l-6 3-6-3v-7z"/><path d="M2 4.5l6 3 6-3"/><path d="M8 7.5v7"/></svg>',
  addresses:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="2.75"/><path d="M2.5 14c0-2.7 2.5-5 5.5-5s5.5 2.3 5.5 5"/></svg>',
  notifications: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5a5 5 0 1 1 10 0v3l1 2H2l1-2v-3z"/><path d="M6.5 13a1.5 1.5 0 0 0 3 0"/></svg>',
  scheduler:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/></svg>',
  email:         '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 5l5.5 4 5.5-4"/></svg>',
};

const TAB_META = {
  inventory:     { title: 'Inventory',     sub: 'Cards in your collection — what you paid, where they live, and what they sold for.' },
  addresses:     { title: 'Addresses',     sub: 'Friends and customers — where cards are sent and who you ship to.' },
  notifications: { title: 'Notifications', sub: 'Who has been notified, and what is queued for the next check.' },
  scheduler:     { title: 'Scheduler',     sub: 'How often the checker polls each carrier.' },
  email:         { title: 'Email',         sub: 'Ingest order confirmations from your inbox.' },
};

let ITEMS = [];
let ADDRESSES = [];
let ADDRESS_MAP = new Map();
let inventoryFilter = 'all';

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

function money(amount) {
  const n = Number(amount || 0);
  const sign = n < 0 ? '-' : '';
  return sign + '£' + Math.abs(n).toLocaleString('en-GB');
}

function statusLabel(s)  { return STATUS_LABELS[s] || s || 'Unknown'; }
function carrierLabel(c) { return CARRIER_LABELS[c] || c || '—'; }

function addressLines(addr) {
  if (!addr) return [];
  return [addr.line1, addr.line2, addr.line3, addr.townCity, addr.county, addr.postcode]
    .map(s => String(s || '').trim())
    .filter(Boolean);
}

function shortAddress(addr) {
  return [addr?.townCity, addr?.postcode]
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .join(', ');
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function nextHourlyRun() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.toLocaleString('en-GB');
}

function statusCell(s) {
  return `<span class="status status-${esc(s)}"><span class="sd"></span>${esc(statusLabel(s))}</span>`;
}

function effectiveStatus(item) {
  return item.saleStatus === 'sold' ? 'sold' : item.acquisitionStatus;
}

function profitOf(item) {
  if (item.saleStatus !== 'sold') return null;
  const sale     = Number(item.salePrice)       || 0;
  const cost     = Number(item.cost)            || 0;
  const fees     = Number(item.fees)            || 0;
  const shipIn   = Number(item.shippingInCost)  || 0;
  const shipOut  = Number(item.shippingOutCost) || 0;
  return sale - cost - fees - shipIn - shipOut;
}

// ── Data ──────────────────────────────────────────────────────────────────────
async function loadData() {
  const [invRes, addrRes] = await Promise.all([
    fetch(INVENTORY_URL, { cache: 'no-store' }),
    fetch(ADDRESSES_URL, { cache: 'no-store' }),
  ]);
  if (!invRes.ok)  throw new Error(`HTTP ${invRes.status} fetching ${INVENTORY_URL}`);
  if (!addrRes.ok) throw new Error(`HTTP ${addrRes.status} fetching ${ADDRESSES_URL}`);
  const inv  = await invRes.json();
  const addr = await addrRes.json();
  ITEMS       = Array.isArray(inv.items) ? inv.items : [];
  ADDRESSES   = Array.isArray(addr.addresses) ? addr.addresses : [];
  ADDRESS_MAP = new Map(ADDRESSES.map(a => [a.id, a]));
}

// ── KPI tiles ─────────────────────────────────────────────────────────────────
function renderSummary() {
  const total  = ITEMS.length;
  const spent  = ITEMS.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const active = ITEMS.filter(i => ACTIVE_STATUSES.includes(i.acquisitionStatus)).length;
  const sold   = ITEMS.filter(i => i.saleStatus === 'sold');
  const profit = sold.reduce((s, i) => s + (profitOf(i) || 0), 0);

  const tiles = [
    { label: 'Items',      value: total,        tint: 'purple' },
    { label: 'Spent',      value: money(spent), tint: 'green'  },
    { label: 'In transit', value: active,       tint: 'blue'   },
    { label: 'Profit',     value: money(profit), tint: 'amber' },
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

  let filtered;
  if (inventoryFilter === 'all') {
    filtered = ITEMS;
  } else if (inventoryFilter === 'sold') {
    filtered = ITEMS.filter(i => i.saleStatus === 'sold');
  } else {
    filtered = ITEMS.filter(i => i.acquisitionStatus === inventoryFilter
                              && i.saleStatus !== 'sold');
  }

  const FILTER_KEYS = ['all', 'pending', 'in_transit', 'out_for_delivery',
                       'delivered', 'failed', 'sold'];
  const options = FILTER_KEYS.map(k => `
    <option value="${esc(k)}" ${k === inventoryFilter ? 'selected' : ''}>
      ${k === 'all' ? 'All statuses' : esc(statusLabel(k))}
    </option>
  `).join('');

  const rows = filtered.map(item => {
    const url  = safeUrl(item.trackingUrl);
    const ref  = item.trackingRef || '';
    const trackHtml = ref
      ? (url
          ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="mono">${esc(ref)}</a>`
          : `<span class="mono">${esc(ref)}</span>`)
      : '<span class="muted">—</span>';

    const addr = ADDRESS_MAP.get(item.recipientAddressId);
    const destName = addr?.fullName || '—';
    const destLoc  = shortAddress(addr);
    const status   = effectiveStatus(item);
    const profit   = profitOf(item);

    const subLine = [item.category, item.setEdition].filter(Boolean).map(esc).join(' · ');

    return `
      <tr>
        <td>
          <div class="primary">${esc(item.item)}</div>
          ${subLine ? `<span class="muted">${subLine}</span>` : ''}
        </td>
        <td>
          ${esc(destName)}
          ${destLoc ? `<span class="muted">${esc(destLoc)}</span>` : ''}
        </td>
        <td>${esc(carrierLabel(item.carrier))}</td>
        <td>${statusCell(status)}</td>
        <td>${trackHtml}</td>
        <td class="num">${esc(money(item.cost))}</td>
        <td class="num">${profit !== null
          ? `<span class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}">${esc(money(profit))}</span>`
          : '<span class="muted">—</span>'}</td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Items</h2>
          <div class="sub">${filtered.length} of ${ITEMS.length} item${ITEMS.length === 1 ? '' : 's'}</div>
        </div>
        <div class="toolbar">
          <select id="status-filter">${options}</select>
        </div>
      </div>
      ${filtered.length ? `
        <table>
          <thead>
            <tr><th>Item</th><th>Sending to</th><th>Carrier</th>
                <th>Status</th><th>Tracking</th><th>Cost</th><th>Profit</th></tr>
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
}

// ── Addresses ─────────────────────────────────────────────────────────────────
function renderAddresses() {
  const el = document.getElementById('tab-addresses');

  const cards = ADDRESSES.map(a => {
    const myItems   = ITEMS.filter(i => i.recipientAddressId === a.id);
    const totalCost = myItems.reduce((s, i) => s + (Number(i.cost) || 0), 0);
    const lines     = addressLines(a);
    const addrHtml  = lines.length
      ? lines.map(esc).join('<br>')
      : '<span class="muted">No address on file</span>';
    const channel   = (a.preferredChannel || 'sms').toLowerCase();

    return `
      <div class="person">
        <div class="head">
          <div class="avatar">${esc(initials(a.fullName))}</div>
          <div class="head-meta">
            <div class="name">${esc(a.fullName)}</div>
            ${a.type ? `<span class="type-tag">${esc(a.type)}</span>` : ''}
          </div>
        </div>
        <div class="addr">${addrHtml}</div>
        <div class="contact">
          ${a.email     ? `<div><b>Email</b>${esc(a.email)}</div>` : ''}
          <div><b>Phone</b>${esc(a.phone || '—')}</div>
          <div><b>WhatsApp</b>${esc(a.whatsapp || '—')}</div>
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

  el.innerHTML = ADDRESSES.length
    ? `<div class="person-grid">${cards}</div>`
    : '<div class="empty">No addresses yet.</div>';
}

// ── Notifications ─────────────────────────────────────────────────────────────
function notifyState(item) {
  if (!NOTIFY_TRIGGERS.includes(item.acquisitionStatus)) return { label: 'No alert', cls: 'muted' };
  if (item.lastNotified === item.acquisitionStatus)      return { label: 'Sent',     cls: 'ok' };
  return { label: 'Queued', cls: 'warn' };
}

function renderNotifications() {
  const el = document.getElementById('tab-notifications');
  const states = ITEMS.map(notifyState);
  const sent   = states.filter(s => s.cls === 'ok').length;
  const queued = states.filter(s => s.cls === 'warn').length;

  const rows = ITEMS.map((item, i) => {
    const st   = states[i];
    const addr = ADDRESS_MAP.get(item.recipientAddressId);
    return `
      <tr>
        <td><div class="primary">${esc(addr?.fullName || '—')}</div></td>
        <td>${esc(item.item)}</td>
        <td>${statusCell(item.acquisitionStatus)}</td>
        <td>${item.lastNotified ? esc(statusLabel(item.lastNotified)) : '<span class="muted">Never</span>'}</td>
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
          <thead><tr><th>Recipient</th><th>Item</th><th>Status</th>
              <th>Last notified</th><th>State</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No items to notify on.</div>'}
    </div>
  `;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function renderScheduler() {
  const el = document.getElementById('tab-scheduler');
  const active = ITEMS.filter(i => ACTIVE_STATUSES.includes(i.acquisitionStatus));

  const rows = ITEMS.map(item => {
    let note = '';
    if (!item.trackingRef)      note = '<span class="pill warn">awaiting tracking ref</span>';
    else if (!item.lastChecked) note = '<span class="pill muted">never checked</span>';
    return `
      <tr>
        <td><div class="primary">${esc(item.item)}</div></td>
        <td>${statusCell(item.acquisitionStatus)}</td>
        <td class="num">${esc(relTime(item.lastChecked))}</td>
        <td>${note}</td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div><h2>Schedule</h2><div class="sub">How often the checker polls each carrier.</div></div>
      </div>
      <div class="info-row"><span class="k">Frequency</span><span>Hourly &middot; <code>0 * * * *</code></span></div>
      <div class="info-row"><span class="k">Runner</span><span>GitHub Actions &middot; <code>.github/workflows/checker.yml</code></span></div>
      <div class="info-row"><span class="k">Active items next run</span><span class="num">${active.length}</span></div>
      <div class="info-row"><span class="k">Estimated next run</span><span class="num">${esc(nextHourlyRun())}</span></div>
    </div>
    <div class="section">
      <div class="section-head">
        <div><h2>Last checked</h2><div class="sub">When each item was last polled.</div></div>
      </div>
      ${ITEMS.length ? `
        <table>
          <thead><tr><th>Item</th><th>Status</th><th>Last checked</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No items scheduled.</div>'}
    </div>
  `;
}

// ── Email ─────────────────────────────────────────────────────────────────────
function renderEmail() {
  document.getElementById('tab-email').innerHTML = `
    <div class="section">
      <div class="section-head">
        <div><h2>Email ingestion</h2><div class="sub">Auto-import orders from your inbox.</div></div>
      </div>
      <div class="info-row"><span class="k">Status</span><span class="pill muted">Not connected</span></div>
      <div class="section-body">
        <p style="color: var(--text-muted); margin-bottom: 12px; font-size: 13.5px;">
          Once connected, order confirmations from these senders would create new
          items in <code>cardtrack/inventory.json</code> automatically.
        </p>
        <ul class="sources">
          ${EMAIL_SOURCES.map(s => `<li>${esc(s)}</li>`).join('')}
        </ul>
      </div>
    </div>
  `;
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
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
    const meta = TAB_META[tab] || {};
    document.getElementById('page-title').textContent = meta.title || '';
    document.getElementById('page-sub').textContent   = meta.sub   || '';
  });
}

// ── Render all ────────────────────────────────────────────────────────────────
function renderAll() {
  renderSummary();
  renderInventory();
  renderAddresses();
  renderNotifications();
  renderScheduler();
  renderEmail();
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

setupNav();
document.getElementById('refresh').addEventListener('click', refresh);
refresh();
