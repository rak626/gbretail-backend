#!/usr/bin/env python3
"""
Import sample_products.csv into GB Retail master catalog via API.

Usage:
    python import_inventory.py [--csv sample_products.csv] [--api http://localhost:4000] [--token <SUPER_ADMIN_TOKEN>]

The CSV is sent in batches of 500 rows (API limit).
"""

import csv
import json
import sys
import argparse
import urllib.request
import urllib.error

BATCH_SIZE = 500

def read_csv(csv_file):
    """Read CSV and return list of product dicts."""
    products = []
    with open(csv_file, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            products.append({
                "name": row["name"],
                "category": row["category"],
                "brand": row["brand"] or None,
                "barcode": row["barcode"] or None,
                "is_loose": row["is_loose"].lower() == "true",
                "unit": row["unit"] or "pcs",
                "basePrice": float(row["base_price"]) if row["base_price"] else None,
                "imageUrl": row["image_url"] or None,
            })
    return products

def send_batch(api_url, token, batch):
    """Send one batch of products to the API."""
    data = json.dumps({"items": batch}).encode("utf-8")
    req = urllib.request.Request(
        f"{api_url}/api/master-products/batch",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"  ✗ Batch failed: {e.code} {body}")
        return None

def main():
    parser = argparse.ArgumentParser(description="Import sample_products.csv into GB Retail master catalog")
    parser.add_argument("--csv", default="sample_products.csv", help="Input CSV file (default: sample_products.csv)")
    parser.add_argument("--api", default="http://localhost:4000", help="Backend API URL (default: http://localhost:4000)")
    parser.add_argument("--token", required=True, help="SUPER_ADMIN bearer token")
    args = parser.parse_args()

    products = read_csv(args.csv)
    print(f"Read {len(products)} products from {args.csv}")

    total_imported = 0
    total_failed = 0

    for i in range(0, len(products), BATCH_SIZE):
        batch = products[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(products) + BATCH_SIZE - 1) // BATCH_SIZE

        print(f"  Sending batch {batch_num}/{total_batches} ({len(batch)} products)...")

        result = send_batch(args.api, args.token, batch)
        if result:
            imported = result.get("count", 0)
            total_imported += imported
            print(f"    ✓ Imported {imported} products")
        else:
            total_failed += len(batch)
            print(f"    ✗ Failed to import batch")

    print(f"\n✓ Import complete: {total_imported} imported, {total_failed} failed")

if __name__ == "__main__":
    main()