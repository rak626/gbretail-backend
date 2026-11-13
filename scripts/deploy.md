# GB Retail — Production Deploy Checklist

## Prerequisites
- Cloudflare account + `npx wrangler login` (hosts the backend)
- Vercel account + `npx vercel login` (hosts the POS frontend)
- Neon Postgres (free tier OK) reachable from the edge — use the pooled/HTTP URL with `USE_NEON=1`
- Optional: custom domains — free `*.workers.dev` / `*.vercel.app` URLs work without one

## Step 1: Configure environment variables

### Backend (.env or wrangler secrets)
```bash
# Required
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
JWT_ACCESS_SECRET=<strong-random-min-32-chars>
JWT_REFRESH_SECRET=<different-strong-random-min-32-chars>

# CORS — include all production frontend origins
CORS_ORIGIN=https://shop1.yourdomain.com,https://shop2.yourdomain.com,https://shop3.yourdomain.com,https://online.yourdomain.com

# Node environment
NODE_ENV=production
```

For Cloudflare Workers:
```bash
wrangler secret put DATABASE_URL
wrangler secret put JWT_ACCESS_SECRET
wrangler secret put JWT_REFRESH_SECRET
wrangler var put CORS_ORIGIN   # comma-separated origins
```

## Step 2: Apply database migrations

```bash
cd gbretail-backend
npx prisma generate
npx prisma migrate deploy
```

This applies all 9 migrations (baseline → online storefront → hardening → batch/expiry → MasterProduct/ShopProduct).

## Step 3: Seed initial data

```bash
npx tsx prisma/seed.ts
```

This creates:
- 3 shops: GB-SHOP-1001 (Main Bazaar), GB-SHOP-1002 (East End), GB-SHOP-1003 (West Side)
- Each shop: 2 counters, 25 products, 2 batches per product (staggered expiry: 5-day + 45-day)
- Users: super@gbretail.local + owner/staff per shop (passwords from SEED_* env vars)

> **Production:** set strong `SEED_SUPER_PASSWORD` / `SEED_OWNER_PASSWORD` /
> `SEED_STAFF_PASSWORD` *before* seeding. The defaults (`super123` / `owner123` /
> `staff123`) must never reach a production database.

## Step 4: Deploy backend

Cloudflare Workers (recommended — edge, never sleeps):
```bash
wrangler deploy
```

Vercel Edge:
```bash
vercel deploy --prod
```

## Step 5: Deploy frontends

### POS (each shop device)
```bash
cd gbretail-pos
# Set NEXT_PUBLIC_API_URL to your backend URL (baked in at build time —
# set it in the Vercel project settings so dashboard builds get it too)
NEXT_PUBLIC_API_URL=https://gbretail-backend.yourdomain.com npm run build
vercel deploy --prod   # or your preferred host
```

Then add the POS origin to the backend CORS allow-list — credentials mode
rejects unknown origins, so the POS will fail every API call otherwise:
```bash
npx wrangler var put CORS_ORIGIN   # e.g. "https://pos.yourdomain.com"
```

### Online storefront (customer-facing)
```bash
cd gbretail-online
NEXT_PUBLIC_API_URL=https://gbretail-backend.yourdomain.com npm run build
vercel deploy --prod   # or your preferred host
```

## Step 6: Verify

- [ ] Backend health: `GET https://api.yourdomain.com/api/health` → `{ status: "ok", db: "ok" }`
- [ ] All 3 shops visible: `GET https://api.yourdomain.com/api/shops` (as SUPER_ADMIN)
- [ ] POS loads at each shop device, can browse catalog
- [ ] Test sale creates order and decrements stock
- [ ] Test offline: disconnect network, create sale, reconnect, verify auto-sync
- [ ] Test batch restock with expiry date
- [ ] Test inter-shop transfer request → approve → receive
- [ ] Receipt printing shows shop GSTIN/UPI/receipt name

## Step 7: Per-shop configuration (via backend API or dashboard)

For each shop, configure via `PATCH /api/shops/:id`:
- `isOnlineEnabled` — enable online ordering
- `pickupEnabled` / `deliveryEnabled` — fulfilment options
- `deliveryFee`, `freeDeliveryAbove`, `minOrderAmount` — online pricing
- `receiptName`, `gstin`, `upiId`, `phone`, `receiptFooter` — receipt identity

## Rollback

If a migration fails:
```bash
npx prisma migrate resolve --rolled-back <migration-name>
npx prisma migrate deploy
```

If seed needs re-run (after truncating):
```bash
npx tsx prisma/seed.ts
```
