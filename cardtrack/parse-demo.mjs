// Demo: run parseShopifyEmail() against the real text/plain bodies of the
// three Topps emails and print what comes out. Eyeball tool — for pass/fail
// assertions see test-parse.mjs. Fixtures live in _shopify-fixtures.mjs.

import { parseShopifyEmail } from './parseShopifyEmail.js';
import { qpDecode, SAMPLES } from './_shopify-fixtures.mjs';

for (const sample of SAMPLES) {
  const text = qpDecode(sample.raw, sample.charset);
  const result = parseShopifyEmail({ subject: sample.subject, text });
  console.log('\n' + '='.repeat(72));
  console.log('SUBJECT:', sample.subject);
  console.log('-'.repeat(72));
  console.log(JSON.stringify(result, null, 2));
}
console.log('');
