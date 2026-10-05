import { callCapability, searchAcrossMerchants, type CapabilityCallContext } from "@/server/capabilities/router";
import { matchOffer, parseRequirements, type Requirements } from "@/server/offers/matcher";
import type { Offer } from "@/server/offers/types";
import { recordInsight } from "@/server/insight/service";
import { recordShoppingEvent } from "@/server/shopping-events/log";
import { listMerchantKeywords, matchMerchantKeyword } from "@/server/merchants/keywords";

export interface NormalizedOfferResult {
  offer: Offer;
  verdict: "selected" | "rejected";
  reasons: string[];
}

export interface MerchantSearchOutcome {
  merchantId: string;
  merchantName: string;
  offers: NormalizedOfferResult[];
  blocked?: string;
  error?: string;
}

export interface ProductSearchResult {
  requirements: Requirements;
  merchants: MerchantSearchOutcome[];
  offers: NormalizedOfferResult[]; // flattened, convenience for the frontend
}

/**
 * The one normalized search path for both the LLM chat agent and the direct
 * `/api/agent/search` endpoint: fan out to every connected, authorized
 * merchant, score each offer deterministically against the shopper's stated
 * requirements, and record both the merchant-insight row (existing System 1
 * analytics) and a `shopping_events` row (new Agent Mall analytics feed).
 */
export async function runProductSearch(
  input: { query: string; filters?: Requirements },
  ctx: CapabilityCallContext,
): Promise<ProductSearchResult> {
  const requirements = { ...parseRequirements(input.query), ...input.filters };
  const results = await searchAcrossMerchants({ query: input.query, filters: input.filters }, ctx);

  await recordShoppingEvent({
    sessionId: ctx.sessionId,
    eventType: "SEARCH",
    payload: { query: input.query, filters: input.filters ?? {}, merchantCount: results.length },
  });

  const merchants: MerchantSearchOutcome[] = [];
  const offers: NormalizedOfferResult[] = [];
  let keywordMatchedMerchantId: string | null = null;

  for (const r of results) {
    if (r.blocked || r.error) {
      merchants.push({ merchantId: r.merchant.id, merchantName: r.merchant.name, offers: [], blocked: r.blocked, error: r.error });
      continue;
    }
    // Keyword relevance is an additional signal, never a gate: every
    // authorized merchant is still searched and matched on its real catalog
    // exactly as before. A merchant whose keyword matches the query just
    // gets a visible "matched your keyword" reason and is ranked first —
    // it can never surface a product that wasn't already a real offer.
    const keywords = await listMerchantKeywords(r.merchant.id);
    const matchedKeyword = matchMerchantKeyword(keywords, input.query);
    if (matchedKeyword) keywordMatchedMerchantId = r.merchant.id;

    const merchantOffers: NormalizedOfferResult[] = [];
    for (const offer of r.offers) {
      const verdict = matchOffer(offer, requirements);
      const reasons = matchedKeyword && verdict.decision === "selected" ? [...verdict.reasons, `Matches this store's keyword "${matchedKeyword}"`] : verdict.reasons;
      const entry: NormalizedOfferResult = { offer, verdict: verdict.decision, reasons };
      merchantOffers.push(entry);
      offers.push(entry);
      await recordInsight({ sessionId: ctx.sessionId, merchantId: offer.merchantId, requirements: requirements as Record<string, unknown>, decision: verdict.decision, reasons });
      await recordShoppingEvent({
        sessionId: ctx.sessionId,
        merchantId: offer.merchantId,
        eventType: verdict.decision === "selected" ? "PRODUCT_MATCHED" : "PRODUCT_EXCLUDED",
        payload: { productId: offer.productId, reasons },
      });
    }
    merchants.push({ merchantId: r.merchant.id, merchantName: r.merchant.name, offers: merchantOffers });
  }

  if (keywordMatchedMerchantId) {
    merchants.sort((a, b) => (a.merchantId === keywordMatchedMerchantId ? -1 : b.merchantId === keywordMatchedMerchantId ? 1 : 0));
    offers.sort((a, b) => (a.offer.merchantId === keywordMatchedMerchantId ? -1 : b.offer.merchantId === keywordMatchedMerchantId ? 1 : 0));
  }

  return { requirements, merchants, offers };
}

export async function runGetProduct(merchantId: string, productId: string, ctx: CapabilityCallContext): Promise<Offer> {
  const call = await callCapability("get_product", merchantId, { productId }, ctx);
  if (!call.ok) throw new Error(call.reason);
  await recordShoppingEvent({ sessionId: ctx.sessionId, merchantId, eventType: "PRODUCT_VIEWED", payload: { productId } });
  return call.result as Offer;
}

export interface CompareRef {
  merchantId: string;
  productId: string;
}

export interface CompareEntry {
  merchantId: string;
  productId: string;
  offer?: Offer;
  error?: string;
}

/**
 * Builds a side-by-side from live per-merchant data. A ref that fails (denied
 * by policy, connector error, unknown product) is reported with its error
 * rather than silently dropped or backfilled with invented values.
 */
export async function runCompareProducts(refs: CompareRef[], ctx: CapabilityCallContext): Promise<CompareEntry[]> {
  const entries = await Promise.all(
    refs.map(async (ref): Promise<CompareEntry> => {
      const call = await callCapability("get_product", ref.merchantId, { productId: ref.productId }, ctx);
      if (!call.ok) return { merchantId: ref.merchantId, productId: ref.productId, error: call.reason };
      return { merchantId: ref.merchantId, productId: ref.productId, offer: call.result as Offer };
    }),
  );

  for (const entry of entries) {
    await recordShoppingEvent({
      sessionId: ctx.sessionId,
      merchantId: entry.merchantId,
      eventType: "PRODUCT_COMPARED",
      payload: { productId: entry.productId, ok: !entry.error },
    });
  }

  return entries;
}
