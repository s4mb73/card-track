# SiS Hydro Tablets Stock Monitor

A small Python script that polls a Science in Sport product page and sends a
push notification via [ntfy.sh](https://ntfy.sh) when a specific product
variant comes back in stock.

It works by reading the JSON-LD structured data the page embeds in a
`<script type="application/ld+json">` block (the one with `"@type": "Product"`),
finding the offer for the target SKU, and checking its `availability` field.

## Setup

1. **Install dependencies** (a virtual environment is recommended):

   ```bash
   pip install -r requirements.txt
   ```

2. **Set your ntfy topic.** Open `stock_monitor.py` and change the `NTFY_TOPIC`
   constant near the top to a topic name of your choosing (any string — pick
   something unguessable so others can't read it):

   ```python
   NTFY_TOPIC = "my-secret-stock-topic"
   ```

3. **Subscribe to the topic** so you actually receive the alert:
   - Install the ntfy app (iOS / Android), or
   - Open `https://ntfy.sh/<your-topic>` in a browser and leave the tab open.

## Running

```bash
python stock_monitor.py
```

The script checks every 10 minutes and logs each check with a timestamp
(in stock / out of stock / SKU-not-found). The polling interval is deliberately
generous to be polite to the site — it's the `CHECK_INTERVAL_SECONDS` constant
at the top if you really need to change it.

When the variant is in stock it sends the ntfy notification and then exits.

## Configuration

All settings live as constants at the top of `stock_monitor.py`:

| Constant                 | Meaning                                  |
| ------------------------ | ---------------------------------------- |
| `PRODUCT_URL`            | The product page to monitor              |
| `TARGET_SKU`             | The variant SKU you want (`130928`)      |
| `NTFY_TOPIC`             | Your ntfy.sh topic                       |
| `CHECK_INTERVAL_SECONDS` | How often to poll (default: 10 minutes)  |
