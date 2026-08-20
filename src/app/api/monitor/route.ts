/** GET /api/monitor — dernier état monitor décodé (raccourci de /api/status). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { store } from "@/lib/session";

export async function GET() {
  return NextResponse.json({ lastMonitor: store.lastMonitor });
}
