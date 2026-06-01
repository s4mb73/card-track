// Supabase Edge Function: trigger-check
//
// Mirror of trigger-ingest, but pointed at Railway's /check endpoint
// (the carrier-poll trigger). Lets the dashboard kick the 15-min cron
// on demand instead of waiting for the next tick. Holds the shared
// INGEST_TOKEN server-side so the browser never sees it.
//
// Secrets (already set for trigger-ingest, no new ones needed):
//   INGEST_URL    — Railway service base URL
//   INGEST_TOKEN  — shared bearer the Railway service expects

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const baseUrl = (Deno.env.get('INGEST_URL') || '').replace(/\/+$/, '');
  const token   = Deno.env.get('INGEST_TOKEN');
  if (!baseUrl || !token) return json({ error: 'INGEST_URL and INGEST_TOKEN must be set' }, 500);

  const r = await fetch(`${baseUrl}/check`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
  });
  const detail = await r.text();
  if (!r.ok) return json({ error: `Railway responded ${r.status}: ${detail}` }, r.status);

  try { return json(JSON.parse(detail)); }
  catch { return json({ ok: true, message: detail || 'started' }); }
});
