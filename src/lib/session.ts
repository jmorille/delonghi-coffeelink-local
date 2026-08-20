/**
 * ⚠️ **Ce fichier ne tourne pas.** `server.mjs` sert lui-même `/local_lan/*` et `/api/*` en
 * HTTP brut, dans tous les modes : ces routes et ces modules sont shadowés et ne sont gardés
 * que comme référence. En cas de divergence, `server.mjs` fait foi.
 */
/**
 * État partagé du serveur LAN mode (singleton, survit entre requêtes dans le runtime Node).
 * Contient : la session crypto courante, la file de commandes à pousser à la machine,
 * le dernier monitor reçu, et un journal d'événements pour l'UI.
 */
import { AylaSession } from "./crypto";

export interface PendingCommand {
  id: string; // token 8 hex si ack attendu
  name: string; // ex. data_request
  value: string; // base64
  baseType: string; // "string"
  needsAck: boolean;
  label: string; // libellé humain (ex. "Allumer")
  queuedAt: number;
}

export interface LogEntry {
  t: number;
  dir: "in" | "out" | "sys";
  msg: string;
}

export interface MonitorSnapshot {
  at: number;
  stateByte: number;
  switchBits: number; // octets 5-6 : capteurs, PAS une progression
  alarms: number[];
  raw: string;
}

/**
 * Un "programme" reproduit la séquence de l'app officielle qui, elle, réussit :
 *   device_connected (frais) → la trame ECAM voulue → puis présence soutenue
 *   (SEND_PROFILE + refresh device_connected) pendant tout le boot machine.
 * Servi commande par commande à chaque GET commands.json, avec keep-alive rapide.
 */
export interface Program {
  active: boolean;
  ecamB64: string; // datapointValue(frame) de la commande principale
  label: string;
  startedAt: number;
  durationMs: number;
  counter: number; // avance à chaque GET commands.json
}

class Store {
  session: AylaSession | null = null;
  sessionStartedAt = 0;
  queue: PendingCommand[] = [];
  program: Program | null = null;
  lastMonitor: MonitorSnapshot | null = null;
  lastDataResponse: { at: number; hex: string } | null = null;
  lastRegisterAt = 0;
  log: LogEntry[] = [];

  addLog(dir: LogEntry["dir"], msg: string) {
    this.log.unshift({ t: Date.now(), dir, msg });
    if (this.log.length > 200) this.log.pop();
  }

  enqueue(cmd: PendingCommand) {
    this.queue.push(cmd);
    this.addLog("sys", `commande en file: ${cmd.label} (${cmd.name})`);
  }

  peek(): PendingCommand | undefined {
    return this.queue[0];
  }

  /**
   * Retire la commande acquittée.
   *
   * L'ancienne version filtrait `c.id !== id && c !== this.queue[0]`, ce qui retirait AUSSI la
   * tête de file : un accusé portant l'id d'une commande qui n'était pas en tête faisait
   * disparaître silencieusement une commande jamais envoyée. On retire une seule entrée, et on
   * garde le repli historique « à défaut, vider la tête » pour ne pas bloquer la file si la
   * machine acquitte sans id reconnaissable.
   */
  dequeue(id: string) {
    const i = id ? this.queue.findIndex((c) => c.id === id) : 0;
    this.queue.splice(i >= 0 ? i : 0, 1);
  }
}

// Singleton résistant au HMR de Next.js en dev.
const g = globalThis as unknown as { __dlStore?: Store };
export const store: Store = g.__dlStore ?? (g.__dlStore = new Store());
