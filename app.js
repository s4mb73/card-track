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

const SALE_STATUSES = ['holding', 'listed', 'sold', 'refunded'];
const ACQ_STATUSES  = ['pending', 'in_transit', 'out_for_delivery', 'delivered', 'failed'];
const NOTIFY_TRIGGERS = ['in_transit', 'out_for_delivery', 'delivered', 'failed'];
const ACTIVE_STATUSES = ['pending', 'in_transit', 'out_for_delivery'];
const EMAIL_SOURCES   = [
  'orders@topps.com', 'noreply@pokemoncenter.com', 'orders@aycd.io', 'ebay@ebay.co.uk',
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
function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function nextHourlyRun() {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
  return d.toLocaleString('en-GB');
}
function statusCell(s) {
  return `<span class="status status-${esc(s)}"><span class="sd"></span>${esc(statusLabel(s))}</span>`;
}
function effectiveStatus(item) {
  return item.sale_status === 'sold' ? 'sold' : item.acquisition_status;
}
function profitOf(item) {
  if (item.sale_status !== 'sold') return null;
  const sale = Number(item.sale_price) || 0;
  const cost = Number(item.cost) || 0;
  const fees = Number(item.fees) || 0;
  const shipIn  = Number(item.shipping_in_cost)  || 0;
  const shipOut = Number(item.shipping_out_cost) || 0;
  return sale - cost - fees - shipIn - shipOut;
}
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData() {
  const [invRes, addrRes] = await Promise.all([
    supabase.from('inventory').select('*').order('id'),
    supabase.from('addresses').select('*').order('id'),
  ]);
  if (invRes.error)  throw new Error(`Inventory: ${invRes.error.message}`);
  if (addrRes.error) throw new Error(`Addresses: ${addrRes.error.message}`);
  ITEMS       = invRes.data  ?? [];
  ADDRESSES   = addrRes.data ?? [];
  ADDRESS_MAP = new Map(ADDRESSES.map(a => [a.id, a]));
}

// ── KPI tiles ─────────────────────────────────────────────────────────────────
function renderSummary() {
  const total  = ITEMS.length;
  const spent  = ITEMS.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const active = ITEMS.filter(i => ACTIVE_STATUSES.includes(i.acquisition_status)).length;
  const sold   = ITEMS.filter(i => i.sale_status === 'sold');
  const profit = sold.reduce((s, i) => s + (profitOf(i) || 0), 0);

  const tiles = [
    { label: 'Items',      value: total,         tint: 'purple' },
    { label: 'Spent',      value: money(spent),  tint: 'green'  },
    { label: 'In transit', value: active,        tint: 'blue'   },
    { label: 'Profit',     value: money(profit), tint: 'amber'  },
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
  if (inventoryFilter === 'all')        filtered = ITEMS;
  else if (inventoryFilter === 'sold')  filtered = ITEMS.filter(i => i.sale_status === 'sold');
  else filtered = ITEMS.filter(i => i.acquisition_status === inventoryFilter && i.sale_status !== 'sold');

  const FILTER_KEYS = ['all', ...ACQ_STATUSES, 'sold'];
  const options = FILTER_KEYS.map(k => `
    <option value="${esc(k)}" ${k === inventoryFilter ? 'selected' : ''}>
      ${k === 'all' ? 'All statuses' : esc(statusLabel(k))}
    </option>
  `).join('');

  const rows = filtered.map(item => {
    const url = safeUrl(item.tracking_url);
    const ref = item.tracking_ref || '';
    const trackHtml = ref
      ? (url
          ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="mono" data-stop>${esc(ref)}</a>`
          : `<span class="mono">${esc(ref)}</span>`)
      : '<span class="muted">—</span>';
    const addr     = ADDRESS_MAP.get(item.recipient_address_id);
    const destName = addr?.full_name || '—';
    const destLoc  = shortAddress(addr);
    const status   = effectiveStatus(item);
    const profit   = profitOf(item);
    const subLine  = [item.category, item.set_edition].filter(Boolean).map(esc).join(' · ');

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
          <button class="btn-primary btn-add" id="add-inv">+ Add item</button>
        </div>
      </div>
      ${filtered.length ? `
        <table class="row-clickable">
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
            ${a.type ? `<span class="type-tag">${esc(a.type)}</span>` : ''}
          </div>
        </div>
        <div class="addr">${addrHtml}</div>
        <div class="contact">
          ${a.email ? `<div><b>Email</b>${esc(a.email)}</div>` : ''}
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

// ── Scheduler ─────────────────────────────────────────────────────────────────
function renderScheduler() {
  const el = document.getElementById('tab-scheduler');
  const active = ITEMS.filter(i => ACTIVE_STATUSES.includes(i.acquisition_status));
  const rows = ITEMS.map(item => {
    let note = '';
    if (!item.tracking_ref)      note = '<span class="pill warn">awaiting tracking ref</span>';
    else if (!item.last_checked) note = '<span class="pill muted">never checked</span>';
    return `
      <tr>
        <td><div class="primary">${esc(item.item)}</div></td>
        <td>${statusCell(item.acquisition_status)}</td>
        <td class="num">${esc(relTime(item.last_checked))}</td>
        <td>${note}</td>
      </tr>
    `;
  }).join('');
  el.innerHTML = `
    <div class="section">
      <div class="section-head"><div><h2>Schedule</h2><div class="sub">How often the checker polls each carrier.</div></div></div>
      <div class="info-row"><span class="k">Frequency</span><span>Hourly &middot; <code>0 * * * *</code></span></div>
      <div class="info-row"><span class="k">Runner</span><span>GitHub Actions &middot; <code>.github/workflows/checker.yml</code></span></div>
      <div class="info-row"><span class="k">Store</span><span>Supabase Postgres</span></div>
      <div class="info-row"><span class="k">Active items next run</span><span class="num">${active.length}</span></div>
      <div class="info-row"><span class="k">Estimated next run</span><span class="num">${esc(nextHourlyRun())}</span></div>
    </div>
    <div class="section">
      <div class="section-head"><div><h2>Last checked</h2><div class="sub">When each item was last polled.</div></div></div>
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
      <div class="section-head"><div><h2>Email ingestion</h2><div class="sub">Auto-import orders from your inbox.</div></div></div>
      <div class="info-row"><span class="k">Status</span><span class="pill muted">Not connected</span></div>
      <div class="section-body">
        <p style="color: var(--text-muted); margin-bottom: 12px; font-size: 13.5px;">
          Once connected, order confirmations from these senders would insert new
          rows into the <code>inventory</code> table automatically.
        </p>
        <ul class="sources">${EMAIL_SOURCES.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
    </div>
  `;
}

// ── Modal infrastructure ──────────────────────────────────────────────────────
function showModal({ title, body, submitText = 'Save', onSubmit, onDelete }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <form class="modal" id="modal-form" novalidate>
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
}

// ── Form fields ───────────────────────────────────────────────────────────────
function field(label, name, type, opts = {}) {
  const v = opts.value ?? '';
  const req = opts.required ? 'required' : '';
  const wide = opts.wide ? ' wide' : '';
  if (type === 'textarea') {
    return `<label class="field${wide}"><span>${esc(label)}</span><textarea name="${esc(name)}" ${req}>${esc(v)}</textarea></label>`;
  }
  if (type === 'select') {
    const optsHtml = opts.options.map(o => {
      const val = typeof o === 'string' ? o : o.value;
      const lbl = typeof o === 'string' ? o : o.label;
      return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lbl)}</option>`;
    }).join('');
    return `<label class="field${wide}"><span>${esc(label)}</span><select name="${esc(name)}" ${req}>${optsHtml}</select></label>`;
  }
  return `<label class="field${wide}"><span>${esc(label)}</span><input type="${esc(type)}" name="${esc(name)}" value="${esc(v)}" ${req}></label>`;
}

function addressFormHtml(a = {}) {
  return `
    <div class="form-grid">
      ${field('Full name', 'full_name', 'text', { value: a.full_name, required: true })}
      ${field('Type', 'type', 'select', { value: a.type || 'Friend', options: ['Friend', 'Customer', 'Self'] })}
      ${field('Email', 'email', 'email', { value: a.email })}
      ${field('Phone', 'phone', 'tel', { value: a.phone })}
      ${field('WhatsApp', 'whatsapp', 'tel', { value: a.whatsapp })}
      ${field('Preferred channel', 'preferred_channel', 'select', { value: a.preferred_channel || 'sms', options: ['sms', 'whatsapp', 'email'] })}
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
  const carrierOpts = [{ value: '', label: '—' }, ...Object.entries(CARRIER_LABELS).map(([v, l]) => ({ value: v, label: l }))];
  return `
    <div class="form-section-label">Card</div>
    <div class="form-grid">
      ${field('Item', 'item', 'text', { value: it.item, required: true, wide: true })}
      ${field('Category', 'category', 'text', { value: it.category })}
      ${field('Set / Edition', 'set_edition', 'text', { value: it.set_edition })}
      ${field('Condition', 'condition', 'text', { value: it.condition })}
      ${field('Quantity', 'quantity', 'number', { value: it.quantity ?? 1 })}
    </div>
    <div class="form-section-label">Buying</div>
    <div class="form-grid">
      ${field('Source', 'source', 'text', { value: it.source })}
      ${field('Order reference', 'order_reference', 'text', { value: it.order_reference })}
      ${field('Date ordered', 'date_ordered', 'date', { value: it.date_ordered })}
      ${field('Cost', 'cost', 'number', { value: it.cost ?? 0 })}
      ${field('Shipping (in)', 'shipping_in_cost', 'number', { value: it.shipping_in_cost ?? 0 })}
      ${field('Carrier', 'carrier', 'select', { value: it.carrier || '', options: carrierOpts })}
      ${field('Tracking ref', 'tracking_ref', 'text', { value: it.tracking_ref })}
      ${field('Tracking URL', 'tracking_url', 'url', { value: it.tracking_url, wide: true })}
      ${field('Acquisition status', 'acquisition_status', 'select', { value: it.acquisition_status || 'pending', options: ACQ_STATUSES })}
      ${field('Date received', 'date_received', 'date', { value: it.date_received })}
      ${field('Recipient', 'recipient_address_id', 'select', { value: it.recipient_address_id || '', options: addrOpts, required: true, wide: true })}
    </div>
    <div class="form-section-label">Selling</div>
    <div class="form-grid">
      ${field('Sale status', 'sale_status', 'select', { value: it.sale_status || 'holding', options: SALE_STATUSES })}
      ${field('Sold via', 'sold_via', 'text', { value: it.sold_via })}
      ${field('Sale price', 'sale_price', 'number', { value: it.sale_price ?? '' })}
      ${field('Fees', 'fees', 'number', { value: it.fees ?? '' })}
      ${field('Shipping (out)', 'shipping_out_cost', 'number', { value: it.shipping_out_cost ?? '' })}
      ${field('Date sold', 'date_sold', 'date', { value: it.date_sold })}
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
  // Convert numerics
  ['quantity', 'cost', 'shipping_in_cost', 'sale_price', 'fees', 'shipping_out_cost'].forEach(k => {
    if (data[k] === '' || data[k] == null) data[k] = null;
    else data[k] = Number(data[k]);
  });
  // Null out empty optional fields the schema accepts as null
  ['date_ordered', 'date_received', 'date_sold', 'recipient_address_id'].forEach(k => {
    if (data[k] === '' || data[k] == null) data[k] = null;
  });
  return data;
}

function openAddressEditor(existing) {
  const editing = !!existing;
  showModal({
    title: editing ? 'Edit address' : 'New address',
    body:  addressFormHtml(existing || {}),
    submitText: editing ? 'Save changes' : 'Add address',
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

// ── Init ──────────────────────────────────────────────────────────────────────
setupNav();
document.getElementById('refresh').addEventListener('click', refresh);
refresh();
