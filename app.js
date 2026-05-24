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

const RARITY = {
  common:   { name: 'Common',      grad: 'linear-gradient(135deg, #64748b 0%, #334155 100%)' },
  uncommon: { name: 'Uncommon',    grad: 'linear-gradient(135deg, #10b981 0%, #047857 100%)' },
  rare:     { name: 'Rare',        grad: 'linear-gradient(135deg, #3b82f6 0%, #1e40af 100%)' },
  holo:     { name: 'Holo Rare',   grad: 'linear-gradient(135deg, #a78bfa 0%, #6d28d9 100%)' },
  secret:   { name: 'Secret Rare', grad: 'linear-gradient(135deg, #fbbf24 0%, #f97316 100%)' },
};

function rarityFor(price) {
  const p = Number(price) || 0;
  if (p < 20)  return { key: 'common',   ...RARITY.common };
  if (p < 50)  return { key: 'uncommon', ...RARITY.uncommon };
  if (p < 100) return { key: 'rare',     ...RARITY.rare };
  if (p < 300) return { key: 'holo',     ...RARITY.holo };
  return         { key: 'secret',   ...RARITY.secret };
}

const TIMELINE_STEPS = ['Ordered', 'In transit', 'Out', 'Delivered'];
const STATUS_STEP = {
  pending:          1,
  in_transit:       2,
  out_for_delivery: 3,
  delivered:        4,
  failed:           2,
  unknown:          0,
};

function timeline(status) {
  const cur = STATUS_STEP[status] ?? 0;
  const failed = status === 'failed';
  const dotCls = (i) => {
    if (failed && i === cur) return 'fail';
    return i <= cur ? 'on' : '';
  };
  const lineCls = (i) => (!failed && i < cur) ? 'on' : '';
  return `
    <div class="timeline">
      <div class="dots">
        <span class="dot ${dotCls(1)}"></span><span class="line ${lineCls(1)}"></span>
        <span class="dot ${dotCls(2)}"></span><span class="line ${lineCls(2)}"></span>
        <span class="dot ${dotCls(3)}"></span><span class="line ${lineCls(3)}"></span>
        <span class="dot ${dotCls(4)}"></span>
      </div>
      <div class="labels">
        ${TIMELINE_STEPS.map((s, i) => {
          const here = (i + 1) === cur;
          return `<span class="${here ? 'now' : ''}">${esc(s)}</span>`;
        }).join('')}
      </div>
    </div>
  `;
}

const ICONS = {
  package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  money:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  truck:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
};

function attachTilt(card) {
  let raf = null;
  card.addEventListener('mousemove', (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      card.style.setProperty('--mx', `${x * 100}%`);
      card.style.setProperty('--my', `${y * 100}%`);
      card.style.setProperty('--rx', `${(0.5 - y) * 6}deg`);
      card.style.setProperty('--ry', `${(x - 0.5) * 8}deg`);
    });
  });
  card.addEventListener('mouseleave', () => {
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
    card.style.setProperty('--mx', '50%');
    card.style.setProperty('--my', '50%');
  });
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
  const pct       = total ? Math.round((delivered / total) * 100) : 0;
  const avg       = total ? Math.round(value / total) : 0;

  const stats = [
    { label: 'Total orders', value: total,         tint: 'violet',  icon: ICONS.package, sub: `${total} card${total === 1 ? '' : 's'} tracked` },
    { label: 'Total value',  value: money(value),  tint: 'green',   icon: ICONS.money,   sub: `avg ${money(avg)} per card` },
    { label: 'In flight',    value: active,        tint: 'blue',    icon: ICONS.truck,   sub: `${active} on the move` },
    { label: 'Delivered',    value: delivered,     tint: 'emerald', icon: ICONS.check,   sub: `${pct}% complete` },
  ];

  document.getElementById('summary').innerHTML = stats.map(s => `
    <div class="stat" data-tint="${esc(s.tint)}">
      <div class="stat-top">
        <span class="label">${esc(s.label)}</span>
        <span class="stat-icon">${s.icon}</span>
      </div>
      <div class="value">${esc(s.value)}</div>
      <div class="sub-stat">${esc(s.sub)}</div>
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
    const r = rarityFor(o.price);
    return `
      <div class="item-card" data-rarity="${esc(r.key)}">
        <div class="strip" style="background: ${r.grad}"></div>
        <div class="body">
          <div class="title">${esc(o.item)}</div>
          <div class="meta">${esc(carrierLabel(o.tracking?.carrier))} &middot; ${trackHtml}</div>
          <div class="dest">
            <div class="who">${esc(o.recipient?.name)}</div>
            ${dest ? `<div class="where">${esc(dest)}</div>` : ''}
          </div>
          ${timeline(o.status)}
          <div class="foot">
            <span class="rarity">${esc(r.name)}</span>
            <span class="price">${esc(money(o.price))}</span>
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

  el.querySelectorAll('.item-card').forEach(attachTilt);
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
