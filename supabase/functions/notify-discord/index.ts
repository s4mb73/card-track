// Supabase Edge Function: notify-discord
//
// Posts a Discord embed for each queued inventory row whose status
// has crossed a notification trigger (in_transit, out_for_delivery,
// delivered, failed). The dashboard calls this with
// `{ inventory_ids: [...] }`; the function looks each row up,
// formats one embed per row, fires them at every active webhook
// configured in the `webhooks` table, and stamps
// `inventory.last_notified` on success so the row drops out of the
// queue.
//
// Webhook URLs live in the DB (Settings → Webhooks). The function
// uses the service-role key, which bypasses the column-level
// REVOKE that keeps anon from reading them.

import { serve }        from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

// Decimal colours so Discord's embed sidebar matches the status pill colour.
const STATUS_COLOR: Record<string, number> = {
  in_transit:       0x3b82f6, // blue
  out_for_delivery: 0xf59e0b, // amber
  delivered:        0x10b981, // green
  picked_up:        0x8b5cf6, // purple
  failed:           0xef4444, // red
  cancelled:        0x6b7280, // slate
};
const STATUS_LABEL: Record<string, string> = {
  in_transit:       'In transit',
  out_for_delivery: 'Out for delivery',
  delivered:        'Delivered',
  picked_up:        'Picked up',
  failed:           'Delivery failed',
  cancelled:        'Cancelled',
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

function shortAddress(a: any): string {
  return [a?.town_city, a?.postcode].map(s => String(s || '').trim()).filter(Boolean).join(' · ');
}

function buildEmbed(item: any, address: any) {
  const status = item.acquisition_status;
  const url    = trackingUrl(item.carrier, item.tracking_ref);
  const where  = shortAddress(address);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Recipient', value: address?.full_name || '—', inline: true },
    { name: 'Item',      value: item.item || '—',          inline: true },
  ];
  if (item.order_reference) fields.push({ name: 'Order ref', value: String(item.order_reference), inline: true });
  if (where)                fields.push({ name: 'Going to',  value: where,                         inline: true });
  if (url)                  fields.push({ name: 'Tracking',  value: `[${item.carrier || 'Track'}](${url})` });
  else if (item.tracking_ref) fields.push({ name: 'Tracking ref', value: String(item.tracking_ref), inline: true });

  return {
    title:       STATUS_LABEL[status] || status,
    description: `Status changed to **${STATUS_LABEL[status] || status}**.`,
    color:       STATUS_COLOR[status] ?? 0x6366f1,
    fields,
    timestamp:   new Date().toISOString(),
  };
}

async function postToDiscord(webhookUrl: string, embed: object) {
  const r = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Discord responded ${r.status}: ${detail || '(no body)'}`);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey) return json({ error: 'Function missing Supabase env vars' }, 500);

  let body: { inventory_ids?: string[] } = {};
  try { body = await req.json(); } catch { /* empty OK */ }
  const ids = Array.isArray(body.inventory_ids) ? body.inventory_ids.filter(Boolean) : [];
  if (!ids.length) return json({ error: 'inventory_ids must be a non-empty array' }, 400);

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // Pull every active webhook. Service role bypasses the column-level
  // REVOKE on `url` that hides the value from anon SELECTs.
  const { data: hooks, error: hookErr } = await supabase
    .from('webhooks')
    .select('id, label, url, active')
    .eq('active', true);
  if (hookErr)        return json({ error: `Loading webhooks: ${hookErr.message}` }, 500);
  const targets = (hooks || []).filter(h => h.url);
  if (!targets.length) return json({ error: 'No active webhooks configured in Settings' }, 400);

  const { data: items, error: itemErr } = await supabase
    .from('inventory')
    .select('id, item, order_reference, acquisition_status, last_notified, carrier, tracking_ref, recipient_address_id')
    .in('id', ids);
  if (itemErr) return json({ error: `Loading inventory: ${itemErr.message}` }, 500);

  const addrIds = [...new Set((items || []).map(i => i.recipient_address_id).filter(Boolean))];
  const { data: addrs, error: addrErr } = await supabase
    .from('addresses')
    .select('id, full_name, town_city, postcode')
    .in('id', addrIds.length ? addrIds : ['__none__']);
  if (addrErr) return json({ error: `Loading addresses: ${addrErr.message}` }, 500);
  const addrMap = new Map((addrs || []).map(a => [a.id, a]));

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const item of items || []) {
    try {
      if (item.last_notified === item.acquisition_status) throw new Error('Already notified for this status');
      const addr  = addrMap.get(item.recipient_address_id);
      const embed = buildEmbed(item, addr);
      // Post to every active webhook. If any one fails we fail the row,
      // so a misconfigured hook doesn't silently swallow updates.
      for (const hook of targets) await postToDiscord(hook.url, embed);
      const { error: updErr } = await supabase
        .from('inventory')
        .update({ last_notified: item.acquisition_status })
        .eq('id', item.id);
      if (updErr) throw new Error(`Sent but failed to update inventory: ${updErr.message}`);
      results.push({ id: item.id, ok: true });
    } catch (err) {
      results.push({ id: item.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return json({
    sent:    results.filter(r => r.ok).length,
    failed:  results.filter(r => !r.ok).length,
    results,
  });
});
