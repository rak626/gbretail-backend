# GB Retail — Dev Login Credentials (DEV ONLY)

> ⚠️ Local development seeds only. Never use these passwords in staging/production.
> They are also hardcoded in `prisma/seed.ts` and reseeded on every `db:seed`.
> Do not copy this file to any deployed environment.

Seed command:

```bash
npm run db:seed
# or: npx prisma db seed
```

Frontend: `http://localhost:3000/login`
Backend: `http://localhost:4000`

Show demo creds hint on `/login` (dev only):

```bash
# gbretail-pos/.env.local
NEXT_PUBLIC_SHOW_DEMO_CREDS=1
```

## Users (passwords are plain text for local dev)

| Role | Name | Email | Password | Shop | Counter |
|------|------|-------|----------|------|---------|
| SUPER_ADMIN | Super Admin | `super@gbretail.local` | `super123` | — (all shops via `x-shop-id`) | — |
| SHOP_OWNER | Shop Owner | `owner@shop.local` | `owner123` | Main Shop (`GB-SHOP-1001` / `shop_default`) | picks via header |
| STAFF | Staff 1 | `staff1@shop.local` | `staff123` | Main Shop | auto-attached (assigned or emptiest) |
| STAFF | Staff 2 | `staff2@shop.local` | `staff123` | Main Shop | auto-attached (assigned or emptiest) |

Notes:
- STAFF counter is resolved server-side at login (`resolveStaffCounter`) — client `counterId` is ignored.
- OWNER/SUPER may pass explicit `counterId` at login.
- Password change / deactivate / `POST /api/users/:id/revoke-sessions` kills **all** sessions (`tokenVersion++` + `Session.revokedAt`).
- `POST /api/auth/logout` kills **this device only** (`jti` revoked).
- Refresh rotation is single-use — replaying an old refresh returns `401 REUSE_DETECTED` and revokes all sessions.

## Default shop / counters (from seed)

- Shop: Main Shop — `id: shop_default`, `code: GB-SHOP-1001`, `address: Main Bazaar`
- Counters: `Counter 1` (`counter_1`), `Counter 2` (`counter_2`)
- Receipt defaults (only set when `NULL`, never clobbered on reseed): `receiptName: GB Retail`, `gstin: 07ABCDE1234F1Z5`, `upiId: store@upi`

## Quick login (curl)

```bash
# owner
curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@shop.local","password":"owner123"}'

# staff
curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"staff1@shop.local","password":"staff123"}'

# super admin (add x-shop-id header for shop-scoped calls)
curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"super@gbretail.local","password":"super123"}'
```
