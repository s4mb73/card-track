// Self-contained tests for the scraper's pure logic. Doesn't connect to
// Gmail or Supabase — instead it copies the helpers from ingest.js
// inline and feeds them realistic inputs, plus simulates the dispatch
// loop against an in-memory inventory + a mock Supabase client.
//
// Run with:  node cardtrack/test-ingest.mjs
// Exits 0 if all assertions pass, 1 otherwise. Prints a tally.

import assert from 'node:assert/strict';

// ── Helpers under test (mirrored from ingest.js) ──────────────────────────────
function safeDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

const normPostcode = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
const normName     = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function buildAddressMatcher(addresses) {
  return function findMatch(name, postcode) {
    if (!postcode) return null;
    const pc = normPostcode(postcode);
    const nm = normName(name);
    const pcMatches = addresses.filter(a => normPostcode(a.postcode) === pc);
    if (!pcMatches.length) return null;
    if (nm) {
      const named = pcMatches.find(a => normName(a.full_name) === nm);
      if (named) return named.id;
    }
    return pcMatches.length === 1 ? pcMatches[0].id : null;
  };
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(label) { console.log(`\n${label}`); }

// ── safeDate ──────────────────────────────────────────────────────────────────
section('safeDate');

test('accepts valid YYYY-MM-DD', () => {
  assert.equal(safeDate('2026-05-21'), '2026-05-21');
});
test('rejects Claude placeholder', () => {
  assert.equal(safeDate('<UNKNOWN>'), null);
});
test('rejects empty string', () => {
  assert.equal(safeDate(''), null);
});
test('rejects undefined/null', () => {
  assert.equal(safeDate(undefined), null);
  assert.equal(safeDate(null), null);
});
test('rejects loose date forms', () => {
  assert.equal(safeDate('21/05/2026'), null);
  assert.equal(safeDate('May 21 2026'), null);
  assert.equal(safeDate('2026-5-21'), null); // no zero-padding
});
test('trims whitespace before validating', () => {
  assert.equal(safeDate('  2026-05-21 '), '2026-05-21');
});

// ── normPostcode / normName ───────────────────────────────────────────────────
section('normalisation');

test('normPostcode strips whitespace + uppercases', () => {
  assert.equal(normPostcode('wa3 5nu'),  'WA35NU');
  assert.equal(normPostcode('WA3 5NU'),  'WA35NU');
  assert.equal(normPostcode('WA35NU'),   'WA35NU');
  assert.equal(normPostcode(' wa3  5nu '), 'WA35NU');
});
test('normName lowercases + collapses whitespace', () => {
  assert.equal(normName('Luke Downes'),    'luke downes');
  assert.equal(normName('  LUKE   DOWNES '),'luke downes');
});

// ── buildAddressMatcher ───────────────────────────────────────────────────────
section('address matching');

const ADDRS = [
  { id: 'addr_001', full_name: 'Luke Downes',     postcode: 'WA3 5NU' },
  { id: 'addr_002', full_name: 'Matt Wood',       postcode: 'WA3 4NL' },
  { id: 'addr_003', full_name: 'Fi Bimpson',      postcode: 'WA3 4NR' },
  { id: 'addr_004', full_name: 'Sammy Bimpson',   postcode: 'WA3 4NR' }, // shares postcode with Fi
  { id: 'addr_005', full_name: 'Louis Bimpson',   postcode: 'WA3 4NR' }, // ditto
  { id: 'addr_006', full_name: 'Ethan Inns',      postcode: 'WN2 4TZ' },
];
const find = buildAddressMatcher(ADDRS);

test('exact name + postcode match wins', () => {
  assert.equal(find('Luke Downes', 'WA3 5NU'), 'addr_001');
});
test('case-insensitive name match', () => {
  assert.equal(find('luke downes', 'wa3 5nu'), 'addr_001');
});
test('whitespace-different postcode match', () => {
  assert.equal(find('Luke Downes', 'WA35NU'), 'addr_001');
});
test('name+postcode beats lone-occupant fallback', () => {
  assert.equal(find('Matt Wood',  'WA3 4NL'), 'addr_002');
});
test('lone occupant of postcode matches without name', () => {
  assert.equal(find('',           'WA3 4NL'), 'addr_002');
  assert.equal(find('Random Name','WA3 4NL'), 'addr_002');
});
test('shared postcode + unknown name → null (ambiguous)', () => {
  assert.equal(find('Stranger', 'WA3 4NR'), null);
});
test('shared postcode + matching name resolves', () => {
  assert.equal(find('Sammy Bimpson', 'WA3 4NR'), 'addr_004');
});
test('no postcode → null', () => {
  assert.equal(find('Luke Downes', ''),    null);
  assert.equal(find('Luke Downes', null),  null);
});
test('unknown postcode → null', () => {
  assert.equal(find('Luke Downes', 'AB1 2CD'), null);
});

// ── Mock Supabase client ──────────────────────────────────────────────────────
// Records every call so tests can assert against the resulting state.
function makeMockSupabase(seed = {}) {
  const tables = {
    inventory:        [...(seed.inventory || [])],
    email_ingestions: [...(seed.email_ingestions || [])],
  };

  function chain(table, op) {
    let rows = [...tables[table]];
    let filters = [];
    const api = {
      eq(col, val) { filters.push(r => r[col] === val); return api; },
      in(col, vals) { filters.push(r => vals.includes(r[col])); return api; },
      limit(n) { rows = rows.slice(0, n); return api; },
      select(_cols) {
        const result = applyFilters(rows, filters);
        if (op === 'update') return Promise.resolve({ data: result, error: null });
        return Promise.resolve({ data: result, error: null });
      },
      maybeSingle() {
        const result = applyFilters(rows, filters);
        if (result.length > 1) return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'multiple rows' } });
        return Promise.resolve({ data: result[0] || null, error: null });
      },
      then(resolve) { return resolve({ data: rows, error: null }); },
    };
    return api;
  }
  function applyFilters(rows, filters) {
    return rows.filter(r => filters.every(f => f(r)));
  }

  return {
    tables,
    from(table) {
      return {
        select() {
          let rows = [...tables[table]];
          let filters = [];
          const sel = {
            eq(col, val) { filters.push(r => r[col] === val); return sel; },
            in(col, vals) { filters.push(r => vals.includes(r[col])); return sel; },
            limit(n) {
              const result = applyFilters(rows, filters).slice(0, n);
              return Promise.resolve({ data: result, error: null });
            },
            maybeSingle() {
              const result = applyFilters(rows, filters);
              if (result.length > 1) return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
              return Promise.resolve({ data: result[0] || null, error: null });
            },
            then(resolve) { return resolve({ data: applyFilters(rows, filters), error: null }); },
          };
          return sel;
        },
        insert(row) {
          tables[table].push({ ...row });
          return Promise.resolve({ data: row, error: null });
        },
        update(patch) {
          let filters = [];
          const upd = {
            eq(col, val) { filters.push(r => r[col] === val); return upd; },
            in(col, vals) { filters.push(r => vals.includes(r[col])); return upd; },
            select() {
              const hits = applyFilters(tables[table], filters);
              for (const row of hits) Object.assign(row, patch);
              return Promise.resolve({ data: hits.map(r => ({ id: r.id })), error: null });
            },
            then(resolve) {
              const hits = applyFilters(tables[table], filters);
              for (const row of hits) Object.assign(row, patch);
              return resolve({ data: null, error: null });
            },
          };
          return upd;
        },
      };
    },
  };
}

// ── Dispatch simulator ────────────────────────────────────────────────────────
// Mirrors the per-message body of ingest.js's loop. Takes parsed Claude
// output + parsed.date + mock supabase + findAddress. Returns the action
// taken so tests can assert.
async function dispatch(cls, parsedDate, supabase, findAddress) {
  if (cls.email_type === 'other' || !cls.order_reference) return { action: 'skip', reason: 'other-or-no-ref' };

  if (cls.email_type === 'order_confirmation') {
    const { data: dups } = await supabase
      .from('inventory').select('id').eq('order_reference', cls.order_reference).limit(1);
    if (dups && dups.length) return { action: 'skip', reason: 'duplicate', existingId: dups[0].id };

    const matchedAddressId = findAddress(cls.recipient_name, cls.recipient_postcode);
    const inventoryRow = {
      id: `inv_${cls.order_reference}`,
      item: cls.item, category: cls.category, quantity: cls.quantity || 1,
      order_reference: cls.order_reference,
      date_ordered: safeDate(parsedDate ? parsedDate.toISOString().slice(0, 10) : cls.date_ordered),
      cost: cls.cost || 0, carrier: '', tracking_ref: '',
      acquisition_status: 'confirmed',
      recipient_address_id: matchedAddressId,
    };
    await supabase.from('inventory').insert(inventoryRow);
    return { action: 'insert', row: inventoryRow };
  }

  const update = {};
  if (cls.email_type === 'shipment') {
    if (cls.carrier)      update.carrier      = cls.carrier;
    if (cls.tracking_ref) update.tracking_ref = cls.tracking_ref;
    update.acquisition_status = 'in_transit';
  } else {
    update.acquisition_status = 'cancelled';
  }

  let q = supabase.from('inventory').update(update).eq('order_reference', cls.order_reference);
  if (cls.email_type === 'shipment') q = q.in('acquisition_status', ['confirmed', 'pending', '']);
  const { data: hits } = await q.select('id');
  if (!hits?.length) return { action: 'defer', reason: 'no matching order' };
  return { action: 'update', hits: hits.length, type: cls.email_type };
}

// ── Scenarios driving the dispatcher ──────────────────────────────────────────
section('dispatch — order_confirmation');

await (async () => {
  const supabase = makeMockSupabase();
  const find = buildAddressMatcher(ADDRS);

  // First confirmation lands as new inventory row.
  const cls = {
    email_type: 'order_confirmation',
    order_reference: 'UK-1199441-S',
    item: 'Topps Chrome UEFA Hobby Box', category: 'Topps',
    cost: 220, quantity: 1,
    recipient_name: 'Matt Wood', recipient_postcode: 'WA3 4NL',
    date_ordered: '',
  };
  const r1 = await dispatch(cls, new Date('2026-05-07T12:00:48Z'), supabase, find);
  test('inserts new row with linked address + cost intact', () => {
    assert.equal(r1.action, 'insert');
    assert.equal(supabase.tables.inventory.length, 1);
    const row = supabase.tables.inventory[0];
    assert.equal(row.order_reference, 'UK-1199441-S');
    assert.equal(row.recipient_address_id, 'addr_002');
    assert.equal(row.cost, 220);
    assert.equal(row.acquisition_status, 'confirmed');
    assert.equal(row.date_ordered, '2026-05-07');
  });

  // Same confirmation on the next scrape → dedup hits.
  const r2 = await dispatch(cls, new Date('2026-05-07T12:00:48Z'), supabase, find);
  test('second pass dedups by order_reference', () => {
    assert.equal(r2.action, 'skip');
    assert.equal(r2.reason, 'duplicate');
    assert.equal(supabase.tables.inventory.length, 1);
  });
})();

section('dispatch — order_confirmation with Claude UNKNOWN date');

await (async () => {
  const supabase = makeMockSupabase();
  const find = buildAddressMatcher(ADDRS);
  const cls = {
    email_type: 'order_confirmation',
    order_reference: 'UK-9999999-S',
    item: 'Topps Edge Case', category: 'Topps', cost: 50, quantity: 1,
    recipient_name: '', recipient_postcode: '',
    date_ordered: '<UNKNOWN>',
  };
  await dispatch(cls, null, supabase, find);
  test('Claude <UNKNOWN> date becomes null, not a PG error', () => {
    assert.equal(supabase.tables.inventory[0].date_ordered, null);
  });
})();

section('dispatch — shipment + cancellation flow');

await (async () => {
  const supabase = makeMockSupabase();
  const find = buildAddressMatcher(ADDRS);

  // Order arrives first.
  await dispatch({
    email_type: 'order_confirmation', order_reference: 'UK-1196937-S',
    item: 'Simplicidad', category: 'Topps', cost: 140, quantity: 1,
    recipient_name: 'Ethan Inns', recipient_postcode: 'WN2 4TZ',
    date_ordered: '',
  }, new Date('2026-05-21T02:42:40Z'), supabase, find);

  // Shipment lands → in_transit + tracking.
  const ship = await dispatch({
    email_type: 'shipment', order_reference: 'UK-1196937-S',
    item: '', category: '', cost: 0, quantity: 0, date_ordered: '',
    recipient_name: '', recipient_postcode: '',
    carrier: 'royal_mail', tracking_ref: 'QG472502524GB',
  }, new Date('2026-05-21T02:42:40Z'), supabase, find);
  test('shipment fills carrier + tracking + status=in_transit', () => {
    assert.equal(ship.action, 'update');
    const row = supabase.tables.inventory[0];
    assert.equal(row.acquisition_status, 'in_transit');
    assert.equal(row.carrier, 'royal_mail');
    assert.equal(row.tracking_ref, 'QG472502524GB');
  });

  // Cancellation lands AFTER shipment → row becomes cancelled (cancellation always wins).
  const cancel = await dispatch({
    email_type: 'cancellation', order_reference: 'UK-1196937-S',
    item: '', category: '', cost: 0, quantity: 0,
    recipient_name: '', recipient_postcode: '', date_ordered: '',
    carrier: '', tracking_ref: '',
  }, null, supabase, find);
  test('cancellation overrides any prior state', () => {
    assert.equal(cancel.action, 'update');
    assert.equal(supabase.tables.inventory[0].acquisition_status, 'cancelled');
  });

  // A LATE-arriving shipment should NOT un-cancel.
  const lateShip = await dispatch({
    email_type: 'shipment', order_reference: 'UK-1196937-S',
    item: '', category: '', cost: 0, quantity: 0,
    recipient_name: '', recipient_postcode: '', date_ordered: '',
    carrier: 'royal_mail', tracking_ref: 'QG472502524GB',
  }, null, supabase, find);
  test('late shipment can\'t un-cancel a cancelled row', () => {
    assert.equal(lateShip.action, 'defer');
    assert.equal(supabase.tables.inventory[0].acquisition_status, 'cancelled');
  });
})();

section('dispatch — deferred retry when confirmation hasn\'t landed');

await (async () => {
  const supabase = makeMockSupabase();
  const find = buildAddressMatcher(ADDRS);

  const r = await dispatch({
    email_type: 'cancellation', order_reference: 'UK-NEW-S',
    item: '', category: '', cost: 0, quantity: 0,
    recipient_name: '', recipient_postcode: '', date_ordered: '',
    carrier: '', tracking_ref: '',
  }, null, supabase, find);
  test('cancellation with no matching row defers (will retry next run)', () => {
    assert.equal(r.action, 'defer');
    assert.equal(supabase.tables.inventory.length, 0);
  });
})();

section('dispatch — duplicate-proof shipment update');

await (async () => {
  // Two rows for the same order_reference (left over from earlier no-dedup tests).
  const supabase = makeMockSupabase({
    inventory: [
      { id: 'inv_A', order_reference: 'UK-DUP-S', acquisition_status: 'confirmed', carrier: '', tracking_ref: '' },
      { id: 'inv_B', order_reference: 'UK-DUP-S', acquisition_status: 'confirmed', carrier: '', tracking_ref: '' },
    ],
  });
  const find = buildAddressMatcher(ADDRS);

  await dispatch({
    email_type: 'shipment', order_reference: 'UK-DUP-S',
    item: '', category: '', cost: 0, quantity: 0,
    recipient_name: '', recipient_postcode: '', date_ordered: '',
    carrier: 'evri', tracking_ref: 'H123XYZ',
  }, null, supabase, find);

  test('shipment updates ALL rows sharing the order_reference', () => {
    for (const row of supabase.tables.inventory) {
      assert.equal(row.acquisition_status, 'in_transit');
      assert.equal(row.carrier, 'evri');
      assert.equal(row.tracking_ref, 'H123XYZ');
    }
  });
})();

// ── Wrap up ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
