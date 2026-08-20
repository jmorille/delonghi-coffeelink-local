/**
 * GET /local_lan/commands.json — la machine vient chercher les commandes.
 * On renvoie encapsulate("{}") si rien, sinon encapsulate(<payload de la 1re commande>).
 * La commande reste en file jusqu'à l'ACK (si needsAck) ou est retirée sinon.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { store } from "@/lib/session";
import { nextProgramData } from "@/lib/program";

export async function GET() {
  const session = store.session;
  if (!session) {
    store.addLog("in", "GET commands.json sans session — key_exchange manquant");
    return new NextResponse("no session", { status: 412 });
  }

  // Un programme actif (wake / dispense) reproduit la séquence de l'app.
  const { data, label } = nextProgramData();
  if (label !== "idle" && label !== "done") {
    store.addLog("out", `commande servie: ${label}`);
  }
  const body = session.encapsulate(data);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      Connection: "close",
    },
  });
}
