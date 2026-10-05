# backend_agentic_mall

Backend half of the Agent Mall POC, split out of the original `agentic_commerce`
monorepo. Copied as-is (API routes, server logic, demo-merchant data, migrations,
scripts) — nothing rewritten yet.

## Running locally

**Start this backend first, then the frontend** — the frontend's
`NEXT_PUBLIC_API_BASE_URL` and this repo's `ALLOWED_ORIGINS` are pinned to fixed
ports (3000 / 3001). If the backend is started twice, or started after something
else already holds port 3000, Next.js silently falls back to the next free port
and the frontend will call the wrong origin (symptoms: 404s, login failing,
CORS errors).

```bash
npm install
cp .env.example .env     # fill in DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, etc.
npm run dev               # always http://localhost:3000 (port is pinned, no auto-fallback)
```

Then, in the frontend repo: `npm run dev` → http://localhost:3001.

Visiting `http://localhost:3000` shows a status page listing every API route
currently registered (method + path), generated from the actual `src/app/api`
tree — so a 404 at the root is no longer ambiguous with "backend is down."

## What's here
- `src/app/api/**` — Next.js route handlers (the actual backend endpoints)
- `src/server/**` — auth, auctions, payments, tax, offers, policy, connectors, etc.
- `src/demo-merchants/**` — catalog + REST handler fixtures the demo endpoints use
- `src/lib/types.ts` — shared request/response types (duplicated from frontend repo)
- `migrations/`, `scripts/` — DB schema + seed/migrate scripts

## Gap this split leaves — status

This is still a single Next.js app — the "backend" is just the `app/api` route
tree, not a separate server. Resolved so far:
- `src/app/layout.tsx` + `src/app/page.tsx` exist (the latter is the route-index
  status page described above), so `next build`/`next dev` no longer fail for
  lacking an app root.
- CORS is handled in `src/middleware.ts` via `ALLOWED_ORIGINS`.
- The frontend calls this backend via `NEXT_PUBLIC_API_BASE_URL`, not relative
  `/api/...` paths, so the two can live on different origins/ports.

Still open: this is a Next.js app serving an API, not a standalone API server.
Porting the route handlers to Express/Fastify remains an option if that's ever
needed, but nothing here currently requires it.

## Env vars to set in this repo (see `.env.example`)
- `DATABASE_URL` — Postgres connection string
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — auth only, not data access
- `MODEL_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — agent model provider
- `APP_BASE_URL` — this backend's own base URL
- `MERCHANT_B_MCP_COMMAND`, `MERCHANT_B_MCP_ARGS` — Merchant B MCP child process
- `CONNECT_ALLOW_LOCAL`, `CONNECT_SECRET` — `/connect` endpoint
- `MISTRAL_API_KEY`, `MISTRAL_MODEL` — optional alt model provider
- `ALLOWED_ORIGINS` — **new**, needed for CORS once frontend is a separate origin
