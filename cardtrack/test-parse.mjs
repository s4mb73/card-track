// Assertion tests for parseShopifyEmail() against the three real Topps
// emails. Run: node cardtrack/test-parse.mjs

import { parseShopifyEmail } from './parseShopifyEmail.js';
import { qpDecode, SAMPLES } from './_shopify-fixtures.mjs';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else      { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

for (const sample of SAMPLES) {
  console.log(`\n${sample.name}`);
  const text = qpDecode(sample.raw, sample.charset);
  const r = parseShopifyEmail({ subject: sample.subject, text });
  const e = sample.expect;

  check('classified without AI', r.needsAI === false, `needsAI=${r.needsAI} missing=[${r.missing}]`);
  check(`type = ${e.emailType}`, r.emailType === e.emailType, `got ${r.emailType}`);
  check(`order ref = ${e.orderReference}`, r.orderReference === e.orderReference, `got ${r.orderReference}`);
  check(`item = ${e.item}`, r.item === e.item, `got ${r.item}`);

  if (e.carrier !== undefined)     check(`carrier = ${e.carrier}`, r.carrier === e.carrier, `got ${r.carrier}`);
  if (e.trackingRef !== undefined) check(`tracking ref = ${e.trackingRef}`, r.trackingRef === e.trackingRef, `got ${r.trackingRef}`);
  if (e.trackingUrl !== undefined) check('tracking URL extracted', r.trackingUrl === e.trackingUrl, `got ${r.trackingUrl}`);
  if (e.cost !== undefined)        check(`cost = ${e.cost} (no VAT doubling)`, r.cost === e.cost, `got ${r.cost}`);
  if (e.recipientName !== undefined)     check(`recipient = ${e.recipientName}`, r.recipient?.name === e.recipientName, `got ${r.recipient?.name}`);
  if (e.recipientPostcode !== undefined) check(`postcode = ${e.recipientPostcode}`, r.recipient?.postcode === e.recipientPostcode, `got ${r.recipient?.postcode}`);
}

// An unknown email must defer to AI rather than guess.
console.log('\nunknown email');
const unknown = parseShopifyEmail({ subject: 'Big summer sale — 20% off!', text: 'Shop now' });
check('unknown subject → needsAI', unknown.needsAI === true, `needsAI=${unknown.needsAI}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
