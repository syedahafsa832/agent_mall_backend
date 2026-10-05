# APIs needed from Hafsa

Gaps found while building the merchant/account UI on `muhammad/merchant-ui`.
Items 1–3 below were originally flagged as missing and have since been built
(by me, in a later pass of this same branch) — kept here as a record of what
was missing and what now fills it, not as an open request anymore.

---

## 1. Saved auctions — RESOLVED

`saved_auctions` had a table (migrations/002) but no API route. Built:
`GET/POST /api/profile/saved-auctions`, `DELETE /api/profile/saved-auctions/:id`
(`src/server/profile/repository.ts`: `listSavedAuctions`/`saveAuction`/`unsaveAuction`,
mirroring the `saved_websites` pattern exactly). Wired into `/app/profile` and
a save/unsave button on `/app/auctions/:id`.

---

## 2. Per-merchant product count — RESOLVED

`GET /api/merchants/:id/products` now exists and the dashboard calls it
generically instead of special-casing the three demo-store slugs.

---

## 3. Per-merchant policies — RESOLVED

`merchant_policies` (migrations/002) now has `src/server/merchants/policies.ts`
(`getMerchantPolicies`/`upsertMerchantPolicies`) and
`GET/PATCH /api/merchants/:id/policies`, surfaced via `PoliciesCard` on the
merchant dashboard (owner can view and edit shipping/returns/warranty/notes).

---

## 4. Website auto-detection for `/merchant/connect`

Not a blocker — a lightweight preview endpoint
(`GET /api/merchants/detect?url=`, `src/app/api/merchants/detect/route.ts`)
fetches the given URL and reads `<title>`/meta description via cheerio to
prefill the connect form. It does **not** verify ownership (that's still
exclusively `src/server/merchants/verification.ts`, untouched) and isn't a
connector — purely a form-prefill convenience. Flagging in case you'd rather
this live in your `connect` module instead, or want it to guess
`connectorType`/`category` more intelligently.

---

## 5. Mock financial engine (checkout/tax/accounting demo)

New, separate from the real auction settlement path (which already uses
`src/server/payments/provider.ts` / `src/server/tax/provider.ts` — this
reuses `getPaymentProvider().charge()` for the actual success/decline
decision rather than inventing a second one). `src/server/financial/*`
(`taxService`, `paymentService`, `accountingService`, `invoiceService`,
`refundService`) powers a standalone demo at `/merchant/billing`: a
jurisdiction-aware tax calculator, a real balanced double-entry ledger, and
invoice/refund generation, seeded against migrations/004. Intentionally a
richer showcase layer on top of your simpler flat-rate auction pricing, not
a replacement for it.
