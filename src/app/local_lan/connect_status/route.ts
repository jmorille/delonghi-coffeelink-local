/**
 * /local_lan/connect_status — sondage de vivacité par la machine.
 * On répond simplement 200 et on note le contact.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { store } from "@/lib/session";

function ok() {
  store.addLog("in", "connect_status ping");
  return new NextResponse(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET() {
  return ok();
}
export async function POST() {
  return ok();
}
