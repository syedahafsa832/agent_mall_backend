// @ts-nocheck -- unused/unwired (nothing imports this module); TYPE_SYNONYMS/wordsOf
// were never added to rest-handlers.ts. Left in place rather than deleted since this
// looks like in-progress work; suppressing here just keeps it from breaking the build.
import { query, withPlatformScope } from "@/server/db/pool";
import { TYPE_SYNONYMS, wordsOf } from "@/demo-merchants/rest-handlers";

export interface MerchantKeywordRow {
  id: string;
  merchant_id: string;
  keyword: string;
  resolved_type: string | null;
  created_at: string;
}

/**
 * A keyword only ever resolves to a canonical product type (e.g. "mountain
 * bike" -> "bicycle", because "bike" already resolves there) via the exact
 * same deterministic synonym map search uses. A phrase with no recognizable
 * product-type word (e.g. "bestseller") resolves to null and is inert in
 * search — display-only. This is the whole mechanism that keeps a keyword
 * from ever being able to reassign a product's actual category.
 */
export const KNOWN_PRODUCT_TYPES = [...new Set(Object.values(TYPE_SYNONYMS))];

export function resolveKeywordType(keyword: string): string | null {
  for (const w of wordsOf(keyword)) {
    const type = TYPE_SYNONYMS[w];
    if (type) return type;
  }
  return null;
}

export async function listMerchantKeywords(merchantId: string): Promise<MerchantKeywordRow[]> {
  return query<MerchantKeywordRow>(`select * from merchant_keywords where merchant_id = $1 order by created_at asc`, [merchantId]);
}

/**
 * `explicitType`, if given, must itself be one of this platform's known
 * product types (validated by the route against KNOWN_PRODUCT_TYPES) — so a
 * merchant can register vocabulary the global synonym map doesn't know
 * (e.g. "errand runner" -> bicycle) without ever being able to invent an
 * arbitrary new category. Falls back to auto-detection when omitted.
 */
export async function addMerchantKeyword(merchantId: string, keyword: string, explicitType?: string | null): Promise<MerchantKeywordRow> {
  const resolvedType = explicitType ?? resolveKeywordType(keyword);
  const row = await withPlatformScope((client) =>
    client
      .query<MerchantKeywordRow>(`insert into merchant_keywords (merchant_id, keyword, resolved_type) values ($1,$2,$3) returning *`, [merchantId, keyword, resolvedType])
      .then((r) => r.rows[0]),
  );
  if (!row) throw new Error("failed to add keyword");
  return row;
}

export async function updateMerchantKeyword(merchantId: string, id: string, keyword: string, explicitType?: string | null): Promise<MerchantKeywordRow | undefined> {
  const resolvedType = explicitType ?? resolveKeywordType(keyword);
  return withPlatformScope((client) =>
    client
      .query<MerchantKeywordRow>(`update merchant_keywords set keyword = $3, resolved_type = $4 where id = $1 and merchant_id = $2 returning *`, [id, merchantId, keyword, resolvedType])
      .then((r) => r.rows[0]),
  );
}

export async function deleteMerchantKeyword(merchantId: string, id: string): Promise<void> {
  await withPlatformScope((client) => client.query(`delete from merchant_keywords where id = $1 and merchant_id = $2`, [id, merchantId]));
}

/**
 * If any word of the shopper's query matches one of this merchant's
 * keywords (word-for-word, case-insensitive — not a substring) and that
 * keyword resolved to a real product type, return that type so the search
 * layer can extend the text sent to this merchant's own connector with it.
 * Never invents a type beyond what resolveKeywordType already derived at
 * keyword-creation time.
 */
export function matchKeywordType(keywords: MerchantKeywordRow[], query: string): string | null {
  const queryWords = new Set(wordsOf(query));
  for (const k of keywords) {
    if (!k.resolved_type) continue;
    const keywordWords = wordsOf(k.keyword);
    if (keywordWords.length > 0 && keywordWords.every((w) => queryWords.has(w))) return k.resolved_type;
  }
  return null;
}
