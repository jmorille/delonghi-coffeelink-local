/** POST /api/register — s'annoncer auprès de la machine (local_reg.json). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { postLocalReg } from "@/lib/machine";

export async function POST() {
  try {
    const r = await postLocalReg();
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}
