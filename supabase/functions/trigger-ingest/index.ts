// Supabase Edge Function: trigger-ingest
//
// Lets the dashboard kick off the "CardTrack email ingest" GitHub Actions
// workflow on demand. Holds the GitHub token server-side so it never
// reaches the browser.
//
// Secrets (set with `supabase secrets set ...`):
//   GH_TOKEN     — fine-grained PAT with Actions: read+write on this repo
//   GH_OWNER     — repo owner, e.g. "s4mb73"
//   GH_REPO      — repo name,  e.g. "card-track"
//   GH_WORKFLOW  — workflow filename, e.g. "ingest.yml" (defaults to that)
//   GH_REF       — branch to run on, defaults to "main"

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const token    = Deno.env.get('GH_TOKEN');
  const owner    = Deno.env.get('GH_OWNER');
  const repo     = Deno.env.get('GH_REPO');
  const workflow = Deno.env.get('GH_WORKFLOW') ?? 'ingest.yml';
  const ref      = Deno.env.get('GH_REF')      ?? 'main';

  if (!token || !owner || !repo) {
    return json({ error: 'Function is missing one of GH_TOKEN, GH_OWNER, GH_REPO' }, 500);
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:          `Bearer ${token}`,
      Accept:                 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':           'cardtrack-trigger-ingest',
    },
    body: JSON.stringify({ ref }),
  });

  // workflow_dispatch returns 204 No Content on success.
  if (r.status === 204) return json({ ok: true, workflow, ref });

  const detail = await r.text();
  return json({ error: `GitHub responded ${r.status}: ${detail}` }, r.status);
});
