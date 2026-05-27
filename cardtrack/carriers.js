/**
 * carriers.js
 * Lightweight status fetchers for Royal Mail, Evri, DPD, Yodel, and ParcelForce.
 *
 * Reliability features:
 *   - Each request retries network failures (and 5xx) with exponential backoff.
 *   - Every request is capped by a 12s timeout via AbortController.
 *   - Each fetcher logs whether the status came from a carrier API or an
 *     HTML scrape, so the GitHub Actions log shows which method succeeded.
 *
 * Returns a normalised status string:
 *   confirmed | in_transit | out_for_delivery | delivered | failed | unknown
 */

// ── Tunables ──────────────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = 12000; // per-request hard cap
const MAX_ATTEMPTS       = 3;     // total tries before giving up
const RETRY_BASE_MS      = 1000;  // backoff: 1s, then 2s

// ── Normalised status values ──────────────────────────────────────────────────
export const STATUS = {
  CONFIRMED:         'confirmed',
  IN_TRANSIT:        'in_transit',
  OUT_FOR_DELIVERY:  'out_for_delivery',
  DELIVERED:         'delivered',
  FAILED:            'failed',
  UNKNOWN:           'unknown',
};

export const STATUS_LABELS = {
  confirmed:         'Confirmed',
  in_transit:        'In transit',
  out_for_delivery:  'Out for delivery',
  delivered:         'Delivered',
  failed:            'Delivery failed',
  unknown:           'Unknown',
};

// ── Helper: log which method resolved a tracking ref ─────────────────────────
function logMethod(carrier, ref, method, status) {
  console.log(`  TRACK ${carrier} · ${ref} — via ${method} (${status})`);
}

// ── Helper: sleep ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Helper: fetch with a 12s timeout + retries on transient failures ─────────
// Retries network errors/timeouts and 5xx responses; 4xx is returned as-is so
// callers can decide to fall back to an HTML scrape.
async function fetchWithRetry(url, options = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      // Server errors are usually transient — retry if we have attempts left.
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        lastErr = new Error(`HTTP ${res.status} from ${url}`);
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
    }
  }

  throw lastErr;
}

// ── Helper: fetch page HTML with a browser-like UA ───────────────────────────
async function getHTML(url) {
  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CardTrack/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// ── Royal Mail ────────────────────────────────────────────────────────────────
// Uses their unofficial summary API used by the tracking page.

// Royal Mail event codes → normalised status
function mapRoyalMailEvent(latest, eventCount) {
  const delivered      = ['DDDA','DDDB','DDDC','DDDD','DDDE','DDDF','LD01','EVRD'];
  const outForDelivery = ['EVNI','DDNA','DDNB','DDNC'];
  const inTransit      = ['EVUA','EVUB','EVGA','EVGB','EVHH','MECE','EVHG'];
  const failed         = ['NDNA','NDNB','NDNC','NDND'];

  if (delivered.includes(latest))      return STATUS.DELIVERED;
  if (outForDelivery.includes(latest)) return STATUS.OUT_FOR_DELIVERY;
  if (failed.includes(latest))         return STATUS.FAILED;
  if (inTransit.includes(latest))      return STATUS.IN_TRANSIT;
  if (eventCount > 0)                  return STATUS.IN_TRANSIT;
  return STATUS.CONFIRMED;
}

async function checkRoyalMail(ref) {
  try {
    const url = `https://api.royalmail.com/track/v2/events/${encodeURIComponent(ref)}`;
    const res = await fetchWithRetry(url, {
      headers: {
        'Accept': 'application/json',
        'X-IBM-Client-Id': 'Royal Mail web client', // public web client key
        'User-Agent': 'Mozilla/5.0 (compatible; CardTrack/1.0)',
      },
    });

    // Non-OK (e.g. ref not live yet) — fall back to HTML scrape.
    if (!res.ok) return await checkRoyalMailHTML(ref);

    const data   = await res.json();
    const events = data?.mailPieces?.[0]?.events ?? [];
    const status = mapRoyalMailEvent(events[0]?.eventCode ?? '', events.length);

    logMethod('royal_mail', ref, 'API', status);
    return status;

  } catch {
    return await checkRoyalMailHTML(ref).catch(() => STATUS.UNKNOWN);
  }
}

async function checkRoyalMailHTML(ref) {
  const html  = await getHTML(
    `https://www.royalmail.com/track-your-item#/tracking-results/${ref}`
  );
  const lower = html.toLowerCase();

  let status = STATUS.UNKNOWN;
  if (lower.includes('delivered'))             status = STATUS.DELIVERED;
  else if (lower.includes('out for delivery')) status = STATUS.OUT_FOR_DELIVERY;
  else if (lower.includes('with our courier')) status = STATUS.OUT_FOR_DELIVERY;
  else if (lower.includes('in transit'))       status = STATUS.IN_TRANSIT;
  else if (lower.includes('item received'))    status = STATUS.IN_TRANSIT;
  else if (lower.includes('sorry'))            status = STATUS.FAILED;

  logMethod('royal_mail', ref, 'HTML', status);
  return status;
}

// ── Evri ──────────────────────────────────────────────────────────────────────
async function checkEvri(ref) {
  try {
    const url = `https://api.hermesworld.co.uk/enterprise-tracking-api/v2/parcels/${encodeURIComponent(ref)}`;
    const res = await fetchWithRetry(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; CardTrack/1.0)',
      },
    });

    if (!res.ok) return await checkEvriHTML(ref);

    const data  = await res.json();
    const state = (data?.parcel?.parcelStatusDescription ?? '').toLowerCase();

    let status;
    if (state.includes('delivered'))             status = STATUS.DELIVERED;
    else if (state.includes('out for delivery')) status = STATUS.OUT_FOR_DELIVERY;
    else if (state.includes('transit'))          status = STATUS.IN_TRANSIT;
    else if (state.includes('sorted'))           status = STATUS.IN_TRANSIT;
    else if (state.includes('received'))         status = STATUS.IN_TRANSIT;
    else                                         status = STATUS.IN_TRANSIT;

    logMethod('evri', ref, 'API', status);
    return status;

  } catch {
    return await checkEvriHTML(ref).catch(() => STATUS.UNKNOWN);
  }
}

async function checkEvriHTML(ref) {
  const html  = await getHTML(`https://www.evri.com/track/${ref}`);
  const lower = html.toLowerCase();

  let status = STATUS.UNKNOWN;
  if (lower.includes('delivered'))             status = STATUS.DELIVERED;
  else if (lower.includes('out for delivery')) status = STATUS.OUT_FOR_DELIVERY;
  else if (lower.includes('in transit'))       status = STATUS.IN_TRANSIT;
  else if (lower.includes('on its way'))       status = STATUS.IN_TRANSIT;

  logMethod('evri', ref, 'HTML', status);
  return status;
}

// ── DPD ───────────────────────────────────────────────────────────────────────
async function checkDPD(ref) {
  try {
    const html  = await getHTML(
      `https://track.dpd.co.uk/tracking/parcel/${encodeURIComponent(ref)}`
    );
    const lower = html.toLowerCase();

    let status = STATUS.UNKNOWN;
    if (lower.includes('delivered'))             status = STATUS.DELIVERED;
    else if (lower.includes('out for delivery')) status = STATUS.OUT_FOR_DELIVERY;
    else if (lower.includes('with driver'))      status = STATUS.OUT_FOR_DELIVERY;
    else if (lower.includes('in transit'))       status = STATUS.IN_TRANSIT;
    else if (lower.includes('at depot'))         status = STATUS.IN_TRANSIT;
    else if (lower.includes('collection'))       status = STATUS.IN_TRANSIT;

    logMethod('dpd', ref, 'HTML', status);
    return status;
  } catch {
    return STATUS.UNKNOWN;
  }
}

// ── Yodel ─────────────────────────────────────────────────────────────────────
async function checkYodel(ref) {
  try {
    const html  = await getHTML(`https://www.yodel.co.uk/tracking/${ref}`);
    const lower = html.toLowerCase();

    let status = STATUS.UNKNOWN;
    if (lower.includes('delivered'))             status = STATUS.DELIVERED;
    else if (lower.includes('out for delivery')) status = STATUS.OUT_FOR_DELIVERY;
    else if (lower.includes('in transit'))       status = STATUS.IN_TRANSIT;

    logMethod('yodel', ref, 'HTML', status);
    return status;
  } catch {
    return STATUS.UNKNOWN;
  }
}

// ── ParcelForce ───────────────────────────────────────────────────────────────
async function checkParcelForce(ref) {
  try {
    const html  = await getHTML(
      `https://www.parcelforce.com/track-trace?trackNumber=${encodeURIComponent(ref)}`
    );
    const lower = html.toLowerCase();

    let status = STATUS.UNKNOWN;
    if (lower.includes('delivered'))                 status = STATUS.DELIVERED;
    else if (lower.includes('out for delivery'))     status = STATUS.OUT_FOR_DELIVERY;
    else if (lower.includes('on board for delivery'))status = STATUS.OUT_FOR_DELIVERY;
    else if (lower.includes('in transit'))           status = STATUS.IN_TRANSIT;
    else if (lower.includes('at depot'))             status = STATUS.IN_TRANSIT;
    else if (lower.includes('collected'))            status = STATUS.IN_TRANSIT;
    else if (lower.includes('sorted'))               status = STATUS.IN_TRANSIT;
    else if (lower.includes('unable to deliver'))    status = STATUS.FAILED;
    else if (lower.includes('unsuccessful'))         status = STATUS.FAILED;

    logMethod('parcelforce', ref, 'HTML', status);
    return status;
  } catch {
    return STATUS.UNKNOWN;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────
export async function checkTracking(carrier, ref) {
  if (!ref || ref.trim() === '') return STATUS.CONFIRMED;

  switch (carrier) {
    case 'royal_mail':  return checkRoyalMail(ref);
    case 'evri':        return checkEvri(ref);
    case 'dpd':         return checkDPD(ref);
    case 'yodel':       return checkYodel(ref);
    case 'parcelforce': return checkParcelForce(ref);
    default:            return STATUS.UNKNOWN;
  }
}
