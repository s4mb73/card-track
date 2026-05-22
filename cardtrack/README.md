# CardTrack — Hourly Order Checker

Polls Royal Mail, Evri, and DPD for tracking updates and fires Twilio SMS/WhatsApp notifications automatically when a status changes.

---

## Quick start

### 1. Install

```bash
cd cardtrack
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in your credentials:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_FROM_NUMBER=+447700000000
NOTIFY_CHANNELS=sms
```

Get your Twilio credentials at https://console.twilio.com

### 3. Add your orders

Edit `orders.json` — each order needs:

| Field | Example | Notes |
|---|---|---|
| `item` | `"Charizard Holo"` | Display name |
| `recipient.name` | `"Jamie Wilson"` | First + last |
| `recipient.phone` | `"+447700900123"` | E.164 format |
| `tracking.ref` | `"RM12345678GB"` | Carrier reference |
| `tracking.carrier` | `"royal_mail"` | See carriers below |
| `status` | `"pending"` | Starting status |

**Supported carriers:** `royal_mail` · `evri` · `dpd` · `yodel` · `parcelforce`

### 4. Run it

```bash
node checker.js
# or
npm start
```

---

## Automate with cron

Run every hour, log to file:

```bash
# Open crontab
crontab -e

# Add this line (update the path)
0 * * * * cd /home/you/cardtrack && node checker.js >> logs/checker.log 2>&1
```

Watch the log live:
```bash
npm run logs
# or
tail -f logs/checker.log
```

---

## Free cloud hosting options

Don't want to leave your computer on? Run the checker for free:

### Option A — cron-job.org (easiest)
1. Deploy the script to a free host (Railway, Render, Fly.io)
2. Create a free cron job at https://cron-job.org pointing to your deployed URL
3. No server management needed

### Option B — Railway
```bash
# Install Railway CLI
npm i -g @railway/cli

# Deploy
railway login
railway init
railway up
```
Then set your environment variables in the Railway dashboard and add a cron schedule.

### Option C — GitHub Actions (free, reliable)
Create `.github/workflows/checker.yml`:

```yaml
name: CardTrack hourly check
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: node checker.js
        env:
          TWILIO_ACCOUNT_SID: ${{ secrets.TWILIO_ACCOUNT_SID }}
          TWILIO_AUTH_TOKEN: ${{ secrets.TWILIO_AUTH_TOKEN }}
          TWILIO_FROM_NUMBER: ${{ secrets.TWILIO_FROM_NUMBER }}
          NOTIFY_CHANNELS: sms
```

Add your Twilio credentials as GitHub repository secrets. Commits `orders.json` back automatically.

---

## Status values

| Value | Meaning |
|---|---|
| `pending` | No tracking activity yet |
| `in_transit` | Parcel is moving through the network |
| `out_for_delivery` | With the driver today |
| `delivered` | Confirmed delivered |
| `failed` | Delivery attempted, nobody home |
| `unknown` | Couldn't read the tracking page |

## Notification triggers

Notifications fire when status changes **to**:

| New status | Notifies? |
|---|---|
| `in_transit` | ✓ Once |
| `out_for_delivery` | ✓ Once |
| `delivered` | ✓ Once |
| `failed` | ✓ Once |

Orders marked `delivered` or `failed` are skipped on future checks.

---

## File structure

```
cardtrack/
├── checker.js      ← main script (run this)
├── carriers.js     ← Royal Mail / Evri / DPD scrapers
├── notify.js       ← Twilio SMS + WhatsApp sender
├── orders.json     ← your orders (read + written by checker)
├── .env            ← credentials (never commit this)
├── .env.example    ← template
├── package.json
└── logs/
    └── checker.log ← run history
```
