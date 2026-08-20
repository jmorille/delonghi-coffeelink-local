/**
 * POST /local_lan/property/datapoint.json — la machine nous pousse une mise à jour
 * de propriété (typiquement d302_monitor). Corps chiffré {"enc","sign"} (clés "dev").
 * data = {"name","value","metadata"}. On décode le monitor si c'est lui.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/session";
import { props } from "@/lib/config";
import { decodeMonitor } from "@/lib/ecam";

export async function POST(req: NextRequest) {
  const session = store.session;
  if (!session) return new NextResponse("no session", { status: 412 });

  const raw = await req.text();
  let msg: any;
  try {
    msg = JSON.parse(raw);
    const { data } = session.decapsulate(msg);
    const name: string = data?.name;
    const value = data?.value;
    store.addLog("in", `datapoint reçu: ${name}`);

    if (name === props.monitor && typeof value === "string") {
      const m = decodeMonitor(value);
      store.lastMonitor = {
        at: Date.now(),
        stateByte: m.stateByte,
        switchBits: m.switchBits,
        alarms: m.alarms,
        raw: m.raw,
      };
      store.addLog(
        "in",
        `monitor: état=0x${m.stateByte.toString(16).padStart(2, "0")} capteurs=0x${m.switchBits.toString(16)}`,
      );
    } else if (name === "data_response" && typeof value === "string") {
      // Accusé/réponse de la machine à nos commandes (trame ECAM 0xD0…).
      const hex = Buffer.from(value, "base64").toString("hex").replace(/(..)/g, "$1 ").trim();
      store.lastDataResponse = { at: Date.now(), hex };
      store.addLog("in", `data_response: ${hex}`);
    }
  } catch (e: any) {
    store.addLog("in", `échec déchiffrement datapoint: ${e?.message ?? e}`);
    return NextResponse.json({ error: "decrypt failed" }, { status: 400 });
  }

  // Réponse attendue : un message encapsulé (accusé applicatif), Content-Length explicite.
  const respBody = session.encapsulate("{}");
  return new NextResponse(respBody, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(respBody)),
      Connection: "close",
    },
  });
}
