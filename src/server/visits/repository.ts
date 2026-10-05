import { withPlatformScope } from "@/server/db/pool";

export interface VisitPackageRow {
  id: string;
  merchant_id: string;
  visit_limit: number;
  visits_used: number;
  status: "active" | "exhausted" | "expired" | "cancelled";
  starts_at: string;
  ends_at: string | null;
  created_at: string;
}

export interface UniqueVisitRow {
  id: string;
  package_id: string;
  merchant_id: string;
  visitor_subject_id: string;
  session_id: string | null;
  approval_id: string | null;
  first_visit_at: string;
}

// No visit-package *purchase* API exists yet (out of scope for this pass —
// merchants don't yet have a way to buy one through the platform). A
// merchant's very first package is still bootstrapped lazily on its first
// visit so the mechanics work out of the box; createVisitPackage() below is
// the seam a future "buy a package" endpoint calls to add a new one and
// restore availability — see recordMerchantVisit for why a merchant with an
// *existing but exhausted* package does NOT get a fresh one auto-created.
const DEFAULT_VISIT_LIMIT = 1_000_000;

export async function createVisitPackage(merchantId: string, visitLimit: number = DEFAULT_VISIT_LIMIT): Promise<VisitPackageRow> {
  const row = await withPlatformScope((client) =>
    client.query<VisitPackageRow>(`insert into visit_packages (merchant_id, visit_limit) values ($1, $2) returning *`, [merchantId, visitLimit]).then((r) => r.rows[0]),
  );
  if (!row) throw new Error("failed to create visit package");
  return row;
}

export async function getLatestVisitPackage(merchantId: string): Promise<VisitPackageRow | undefined> {
  return withPlatformScope(async (client) => {
    const res = await client.query<VisitPackageRow>(
      `select * from visit_packages where merchant_id = $1 order by created_at desc limit 1`,
      [merchantId],
    );
    return res.rows[0];
  });
}

export interface RecordVisitResult {
  visit: UniqueVisitRow;
  isNewUniqueVisit: boolean;
  visitPackage: VisitPackageRow;
}

export interface VisitRejected {
  rejected: true;
  reason: string;
}

/**
 * The one place a merchant visit is ever recorded. A visitor who already
 * has a row under the merchant's *current* (latest) package always
 * succeeds idempotently — that's what "repeat visits don't consume another
 * unique visit" means, and it holds even if that package has since become
 * exhausted by other visitors. A visitor with no existing row is a "new
 * qualifying visitor": if the current package is active with room, they
 * consume a slot; if it's exhausted (or there's no active package at all
 * beyond the first lazy bootstrap), they are REJECTED — the platform does
 * NOT silently mint a replacement package to work around exhaustion. A new
 * package (createVisitPackage) is what restores availability, and once one
 * exists, it becomes "current" and every visitor — including ones already
 * counted under the old package — can count again under it.
 *
 * Locks the merchant's latest visit_packages row for the duration of the
 * transaction, so two concurrent visit attempts for the same merchant are
 * serialized — the exhaustion check and the increment can never race.
 */
export async function recordMerchantVisit(input: {
  merchantId: string;
  visitorSubjectId: string;
  sessionId?: string | null;
  approvalId?: string | null;
}): Promise<RecordVisitResult | VisitRejected> {
  return withPlatformScope(async (client) => {
    const latestRes = await client.query<VisitPackageRow>(
      `select * from visit_packages where merchant_id = $1 order by created_at desc limit 1 for update`,
      [input.merchantId],
    );
    let pkg = latestRes.rows[0];
    if (!pkg) {
      const created = await client.query<VisitPackageRow>(
        `insert into visit_packages (merchant_id, visit_limit) values ($1, $2) returning *`,
        [input.merchantId, DEFAULT_VISIT_LIMIT],
      );
      pkg = created.rows[0]!;
    }

    const existing = await client.query<UniqueVisitRow>(
      `select * from unique_visits where package_id = $1 and merchant_id = $2 and visitor_subject_id = $3`,
      [pkg.id, input.merchantId, input.visitorSubjectId],
    );
    if (existing.rows[0]) {
      return { visit: existing.rows[0], isNewUniqueVisit: false, visitPackage: pkg };
    }

    if (pkg.status !== "active" || pkg.visits_used >= pkg.visit_limit) {
      return { rejected: true, reason: "This merchant's visit package is exhausted. A new package is required before new visitors can be recorded." };
    }

    const inserted = await client.query<UniqueVisitRow>(
      `insert into unique_visits (package_id, merchant_id, visitor_subject_id, session_id, approval_id)
       values ($1,$2,$3,$4,$5)
       on conflict (package_id, merchant_id, visitor_subject_id) do nothing
       returning *`,
      [pkg.id, input.merchantId, input.visitorSubjectId, input.sessionId ?? null, input.approvalId ?? null],
    );
    if (!inserted.rows[0]) throw new Error("expected a new unique visit row (pre-check found none, but insert reported a conflict)");

    const updated = await client.query<VisitPackageRow>(
      `update visit_packages
       set visits_used = visits_used + 1,
           status = case when visits_used + 1 >= visit_limit then 'exhausted' else status end
       where id = $1
       returning *`,
      [pkg.id],
    );
    if (!updated.rows[0]) throw new Error("visit package disappeared mid-transaction");
    return { visit: inserted.rows[0], isNewUniqueVisit: true, visitPackage: updated.rows[0] };
  });
}
