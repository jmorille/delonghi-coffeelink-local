/**
 * POST /local_lan/property/datapoint/ack.json — accusé de la machine après application
 * d'une commande data_request. Corps chiffré ; data contient {id, ack_status, ...}.
 * On retire la commande correspondante de la file.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/session";

export async function POST(req: NextRequest) {
  const session = store.session;
  if (!session) return new NextResponse("no session", { status: 412 });

  const raw = await req.text();
  try {
    const { data } = session.decapsulate(JSON.parse(raw));
    const id: string = data?.id;
    const status = data?.ack_status;
    store.addLog("in", `ACK datapoint id=${id} status=${status}`);
    if (id) store.dequeue(id);
  } catch (e: any) {
    store.addLog("in", `échec déchiffrement ACK: ${e?.message ?? e}`);
    return NextResponse.json({ error: "decrypt failed" }, { status: 400 });
  }

  return new NextResponse(session.encapsulate("{}"), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
