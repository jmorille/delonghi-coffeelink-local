/**
 * Actions SORTANTES vers la machine (nous → cafetière), en HTTP simple.
 * Essentiellement : POST /local_reg.json pour nous annoncer comme serveur LAN.
 */
import crypto from "node:crypto";
import http from "node:http";
import { config } from "./config";
import { store, PendingCommand } from "./session";

/**
 * POST http://<machineIp>/local_reg.json
 * body { "local_reg": { ip, port, uri, notify } }
 * notify=1 => la machine vient chercher les commandes immédiatement.
 *
 * NB: on utilise node:http (pas fetch/undici) car le mini-serveur HTTP de l'ESP32
 * rejette le framing d'undici (400). node:http avec Content-Length explicite = OK (202).
 */
export function postLocalReg(): Promise<{ ok: boolean; status: number; body: string }> {
  const notify = store.program?.active || store.queue.length > 0 ? 1 : 0;
  const body = Buffer.from(
    JSON.stringify({
      local_reg: {
        ip: config.serverIp,
        port: config.serverPort,
        uri: "/local_lan",
        notify,
      },
    }),
    "utf8",
  );

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: config.machineIp,
        port: 80,
        path: "/local_reg.json",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          Connection: "close",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          store.lastRegisterAt = Date.now();
          store.addLog(
            "out",
            `local_reg → ${config.machineIp} (notify=${notify}) : HTTP ${res.statusCode}`,
          );
          resolve({
            ok: (res.statusCode ?? 500) < 300,
            status: res.statusCode ?? 0,
            body: data,
          });
        });
      },
    );
    req.on("error", (e) => {
      store.addLog("out", `local_reg → erreur: ${e.message}`);
      reject(e);
    });
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

/** Construit une PendingCommand pour écrire une propriété (ex. data_request). */
export function buildDatapointCommand(
  name: string,
  base64Value: string,
  label: string,
  needsAck = true,
): PendingCommand {
  return {
    id: needsAck ? crypto.randomBytes(4).toString("hex") : "",
    name,
    value: base64Value,
    baseType: "string",
    needsAck,
    label,
    queuedAt: Date.now(),
  };
}

/**
 * Charge utile d'une commande "set property" telle qu'attendue par la machine
 * (CreateDatapointCommand.getPayload) :
 *   {"properties":[{"property":{"base_type","dsn","name","value","metadata"[,"id"]}}]}
 */
export function commandDataJson(cmd: PendingCommand): string {
  const property: Record<string, unknown> = {
    base_type: cmd.baseType,
    dsn: config.dsn,
    name: cmd.name,
    value: cmd.value,
    metadata: {},
  };
  if (cmd.needsAck && cmd.id) property.id = cmd.id;
  return JSON.stringify({ properties: [{ property }] });
}
