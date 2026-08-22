/**
 * Une fausse machine, pour prouver le RELAIS de bout en bout : une lecture réelle, N destinataires.
 *
 * C'est le pendant de `scripts/faux-app.mjs`. Avec les deux et un lan-server au milieu, la chaîne
 * complète du multiplexeur tourne sur la boucle locale :
 *
 * ```
 * PROXY_APPS=1 SERVER_PORT=3099 node server.mjs
 * node scripts/faux-app.mjs --serveur 127.0.0.1:3099 --port 8888
 * node scripts/faux-app.mjs --serveur 127.0.0.1:3099 --port 8890
 * node scripts/fausse-machine.mjs --serveur 127.0.0.1:3099    # ← pousse un état
 * ```
 *
 * Chaque fausse application doit alors afficher le même datapoint. **C'est l'affirmation centrale
 * de la fonctionnalité** — une seule liaison vers l'appareil, plusieurs applications servies — et
 * elle ne se démontre pas autrement sans plusieurs téléphones.
 *
 * Ce script joue le rôle **appareil** vers lan-server, c'est-à-dire exactement ce que fait la vraie
 * machine : c'est lui qui initie l'échange de clés, lui qui visite `commands.json`, lui qui pousse
 * les datapoints. Il ne pilote rien et n'envoie aucune trame ECAM.
 */
import { makeLanSession, token } from "../src/lib/lansession.mjs";
import { httpJson } from "../src/lib/appproxy.mjs";
import { readFileSync } from "node:fs";

const arg = (nom, defaut = null) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};
const [ip, port] = arg("serveur", "127.0.0.1:3099").split(":");
const nom = arg("propriete", "d302_monitor");
/** Un monitor plausible et INOFFENSIF : lu, jamais exécuté. Rien ici n'atteint un appareil. */
const valeur = arg("valeur", Buffer.from([0xd0, 0x12, 0x75, 0x0f, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64"));

function cleLan() {
  const explicite = arg("cle", null) ?? process.env.LANIP_KEY;
  if (explicite) return Buffer.from(explicite, "utf8");
  try {
    for (const l of readFileSync(".env.local", "utf8").split("\n")) {
      const m = l.match(/^\s*LANIP_KEY\s*=\s*(.+?)\s*$/);
      if (m) return Buffer.from(m[1], "utf8");
    }
  } catch { /* pas de .env.local */ }
  return null;
}
const LAN_KEY = cleLan();
if (!LAN_KEY) {
  console.error("Clé LAN introuvable. Renseigner LANIP_KEY dans .env.local, ou passer --cle <valeur>.");
  process.exit(2);
}

console.log(`\nFausse machine → lan-server ${ip}:${port}`);

// 1. L'échange de clés, initié par l'appareil — le sens qui a coûté le plus cher à comprendre.
const random1 = token(16);
const time1 = String(Math.floor(Date.now() / 1000));
const rep = await httpJson({
  ip, port: Number(port), path: "/local_lan/key_exchange.json", method: "POST",
  body: JSON.stringify({ key_exchange: { ver: 1, proto: 1, key_id: Number(arg("keyid", "0")), random_1: random1, time_1: Number(time1) } }),
});
if (rep.status !== 200) { console.error(`  ✗ échange de clés refusé : HTTP ${rep.status} ${rep.corps}`); process.exit(1); }
const brut = rep.corps.match(/"time_2"\s*:\s*"?(-?\d+)"?/);
const { random_2 } = JSON.parse(rep.corps);
const session = makeLanSession({ lanKey: LAN_KEY, random1, random2: random_2, time1, time2: brut[1], role: "device" });
console.log("  → session ouverte avec le serveur");

// 2. Une visite de `commands.json`, comme le ferait la machine. Ce qui en revient est journalisé
//    mais **jamais exécuté** : ce script ne sait pas piloter une cafetière, et c'est voulu.
const cmds = await httpJson({ ip, port: Number(port), path: "/local_lan/commands.json", method: "GET" });
if (cmds.status === 200 && cmds.corps.trim().startsWith("{") && cmds.corps.includes("enc")) {
  try { console.log(`  ← commande du serveur : ${session.decapsulate(JSON.parse(cmds.corps)).slice(0, 120)}`); }
  catch (e) { console.log(`  ← commande illisible (${e.message})`); }
} else console.log(`  ← rien en file (HTTP ${cmds.status})`);

// 3. Le datapoint. C'est lui que le serveur doit rediffuser à toutes les applications branchées.
const corps = session.encapsulate(JSON.stringify({ properties: [{ property: { base_type: "string", name: nom, value: valeur } }] }));
const push = await httpJson({ ip, port: Number(port), path: "/local_lan/property/datapoint.json", method: "POST", body: corps });
console.log(`  → datapoint ${nom} poussé (HTTP ${push.status})`);
console.log("\nRegarder maintenant les fausses applications : chacune doit avoir reçu ce datapoint.\n");
