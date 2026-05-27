// Supabase Edge Function: send-sms
//
// Sends queued shipping-status notifications via Twilio SMS using an
// alphanumeric sender ID ("CardTrack"). The dashboard calls this with
// `{ inventory_ids: [...] }`; the function looks each inventory item
// up, fetches the recipient phone, builds a message based on the
// current acquisition_status, hits Twilio, and stamps `last_notified`
// on success so the row leaves the queue.
//
// Secrets (set with `supabase secrets set ...`):
//   TWILIO_ACCOUNT_SID  — Twilio "ACxxxxxxxx..."
//   TWILIO_AUTH_TOKEN   — Twilio auth token
//   TWILIO_SENDER_ID    — Registered alphanumeric sender, e.g. "CardTrack"
//
// Uses the service-role key to write `last_notified` back, since the
// row owner (anon) can already mutate inventory but it keeps the
// function self-contained.

import { serve }        from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

// Keep the wording close to what the user can later edit in code.
// Placeholders: {name}, {item}, {tracking}.
const TEMPLATES: Record<string, string> = {
  in_transit:       'Hi {name}, your {item} is on its way. {tracking}',
  out_for_delivery: 'Hi {name}, your {item} is out for delivery today. {tracking}',
  delivered:        'Hi {name}, your {item} has been delivered. Enjoy!',
  failed:           'Hi {name}, there was a delivery problem with your {item}. Will look into it.',
};

function trackingUrl(carrier: string | null, ref: string | null): string {
  if (!ref) return '';
  switch ((carrier || '').toLowerCase()) {
    case 'royal_mail':  return `https://www.royalmail.com/track-your-item#/tracking-results/${ref}`;
    case 'evri':        return `https://www.evri.com/track/parcel/${ref}`;
    case 'dpd':         return `https://track.dpd.co.uk/parcels/${ref}`;
    case 'yodel':       return `https://www.yodel.co.uk/tracking/${ref}`;
    case 'parcelforce': return `https://www.parcelforce.com/track-trace?trackNumber=${ref}`;
    default:            return '';
  }
}

function buildMessage(item: any, address: any): string {
  const tpl = TEMPLATES[item.acquisition_status];
  if (!tpl) throw new Error(`No template for status "${item.acquisition_status}"`);
  const url = trackingUrl(item.carrier, item.tracking_ref);
  return tpl
    .replace('{name}',    (address.full_name || 'there').split(' ')[0])
    .replace('{item}',    item.item || 'order')
    .replace('{tracking}', url ? `Track: ${url}` : '')
    .replace(/\s+$/, '');
}

// UK mobile → E.164. Accepts "07700 900123", "+447700900123", "447700900123".
function normalisePhone(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('44')) return `+${digits}`;
  if (digits.startsWith('0'))  return `+44${digits.slice(1)}`;
  return `+${digits}`;
}

async function sendOne(twilio: { sid: string; token: string; from: string }, to: string, body: string) {
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Messages.json`;
  const form = new URLSearchParams({ From: twilio.from, To: to, Body: body });
  const auth = btoa(`${twilio.sid}:${twilio.token}`);
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    form.toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.message || `Twilio responded ${r.status}`);
  return data; // contains sid, status etc.
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const sid   = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from  = Deno.env.get('TWILIO_SENDER_ID');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!sid || !token || !from) return json({ error: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SENDER_ID must be set' }, 500);
  if (!supabaseUrl || !supabaseKey) return json({ error: 'Function missing Supabase env vars' }, 500);

  let body: { inventory_ids?: string[] } = {};
  try { body = await req.json(); } catch { /* empty OK */ }
  const ids = Array.isArray(body.inventory_ids) ? body.inventory_ids.filter(Boolean) : [];
  if (!ids.length) return json({ error: 'inventory_ids must be a non-empty array' }, 400);

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  const { data: items, error: itemErr } = await supabase
    .from('inventory')
    .select('id, item, acquisition_status, last_notified, carrier, tracking_ref, recipient_address_id')
    .in('id', ids);
  if (itemErr) return json({ error: `Loading inventory: ${itemErr.message}` }, 500);

  const addrIds = [...new Set((items || []).map(i => i.recipient_address_id).filter(Boolean))];
  const { data: addrs, error: addrErr } = await supabase
    .from('addresses')
    .select('id, full_name, phone, preferred_channel')
    .in('id', addrIds.length ? addrIds : ['__none__']);
  if (addrErr) return json({ error: `Loading addresses: ${addrErr.message}` }, 500);
  const addrMap = new Map((addrs || []).map(a => [a.id, a]));

  const results: Array<{ id: string; ok: boolean; error?: string; twilio_sid?: string }> = [];

  for (const item of items || []) {
    try {
      if (item.last_notified === item.acquisition_status) throw new Error('Already notified for this status');
      const addr = addrMap.get(item.recipient_address_id);
      if (!addr) throw new Error('Item has no recipient');
      const phone = normalisePhone(addr.phone);
      if (!phone) throw new Error(`Recipient ${addr.full_name} has no phone number`);
      const text = buildMessage(item, addr);
      const tw   = await sendOne({ sid, token, from }, phone, text);
      const { error: updErr } = await supabase
        .from('inventory')
        .update({ last_notified: item.acquisition_status })
        .eq('id', item.id);
      if (updErr) throw new Error(`Sent but failed to update inventory: ${updErr.message}`);
      results.push({ id: item.id, ok: true, twilio_sid: tw.sid });
    } catch (err) {
      results.push({ id: item.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary = {
    sent:    results.filter(r => r.ok).length,
    failed:  results.filter(r => !r.ok).length,
    results,
  };
  return json(summary);
});
