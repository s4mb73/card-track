#!/usr/bin/env python3
"""Monitor stock availability of a single product variant on a Magento site.

The product page embeds JSON-LD structured data in a
<script type="application/ld+json"> block with "@type": "Product". That block
holds an "offers" array (one entry per variant), each with "sku", "price", and
"availability". We poll the page, find the offer matching our target SKU, and
notify via ntfy.sh when it comes back in stock.
"""

import json
import time
from datetime import datetime

import requests
from bs4 import BeautifulSoup

# --- Configuration -----------------------------------------------------------

PRODUCT_URL = (
    "https://www.scienceinsport.com/shop-sis/go-range/"
    "go-hydro-tablets/sis-hydro-tablets-pack"
)

# The specific variant we care about.
TARGET_SKU = "130928"

# ntfy.sh topic to publish to. Set this to your own topic name (any string),
# then subscribe to it in the ntfy app or at https://ntfy.sh/<topic>.
NTFY_TOPIC = "sis-hydro-stock-CHANGE-ME"

# Poll every 10 minutes. Stock checks don't need to be aggressive, and a
# generous interval keeps us polite to the site (avoids hammering their server
# and looking like a bot / getting rate-limited).
CHECK_INTERVAL_SECONDS = 10 * 60

# Browser-like User-Agent so the request isn't rejected as an obvious bot.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}

REQUEST_TIMEOUT_SECONDS = 30


def log(message):
    """Print a message prefixed with a timestamp."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def find_product_jsonld(soup):
    """Return the parsed JSON-LD object whose "@type" is "Product".

    There may be several JSON-LD blocks on the page (e.g. BreadcrumbList,
    Organization); we only trust the Product one. A block may also contain a
    list or use "@graph", so we check those shapes too.
    """
    for script in soup.find_all("script", type="application/ld+json"):
        if not script.string:
            continue
        try:
            data = json.loads(script.string)
        except json.JSONDecodeError:
            # Skip malformed blocks rather than letting one bad block abort
            # the whole check.
            continue

        # Normalise into a flat list of candidate objects.
        candidates = []
        if isinstance(data, list):
            candidates.extend(data)
        elif isinstance(data, dict):
            if isinstance(data.get("@graph"), list):
                candidates.extend(data["@graph"])
            else:
                candidates.append(data)

        for obj in candidates:
            if isinstance(obj, dict) and obj.get("@type") == "Product":
                return obj

    return None


def find_offer_for_sku(product, sku):
    """Return the offer dict matching the given SKU, or None."""
    offers = product.get("offers", [])
    # "offers" may be a single object rather than a list.
    if isinstance(offers, dict):
        offers = [offers]
    for offer in offers:
        if isinstance(offer, dict) and str(offer.get("sku")) == str(sku):
            return offer
    return None


def is_in_stock(offer):
    """Return True if the offer's availability indicates in stock.

    Availability is a schema.org URL like "https://schema.org/InStock" or
    "https://schema.org/OutOfStock". We match on the suffix with .endswith()
    rather than comparing the full URL, because the scheme/host can vary
    (http vs https, with or without trailing slash) while the meaningful part
    is always the final "InStock"/"OutOfStock" token.
    """
    availability = str(offer.get("availability", ""))
    return availability.endswith("InStock")


def send_notification(message):
    """Send a push notification via ntfy.sh."""
    requests.post(
        f"https://ntfy.sh/{NTFY_TOPIC}",
        data=message.encode("utf-8"),
        timeout=REQUEST_TIMEOUT_SECONDS,
    )


def check_stock():
    """Fetch the page and return True if the target SKU is in stock.

    Returns True on confirmed in-stock, False otherwise (out of stock,
    SKU not found, or any error). Errors are logged but never raised, so the
    polling loop keeps running.
    """
    try:
        response = requests.get(
            PRODUCT_URL, headers=HEADERS, timeout=REQUEST_TIMEOUT_SECONDS
        )
        # Raise on 4xx/5xx so an HTTP error isn't silently treated as
        # "out of stock".
        response.raise_for_status()
    except requests.RequestException as exc:
        log(f"ERROR fetching page: {exc}")
        return False

    soup = BeautifulSoup(response.text, "html.parser")
    product = find_product_jsonld(soup)
    if product is None:
        log("ERROR: no Product JSON-LD block found on page")
        return False

    offer = find_offer_for_sku(product, TARGET_SKU)
    if offer is None:
        log(f"SKU-not-found: {TARGET_SKU} not present in offers")
        return False

    if is_in_stock(offer):
        price = offer.get("price", "?")
        log(f"IN STOCK: SKU {TARGET_SKU} (price {price})")
        return True

    log(f"out of stock: SKU {TARGET_SKU}")
    return False


def main():
    log(f"Starting stock monitor for SKU {TARGET_SKU}")
    log(f"Checking every {CHECK_INTERVAL_SECONDS // 60} minutes")

    while True:
        in_stock = check_stock()
        if in_stock:
            message = (
                f"SiS Hydro tablets (SKU {TARGET_SKU}) are IN STOCK!\n"
                f"{PRODUCT_URL}"
            )
            try:
                send_notification(message)
                log("Notification sent via ntfy.sh")
            except requests.RequestException as exc:
                log(f"ERROR sending notification: {exc}")
            log("Stopping monitor.")
            break

        time.sleep(CHECK_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
