// CardTrack Railway service.
//
// One Node process that does the work two GitHub Actions workflows used
// to do:
//   - POST /ingest      — on-demand Gmail scrape (replaces ingest.yml)
//   - cron */15 min     — carrier poll (replaces checker.yml)
//
// The dashboard never hits this service directly; it calls the
// `trigger-ingest` Supabase Edge Function, which holds the shared token
// server-side and forwards.

import express                from 'express';
import cron                   from 'node-cron';
import { spawn }              from 'node:child_process';
import path                   from 'node:path';
import { fileURLToPath }      from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT         = Number(process.env.PORT || 3000);
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const CHECK_CRON   = process.env.CHECK_CRON || '*/15 * * * *';

if (!INGEST_TOKEN) {
  console.error('INGEST_TOKEN must be set');
  process.exit(1);
}

// Run a child Node script and stream its stdout/stderr to ours so
// Railway's log view shows everything in one place. Resolves on exit 0.
function runScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, script), ...args], {
      env:   process.env,
      stdio: 'inherit',
    });
    child.on('exit',  code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
    child.on('error', reject);
  });
}

// Serialise checker runs: if a 15-min tick lands while the previous one
// is still polling carriers, just skip — no point queueing.
let checkerRunning = false;
function runChecker(trigger) {
  if (checkerRunning) {
    console.log(`[checker] skipped (${trigger}); previous run still in flight`);
    return;
  }
  checkerRunning = true;
  const started = Date.now();
  console.log(`[checker] start (${trigger}) ${new Date().toISOString()}`);
  runScript('checker.js')
    .then(() => console.log(`[checker] done in ${((Date.now() - started) / 1000).toFixed(1)}s`))
    .catch(err => console.error(`[checker] failed: ${err.message}`))
    .finally(() => { checkerRunning = false; });
}

const app = express();
app.use(express.json({ limit: '32kb' }));

function checkAuth(req, res, next) {
  const supplied = req.get('X-Ingest-Token') || '';
  if (supplied !== INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Health probe — Railway calls this for restarts.
app.get('/healthz', (_req, res) => res.json({ ok: true, checkerRunning }));

// Kick off the Gmail ingest. Fire-and-forget: returns 202 immediately,
// the script runs in the background. Progress lands in the
// `email_ingestions` table, which the dashboard already polls.
app.post('/ingest', checkAuth, (req, res) => {
  const { account_id, site_id } = req.body || {};
  if (!account_id || !site_id) {
    return res.status(400).json({ error: 'account_id and site_id are required' });
  }
  runScript('ingest.js', [`--account=${account_id}`, `--site=${site_id}`])
    .then(() => console.log(`[ingest] done ${account_id}/${site_id}`))
    .catch(err => console.error(`[ingest] failed ${account_id}/${site_id}: ${err.message}`));
  res.status(202).json({ ok: true, message: 'ingest started', account_id, site_id });
});

// Manual checker trigger — handy for testing without waiting for cron.
app.post('/check', checkAuth, (_req, res) => {
  runChecker('manual');
  res.status(202).json({ ok: true, message: 'checker started' });
});

cron.schedule(CHECK_CRON, () => runChecker('cron'), { timezone: 'Europe/London' });

app.listen(PORT, () => {
  console.log(`cardtrack server listening on :${PORT} (cron "${CHECK_CRON}")`);
});
