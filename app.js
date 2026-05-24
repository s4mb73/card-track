/**
 * app.js
 * CardTrack dashboard — a static single-page UI that reads cardtrack/orders.json
 * and renders Inventory, Addresses, Notifications, Scheduler and Email views.
 * No build step, no framework: served straight from the repo root by Vercel.
 */

const ORDERS_URL = 'cardtrack/orders.json';

const STATUS_LABELS = {
  pending:          'Pending',
  in_transit:       'In transit',
  out_for_delivery: 'Out for delivery',
  delivered:        'Delivered',
  failed:           'Delivery failed',
  unknown:          'Unknown',
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
  inventory:     { title: 'Inventory',     sub: 'Every card order and its current tracking status.' },
  addresses:     { title: 'Addresses',     sub: 'Recipients these cards are being sent to.' },
  notifications: { title: 'Notifications', sub: 'Who has been notified, and what is queued for the next check.' },
  scheduler:     { title: 'Scheduler',     sub: 'How often the checker polls each carrier.' },
  email:         { title: 'Email',         sub: 'Ingest order confirmations from your inbox.' },
};

let ORDERS = [];
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
  return '£' + Number(amount || 0).toLocaleString('en-GB');
}

function statusLabel(s)  { return STATUS_LABELS[s] || s || 'Unknown'; }
function carrierLabel(c) { return CARRIER_LABELS[c] || c || '—'; }

function addressLines(addr) {
  if (!addr) return [];
  return [addr.line1, addr.line2, addr.city, addr.postcode]
    .map(s => String(s || '').trim())
    .filter(Boolean);
}

function shortAddress(addr) {
  return [addr?.city, addr?.postcode]
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

// ── Data ──────────────────────────────────────────────────────────────────────
async function loadOrders() {
  const res = await fetch(ORDERS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${ORDERS_URL}`);
  const data = await res.json();
  ORDERS = Array.isArray(data.orders) ? data.orders : [];
}

// ── KPI tiles ─────────────────────────────────────────────────────────────────
function renderSummary() {
  const total     = ORDERS.length;
  const value     = ORDERS.reduce((s, o) => s + (Number(o.price) || 0), 0);
  const active    = ORDERS.filter(o => ACTIVE_STATUSES.includes(o.status)).length;
  const delivered = ORDERS.filter(o => o.status === 'delivered').length;

  const tiles = [
    { label: 'Total orders',  value: total,        tint: 'purple' },
    { label: 'Total value',   value: money(value), tint: 'green'  },
    { label: 'In transit',    value: active,       tint: 'blue'   },
    { label: 'Delivered',     value: delivered,    tint: 'amber'  },
  ];

  document.getElementById('summary').innerHTML = tiles.map(t => `
    <div class="kpi" data-tint="${esc(t.tint)}">
      <div class="label"><span class="dot"></span>${esc(t.label)}</div>
      <div class="value">${esc(t.value)}</div>
    </div>
  `).join('');
}

// ── Inventory (table) ─────────────────────────────────────────────────────────
function renderInventory() {
  const el = document.getElementById('tab-inventory');
  const filtered = inventoryFilter === 'all'
    ? ORDERS
    : ORDERS.filter(o => o.status === inventoryFilter);

  const options = ['all', ...Object.keys(STATUS_LABELS)].map(s => `
    <option value="${esc(s)}" ${s === inventoryFilter ? 'selected' : ''}>
      ${s === 'all' ? 'All statuses' : esc(statusLabel(s))}
    </option>
  `).join('');

  const rows = filtered.map(o => {
    const url = safeUrl(o.tracking?.url);
    const ref = o.tracking?.ref || '';
    const trackHtml = ref
      ? (url
          ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="mono">${esc(ref)}</a>`
          : `<span class="mono">${esc(ref)}</span>`)
      : '<span class="muted">—</span>';
    const dest = shortAddress(o.recipient?.address);
    return `
      <tr>
        <td><div class="primary">${esc(o.item)}</div></td>
        <td>
          ${esc(o.recipient?.name)}
          ${dest ? `<span class="muted">${esc(dest)}</span>` : ''}
        </td>
        <td>${esc(carrierLabel(o.tracking?.carrier))}</td>
        <td>${statusCell(o.status)}</td>
        <td>${trackHtml}</td>
        <td class="num">${esc(money(o.price))}</td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div>
          <h2>Orders</h2>
          <div class="sub">${filtered.length} of ${ORDERS.length} order${ORDERS.length === 1 ? '' : 's'}</div>
        </div>
        <div class="toolbar">
          <select id="status-filter">${options}</select>
        </div>
      </div>
      ${filtered.length ? `
        <table>
          <thead>
            <tr><th>Item</th><th>Sending to</th><th>Carrier</th>
                <th>Status</th><th>Tracking</th><th>Value</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No orders match this filter.</div>'}
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
  const people = new Map();

  for (const o of ORDERS) {
    const r = o.recipient || {};
    const key = `${r.name || '?'}|${r.phone || ''}`;
    if (!people.has(key)) {
      people.set(key, {
        name: r.name || 'Unknown',
        phone: r.phone || '',
        whatsapp: r.whatsapp || '',
        address: r.address || null,
        orders: [],
        value: 0,
      });
    }
    const p = people.get(key);
    p.orders.push(o.item);
    p.value += Number(o.price) || 0;
  }

  const cards = [...people.values()].map(p => {
    const lines = addressLines(p.address);
    const addrHtml = lines.length
      ? lines.map(esc).join('<br>')
      : '<span class="muted">No address on file</span>';
    return `
      <div class="person">
        <div class="head">
          <div class="avatar">${esc(initials(p.name))}</div>
          <div class="name">${esc(p.name)}</div>
        </div>
        <div class="addr">${addrHtml}</div>
        <div class="contact">
          <div><b>Phone</b>${esc(p.phone || '—')}</div>
          <div><b>WhatsApp</b>${esc(p.whatsapp || '—')}</div>
        </div>
        <div class="meta">
          <span>${p.orders.length} order${p.orders.length === 1 ? '' : 's'}</span>
          <b>${esc(money(p.value))}</b>
        </div>
        <div class="items">${p.orders.map(esc).join(', ')}</div>
      </div>
    `;
  }).join('');

  el.innerHTML = people.size
    ? `<div class="person-grid">${cards}</div>`
    : '<div class="empty">No recipients yet.</div>';
}

// ── Notifications ─────────────────────────────────────────────────────────────
function notifyState(o) {
  if (!NOTIFY_TRIGGERS.includes(o.status)) return { label: 'No alert', cls: 'muted' };
  if (o.lastNotified === o.status)         return { label: 'Sent',     cls: 'ok' };
  return { label: 'Queued', cls: 'warn' };
}

function renderNotifications() {
  const el = document.getElementById('tab-notifications');
  const states = ORDERS.map(notifyState);
  const sent   = states.filter(s => s.cls === 'ok').length;
  const queued = states.filter(s => s.cls === 'warn').length;

  const rows = ORDERS.map((o, i) => {
    const st = states[i];
    return `
      <tr>
        <td><div class="primary">${esc(o.recipient?.name)}</div></td>
        <td>${esc(o.item)}</td>
        <td>${statusCell(o.status)}</td>
        <td>${o.lastNotified ? esc(statusLabel(o.lastNotified)) : '<span class="muted">Never</span>'}</td>
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
      ${ORDERS.length ? `
        <table>
          <thead><tr><th>Recipient</th><th>Item</th><th>Status</th>
              <th>Last notified</th><th>State</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No orders to notify on.</div>'}
    </div>
  `;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function renderScheduler() {
  const el = document.getElementById('tab-scheduler');
  const active = ORDERS.filter(o => ACTIVE_STATUSES.includes(o.status));

  const rows = ORDERS.map(o => {
    let note = '';
    if (!o.tracking?.ref) note = '<span class="pill warn">awaiting tracking ref</span>';
    else if (!o.lastChecked) note = '<span class="pill muted">never checked</span>';
    return `
      <tr>
        <td><div class="primary">${esc(o.item)}</div></td>
        <td>${statusCell(o.status)}</td>
        <td class="num">${esc(relTime(o.lastChecked))}</td>
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
      <div class="info-row"><span class="k">Active orders next run</span><span class="num">${active.length}</span></div>
      <div class="info-row"><span class="k">Estimated next run</span><span class="num">${esc(nextHourlyRun())}</span></div>
    </div>
    <div class="section">
      <div class="section-head">
        <div><h2>Last checked</h2><div class="sub">When each order was last polled.</div></div>
      </div>
      ${ORDERS.length ? `
        <table>
          <thead><tr><th>Item</th><th>Status</th><th>Last checked</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No orders scheduled.</div>'}
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
          orders in <code>cardtrack/orders.json</code> automatically.
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
    document.getElementById('page-sub').textContent = meta.sub || '';
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
    await loadOrders();
    errEl.classList.add('hidden');
    renderAll();
    document.getElementById('loaded-at').textContent =
      `Updated ${new Date().toLocaleTimeString('en-GB')}`;
  } catch (err) {
    errEl.textContent = `Could not load orders: ${err.message}`;
    errEl.classList.remove('hidden');
  }
}

setupNav();
document.getElementById('refresh').addEventListener('click', refresh);
refresh();
