// Shared fixtures for the Shopify parser: the verbatim quoted-printable
// text/plain bodies of the three real Topps emails (shipment / cancellation
// / order_confirmation), plus a quoted-printable decoder that reproduces
// what mailparser hands us at runtime. The giant "View your order" auth
// links are shortened (irrelevant to parsing); the tracking line, totals,
// address and item text are verbatim.
//
// Used by parse-demo.mjs (eyeballing) and test-parse.mjs (assertions).

export function qpDecode(input, charset = 'utf8') {
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '=') {
      if (input[i + 1] === '\n') { i += 1; continue; }              // soft break
      if (input[i + 1] === '\r' && input[i + 2] === '\n') { i += 2; continue; }
      const hex = input.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; continue; }
      bytes.push(0x3D);
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  const enc = (charset === 'iso-8859-1' || charset === 'latin1') ? 'latin1' : 'utf8';
  return Buffer.from(bytes).toString(enc);
}

export const SAMPLES = [
  {
    name: 'shipment',
    subject: 'A shipment from order UK-1196937-S is on the way',
    charset: 'iso-8859-1',
    raw: `Your order is on the way

Topps UK

Order UK-1196937-S

------------------------
Your order is on the way
------------------------

Your order is on the way. Track your shipment to see
the delivery status.

View your order=20
( https://shop-uk.topps.com/73920151805/orders/1d9bd1c35456f0ef3ab0920d855c=
0a47/authenticate?key=3Dshcct_SHORTENED )


or Visit our store=20
( https://shop-uk.topps.com?syclid=3D301c3696-c450-4d72-878b-ecddb0eb2723 )


Royal Mail tracking number: QG472502524GB=20
( https://www.royalmail.com/portal/rm/track?trackNumber=3DQG472502524GB )


Items in this shipment
----------------------

Topps=AE UEFA Club Competitions Simplicidad 2025-26 =D7 1

Please note, replies to this email address are not
monitored. For Collector Support, please visit
uk.topps.com/support ( https://uk.topps.com/support ).`,
    expect: {
      emailType: 'shipment',
      orderReference: 'UK-1196937-S',
      carrier: 'royal_mail',
      trackingRef: 'QG472502524GB',
      trackingUrl: 'https://www.royalmail.com/portal/rm/track?trackNumber=QG472502524GB',
      item: 'Topps® UEFA Club Competitions Simplicidad 2025-26',
      needsAI: false,
    },
  },
  {
    name: 'cancellation',
    subject: 'Order UK-1208105-S has been canceled',
    charset: 'utf-8',
    raw: `Your order has been canceled

Topps UK

Order UK-1208105-S

----------------------------
Your order has been canceled
----------------------------

Removed Items
-------------

Topps F1=C2=AE Lights Out 2026 =C3=97 1

Refunded

=C2=A370.00

Subtotal

=C2=A370.00

Shipping

=C2=A33.50

Taxes

=C2=A312.25

Total

=C2=A373.50 GBP

Please note, replies to this email address are not
monitored. For Collector Support, please visit
uk.topps.com/support ( https://uk.topps.com/support ).`,
    expect: {
      emailType: 'cancellation',
      orderReference: 'UK-1208105-S',
      item: 'Topps F1® Lights Out 2026',
      needsAI: false,
    },
  },
  {
    name: 'order_confirmation',
    subject: 'Order UK-1212655-S confirmed',
    charset: 'utf-8',
    raw: `Thank you for your purchase!

Topps UK

Order UK-1212655-S

----------------------------
Thank you for your purchase!
----------------------------

We're getting your order ready to be shipped. We will
notify you when it has been sent.

View your order=20
( https://shop-uk.topps.com/73920151805/orders/8c099de339398d243543f4368d13=
de09/authenticate?key=3Dshcct_SHORTENED )


or Visit our store=20
( https://shop-uk.topps.com?syclid=3D063d348d-09b4-4922-aa01-2479ede9d5f2 )


Order summary
-------------

Topps=C2=AE Finest UEFA Club Competitions 2025/26 - Hobby
Box =C3=97 1

=C2=A3230.00

Subtotal

=C2=A3230.00

Shipping

=C2=A30.00

Taxes

=C2=A338.33

Total

=C2=A3230.00 GBP

Customer information
--------------------

Shipping address
----------------

Alex Carter
5 Sample Road
Didsbury
Manchester M1 1AA
United Kingdom

Billing address
---------------

Alex Carter
5 Sample Road
Didsbury
Manchester M1 1AA
United Kingdom

Shipping method
---------------

Free Shipping

Please note, replies to this email address are not
monitored.`,
    expect: {
      emailType: 'order_confirmation',
      orderReference: 'UK-1212655-S',
      item: 'Topps® Finest UEFA Club Competitions 2025/26 - Hobby Box',
      cost: 230,
      recipientName: 'Alex Carter',
      recipientPostcode: 'M1 1AA',
      needsAI: false,
    },
  },
];
