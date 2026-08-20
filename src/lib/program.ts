/**
 * ⚠️ **Ce fichier ne tourne pas.** `server.mjs` sert lui-même `/local_lan/*` et `/api/*` en
 * HTTP brut, dans tous les modes : ces routes et ces modules sont shadowés et ne sont gardés
 * que comme référence. En cas de divergence, `server.mjs` fait foi.
 *
 * ⚠️ **Et la divergence est maintenant structurelle** : `server.mjs` gère PLUSIEURS machines, avec
 * un état, une session, une file de commandes et un cache par machine. Ce qui suit décrit encore
 * un singleton de processus, c'est-à-dire une seule cafetière. Ne pas s'en servir de modèle.
 */
/**
 * Génère la charge utile de commande à servir à CHAQUE GET commands.json, en
 * reproduisant la séquence de l'app officielle (validée : la machine s'allume) :
 *   step 0     → device_connected (unix-sec frais)   [présence de l'app]
 *   step 1     → data_request = trame ECAM voulue     [ex. turn-on]
 *   step ≥2    → présence soutenue : demande de MONITOR (lecture pure), avec refresh
 *                  device_connected tous les 5
 * Au-delà de durationMs, le programme est terminé (on sert "{}").
 */
import { config } from "./config";
import { store } from "./session";
import { frameMonitorRequest, toDatapointValue } from "./ecam";
import crypto from "node:crypto";

function prop(name: string, value: string, withId = false) {
  const p: Record<string, unknown> = {
    base_type: "string",
    dsn: config.dsn,
    name,
    value,
    metadata: {},
  };
  if (withId) p.id = crypto.randomBytes(4).toString("hex");
  return { property: p };
}

const nowSec = () => String(Math.floor(Date.now() / 1000));

/** Retourne la chaîne JSON `data` à encapsuler, ou "{}" si le programme est fini/inactif. */
export function nextProgramData(): { data: string; label: string } {
  const pg = store.program;
  if (!pg || !pg.active) return { data: "{}", label: "idle" };
  if (Date.now() > pg.startedAt + pg.durationMs) {
    pg.active = false;
    store.addLog("sys", `programme « ${pg.label} » terminé`);
    return { data: "{}", label: "done" };
  }
  const c = pg.counter++;
  const send = config.generation === "striker" ? "app_data_request" : "data_request";
  if (c === 0) {
    return { data: JSON.stringify({ properties: [prop("device_connected", nowSec())] }), label: "device_connected" };
  }
  if (c === 1) {
    return { data: JSON.stringify({ properties: [prop(send, pg.ecamB64, true)] }), label: pg.label };
  }
  if (c % 5 === 0) {
    return { data: JSON.stringify({ properties: [prop("device_connected", nowSec())] }), label: "device_connected(refresh)" };
  }
  // Présence soutenue pendant le démarrage : une DEMANDE DE MONITOR, qui ne change rien sur la
  // machine.
  //
  // ⚠️ Ne pas remettre `frameSendProfile(1)` ici. `0xA9` **est** la commande de sélection de
  // profil : s'en servir comme battement de cœur imposait silencieusement le profil 1 à chaque
  // programme (constaté sur la machine : une simple demande de sommes de contrôle la ramenait du
  // profil 3 au profil 1). `server.mjs`, qui est le code réellement exécuté, réserve `0xA9` au
  // réveil — sa recette validée — et à la sélection de profil elle-même.
  return {
    data: JSON.stringify({ properties: [prop(send, toDatapointValue(frameMonitorRequest()), true)] }),
    label: "sustain(monitor)",
  };
}

/** Démarre un programme : sert device_connected → <frame> → présence soutenue. */
export function startProgram(ecamB64: string, label: string, durationMs = 75000) {
  store.program = { active: true, ecamB64, label, startedAt: Date.now(), durationMs, counter: 0 };
  store.addLog("sys", `programme « ${label} » démarré (${durationMs / 1000}s)`);
}
