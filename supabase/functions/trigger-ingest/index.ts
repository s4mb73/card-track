// Supabase Edge Function: trigger-ingest
//
// Thin proxy from the dashboard to the Railway-hosted scraper service.
// Holds the shared INGEST_TOKEN server-side so it never reaches the
// browser — the dashboard only knows that POSTing here, with an
// account_id + site_id in the body, will kick off a scrape.
//
// Secrets (set with `supabase secrets set ...`):
//   INGEST_URL    — full Railway URL, e.g. https://cardtrack-production.up.railway.app
//   INGEST_TOKEN  — shared bearer the Railway service expects in X-Ingest-Token

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

  let body: { account_id?: string; site_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }
  const { account_id, site_id } = body;
  if (!account_id || !site_id) return json({ error: 'Missing account_id or site_id in request body' }, 400);

  const r = await fetch(`${baseUrl}/ingest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
    body:    JSON.stringify({ account_id, site_id }),
  });
  const detail = await r.text();
  if (!r.ok) return json({ error: `Railway responded ${r.status}: ${detail}` }, r.status);

  try { return json(JSON.parse(detail)); }
  catch { return json({ ok: true, message: detail || 'started' }); }
});
