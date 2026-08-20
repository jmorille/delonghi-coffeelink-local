/**
 * POST /api/command — démarre un "programme" reproduisant la séquence de l'app
 * (device_connected → trame ECAM → présence soutenue), avec keep-alive rapide.
 * body:
 *   { "action": "on" | "off" }
 *   { "action": "dispense", "recipeId": "espresso" }
 *   { "action": "dispense", "beverageId": 1, "profileId": 1, "params": [...] }
 *   { "action": "stop", "beverageId": 1, "profileId": 1 }
 *   { "action": "clear" }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/session";
import { postLocalReg } from "@/lib/machine";
import { ensureKeepalive } from "@/lib/keepalive";
import { startProgram } from "@/lib/program";
import {
  frameTurnOn,
  frameTurnOff,
  frameDispense,
  toDatapointValue,
  MODE,
  ACTION,
  BEVERAGES,
} from "@/lib/ecam";
import { listRecipes } from "@/lib/recipes";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = body.action as string;

  if (action === "clear") {
    store.program = null;
    store.queue = [];
    store.addLog("sys", "programme annulé");
    return NextResponse.json({ cleared: true });
  }

  let frame: Buffer | null = null;
  let label = "";
  let duration = 75000;

  try {
    switch (action) {
      case "on":
        frame = frameTurnOn();
        label = "Allumer";
        break;
      case "off":
        frame = frameTurnOff();
        label = "Éteindre";
        duration = 20000;
        break;
      case "stop": {
        const bevId = Number(body.beverageId ?? 1);
        const prof = Number(body.profileId ?? 1);
        frame = frameDispense(bevId, prof, MODE.STOPV2, ACTION.PREPARE_BEVERAGE, []);
        label = `Arrêt ${BEVERAGES[bevId] ?? bevId}`;
        duration = 20000;
        break;
      }
      case "dispense": {
        let bevId: number, prof: number, params: { id: number; value: number }[];
        if (body.recipeId) {
          const r = (await listRecipes()).find((x) => x.id === body.recipeId);
          if (!r) return NextResponse.json({ error: "recette inconnue" }, { status: 404 });
          ({ beverageId: bevId, profileId: prof, params } = r);
        } else {
          bevId = Number(body.beverageId ?? 1);
          prof = Number(body.profileId ?? 1);
          params = body.params ?? [];
        }
        frame = frameDispense(bevId, prof, MODE.START, ACTION.PREPARE_BEVERAGE, params);
        label = `Préparer ${BEVERAGES[bevId] ?? bevId}`;
        break;
      }
      default:
        return NextResponse.json({ error: "action inconnue" }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }

  const ecamB64 = toDatapointValue(frame);
  startProgram(ecamB64, label, duration);
  ensureKeepalive();

  let reg: any = null;
  try {
    reg = await postLocalReg();
  } catch (e: any) {
    store.addLog("sys", `local_reg échoué: ${e?.message ?? e}`);
  }

  return NextResponse.json({
    program: label,
    frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(),
    datapoint: ecamB64,
    register: reg,
  });
}
