# GB Retail — Production Deploy Checklist

## Production topology (current)

```
browser ──► https://gbretail-pos-web.vercel.app        (Vercel, one project)
             ├── /            Next.js POS UI
             └── /api/*       Hono API mounted in the same deployment
                              → Neon Postgres (HTTP driver, USE_NEON=1)
```

The API is a **package inside the POS project** (`@gbretail/backend`), so there is
exactly one origin, one Vercel login, and no cross-site cookie problem. The
Cloudflare Worker (`gbretail-backend.<sub>.workers.dev`) stays deployed as the
**free fallback**: set `API_PROXY_TARGET` on the POS project and the existing
rewrite forwards `/api/*` to it.

## Prerequisites
- Vercel account + `npx vercel login` (hosts the POS **and** the API)
- Cloudflare account + `npx wrangler login` (optional — only for the Worker fallback)
- Neon Postgres (free tier OK) — use the pooled/HTTP URL with `USE_NEON=1`
- Optional: custom domains — free `*.vercel.app` URLs work without one

> **Vercel gotcha:** the POS project's **framework preset must be `nextjs`**.
> A project created with `vercel project create` leaves it empty, and Vercel then
> builds it as a *static* site (it serves the repo's `public/` folder and never
> creates the serverless function) — every URL answers `NOT_FOUND`.
> Check: `vercel project inspect <name>` → "Framework Preset: Next.js".


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

This applies all 8 migrations (baseline → online storefront → hardening → batch/expiry → MasterProduct/ShopProduct).

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

## Step 4: Publish the API package (when the API changes)

The POS project consumes the backend as a release tarball, so every backend
change needs a new release:

```bash
cd gbretail-backend
npm run build
npm pack                       # honours .npmignore -> ships dist/ + prisma/
gh release create v1.0.1 gbretail-backend-1.0.1.tgz \
  --repo rak626/gbretail-backend --title "v1.0.1" --notes "API package"
```

Then point the POS at the new tarball:
```bash
cd gbretail-pos
npm i https://github.com/rak626/gbretail-backend/releases/download/v1.0.1/gbretail-backend-1.0.1.tgz
```

## Step 5: Deploy the POS (UI + API)

```bash
cd gbretail-pos
npx vercel link --yes --project gbretail-pos-web
npx vercel deploy --prod --yes
```

Production environment variables on the Vercel project:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon pooled URL (`?schema=public`) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | strong random secrets (32+ chars) |
| `USE_NEON` | `1` (HTTP driver — no TCP in a serverless function) |
| `NODE_ENV` | `production` |
| `CORS_ORIGIN` | the POS origin (only matters for the Worker fallback) |
| `NEXT_PUBLIC_API_URL` | **unset** — the API is same-origin, so client calls use relative `/api/*` URLs |
| `API_PROXY_TARGET` | **unset** — set it only to fall back to the Worker |

### Worker fallback (optional, free)

The Worker keeps the same API on Cloudflare's edge (~50 ms cold start):
```bash
cd gbretail-backend
npx wrangler deploy
```
To use it, set `API_PROXY_TARGET=https://gbretail-backend.<sub>.workers.dev`
on the Vercel project and redeploy — the rewrite forwards `/api/*` there.
Note the Worker and the Vercel deployment use **separate JWT secrets**, so a
fallback switch invalidates in-flight sessions (staff log in again).

### Online storefront (customer-facing)
```bash
cd gbretail-online
NEXT_PUBLIC_API_URL=https://gbretail-backend.yourdomain.com npm run build
vercel deploy --prod   # or your preferred host
```

## Step 6: Verify

- [ ] POS origin health: `GET https://gbretail-pos-web.vercel.app/api/health` → `{ status: "ok", db: "connected" }`
- [ ] Login sets **two** `Set-Cookie` headers (`accessToken` + `refreshToken`) — one means refresh is broken
- [ ] `POST /api/auth/refresh` with the cookie jar → 200
- [ ] All 3 shops visible: `GET /api/shops` (as SUPER_ADMIN)
- [ ] POS loads at each shop device, can browse catalog
- [ ] Test sale creates order and decrements stock
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
