// Mock payment processor — stands in for Payroc/Stripe. Every "step" in the
// processing sequence does real work (real DB writes, a real tax
// calculation, a real balanced journal entry) and is recorded as its own
// demo_payment_events row with a real timestamp; the frontend animates
// through these recorded steps rather than faking a timer. IDs are
// obviously-fake ("pi_demo_…", never a real Stripe/Payroc prefix) — see
// docs/financial-prototype.md.
import { randomBytes } from "node:crypto";
import { query, queryOne } from "@/server/db/pool";
import { calculateTax, type TaxDestination } from "./taxService";
import { postJournalEntry } from "./accountingService";
// Same seam real auction buy-now/bid-win settlement already charges through
// (src/server/auctions/service.ts) — this checkout demo reuses it rather
// than fabricating a second, disconnected "payment always succeeds" path.
// DemoPaymentProvider declines a payment whose token is in its sentinel
// set (see provider.ts), which is how processPayment's failure path below
// gets exercised.
import { getPaymentProvider } from "@/server/payments/provider";

export interface OrderItem { name: string; sku: string; quantity: number; unitPrice: number }
export interface CustomerInput { name: string; email: string; country: string; region: string; city: string; postalCode: string }

function round2(n: number): number { return Math.round(n * 100) / 100; }
function demoId(prefix: string): string { return `${prefix}_demo_${randomBytes(4).toString("hex")}`; }

export async function ensureDemoCustomer(externalRef: string, input: CustomerInput) {
  const existing = await queryOne(`select * from demo_customers where external_ref = $1`, [externalRef]);
  if (existing) return existing;
  return queryOne(
    `insert into demo_customers (external_ref, name, email, country, region, city, postal_code)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [externalRef, input.name, input.email, input.country, input.region, input.city, input.postalCode],
  );
}

async function nextOrderNumber(attempt = 0): Promise<string> {
  const year = new Date().getFullYear();
  const row = await queryOne<{ count: string }>(`select count(*) from demo_orders`);
  // Cosmetic offset matches the brief's example order number. `attempt` only
  // kicks in on a collision (see createDemoOrder) — count-then-insert isn't
  // atomic, so two near-simultaneous calls (e.g. React Strict Mode's double
  // effect in dev) can race for the same number.
  const seq = Number(row?.count ?? 0) + 10482 + attempt;
  return `ORD-${year}-${seq}`;
}

export async function createDemoOrder(input: {
  customerId: string;
  currency?: string;
  items: OrderItem[];
  shipping: number;
  destination: TaxDestination;
}) {
  const subtotal = round2(input.items.reduce((s, it) => s + it.unitPrice * it.quantity, 0));
  const taxableAmount = round2(subtotal + input.shipping);
  const tax = calculateTax(input.destination, taxableAmount);

  for (let attempt = 0; attempt < 5; attempt++) {
    const orderNumber = await nextOrderNumber(attempt);
    try {
      return await queryOne(
        `insert into demo_orders (order_number, customer_id, currency, items, subtotal, shipping, taxable_amount, tax_jurisdiction, tax_rate, tax_amount, total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [
          orderNumber, input.customerId, input.currency ?? "USD", JSON.stringify(input.items),
          subtotal, input.shipping, taxableAmount, tax.jurisdiction, tax.taxRate, tax.taxAmount, tax.total,
        ],
      );
    } catch (err) {
      const isUniqueViolation = (err as { code?: string }).code === "23505";
      if (!isUniqueViolation || attempt === 4) throw err;
    }
  }
  throw new Error("failed to allocate a unique order number");
}

interface DemoOrderRow {
  id: string; order_number: string; customer_id: string; currency: string;
  items: OrderItem[]; subtotal: string; shipping: string; taxable_amount: string;
  tax_jurisdiction: string; tax_rate: string; tax_amount: string; total: string; status: string;
}

async function logEvent(paymentId: string, step: string, detail: Record<string, unknown> = {}) {
  await query(`insert into demo_payment_events (payment_id, step, detail) values ($1,$2,$3)`, [paymentId, step, JSON.stringify(detail)]);
}

/** Runs the full mock pipeline synchronously, writing a real event per step. */
export async function processPayment(orderId: string, paymentMethodToken?: string) {
  const order = await queryOne<DemoOrderRow>(`select * from demo_orders where id = $1`, [orderId]);
  if (!order) throw new Error("order not found");
  const customer = await queryOne<{ id: string; name: string; email: string }>(`select * from demo_customers where id = $1`, [order.customer_id]);
  if (!customer) throw new Error("customer not found");

  const paymentRef = demoId("pi");
  const payment = await queryOne<{ id: string }>(
    `insert into demo_payments (payment_ref, order_id, amount, currency, status) values ($1,$2,$3,$4,'processing') returning id`,
    [paymentRef, order.id, order.total, order.currency],
  );
  if (!payment) throw new Error("failed to create payment");

  await logEvent(payment.id, "creating_payment", { paymentRef, amount: order.total });
  await logEvent(payment.id, "validating_customer", { customer: customer.name, email: customer.email });
  await logEvent(payment.id, "calculating_tax", { jurisdiction: order.tax_jurisdiction, rate: Number(order.tax_rate), taxAmount: Number(order.tax_amount) });

  const authorizationRef = demoId("auth");
  await logEvent(payment.id, "authorizing_payment", { authorizationRef });

  const charge = await getPaymentProvider().charge({
    idempotencyKey: payment.id,
    amount: Number(order.total),
    currency: order.currency,
    paymentMethodToken: paymentMethodToken ?? null,
  });

  if (charge.status !== "SUCCEEDED") {
    await logEvent(payment.id, "payment_failed", { reason: charge.reason ?? "Declined by payment provider", providerReference: charge.providerReference });
    await query(
      `update demo_payments set status='failed', processor_response=$2, risk_status='high', updated_at=now() where id=$1`,
      [payment.id, charge.reason ?? "Declined"],
    );
    return getPaymentDetail(payment.id);
  }

  const transactionRef = demoId("txn");
  await logEvent(payment.id, "capturing_payment", { transactionRef, amount: order.total, providerReference: charge.providerReference });
  await logEvent(payment.id, "creating_transaction", { transactionRef });

  const entry = await postJournalEntry({
    reference: order.order_number,
    description: `Customer payment for Order ${order.order_number}`,
    lines: [
      { accountName: "Cash / Payment Processor Receivable", debit: Number(order.total) },
      { accountName: "Product Revenue", credit: Number(order.subtotal) },
      { accountName: "Sales Tax Payable", credit: Number(order.tax_amount) },
      { accountName: "Shipping Revenue", credit: Number(order.shipping) },
    ],
  });
  await logEvent(payment.id, "updating_accounting", { journalEntry: entry.entry_number });

  await query(
    `update demo_payments set status='succeeded', payment_method_brand='Visa', payment_method_last4='4242',
       authorization_ref=$2, transaction_ref=$3, processor_response='Approved', risk_status='low', updated_at=now()
     where id=$1`,
    [payment.id, authorizationRef, transactionRef],
  );
  await query(`update demo_orders set status='paid' where id=$1`, [order.id]);
  await logEvent(payment.id, "payment_successful", { journalEntry: entry.entry_number });

  return getPaymentDetail(payment.id);
}

export async function getPaymentDetail(paymentId: string) {
  const payment = await queryOne(`select * from demo_payments where id = $1`, [paymentId]);
  if (!payment) return null;
  const events = await query(`select * from demo_payment_events where payment_id = $1 order by occurred_at`, [paymentId]);
  const order = await queryOne(`select * from demo_orders where id = $1`, [(payment as { order_id: string }).order_id]);
  const customer = order ? await queryOne(`select * from demo_customers where id = $1`, [(order as { customer_id: string }).customer_id]) : null;
  return { payment, events, order, customer };
}

export async function getFinancialAnalytics() {
  const today = await queryOne<{
    total: string; succeeded: string; failed: string; processing: string;
    volume: string; pending_settlement: string;
  }>(
    `select
       count(*) as total,
       count(*) filter (where status = 'succeeded') as succeeded,
       count(*) filter (where status = 'failed') as failed,
       count(*) filter (where status = 'processing') as processing,
       coalesce(sum(amount) filter (where status = 'succeeded'), 0) as volume,
       coalesce(sum(amount) filter (where status = 'succeeded' and settlement_status = 'pending'), 0) as pending_settlement
     from demo_payments
     where created_at >= current_date`,
  );
  const taxAndRevenue = await queryOne<{ tax_collected: string; revenue: string }>(
    `select
       coalesce(sum(o.tax_amount), 0) as tax_collected,
       coalesce(sum(o.subtotal + o.shipping), 0) as revenue
     from demo_payments p
     join demo_orders o on o.id = p.order_id
     where p.status = 'succeeded' and p.created_at >= current_date`,
  );
  return {
    transactionsToday: Number(today?.total ?? 0),
    successfulPayments: Number(today?.succeeded ?? 0),
    failedPayments: Number(today?.failed ?? 0),
    processingPayments: Number(today?.processing ?? 0),
    processedVolume: round2(Number(today?.volume ?? 0)),
    pendingSettlement: round2(Number(today?.pending_settlement ?? 0)),
    taxCollected: round2(Number(taxAndRevenue?.tax_collected ?? 0)),
    revenue: round2(Number(taxAndRevenue?.revenue ?? 0)),
  };
}

export async function listRecentOrders(limit = 20) {
  return query(
    `select o.*, c.name as customer_name, p.id as payment_id, p.status as payment_status, p.payment_method_brand, p.payment_method_last4, p.created_at as payment_created_at
     from demo_orders o
     join demo_customers c on c.id = o.customer_id
     left join lateral (select * from demo_payments where order_id = o.id order by created_at desc limit 1) p on true
     order by o.created_at desc limit $1`,
    [limit],
  );
}
