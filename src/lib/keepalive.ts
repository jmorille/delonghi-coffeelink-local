/**
 * Keep-alive LAN mode : re-poste `local_reg` périodiquement tant qu'une commande est en file.
 * Prouvé nécessaire par capture : la machine effectue UN cycle complet
 * (key_exchange → GET commands.json → applique) à CHAQUE local_reg reçu ; sans relance
 * périodique, une commande mise en file après coup n'est jamais tirée.
 *
 * Le SDK Ayla fait pareil (`startKeepalive`, intervalle keepAlive/3 ≈ 10 s).
 */
import { store } from "./session";
import { postLocalReg } from "./machine";

// Cadence rapide validée en test réel : la machine exige une présence soutenue
// pendant le boot. 2,5 s reproduit le comportement de l'app officielle.
const INTERVAL_MS = 2500;
const IDLE_STOP_MS = 15000; // arrêt 15 s après la fin du programme

const g = globalThis as unknown as { __dlKeepalive?: NodeJS.Timeout };

export function ensureKeepalive() {
  if (g.__dlKeepalive) return;
  store.addLog("sys", "keep-alive démarré (re-register toutes les 2,5 s)");
  g.__dlKeepalive = setInterval(async () => {
    const active = store.program?.active === true;
    const idleFor = Date.now() - (store.program?.startedAt ?? 0) - (store.program?.durationMs ?? 0);
    if (!active && idleFor > IDLE_STOP_MS) {
      clearInterval(g.__dlKeepalive!);
      g.__dlKeepalive = undefined;
      store.addLog("sys", "keep-alive arrêté");
      return;
    }
    try {
      await postLocalReg();
    } catch (e: any) {
      store.addLog("sys", `keep-alive local_reg échec: ${e?.message ?? e}`);
    }
  }, INTERVAL_MS);
}
