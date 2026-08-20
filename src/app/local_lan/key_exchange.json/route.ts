/**
 * POST /local_lan/key_exchange.json  — la machine initie l'échange de clés.
 * Corps: {"key_exchange":{ver,proto,key_id,random_1,time_1}}
 * Réponse (JSON clair): {"random_2":"...","time_2":<grand entier>}
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { AylaSession } from "@/lib/crypto";
import { config, lanKeyAscii } from "@/lib/config";
import { store } from "@/lib/session";

export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  let kx: any;
  try {
    kx = JSON.parse(bodyText).key_exchange;
  } catch {
    return new NextResponse("Could not read POST body", { status: 400 });
  }
  if (!kx) return new NextResponse("Missing key_exchange", { status: 400 });

  if (kx.proto !== 1 || kx.ver !== 1) {
    store.addLog("in", `key_exchange proto/ver non supporté: ${kx.ver}/${kx.proto}`);
    return NextResponse.json({ error: "Unsupported crypto version" }, { status: 426 });
  }
  if (Number(kx.key_id) !== config.lanKeyId) {
    store.addLog(
      "in",
      `key_exchange key_id ${kx.key_id} ≠ ${config.lanKeyId} — clé LAN périmée ?`,
    );
    return NextResponse.json({ error: "Keys do not match" }, { status: 412 });
  }

  // time_1 EXACT : extrait du texte brut (JSON.parse perdrait la précision si > 2^53).
  const m = bodyText.match(/"time_1"\s*:\s*"?(-?\d+)"?/);
  const time1Raw = m ? m[1] : String(kx.time_1);
  const jsonParsed = String(kx.time_1);
  store.addLog(
    "in",
    `key_exchange reçu: random_1=${kx.random_1} time_1(brut)=${time1Raw} time_1(json)=${jsonParsed} ${time1Raw !== jsonParsed ? "⚠️ PRÉCISION PERDUE" : "ok"}`,
  );
  // On force le time_1 exact dans l'objet passé à la dérivation.
  kx.time_1 = time1Raw;

  // time_2 : entier NUMÉRIQUE (le SDK le sérialise en long, pas en chaîne).
  // On reste sous 2^53 pour un JSON number exact côté JS, et on dérive sur la même chaîne.
  const time2Num = Date.now();
  const time2 = String(time2Num);
  const session = new AylaSession(lanKeyAscii(), kx, time2);
  store.session = session;
  store.sessionStartedAt = Date.now();
  store.addLog(
    "in",
    `key_exchange OK (key_id=${kx.key_id}) → session établie, ${store.queue.length} commande(s) en file`,
  );

  // time_2 renvoyé comme NOMBRE JSON. Content-Length EXPLICITE : le client HTTP
  // de l'ESP32 ne gère pas le chunked (Transfer-Encoding) de Next par défaut.
  const respBody = JSON.stringify({ random_2: session.random2, time_2: time2Num });
  return new NextResponse(respBody, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(respBody)),
      Connection: "close",
    },
  });
}
