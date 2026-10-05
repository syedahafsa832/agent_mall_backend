// Website-owner keyword management ("similar to Google Keywords", per the
// trade-secret brief) — owners add/edit/remove keywords to help agents
// locate relevant products at their store. matchMerchantKeyword() is the
// seam src/server/agent/product-search.ts calls so a keyword genuinely
// affects discovery (surfacing/ranking), not just display on the dashboard.
import { query, withPlatformScope } from "@/server/db/pool";

export interface MerchantKeywordRow {
  id: string;
  merchant_id: string;
  keyword: string;
  resolved_type: string | null;
  created_at: string;
}

const STOPWORDS = new Set(["a", "an", "the", "for", "with", "and", "or", "of", "to", "me", "find", "show", "get", "want", "need", "under", "over"]);

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export async function listMerchantKeywords(merchantId: string): Promise<MerchantKeywordRow[]> {
  return query<MerchantKeywordRow>(`select * from merchant_keywords where merchant_id = $1 order by created_at asc`, [merchantId]);
}

export async function addMerchantKeyword(merchantId: string, keyword: string, explicitType?: string | null): Promise<MerchantKeywordRow> {
  const row = await withPlatformScope((client) =>
    client
      .query<MerchantKeywordRow>(`insert into merchant_keywords (merchant_id, keyword, resolved_type) values ($1,$2,$3) returning *`, [merchantId, keyword, explicitType ?? null]),
  ).then((r) => r.rows[0]);
  if (!row) throw new Error("failed to add keyword");
  return row;
}

export async function updateMerchantKeyword(merchantId: string, id: string, keyword: string, explicitType?: string | null): Promise<MerchantKeywordRow | undefined> {
  return withPlatformScope((client) =>
    client
      .query<MerchantKeywordRow>(`update merchant_keywords set keyword = $3, resolved_type = $4 where id = $1 and merchant_id = $2 returning *`, [id, merchantId, keyword, explicitType ?? null]),
  ).then((r) => r.rows[0]);
}

export async function deleteMerchantKeyword(merchantId: string, id: string): Promise<void> {
  await withPlatformScope((client) => client.query(`delete from merchant_keywords where id = $1 and merchant_id = $2`, [id, merchantId]));
}

/**
 * True if every word of at least one of this merchant's keywords appears in
 * the shopper's query (word-for-word, case-insensitive — not a substring).
 * This is the entire mechanism: it can never invent a product or change what
 * a connector actually returns, only mark an already-returned offer as
 * keyword-relevant and let the search layer rank it accordingly.
 */
export function matchMerchantKeyword(keywords: MerchantKeywordRow[], query: string): string | null {
  const queryWords = new Set(wordsOf(query));
  for (const k of keywords) {
    const keywordWords = wordsOf(k.keyword);
    if (keywordWords.length > 0 && keywordWords.every((w) => queryWords.has(w))) return k.keyword;
  }
  return null;
}
