// parseShopifyEmail.js
//
// Deterministic parser for Topps / Shopify order-notification emails.
// Reads the already-decoded text/plain body (as mailparser gives us) and
// pulls out the order state + fields with ZERO AI. Returns a result with
// `needsAI: true` when a required field for the detected type is missing,
// so the caller can fall back to the LLM classifier for that one email.
//
// Email types and the transition each one drives:
//   confirmation → create/stock the order (item, cost, recipient)
//   shipment     → carrier + tracking ref + tracking URL (status in_transit)
//   cancellation → mark cancelled
//
// Everything Topps sends is a rigid Shopify template, so every field sits
// in a fixed, labelled spot in the plain-text part.

const X = '×'; // the "× 1" multiplication sign used on line items

// Carrier name (as printed in the email) → our normalised carrier id.
const CARRIER_MAP = [
  [/royal\s*mail/i,  'royal_mail'],
  [/parcel\s*force/i,'parcelforce'],
  [/evri|hermes/i,   'evri'],
  [/dpd/i,           'dpd'],
  [/yodel/i,         'yodel'],
];
function mapCarrier(name) {
  for (const [re, id] of CARRIER_MAP) if (re.test(name)) return id;
  return '';
}

// Subject line is the most reliable type signal.
export function detectType(subject = '') {
  const s = subject.toLowerCase();
  if (/is on the way|has shipped|on its way/.test(s))     return 'shipment';
  if (/cancel(l)?ed/.test(s))                             return 'cancellation';
  if (/confirmed|thank you for your (purchase|order)/.test(s)) return 'order_confirmation';
  return null;
}

function findOrderRef(...texts) {
  for (const t of texts) {
    const m = String(t || '').match(/\bUK-\d+-S\b/);
    if (m) return m[0];
  }
  return '';
}

// Only the Total line carries a " GBP" suffix in Shopify UK emails;
// Subtotal / Shipping / Taxes never do. Reading the Total line directly
// is immune to the VAT-doubling trap (UK prices are VAT-inclusive).
function findTotalCost(body) {
  const m = body.match(/£\s*([\d,]+\.\d{2})\s*GBP/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

const SECTION = {
  order_confirmation: /Order summary\s*\n\s*-+/i,
  shipment:           /Items in this shipment\s*\n\s*-+/i,
  cancellation:       /Removed Items\s*\n\s*-+/i,
};

// Item names can wrap across hard newlines in the plain-text part (e.g.
// "...- Hobby\nBox × 1"), so we work on the whole item region rather than a
// single line: take from the section header to the totals/footer, then read
// each "<name> × <qty>" unit, joining wrapped lines into one name.
function findItems(body, type) {
  let region = body;
  const header = SECTION[type];
  if (header) {
    const hi = body.search(header);
    if (hi !== -1) {
      region = body.slice(hi);
      const endRe = /\n\s*(Subtotal|Customer information|Please note|Refunded|United Kingdom)\b/i;
      const ei = region.search(endRe);
      if (ei !== -1) region = region.slice(0, ei);
    }
  }

  const items = [];
  let totalQty = 0;
  const re = new RegExp('([\\s\\S]+?)' + X + '\\s*(\\d+)', 'g');
  let m;
  while ((m = re.exec(region)) !== null) {
    const name = m[1]
      .replace(/Order summary|Items in this shipment|Removed Items/i, '')
      .replace(/-{3,}/g, ' ')
      .replace(/£\s*[\d,]+\.\d{2}/g, ' ')
      .replace(/\bRefunded\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const qty = Number(m[2]);
    if (name) { items.push({ name, qty }); totalQty += qty; }
  }
  return { item: items.map(i => i.name).join(' + '), quantity: totalQty || null, items };
}

// e.g. "Royal Mail tracking number: QG472502524GB" followed by a
// "( https://www.royalmail.com/...trackNumber=QG472502524GB )" deep link.
function findTracking(body) {
  const m = body.match(/([A-Za-z][A-Za-z ]*?)\s*tracking number:\s*([A-Z0-9]+)/i);
  if (!m) return { carrier: '', trackingRef: '', trackingUrl: '' };
  const carrier = mapCarrier(m[1]);
  const trackingRef = m[2];
  // Prefer the carrier deep-link that embeds the tracking ref.
  let trackingUrl = '';
  const u = body.match(new RegExp('https?://\\S*' + trackingRef + '\\S*'));
  if (u) trackingUrl = u[0].replace(/[)\s]+$/, '');
  return { carrier, trackingRef, trackingUrl };
}

const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/;

function findShippingAddress(body) {
  const start = body.search(/Shipping address\s*\n\s*-+/i);
  if (start === -1) return null;
  const after = body.slice(start);
  const stop = after.search(/\n\s*(Billing address|Shipping method)\b/i);
  const block = stop === -1 ? after : after.slice(0, stop);
  const lines = block.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !/^shipping address$/i.test(l) && !/^-+$/.test(l));
  if (!lines.length) return null;
  const pc = block.match(UK_POSTCODE);
  return {
    name:     lines[0],
    postcode: pc ? pc[1].replace(/\s+/g, ' ').toUpperCase() : '',
    lines:    lines.filter(l => !/^united kingdom$/i.test(l)),
  };
}

export function parseShopifyEmail({ subject = '', text = '' } = {}) {
  const emailType = detectType(subject);
  const body = String(text || '');
  const out = {
    ok: false, needsAI: false, emailType,
    orderReference: findOrderRef(subject, body),
    item: '', quantity: null, cost: null,
    carrier: '', trackingRef: '', trackingUrl: '',
    recipient: null, missing: [],
  };

  if (!emailType) { out.needsAI = true; out.missing.push('emailType'); return out; }

  if (emailType === 'order_confirmation') {
    const { item, quantity } = findItems(body, 'order_confirmation');
    out.item = item;
    out.quantity = quantity;
    out.cost = findTotalCost(body);
    out.recipient = findShippingAddress(body);
    for (const f of ['orderReference', 'item', 'cost']) if (out[f] == null || out[f] === '') out.missing.push(f);
  } else if (emailType === 'shipment') {
    Object.assign(out, findTracking(body));
    const { item, quantity } = findItems(body, 'shipment');
    out.item = item;
    out.quantity = quantity;
    for (const f of ['orderReference', 'trackingRef', 'carrier']) if (!out[f]) out.missing.push(f);
  } else if (emailType === 'cancellation') {
    out.item = findItems(body, 'cancellation').item;
    if (!out.orderReference) out.missing.push('orderReference');
  }

  out.needsAI = out.missing.length > 0;
  out.ok = !out.needsAI;
  return out;
}
