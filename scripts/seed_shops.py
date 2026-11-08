#!/usr/bin/env python3
"""
Seed the 3 grocery shops and enable master products at each shop.

Usage:
    python seed_shops.py [--api http://localhost:4000] [--token <SUPER_ADMIN_TOKEN>]
"""

import argparse
import json
import urllib.request
import urllib.error

def api_request(api_url, token, method, path, body=None):
    """Make an API request."""
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    if body is None:
        headers.pop("Content-Type", None)
    req = urllib.request.Request(
        f"{api_url}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"  ✗ API Error {e.code}: {body}")
        return None

def main():
    parser = argparse.ArgumentParser(description="Seed 3 grocery shops and enable master products")
    parser.add_argument("--api", default="http://localhost:4000", help="Backend API URL")
    parser.add_argument("--token", required=True, help="SUPER_ADMIN bearer token")
    args = parser.parse_args()

    shops = [
        {
            "name": "Main Bazaar Shop",
            "code": "GB-SHOP-1001",
            "address": "Main Road, Central Market",
            "city": "Central",
            "owner_email": "owner1@shop.local",
            "owner_name": "Owner - Main Bazaar",
        },
        {
            "name": "East End Grocery",
            "code": "GB-SHOP-1002",
            "address": "East Street, East End",
            "city": "East",
            "owner_email": "owner2@shop.local",
            "owner_name": "Owner - East End",
        },
        {
            "name": "West Side Mart",
            "code": "GB-SHOP-1003",
            "address": "West Avenue, West Side",
            "city": "West",
            "owner_email": "owner3@shop.local",
            "owner_name": "Owner - West Side",
        },
    ]

    print("Checking existing shops...")
    result = api_request(args.api, args.token, "GET", "/api/shops?limit=100")
    if not result:
        print("  ✗ Failed to fetch shops")
        return

    existing_shops = result["shops"]
    shop_ids = {}
    for shop_data in shops:
        # Look for existing shop by code
        existing = next((s for s in existing_shops if s.get("code") == shop_data["code"]), None)
        if existing:
            shop_ids[shop_data["code"]] = existing["id"]
            print(f"  ✓ Found existing {shop_data['name']} ({shop_data['code']})")
        else:
            # Create new shop
            result = api_request(args.api, args.token, "POST", "/api/shops", shop_data)
            if result:
                shop_ids[shop_data["code"]] = result["shop"]["id"]
                print(f"  ✓ Created {shop_data['name']} ({shop_data['code']})")
            else:
                print(f"  ✗ Failed to create {shop_data['name']}")
                return

    print("\nFetching master products...")
    result = api_request(args.api, args.token, "GET", "/api/master-products?limit=500&page=1")
    if not result:
        print("  ✗ Failed to fetch master products")
        return

    master_products = result["masterProducts"]
    total_products = result["total"]
    print(f"  Found {total_products} master products")

    # Fetch all pages
    all_products = list(master_products)
    page = 1
    while len(all_products) < total_products:
        page += 1
        result = api_request(args.api, args.token, "GET", f"/api/master-products?limit=500&page={page}")
        if result:
            all_products.extend(result["masterProducts"])
        else:
            break

    print(f"  Total master products available: {len(all_products)}")

    print("\nEnabling products at each shop...")
    for shop_data in shops:
        shop_id = shop_ids[shop_data["code"]]
        enabled_count = 0
        failed_count = 0

        for mp in all_products:
            result = api_request(args.api, args.token, "POST", f"/api/shop-products?shopId={shop_id}", {
                "masterProductId": mp["id"],
                "shopPrice": mp["basePrice"],
                "costPrice": round(mp["basePrice"] * 0.78, 2) if mp["basePrice"] else 0,
                "stockQuantity": 100,
                "lowStockThreshold": 10,
                "isOnline": True,
                "onlinePrice": round(mp["basePrice"] * 1.1, 2) if mp["basePrice"] else None,
            })
            if result:
                enabled_count += 1
            else:
                failed_count += 1

        print(f"  ✓ {shop_data['name']}: {enabled_count} products enabled, {failed_count} failed")

    print("\n✓ All 3 shops seeded and products enabled!")
    print("\nShop codes: GB-SHOP-1001, GB-SHOP-1002, GB-SHOP-1003")
    print("Owner emails: owner1@shop.local, owner2@shop.local, owner3@shop.local")

if __name__ == "__main__":
    main()