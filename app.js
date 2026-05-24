/**
 * app.js
 * CardTrack dashboard — a static single-page UI that reads cardtrack/orders.json
 * and renders Inventory, Addresses, Notifications, Scheduler and Email tabs.
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

function statusLabel(s) { return STATUS_LABELS[s] || s || 'Unknown'; }
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

const GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
  'linear-gradient(135deg, #ff9966 0%, #ff5e62 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function gradientFor(seed) {
  return GRADIENTS[hashStr(String(seed || '')) % GRADIENTS.length];
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function badge(status) {
  const key = STATUS_LABELS[status] ? status : 'unknown';
  return `<span class="badge badge-${key}">${esc(statusLabel(status))}</span>`;
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

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadOrders() {
  const res = await fetch(ORDERS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${ORDERS_URL}`);
  const data = await res.json();
  ORDERS = Array.isArray(data.orders) ? data.orders : [];
}

// ── Summary ───────────────────────────────────────────────────────────────────
function renderSummary() {
  const total     = ORDERS.length;
  const value     = ORDERS.reduce((sum, o) => sum + (Number(o.price) || 0), 0);
  const active    = ORDERS.filter(o => ACTIVE_STATUSES.includes(o.status)).length;
  const delivered = ORDERS.filter(o => o.status === 'delivered').length;

  const stats = [
    { label: 'Total orders', value: total },
    { label: 'Total value',  value: money(value) },
    { label: 'Active',       value: active },
    { label: 'Delivered',    value: delivered },
  ];

  document.getElementById('summary').innerHTML = stats.map(s => `
    <div class="stat">
      <div class="label">${esc(s.label)}</div>
      <div class="value">${esc(s.value)}</div>
    </div>
  `).join('');
}

// ── Inventory ─────────────────────────────────────────────────────────────────
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

  const cards = filtered.map(o => {
    const url = safeUrl(o.tracking?.url);
    const ref = o.tracking?.ref || '';
    const trackHtml = ref
      ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(ref)}</a>` : esc(ref))
      : '<span class="muted">Waiting for tracking ref</span>';
    const dest = shortAddress(o.recipient?.address);
    return `
      <div class="item-card">
        <div class="strip" style="background: ${gradientFor(o.item)}"></div>
        <div class="body">
          <div class="title">${esc(o.item)}</div>
          <div class="meta">${esc(carrierLabel(o.tracking?.carrier))} &middot; ${trackHtml}</div>
          <div class="dest">
            <div class="who">${esc(o.recipient?.name)}</div>
            ${dest ? `<div class="where">${esc(dest)}</div>` : ''}
          </div>
          <div class="foot">
            ${badge(o.status)}
            <div class="price">${esc(money(o.price))}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Inventory</h2>
        <div class="sub">Every card order and its current tracking status.</div>
      </div>
      <div class="toolbar">
        <span class="label">Filter</span>
        <select id="status-filter">${options}</select>
      </div>
    </div>
    ${filtered.length
      ? `<div class="inventory-grid">${cards}</div>`
      : '<div class="empty">No orders match this filter.</div>'}
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
          <div class="avatar" style="background: ${gradientFor(p.name)}">${esc(initials(p.name))}</div>
          <div class="name">${esc(p.name)}</div>
        </div>
        <div class="addr">${addrHtml}</div>
        <div class="contact">
          <div><b>Phone</b> &nbsp; ${esc(p.phone || '—')}</div>
          <div><b>WhatsApp</b> &nbsp; ${esc(p.whatsapp || '—')}</div>
        </div>
        <div class="meta">
          <span>${p.orders.length} order(s)</span>
          <span><b>${esc(money(p.value))}</b></span>
        </div>
        <div class="items">${p.orders.map(esc).join(', ')}</div>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Addresses</h2>
        <div class="sub">Recipients these cards are being sent to.</div>
      </div>
    </div>
    ${people.size ? `<div class="person-grid">${cards}</div>`
                  : '<div class="empty">No recipients yet.</div>'}
  `;
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
        <td>${esc(o.recipient?.name)}</td>
        <td>${esc(o.item)}</td>
        <td>${badge(o.status)}</td>
        <td>${o.lastNotified ? esc(statusLabel(o.lastNotified)) : '<span class="muted">never</span>'}</td>
        <td><span class="pill ${st.cls}">${esc(st.label)}</span></td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="card">
      <h2>Notifications</h2>
      <div class="sub">
        ${sent} sent &middot; ${queued} queued for the next check.
        Reflects current state — full send history lives in <code>logs/checker.log</code>.
      </div>
      ${ORDERS.length ? `
        <table>
          <thead>
            <tr><th>Recipient</th><th>Item</th><th>Status</th>
                <th>Last notified</th><th>State</th></tr>
          </thead>
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
        <td>${esc(o.item)}</td>
        <td>${badge(o.status)}</td>
        <td>${esc(relTime(o.lastChecked))}</td>
        <td>${note}</td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="card">
      <h2>Scheduler</h2>
      <div class="sub">The checker runs automatically on a fixed schedule.</div>
      <div class="info-row"><span class="k">Schedule</span>
        <span>Hourly &middot; <code>cron 0 * * * *</code></span></div>
      <div class="info-row"><span class="k">Runner</span>
        <span>GitHub Actions (<code>.github/workflows/checker.yml</code>)</span></div>
      <div class="info-row"><span class="k">Active orders next run</span>
        <span>${active.length}</span></div>
      <div class="info-row"><span class="k">Estimated next run</span>
        <span>${esc(nextHourlyRun())}</span></div>
    </div>
    <div class="card">
      <h2>Last checked</h2>
      <div class="sub">When each order was last polled.</div>
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
  const el = document.getElementById('tab-email');
  el.innerHTML = `
    <div class="card">
      <h2>Email ingestion</h2>
      <div class="sub">Automatically turn order confirmation emails into tracked orders.</div>
      <div class="info-row"><span class="k">Status</span>
        <span class="pill muted">Not connected</span></div>
      <p class="muted" style="margin-top:14px">
        Orders are currently added manually to <code>cardtrack/orders.json</code>.
        Email ingestion (a Gmail scraper) is not yet set up. Once connected, order
        confirmations and shipping notices from these senders would be parsed into
        new orders automatically:
      </p>
      <ul class="sources">
        ${EMAIL_SOURCES.map(s => `<li><code>${esc(s)}</code></li>`).join('')}
      </ul>
    </div>
  `;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.getElementById('tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
}

// ── Render everything ─────────────────────────────────────────────────────────
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
      `Loaded ${new Date().toLocaleTimeString('en-GB')}`;
  } catch (err) {
    errEl.textContent = `Could not load orders: ${err.message}`;
    errEl.classList.remove('hidden');
  }
}

setupTabs();
document.getElementById('refresh').addEventListener('click', refresh);
refresh();
