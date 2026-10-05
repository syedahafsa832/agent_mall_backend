import { NextRequest, NextResponse } from "next/server";
import { processPayment } from "@/server/financial/paymentService";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const paymentMethodToken = typeof body.paymentMethodToken === "string" ? body.paymentMethodToken : undefined;
  try {
    const result = await processPayment(params.id, paymentMethodToken);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
