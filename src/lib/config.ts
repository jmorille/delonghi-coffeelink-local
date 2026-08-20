export const config = {
  // Pas de numéro de série en dur : `server.mjs` (le code réellement exécuté) le découvre sur la
  // machine via `GET /regtoken.json` → `host_symname`.
  dsn: process.env.MACHINE_DSN ?? "",
  // Plus de valeur par défaut : voir server.mjs (seul fichier qui tourne réellement).
  machineIp: process.env.MACHINE_IP ?? "",
  lanKey: process.env.LANIP_KEY ?? "",
  lanKeyId: Number(process.env.LANIP_KEY_ID ?? "0"),
  serverIp: process.env.SERVER_IP ?? "127.0.0.1",
  serverPort: Number(process.env.SERVER_PORT ?? "3000"),
  generation: (process.env.MACHINE_GENERATION ?? "classic") as
    | "classic"
    | "striker",
};

/** Propriétés Ayla selon la génération (voir docs/analyse-connexion-wifi.md §4.1). */
export const props =
  config.generation === "striker"
    ? { send: "app_data_request", monitor: "d302_monitor_machine" }
    : { send: "data_request", monitor: "d302_monitor" };

/** lanip_key en octets ASCII (NE PAS décoder le base64). */
export function lanKeyAscii(): Buffer {
  return Buffer.from(config.lanKey, "utf8");
}
