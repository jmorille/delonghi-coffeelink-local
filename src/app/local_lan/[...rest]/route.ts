/**
 * Catch-all diagnostique : journalise tout chemin /local_lan/* non couvert par un
 * handler explicite (les handlers .json explicites ont priorité sur ce segment dynamique).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/session";

async function handle(req: NextRequest, ctx: { params: Promise<{ rest: string[] }> }) {
  const { rest } = await ctx.params;
  const path = "/local_lan/" + (rest?.join("/") ?? "");
  let bodyLen = 0;
  try {
    bodyLen = (await req.text()).length;
  } catch {}
  store.addLog("in", `⟡ ${req.method} ${path} (body ${bodyLen}o) — chemin non géré`);
  return new NextResponse(JSON.stringify({}), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET = handle;
export const POST = handle;
