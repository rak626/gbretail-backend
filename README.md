# gbretail-backend — Hono (Edge, Lightweight)

Standalone backend extracted from `gbretail-pos`. Deploy edge-first, keep running without VM babysitting.

## Stack
- **Runtime:** Hono 4.x — runs on Cloudflare Workers, Vercel Edge, Node (via `@hono/node-server`)
- **DB:** Prisma 7 + Neon HTTP (`@prisma/adapter-neon`) for edge, `pg` + `@prisma/adapter-pg` for local Node
- **DB URL modes:**
  - Local Node: `postgresql://postgres:postgres@localhost:5432/gbretail`
  - Edge Neon: Neon pooled URL + `USE_NEON=1`
  - Accelerate: `prisma://...` (auto-detected)

## Env

```bash
cp .env.example .env
# Edit DATABASE_URL, CORS_ORIGIN
```

## Dev

```bash
npm install
npm run db:generate
npm run db:migrate   # local Node only
npm run db:seed
npm run db:backfill  # legacy NULL shopId -> shop_default
npm run typecheck    # src + prisma + scripts
npm run build        # tsc -p tsconfig.build.json -> dist/
npm start            # node dist/index.js (run build first)
npm run dev          # Node :4000 via @hono/node-server
npm run dev:edge     # Wrangler :8787 (edge isolate, src/worker.ts)
```

## Deploy

### Cloudflare Workers (recommended — lightweight, never sleeps)
```bash
wrangler secret put DATABASE_URL   # Neon URL
wrangler deploy
```

### Vercel Edge
Set `DATABASE_URL=prisma://...` (Accelerate) and `USE_NEON=0`, then `vercel deploy`.

## API

All routes under `/api`:

- `GET  /api/health` — DB check (sanitized 503)
- `GET  /api/stats`
- `GET  /api/auth/login|refresh|logout|me|verify` — cookies + Bearer, refresh via cookie or body.refreshToken
- `GET  /api/shops` + `POST /api/shops` (SUPER_ADMIN; code auto-assigned `GB-SHOP-1001…`, immutable) + `GET/PATCH/DELETE /api/shops/:id` (+ `POST /:id/restore`; only SUPER_ADMIN can toggle `isActive`)
- `GET  /api/counters` + `POST` + `GET/PATCH/DELETE /:id` (+ `POST /:id/restore`)
- `GET  /api/users` + `POST` + `GET/PATCH/DELETE /:id` (+ `POST /:id/restore`, `POST /:id/revoke-sessions`)
- `GET  /api/analytics/*` — sales, profit, staff, stock
- `GET  /api/products?search&category&limit&page&stock&sortBy&sortOrder` + `POST /api/products` + `GET/PATCH/DELETE /api/products/:id` (+ `POST /:id/restore`; barcode unique per shop)
- `GET  /api/customers?q&limit` + `POST /api/customers` + `GET/PATCH /api/customers/:id`
- `GET  /api/orders?page&limit&customerId&paymentMethod&search&date` + `POST /api/orders` + `GET /api/orders/:id` + `GET /api/orders/next-number` (preview only)
- `GET  /api/ledger?filter&q&customerId&page&limit&due` + `GET /api/ledger/due-today?q&includeOverdue` + `POST /api/ledger` + `GET/PATCH/DELETE /api/ledger/:id`

SUPER_ADMIN shop scoping: `x-shop-id` header (merged in requireAuth) or `?shopId=` query.

Frontend: set `NEXT_PUBLIC_API_URL=http://localhost:4000` (dev) or `https://gbretail-backend.<workers>.dev` (prod).
