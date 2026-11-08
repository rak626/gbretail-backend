#!/usr/bin/env python3
"""Verify inventory import and shop seeding."""
import urllib.request
import json

API_URL = "http://localhost:4000"

def get_token():
    import urllib.request
    import json
    data = json.dumps({"email": "super@gbretail.local", "password": "super123"}).encode("utf-8")
    req = urllib.request.Request(
        f"{API_URL}/api/auth/login",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8")).get("accessToken", "")

def api_get(path, token):
    req = urllib.request.Request(
        f"{API_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    token = get_token()
    
    # Get shops
    shops = api_get("/api/shops?limit=100", token)["shops"]
    print(f"Shops: {len(shops)}")
    for s in shops:
        print(f"  {s['name']} ({s['code']}) - active: {s['isActive']}")
    
    # Get master products count
    mp = api_get("/api/master-products?limit=1", token)
    print(f"\nMaster products: {mp['total']}")
    
    # Get shop products per shop
    for s in shops:
        sp = api_get(f"/api/shop-products?shopId={s['id']}&limit=1", token)
        print(f"  {s['name']}: {sp['total']} products enabled")

if __name__ == "__main__":
    main()