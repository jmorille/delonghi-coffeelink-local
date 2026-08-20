/**
 * Serveur personnalisé : HTTP BRUT pour les endpoints device-facing (/local_lan/*) et
 * l'API de contrôle (/api/*), et délégation à Next.js pour l'UI (pages / et /recipes).
 *
 * Pourquoi un serveur brut ? Le client HTTP de l'ESP32 (ADA 1.5.3) est rudimentaire et
 * rejette les réponses de Next (header `vary: rsc,…`, framing App Router). Les réponses
 * node:http avec Content-Length explicite fonctionnent (validé : la machine s'allume).
 *
 * Tout tourne dans UN process → état partagé en mémoire.
 * Lancer : npm run build && node server.mjs   (ou npm start)
 */
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import next from "next";
import { MODEL, ALL_BEVERAGES, CATEGORIES, byId, profileProp, decodeRecipeProperty } from "./src/lib/beverages.mjs";
import { computeBeanAdapt, encodeBeanName, GRINDER_MIN, GRINDER_MAX, AROMA_MIN, AROMA_MAX, TEMPERATURE_MIN, TEMPERATURE_MAX } from "./src/lib/bean-adapt.mjs";
import { ALL_PROFILE_PROPS, PROFILE_NAME_PROPS, CUSTOM_NAME_PROPS, PRIORITY_PROPS, profilePropInfo, isProfileProp, decodeNames, decodePriorities, decodeChecksums, decodeBeanSystem, STRIDE_CLASSIC } from "./src/lib/profiles.mjs";
// Persistance : SQLite (`data/lan-server.db`). Le module migre tout seul les anciens JSON au
// premier démarrage. Chaque propriété reçue est UNE ligne réécrite, plus 80 ko de cache entier.
import { bootMessages as storeBootMessages, storageInfo, machineView, putProp, putBeanSystem, putStats, putChecksums, getMeta, setMeta, clearMeta, countStats, allBeanSystems, listRecipes, putRecipe, deleteRecipe, getLanKey, setLanKey, clearLanKey } from "./src/lib/store.mjs";
// Identification du modele : la machine publie son numero de serie, et les 5 chiffres qui
// indexent la table constructeur sont dedans. Aucun cloud — voir machine-models.mjs.
import { MODELS, MODELS_TABLE_VERSION, SERIAL_PROP, findModel, identify as identifyModel } from "./src/lib/machine-models.mjs";

// --- .env.local ---
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const CFG = {
  // Le DSN n'est PAS écrit en dur : c'est une donnée d'appareil, et elle est découvrable
  // localement (`resolveDsn`). `MACHINE_DSN` dans .env.local reste un forçage possible.
  dsn: process.env.MACHINE_DSN || null,
  dsnSource: process.env.MACHINE_DSN ? "MACHINE_DSN (.env.local)" : "inconnu",
  // **Aucune valeur par défaut** : une IP écrite en dur est la configuration de quelqu'un
  // d'autre, et elle donne l'illusion d'un serveur configuré alors qu'il parle dans le vide.
  // Elle se saisit dans l'interface (page « Clé LAN »), se force par MACHINE_IP, et est
  // mémorisée en base — même priorité que le DSN et la clé LAN.
  machineIp: process.env.MACHINE_IP || null,
  machineIpSource: process.env.MACHINE_IP ? "MACHINE_IP (.env.local)" : "inconnue",
  // Modele : DECOUVERT, pas configure — la cle de 5 chiffres est dans le numero de serie que la
  // machine publie elle-meme (`d270_serialnumber`). Meme priorite que le DSN et la cle LAN :
  // forcage par variable > cache local > la machine.
  modelKey: process.env.MACHINE_MODEL_KEY || null,
  modelSource: process.env.MACHINE_MODEL_KEY ? "MACHINE_MODEL_KEY (.env.local)" : "inconnu",
  lanKey: Buffer.from(process.env.LANIP_KEY ?? "", "utf8"),
  lanKeyId: Number(process.env.LANIP_KEY_ID ?? "0"),
  lanKeySource: process.env.LANIP_KEY ? "LANIP_KEY (.env.local)" : "inconnue",
  serverIp: process.env.SERVER_IP ?? "127.0.0.1",
  port: Number(process.env.SERVER_PORT ?? "3000"),
  gen: process.env.MACHINE_GENERATION ?? "classic",
};
const DEVICE_SHEET = JSON.parse(readFileSync(new URL("./src/lib/device-sheet.json", import.meta.url), "utf8"));
/**
 * Constantes statiques de l'APK servant a la decouverte de la cle LAN.
 *
 * Elles etaient dans `.env.local`, ou elles n'avaient rien a faire : identiques pour tout le
 * monde, lisibles dans un binaire public, et sans pouvoir propre — sans les identifiants d'un
 * compte De'Longhi, elles n'ouvrent rien. Les faire saisir ne protegeait personne, et rendait la
 * decouverte indisponible a qui ne les avait pas sous la main. Le vrai secret, la cle LAN, reste
 * en base ; le mot de passe, lui, ne survit pas a la requete.
 *
 * Chaque valeur reste surchargeable par sa variable d'environnement — compte hors zone
 * europeenne, ou rotation cote De'Longhi.
 */
const CLOUD_APP = JSON.parse(readFileSync(new URL("./src/lib/cloud-app.json", import.meta.url), "utf8"));
const APP = {
  gigyaApiKey: process.env.GIGYA_API_KEY || CLOUD_APP.gigya.apiKey,
  gigyaDatacenter: process.env.GIGYA_DATACENTER || CLOUD_APP.gigya.datacenter,
  aylaAppId: process.env.AYLA_APP_ID || CLOUD_APP.ayla.appId,
  aylaAppSecret: process.env.AYLA_APP_SECRET || CLOUD_APP.ayla.appSecret,
  aylaUserUrl: CLOUD_APP.ayla.userServiceUrl,
  aylaDeviceUrl: CLOUD_APP.ayla.deviceServiceUrl,
};
const SEND = CFG.gen === "striker" ? "app_data_request" : "data_request";
const MON = CFG.gen === "striker" ? "d302_monitor_machine" : "d302_monitor";

const now = () => new Date().toISOString().slice(11, 23);
const S = {
  session: null,
  program: null, // {active,ecamB64,label,startedAt,durationMs,counter}
  lastMonitor: null,
  lastDataResponse: null,
  // Derniere identification du modele (decodage de `d270_serialnumber`). En cas d'echec on garde
  // la raison ET la trame : c'est ce qui rend une decoupe fausse corrigeable en une passe.
  identity: null,
  lastRegisterAt: 0,
  keepalive: null,
  log: [],
  import: null, // {active,queue:[prop],pending,ok,fail,startedAt,durationMs,counter}
  cmdId: 0,
  // Dernier profil qu'on a demandé à la machine. La trame de « présence » (0xA9) EST la
  // commande de sélection de profil : si on la figeait sur 1, chaque programme ramènerait la
  // machine au profil 1 quelques secondes après la commande de l'utilisateur.
  activeProfile: 1,
  // Faux tant qu'on n'a pas nous-mêmes imposé un profil dans cette session. La valeur 1
  // ci-dessus n'est qu'un défaut nécessaire à la trame de présence : elle ne prouve pas que
  // la machine est sur le profil 1. On ne sait pas lire son profil courant (piste :
  // `d286_mach_sett_profile`, encodage non vérifié), donc l'UI doit dire qu'elle l'ignore
  // plutôt que d'affirmer un profil arbitraire après un redémarrage du serveur.
  activeProfileConfirmed: false,
  // Requêtes OTA reçues DE la machine. En LAN mode, c'est la machine qui vient chercher l'image
  // chez nous (`LanOTAHandler` sert la route `/ota_status.json` et le chemin de l'image) : une
  // requête ici est donc le seul signal local d'une opération OTA.
  otaRequests: [],
  // Dernier appel à /api/presence, pour ne pas marteler la machine quand plusieurs onglets
  // s'ouvrent en même temps.
  lastPresenceAt: 0,
  // Balayage de la liste des grains : un programme 0xBA par index.
  beanScan: null,
  // Lecture des paramètres/statistiques : un programme 0xA2 par requête.
  statScan: null,
};
function L(dir, msg) {
  S.log.unshift({ t: Date.now(), dir, msg });
  if (S.log.length > 200) S.log.pop();
  console.log(now(), dir.toUpperCase(), msg);
}

// --- crypto (port validé de debug-capture.mjs) ---
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const derive = (K, seed) => hmac(K, Buffer.concat([hmac(K, seed), seed])); // double HMAC
const CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const token = (n) => { const b = crypto.randomBytes(n); let s = ""; for (let i = 0; i < n; i++) s += CH[b[i] % 62]; return s; };
function makeSession(kx, time2) {
  const R1 = Buffer.from(kx.random_1, "utf8"), R2 = Buffer.from(token(16), "utf8");
  const T1 = Buffer.from(String(kx.time_1), "utf8"), T2 = Buffer.from(time2, "utf8");
  const tag = (t) => Buffer.from([t]);
  const a = (t) => Buffer.concat([R1, R2, T1, T2, tag(t)]);
  const d = (t) => Buffer.concat([R2, R1, T2, T1, tag(t)]);
  const aSign = derive(CFG.lanKey, a(0x30)), aCrypto = derive(CFG.lanKey, a(0x31)), aIv = derive(CFG.lanKey, a(0x32)).subarray(0, 16);
  const dSign = derive(CFG.lanKey, d(0x30)), dCrypto = derive(CFG.lanKey, d(0x31)), dIv = derive(CFG.lanKey, d(0x32)).subarray(0, 16);
  const e = crypto.createCipheriv("aes-256-cbc", aCrypto, aIv); e.setAutoPadding(false);
  const dc = crypto.createDecipheriv("aes-256-cbc", dCrypto, dIv); dc.setAutoPadding(false);
  let seq = 0;
  return {
    random2: R2.toString("utf8"),
    encapsulate(dataJson) {
      const inner = `{"seq_no":${seq++},"data":${dataJson}}`;
      const ib = Buffer.from(inner, "utf8");
      const sign = crypto.createHmac("sha256", aSign).update(ib).digest("base64");
      let len = ib.length + 1; const r = len % 16; if (r) len += 16 - r;
      const pad = Buffer.alloc(len); ib.copy(pad, 0);
      return JSON.stringify({ enc: e.update(pad).toString("base64"), sign });
    },
    decapsulate(body) {
      let p = dc.update(Buffer.from(body.enc, "base64"));
      let end = p.length; while (end > 0 && p[end - 1] === 0) end--;
      return p.subarray(0, end).toString("utf8");
    },
  };
}

// --- ECAM ---
function crc16(b) { let c = 0x1d0f; for (let i = 0; i < b.length - 2; i++) { const a = (((c << 8) | (c >>> 8)) & 0xffff) ^ b[i]; const x = a ^ ((a & 0xff) >> 4); const y = x ^ ((x << 12) & 0xffff); c = y ^ (((y & 0xff) << 5) & 0xffff); } return c & 0xffff; }
function seal(arr) { const b = Buffer.from(arr); const c = crc16(b); b[b.length - 2] = (c >> 8) & 0xff; b[b.length - 1] = c & 0xff; return b; }
const frameTurnOn = () => seal([0x0d, 0x07, 0x84, 0x0f, 0x02, 0x01, 0, 0]);
const frameTurnOff = () => seal([0x0d, 0x07, 0x84, 0x0f, 0x01, 0x01, 0, 0]);
const frameSendProfile = (id = 1) => seal([0x0d, 0x06, 0xa9, 0xf0, id & 0xff, 0, 0]);
const frameSelectBean = (id) => seal([0x0d, 0x06, 0xb9, 0xf0, id & 0xff, 0, 0]);
// M0() « recipeQtyPacket » : lecture ECAM native d'une recette (profil + boisson).
// Réponse : D0 <len> A6 F0 <profil> <boisson> <paramètres…> <crc>, parsée par u0() dans l'app.
const frameRecipeQty = (prof, bev) => seal([0x0d, 0x07, 0xa6, 0xf0, prof & 0xff, bev & 0xff, 0, 0]);
// J() « checksums » : sommes de contrôle des quantités par profil + perso + noms. Une seule
// petite trame permet de savoir si le cache est encore valable, au lieu de tout relire.
const frameChecksums = () => seal([0x0d, 0x05, 0xa3, 0xf0, 0, 0]);
// V(data2) : demande du monitor. Trame de LECTURE, sans aucun effet de bord — c'est ce qu'il
// faut pour tenir la présence, contrairement à 0xA9 qui sélectionne un profil.
const frameMonitorRequest = () => seal([0x0d, 0x05, 0x75, 0x0f, 0, 0]);
// U(index) « BEAN_SYSTEM_READ » : seule source du NOM d'un profil Bean Adapt.
const frameBeanSystem = (index) => seal([0x0d, 0x06, 0xba, 0xf0, index & 0xff, 0, 0]);
/**
 * d0(paramAddress, qty) « readSettingsParameter » : lecture des PARAMÈTRES machine, dont les
 * compteurs d'utilisation (nombre de boissons, détartrages, filtres, litres d'eau…).
 *
 * `0D 08 A2 0F <idHi> <idLo> <qty> <crc>` — l'identifiant est sur 16 bits, `qty` demande autant de
 * paramètres CONSÉCUTIFS à partir de là. Noter le flag `0x0F` (comme la demande de monitor), pas
 * `0xF0`. Trame de lecture pure, aucun effet sur la machine.
 */
const frameParamRead = (id, qty = 1) => seal([0x0d, 0x08, 0xa2, 0x0f, (id >> 8) & 0xff, id & 0xff, qty & 0xff, 0, 0]);

/**
 * a0() « bean system save or delete » — 52 octets (docs/bean-adapt.md §5.1) :
 *
 *   4       id du profil
 *   5..44   nom, 40 octets UTF-16 big-endian
 *   45      mouture      46  température      47  arôme
 *   48      réservé (0)  49  visible (1 actif / 0 supprimé)
 *   50,51   CRC16
 *
 * La suppression n'est pas une commande distincte : c'est la même trame avec `visible = 0`.
 * ⚠️ Le doublement de la mouture (`grinder * 2`) est un cas **Striker** — pas cette machine.
 */
function frameBeanSystemSave(id, name, grinder, temperature, aroma, visible = true) {
  const bytes = new Array(52).fill(0);
  bytes[0] = 0x0d;
  bytes[1] = 0x33;
  bytes[2] = 0xbb;
  bytes[3] = 0xf0;
  bytes[4] = id & 0xff;
  const n = encodeBeanName(name);
  for (let i = 0; i < 40; i++) bytes[5 + i] = n[i];
  bytes[45] = grinder & 0xff;
  bytes[46] = temperature & 0xff;
  bytes[47] = aroma & 0xff;
  bytes[48] = 0;
  bytes[49] = visible ? 1 : 0;
  return seal(bytes);
}
const TWO = new Set([1, 9, 15]);
function frameDispense(bev, prof, mode, action, params, check = false) {
  const body = [];
  for (const p of params) { body.push(p.id & 0xff); if (TWO.has(p.id)) body.push((p.value >> 8) & 0xff, p.value & 0xff); else body.push(p.value & 0xff); }
  const total = body.length + 9; const bytes = new Array(total).fill(0);
  bytes[0] = 0x0d; bytes[1] = total - 1; bytes[2] = 0x83; bytes[3] = 0xf0; bytes[4] = bev & 0xff;
  bytes[5] = check ? (mode | 0x80) & 0xff : mode & 0xff;
  for (let i = 0; i < body.length; i++) bytes[6 + i] = body[i];
  bytes[6 + body.length] = ((prof << 2) | action) & 0xff;
  return seal(bytes);
}
function datapointValue(frame) { const t = Buffer.alloc(4); t.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0); return Buffer.concat([frame, t]).toString("base64"); }
/**
 * Alarmes du monitor — index de bit → identifiant, port de `p127m6/l` (méthode `a(int)`).
 *
 * ⚠️ La table fait autorité sur les couples (groupe, bit) déclarés dans l'énum : plusieurs index
 * sont explicitement `IGNORE_ALARM` sur cette génération (7, 10, 13, 16, 20, 21, 23, 24, 26-31),
 * alors que l'énum y déclare des alarmes. On les marque « ignorée » au lieu de les nommer à tort.
 *
 * Le champ est un bitfield 32 bits construit par `MonitorDataV2.b()` :
 *   octet 7 | octet 8 << 8 | octet 12 << 16 | octet 13 << 24
 */
const MONITOR_ALARMS = {
  0: "EMPTY_WATER_TANK",
  1: "COFFEE_WASTE_CONTAINER_FULL",
  2: "DESCALE_ALARM",
  3: "REPLACE_WATER_FILTER",
  4: "COFFE_GROUND_TOO_FINE",
  5: "COFFEE_BEANS_EMPTY",
  6: "MACHINE_TO_SERVICE",
  8: "TOO_MUCH_COFFEE",
  9: "COFFEE_INFUSER_MOTOR_NOT_WORKING",
  11: "EMPTY_DRIP_TRAY",
  12: "HYDRAULIC_CIRCUIT_PROBLEM",
  14: "CLEAN_KNOB",
  15: "COFFEE_BEANS_EMPTY_TWO",
  17: "BEAN_HOPPER_ABSENT",
  18: "GRID_PRESENCE",
  19: "INFUSER_SENSE",
  22: "EXPANSION_SUBMODULES_PROB",
  25: "CONDENSE_FAN_PROBLEM",
};

/**
 * Capteurs rapportés par le monitor — port de l'énum `p127m6/p` (couple groupe/bit) et de
 * `MonitorDataV2.l()` : l'octet est `5 + groupe`, le bit est la position dans l'énum.
 */
const MONITOR_SWITCHES = [
  { group: 0, bit: 0, name: "WATER_SPOUT", label: "buse à eau" },
  { group: 0, bit: 1, name: "MOTOR_UP", label: "moteur haut" },
  { group: 0, bit: 2, name: "MOTOR_DOWN", label: "moteur bas" },
  { group: 0, bit: 3, name: "COFFEE_WASTE_CONTAINER", label: "bac à marc" },
  { group: 0, bit: 4, name: "WATER_TANK_ABSENT", label: "réservoir d'eau absent" },
  { group: 0, bit: 5, name: "KNOB", label: "molette" },
  { group: 0, bit: 6, name: "WATER_LEVEL_LOW", label: "niveau d'eau bas" },
  { group: 0, bit: 7, name: "COFFEE_JUG", label: "verseuse" },
  { group: 1, bit: 0, name: "IFD_CARAFFE", label: "carafe à lait" },
  { group: 1, bit: 1, name: "CIOCCO_TANK", label: "bac chocolat" },
  { group: 1, bit: 2, name: "CLEAN_KNOB", label: "molette nettoyage" },
  { group: 1, bit: 5, name: "DOOR_OPENED", label: "porte ouverte" },
  { group: 1, bit: 6, name: "PREGROUND_DOOR_OPENED", label: "trappe café moulu ouverte" },
];

/**
 * Décode `d302_monitor` — port de `it/delonghi/ecam/model/MonitorDataV2`, où le tableau indexé
 * est la trame complète décodée du base64.
 *
 * ```
 * 4        état machine        (0x04 = veille ; voir MACHINE_STATES)
 * 5, 6     capteurs           champ de bits 16 bits, octet = 5 + groupe
 * 7, 8, 12, 13  alarmes       champ de bits 32 bits (7 | 8<<8 | 12<<16 | 13<<24)
 * 9, 10, 11     compteurs/divers (accesseurs f(), e(), d() de l'app)
 * ```
 *
 * ⚠️ Les octets 5-6 étaient nommés « progress » dans une première version : c'était faux. La
 * valeur 256 relevée sur cette machine signifie « groupe 1, bit 0 » = carafe à lait connectée,
 * ce que l'écran confirmait.
 */
function decodeMonitor(b64) {
  const raw = Buffer.from(b64, "base64");
  // Une trame exploitable va au moins jusqu'à l'octet 8 (état, capteurs, 2 premiers octets
  // d'alarmes). Sans ce contrôle, une valeur vide donnait `stateByte: undefined` et le
  // `toString(16)` du journal levait une TypeError : les autres propriétés du MÊME datapoint
  // étaient perdues, et le journal accusait à tort le déchiffrement.
  if (raw.length < 9) throw new Error(`trame monitor trop courte (${raw.length} octets)`);
  const n = raw[1] + 1;
  const e = raw.subarray(0, n);
  if (e.length < 9) throw new Error(`trame monitor tronquée (len annoncé ${n}, ${e.length} reçus)`);
  const bits = e[5] + (e[6] << 8);
  const switches = MONITOR_SWITCHES.filter((sw) => (e[5 + sw.group] >> sw.bit) & 1);
  // Octet 13 multiplié, pas décalé : `0x80 << 24` vaut −2147483648 en JS, et l'API publiait alors
  // un champ de bits négatif. La boucle sur les bits utilise déjà `>>>`, seule la valeur exposée
  // était fausse.
  const alarmBits = e[7] + (e[8] << 8) + ((e[12] ?? 0) << 16) + (e[13] ?? 0) * 0x1000000;
  const alarms = [];
  for (let i = 0; i < 32; i++) {
    if (!((alarmBits >>> i) & 1)) continue;
    // `ignored` : l'app écarte explicitement ces index sur cette génération. On les remonte
    // quand même, marqués, plutôt que de les cacher ou de leur coller un nom faux.
    alarms.push({ bit: i, name: MONITOR_ALARMS[i] ?? null, ignored: !MONITOR_ALARMS[i] });
  }
  return {
    stateByte: e[4],
    switchBits: bits,
    switches: switches.map((sw) => ({ name: sw.name, label: sw.label })),
    alarmBits,
    alarms,
    raw: e.toString("hex").replace(/(..)/g, "$1 ").trim(),
  };
}

/**
 * Décode la réponse `0xA2` — port de `p097j6.d.L()` case `-94`.
 *
 * ```
 * 0        0xD0
 * 1        len = taille totale − 1
 * 2        0xA2
 * 3        0x0F
 * 4..      n entrées de 6 octets : id sur 16 bits big-endian, puis valeur sur 32 bits
 * 2 dern.  CRC16
 * ```
 *
 * `n = (len − 5) / 6`. Une seule réponse peut donc porter plusieurs paramètres — c'est ce que
 * `qty` demande. Les valeurs sont lues en big-endian comme tout le reste du protocole (`z.g0()`).
 */
function decodeParameters(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 12) throw new Error(`trame trop courte (${buf.length} octets)`);
  if (buf[2] !== 0xa2) throw new Error(`commande inattendue 0x${buf[2].toString(16)}`);
  const count = Math.floor((buf[1] - 5) / 6);
  if (count < 1) throw new Error(`aucune entrée (len ${buf[1]})`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 6;
    if (o + 6 > buf.length - 2) break;
    entries.push({ id: (buf[o] << 8) | buf[o + 1], value: buf.readUInt32BE(o + 2) });
  }
  return { count, entries, hex: buf.subarray(0, buf[1] + 1).toString("hex").replace(/(..)/g, "$1 ").trim() };
}

// id → libellé, dérivé du catalogue (src/lib/beverages.mjs) : ids réels de CETTE machine.
const BEVERAGES = Object.fromEntries(ALL_BEVERAGES.map((b) => [b.id, b.label]));

// --- programme (séquence app validée : device_connected → cmd → présence soutenue) ---
const prop = (name, value, id = false) => { const p = { base_type: "string", dsn: CFG.dsn ?? "", name, value, metadata: {} }; if (id) p.id = crypto.randomBytes(4).toString("hex"); return { property: p }; };
const nowSec = () => String(Math.floor(Date.now() / 1000));
function nextProgramData() {
  const pg = S.program;
  if (!pg || !pg.active) return { data: "{}", label: "idle" };
  if (Date.now() > pg.startedAt + pg.durationMs) { pg.active = false; L("sys", `programme « ${pg.label} » terminé`); return { data: "{}", label: "done" }; }
  const c = pg.counter++;
  if (c === 0) return { data: JSON.stringify({ properties: [prop("device_connected", nowSec())] }), label: "device_connected" };
  if (c === 1) return { data: JSON.stringify({ properties: [prop(SEND, pg.ecamB64, true)] }), label: pg.label };
  if (c % 5 === 0) return { data: JSON.stringify({ properties: [prop("device_connected", nowSec())] }), label: "device_connected(refresh)" };
  // Trame de présence : dépend du programme. `profile` (0xA9) n'est utilisé que là où il est
  // nécessaire — le réveil, dont c'est la recette validée, et la sélection de profil, où
  // réaffirmer la même valeur est idempotent. Partout ailleurs on tient la présence avec une
  // demande de monitor, qui ne change rien sur la machine.
  //
  // ⚠️ 0xA9 EST la commande de sélection de profil : l'utiliser comme simple battement de cœur
  // avec un profil non confirmé imposait silencieusement le profil 1 à chaque commande (constaté :
  // une simple demande de sommes de contrôle ramenait la machine du profil 3 au profil 1).
  if (pg.sustain === "profile") {
    return { data: JSON.stringify({ properties: [prop(SEND, datapointValue(frameSendProfile(S.activeProfile)), true)] }), label: `sustain(profil ${S.activeProfile})` };
  }
  return { data: JSON.stringify({ properties: [prop(SEND, datapointValue(frameMonitorRequest()), true)] }), label: "sustain(monitor)" };
}
function startProgram(ecamB64, label, durationMs = 75000, sustain = "monitor") { S.program = { active: true, ecamB64, label, startedAt: Date.now(), durationMs, counter: 0, sustain }; L("sys", `programme « ${label} » démarré (présence : ${sustain})`); ensureKeepalive(); }

// --- import des recettes : lecture de propriétés Ayla en LAN (100 % local) ---
// Port de AylaLanCommand.newGetPropertyCommand : on sert une commande GET dans
// commands.json ; la machine POSTe la valeur sur /local_lan/property/datapoint.json,
// endpoint qu'on déchiffre déjà. Aucun appel au cloud.
function readPropertyCmd(name) {
  return JSON.stringify({ cmds: [{ cmd: { cmd_id: ++S.cmdId, method: "GET", resource: `property.json?name=${name}`, data: "", uri: "/local_lan/property/datapoint.json" } }] });
}
function startImport(queue, durationMs = 120000) {
  S.import = { active: true, queue: [...queue], pending: null, ok: [], fail: [], startedAt: Date.now(), durationMs, counter: 0 };
  L("sys", `import démarré : ${queue.length} propriétés à lire`);
  ensureKeepalive();
}
function nextImportData() {
  const im = S.import;
  if (!im?.active) return null;
  if (Date.now() > im.startedAt + im.durationMs) {
    im.active = false;
    im.fail = [...im.fail, ...im.queue];
    L("sys", `import expiré : ${im.ok.length} lues, ${im.fail.length} non lues`);
    return null;
  }
  // Présence de l'app d'abord (même prérequis que pour les commandes ECAM).
  if (im.counter++ === 0) return { data: JSON.stringify({ properties: [prop("device_connected", nowSec())] }), label: "device_connected" };
  const name = im.queue.shift();
  if (!name) {
    im.active = false;
    applyChecksumMark(im);
    L("sys", `import terminé : ${im.ok.length} propriétés lues`);
    return null;
  }
  im.pending = name;
  return { data: readPropertyCmd(name), label: `lecture ${name}` };
}

// --- local_reg (node:http, Content-Length explicite) ---
function postLocalReg() {
  if (!CFG.machineIp) {
    L("out", "local_reg impossible : adresse de la machine non configurée (page « Clé LAN »)");
    return Promise.resolve({ ok: false, error: "machineIp" });
  }
  const notify = S.program?.active || S.import?.active ? 1 : 0;
  const b = Buffer.from(JSON.stringify({ local_reg: { ip: CFG.serverIp, port: CFG.port, uri: "/local_lan", notify } }), "utf8");
  return new Promise((resolve) => {
    const r = httpRequest(
      { host: CFG.machineIp, port: 80, path: "/local_reg.json", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": b.length, Connection: "close" } },
      (res) => { res.on("data", () => {}); res.on("end", () => { S.lastRegisterAt = Date.now(); resolve({ ok: res.statusCode < 300, status: res.statusCode }); }); },
    );
    r.on("error", (e) => { L("out", `local_reg erreur: ${e.message}`); resolve({ ok: false }); });
    r.setTimeout(8000, () => r.destroy());
    r.write(b); r.end();
  });
}

function ensureKeepalive() {
  if (S.keepalive) return;
  L("sys", "keep-alive démarré (2,5 s)");
  S.keepalive = setInterval(async () => {
    const active = S.program?.active === true || S.import?.active === true;
    const past = Date.now() - (S.program?.startedAt ?? 0) - (S.program?.durationMs ?? 0);
    if (!active && past > 15000) { clearInterval(S.keepalive); S.keepalive = null; L("sys", "keep-alive arrêté"); return; }
    await postLocalReg();
  }, 2500);
}

// --- réponse brute (compatible ESP32) ---
function raw(res, bodyStr, status = 200) {
  // PAS de "Connection: close" : l'ESP32 enchaîne key_exchange → commands.json sur la
  // même connexion keep-alive ; fermer casse la séquence. Content-Length explicite suffit.
  const buf = Buffer.from(bodyStr, "utf8");
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
}
function readBody(req) { return new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c))); }); }

// --- handlers device-facing ---
async function handleLan(req, res) {
  const url = req.url.split("?")[0];
  const body = await readBody(req);
  if (url === "/local_lan/key_exchange.json" && req.method === "POST") {
    const m = body.toString("utf8").match(/"time_1"\s*:\s*"?(-?\d+)"?/);
    const kx = JSON.parse(body.toString("utf8")).key_exchange;
    kx.time_1 = m ? m[1] : String(kx.time_1);
    if (kx.proto !== 1 || kx.ver !== 1) return raw(res, JSON.stringify({ error: "ver" }), 426);
    if (Number(kx.key_id) !== CFG.lanKeyId) return raw(res, JSON.stringify({ error: "keyid" }), 412);
    const t2 = Date.now();
    S.session = makeSession(kx, String(t2));
    return raw(res, JSON.stringify({ random_2: S.session.random2, time_2: t2 }));
  }
  if (url === "/local_lan/commands.json" && req.method === "GET") {
    if (!S.session) return raw(res, "no session", 412);
    // Une commande ECAM en cours a priorité ; sinon on écoule la file de lecture.
    const { data, label } = (S.program?.active ? null : nextImportData()) ?? nextProgramData();
    if (label !== "idle" && label !== "done") L("out", `commande servie: ${label}`);
    return raw(res, S.session.encapsulate(data));
  }
  if (url.includes("/property/datapoint") && req.method === "POST") {
    if (S.session) {
      try {
        const dec = S.session.decapsulate(JSON.parse(body.toString("utf8")));
        for (const { name, value } of collectProps(dec)) handleProperty(name, value);
      } catch (e) { L("in", `decrypt datapoint échec: ${e.message}`); }
    }
    return raw(res, S.session ? S.session.encapsulate("{}") : "{}");
  }
  return raw(res, "{}");
}

// Une réponse de la machine peut porter {property:{...}}, {properties:[...]} ou un
// accusé de commande. On collecte donc tous les couples name/value à n'importe quelle
// profondeur, avec repli regex si le JSON est tronqué.
function collectProps(decoded) {
  const out = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v.name === "string" && typeof v.value === "string") out.push({ name: v.name, value: v.value });
    for (const k of Object.keys(v)) walk(v[k]);
  };
  try { walk(JSON.parse(decoded)); } catch {
    const m = decoded.match(/"name"\s*:\s*"([^"]+)".*?"value"\s*:\s*"([^"]*)"/s);
    if (m) out.push({ name: m[1], value: m[2] });
  }
  return out;
}

/**
 * Aiguillage des propriétés reçues de la machine — **sur l'octet de commande de la trame**,
 * pas sur le nom de la propriété.
 *
 * Une première version routait par motif de nom (`_beansystem` → décodeur de recettes) : la
 * machine a répondu à `0xBA` en poussant `d251_beansystem_1`, qui est allé au mauvais décodeur et
 * ressortait « désaligné ». Or chaque famille a son propre octet de commande, vérifié sur les
 * 50 propriétés réellement lues :
 *
 *   0xB0 bornes min/déf/max · 0xA6 valeurs d'un profil · 0xA4 noms de profils
 *   0xAA noms de recettes perso · 0xA8 ordre des favoris · 0xBA profil Bean System
 *   0xA3 sommes de contrôle · 0xA2 paramètres et statistiques
 *
 * `0xA1` (numéro de série) fait exception : voir le routage par nom, plus bas.
 */
function handleProperty(name, value) {
  if (name.startsWith(MON)) {
    // Isolé : un monitor illisible ne doit pas interrompre le traitement des AUTRES propriétés
    // portées par le même datapoint.
    try {
      const mo = decodeMonitor(value);
      S.lastMonitor = { at: Date.now(), ...mo };
      L("in", `monitor: état=0x${mo.stateByte.toString(16).padStart(2, "0")}${mo.switches.length ? " · " + mo.switches.map((x) => x.label).join(", ") : ""}${mo.alarms.length ? " · alarmes " + mo.alarms.map((a) => a.name ?? `bit ${a.bit}`).join(", ") : ""}`);
    } catch (e) {
      L("in", `${name}: monitor illisible (${e.message})`);
    }
    return;
  }
  if (name === "data_response") {
    handleDataResponse(value);
    return;
  }
  if (!value) {
    // Une propriété qui répond vide n'existe pas sur ce modèle (typiquement les variantes
    // Striker) : on le note pour ne pas la confondre avec « pas encore lue ».
    if (isProfileProp(name)) putProp(name, { at: Date.now(), kind: profilePropInfo(name).kind, absent: true });
    if (S.import) { S.import.ok.push(name); S.import.pending = null; }
    L("in", `${name}: absente sur ce modèle`);
    return;
  }

  // Routage par NOM, et c'est délibéré pour celle-ci. Sa trame porte la commande `0xA1`
  // (vérifié en direct : `d0 1b a1 0f …`), qui n'a pas de décodeur — sans cette branche elle
  // tomberait dans `default` et resterait « non décodée ». L'app elle-même ne regarde pas cet
  // octet : elle lit la valeur positionnellement. Nom EXACT, pas motif : c'est le routage par
  // MOTIF (`_beansystem` → décodeur de recettes) qui avait produit les désalignements.
  if (name === SERIAL_PROP) {
    applyIdentity(value);
    if (S.import) { S.import.ok.push(name); S.import.pending = null; }
    return;
  }

  let cmd;
  try { cmd = Buffer.from(value, "base64")[2]; } catch { cmd = undefined; }
  // Chaque branche écrit ce qu'elle a décodé, tout de suite : `done` ne fait plus que journaliser.
  const done = (msg) => {
    if (S.import) { S.import.ok.push(name); S.import.pending = null; }
    L("in", `${name}: ${msg}`);
  };
  const failed = (e) => {
    if (S.import) S.import.fail.push(name);
    L("in", `${name}: décodage impossible (${e.message})`);
  };

  try {
    switch (cmd) {
      case 0xb0:
      case 0xa6: {
        const r = decodeRecipeProperty(value);
        putProp(name, { at: Date.now(), kind: r.kind, beverageId: r.beverageId, profileId: r.profileId ?? null, exact: r.exact, params: r.params, hex: r.hex });
        return done(`${r.kind === "bounds" ? "bornes" : "valeurs"} ${BEVERAGES[r.beverageId] ?? r.beverageId}, ${r.params.length} paramètres${r.exact ? "" : " ⚠ désalignement"}`);
      }
      case 0xa4:
      case 0xaa: {
        const kind = cmd === 0xa4 ? "profileNames" : "customNames";
        const r = decodeNames(value, STRIDE_CLASSIC);
        putProp(name, { at: Date.now(), kind, first: r.first, last: r.last, stride: r.stride, offset: r.offset, exact: r.exact, entries: r.entries, hex: r.hex });
        const named = r.entries.filter((e) => e.name).map((e) => e.name);
        return done(`${r.entries.length} noms${named.length ? " (" + named.join(", ") + ")" : " (tous vides)"}`);
      }
      case 0xa8: {
        const r = decodePriorities(value);
        putProp(name, { at: Date.now(), kind: "priority", profileId: r.profileId, beverageIds: r.beverageIds, hex: r.hex });
        return done(`ordre profil ${r.profileId} → ${r.beverageIds.join(",")}`);
      }
      case 0xba: {
        const bs = decodeBeanSystem(value);
        putProp(name, { at: Date.now(), kind: "beanSystem", index: bs.index, hex: bs.hex });
        putBeanSystem(bs);
        return done(`bean system ${bs.index} « ${bs.name ?? "sans nom"} » mouture=${bs.grinder} temp=${bs.temperature} arôme=${bs.aroma}${bs.active ? " · ACTIF" : ""}${bs.visible ? "" : " · masqué"}`);
      }
      case 0xa2: {
        const pr = decodeParameters(value);
        putProp(name, { at: Date.now(), kind: "parameters", entries: pr.entries, hex: pr.hex });
        putStats(pr.entries);
        return done(`${pr.entries.length} paramètre(s) : ${pr.entries.map((e) => `${e.id}=${e.value}`).join(", ")}`);
      }
      case 0xa3: {
        const cs = decodeChecksums(value);
        putChecksums(cs);
        return done(`sommes de contrôle : ${cs.size} profils, noms=0x${cs.names.toString(16)}`);
      }
      default: {
        const hex = Buffer.from(value, "base64").toString("hex").replace(/(..)/g, "$1 ").trim();
        putProp(name, { at: Date.now(), kind: "unknown", cmd: cmd ?? null, hex });
        return done(`commande 0x${(cmd ?? 0).toString(16)} non décodée — ${hex}`);
      }
    }
  } catch (e) {
    return failed(e);
  }
}

/** Réponse ECAM à une de nos commandes. Les sommes de contrôle arrivent parfois par ici. */
function handleDataResponse(value) {
  const buf = Buffer.from(value, "base64");
  const hex = buf.toString("hex").replace(/(..)/g, "$1 ").trim();
  S.lastDataResponse = { at: Date.now(), hex };
  L("in", `data_response: ${hex}`);
  if (buf[2] === 0xa2) {
    try {
      const pr = decodeParameters(value);
      putStats(pr.entries);
      L("in", `paramètres : ${pr.entries.map((e) => `${e.id}=${e.value}`).join(", ")}`);
    } catch (e) {
      L("in", `paramètres : décodage impossible (${e.message})`);
    }
    return;
  }
  if (buf[2] === 0xa3) {
    try {
      const cs = decodeChecksums(value);
      // `putChecksums` décale l'ancien relevé vers `checksumsPrev` et rend le couple : c'est lui
      // qui dit ce qui a bougé, il est écrit dans une seule transaction.
      const { prev, current } = putChecksums(cs);
      const changed = diffChecksums(prev, current);
      L("in", `sommes de contrôle : ${cs.size} profils, noms=0x${cs.names.toString(16)}, perso=0x${cs.customRecipes.toString(16)}${changed.length ? " — changé : " + changed.join(", ") : prev ? " — rien de changé" : ""}`);
    } catch (e) {
      L("in", `sommes de contrôle : décodage impossible (${e.message})`);
    }
  }
}

/**
 * Noms lus sur la machine, aplatis en « index → entrée ».
 *
 * On scanne le cache par **famille décodée** (`kind`), pas par liste de propriétés attendues :
 * la machine peut répondre sur une propriété qu'on n'avait pas prévue (elle l'a fait pour les
 * Bean Systems), et un nom reçu doit compter quelle que soit la propriété qui l'a porté.
 * Chaque bloc annonce son index de départ ; la première variante qui donne un nom non vide gagne.
 *
 * Partagé par /api/profiles ET /api/beverages : c'est ce qui garantit qu'un emplacement renommé
 * sur la machine porte le même nom partout.
 */
function readNames(store, kind) {
  const out = {};
  for (const [prop, data] of Object.entries(store.props ?? {})) {
    if (data?.kind !== kind || data.absent || !Array.isArray(data.entries)) continue;
    data.entries.forEach((e, i) => {
      const idx = (data.first ?? 1) + i;
      if (out[idx]?.name) return;
      out[idx] = { ...e, prop, stride: data.stride ?? null };
    });
  }
  return out;
}

/**
 * id de boisson → nom donné sur la machine, pour les emplacements personnalisables.
 *
 * **Uniquement les recettes personnalisées** (emplacement n → boisson 229 + n, noms `0xAA`).
 *
 * ⚠️ Ne PAS y mettre les noms de Bean System. Ce sont deux natures différentes : un Bean System est
 * une **configuration de grains** (mouture/température/arôme, nommée d'après la marque du café —
 * « Grain A », « Grain B »), pas une boisson. Une version précédente mappait « bean system n →
 * boisson 199 + n » et écrasait ainsi le nom de la boisson 200 par celui du grain : la première
 * carte de la page s'appelait « Grain A » au lieu de l'espresso qu'elle prépare. Le grain associé
 * s'expose comme **attribut** de la boisson (voir `activeBeanSystem`), jamais comme son nom.
 */
function machineBeverageNames(store) {
  const out = {};
  for (const [slot, entry] of Object.entries(readNames(store, "customNames"))) {
    if (entry?.name) out[229 + Number(slot)] = { name: entry.name, icon: entry.icon, prop: entry.prop, source: "recette perso" };
  }
  return out;
}

/**
 * Configuration de grains actuellement sélectionnée sur la machine (octet 50 de la trame `0xBA`).
 * C'est elle qui détermine la tasse pour la boisson Bean System, donc on l'expose comme attribut.
 */
function activeBeanSystem(store) {
  for (const [index, bs] of Object.entries(store.beanSystems ?? {})) {
    if (bs?.active && Number(index) >= 1) {
      return { index: Number(index), name: bs.name, grinder: bs.grinder, temperature: bs.temperature, aroma: bs.aroma };
    }
  }
  return null;
}

/** Familles dont la somme de contrôle a bougé entre deux relevés. */
function diffChecksums(prev, cur) {
  if (!prev || !cur) return [];
  const out = [];
  if (prev.names !== cur.names) out.push("noms");
  if (prev.customRecipes !== cur.customRecipes) out.push("recettes perso");
  for (const k of Object.keys(cur.profiles ?? {})) {
    if (prev.profiles?.[k] !== cur.profiles[k]) out.push(`profil ${k}`);
  }
  return out;
}

/**
 * Ce qui est périmé dans le cache : on compare la somme actuelle à celle relevée lors du dernier
 * import réussi. `null` = on ne sait pas (jamais relevé), ce qui n'est pas la même chose que
 * « à jour ».
 */
function staleFromChecksums(store) {
  const cur = store.checksums;
  const ref = store.checksumsAtImport;
  if (!cur) return null;
  const cmp = (a, b) => (a == null || b == null ? null : a !== b);
  return {
    names: cmp(ref?.names, cur.names),
    customRecipes: cmp(ref?.customRecipes, cur.customRecipes),
    profiles: Object.fromEntries(Object.keys(cur.profiles ?? {}).map((k) => [k, cmp(ref?.profiles?.[k], cur.profiles[k])])),
  };
}

/**
 * Compteurs dont la signification est **établie** — lue dans `p018b7/e.java`, qui associe chaque
 * identifiant de paramètre à une entrée de l'énumération `p258z7/w.java$a` :
 *
 *   105 → TOTAL_DESCALES     108 → TOTAL_FILTERS      115 → TOTAL_MILK_CLEANS
 *   106 → TOTAL_LITRES_WATER (unité = 0,5 ml, donc litres = valeur / 2000)
 *   3000 → TOTAL_BEVERAGE_BLACK          3001 + 3003 → TOTAL_BEVERAGE_WITH_HOT_MILK
 *   3017 → TOTAL_BEVERAGE_WITH_COLD_MILK (Maestosa seulement)
 *   3021 → TOTAL_CHOCO                   3025 → TOTAL_TEA
 *
 * ⚠️ **La machine ne compte pas boisson par boisson, mais par catégorie.** Le seul compteur propre
 * à une boisson est celui du thé (et l'app a une propriété `d719_id22_tea` qui le confirme : 22 est
 * bien l'id du thé). Ne jamais présenter l'un de ces nombres comme « le nombre d'espressos ».
 *
 * Les 62 identifiants existent sur la machine ; seuls ceux-ci ont un sens connu. Les autres restent
 * exposés bruts par `/api/stats`.
 */
const STAT_MEANINGS = {
  105: { key: "descales" },
  106: { key: "waterLitres", divisor: 2000 },
  108: { key: "filters" },
  115: { key: "milkCleans" },
  3000: { key: "beverageBlack" },
  3001: { key: "beverageHotMilk" },
  3003: { key: "beverageHotMilkExtra" },
  3017: { key: "beverageColdMilk" },
  3021: { key: "choco" },
  3025: { key: "tea" },
};

/**
 * Compteur à rattacher à une boisson. C'est celui de sa **catégorie**, pas de la tasse : voir
 * l'avertissement ci-dessus. `null` quand aucune catégorie connue ne s'applique (eau chaude, mug de
 * voyage — dont le total vit dans `d731/d732`, sans identifiant de paramètre connu).
 */
function beverageCounter(store, bev) {
  const stats = store.stats ?? {};
  const pick = (id, category) => {
    const s = stats[id];
    return s === undefined ? null : { id, value: s.value, at: s.at, category, scope: "category" };
  };
  if (bev.id === 22) return pick(3025, "tea");
  if (bev.id === 16) return null; // eau chaude : aucune catégorie de boisson
  if (bev.id === 26) return null; // mug de voyage : total dans d731/d732, pas d'id connu
  if (bev.milk) return pick(3001, "beverageHotMilk");
  return pick(3000, "beverageBlack");
}

/**
 * Identifiants de paramètres que l'app demande sur son écran de statistiques
 * (`p018b7/e.java`, `readSettingsParameter`). Aucune table de l'APK ne les nomme : le viewmodel les
 * lit par id et affiche le résultat via les propriétés `d7xx_tot_*`. La correspondance
 * id → signification reste donc à établir sur la machine.
 */
const APP_STAT_IDS = [105, 106, 108, 115, 3000, 3001, 3003, 3017, 3021, 3025, 3047, 3048, 3077, 3078, 3080];

/** Propriétés dont la lecture est couverte par la somme de contrôle « noms » (trame `0xA3`). */
const NAME_PROPS = new Set([...PROFILE_NAME_PROPS, ...CUSTOM_NAME_PROPS].map((x) => x.prop));

/**
 * Marque « cette famille est à jour », posée à la FIN d'un import et seulement s'il a tout lu.
 *
 * Une propriété absente sur ce modèle (variantes Striker) compte comme lue, pas comme un échec :
 * c'est `handleProperty` qui la range dans `ok` avec `absent: true`.
 */
function applyChecksumMark(im) {
  const mark = im.checksumMark;
  if (!mark) return;
  const missing = (im.covered ?? []).filter((p) => !im.ok.includes(p));
  if (im.fail.length || missing.length) {
    L("sys", `sommes non mémorisées : ${im.fail.length} échec(s), ${missing.length} sans réponse — la relecture restera proposée`);
    return;
  }
  setMeta("checksumsAtImport", { ...(getMeta("checksumsAtImport") ?? {}), ...mark });
  L("sys", `somme des noms mémorisée (0x${Number(mark.names).toString(16)}) : inutile de les relire tant qu'elle ne bouge pas`);
}

/** GET http://<machine>/regtoken.json — le seul endpoint que le module expose hors mode AP. */
function probeRegtoken() {
  // Sans adresse, il n'y a personne à interroger : on répond « injoignable » plutôt que de
  // laisser node:http composer un hôte nul.
  if (!CFG.machineIp) return Promise.resolve({ reachable: false, error: "adresse de la machine non configurée", at: Date.now() });
  // `host` est renvoyé avec le résultat : l'adresse peut changer pendant que la requête est en
  // vol, et le résultat doit rester attribuable à l'adresse réellement interrogée.
  const host = CFG.machineIp;
  return new Promise((resolve) => {
    const r = httpRequest({ host, port: 80, path: "/regtoken.json", method: "GET" }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => {
        const body = Buffer.concat(c).toString("utf8");
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        resolve({ host, reachable: true, status: res.statusCode, regtoken: parsed, at: Date.now() });
      });
    });
    r.on("error", (e) => resolve({ host, reachable: false, error: e.message, at: Date.now() }));
    r.setTimeout(4000, () => r.destroy(new Error("timeout")));
    r.end();
  });
}

// --- clé LAN : découverte à la demande via le compte De'Longhi ------------------------------
// Strictement OPTIONNEL et sur action explicite de l'utilisateur. Le pilotage, lui, reste
// 100 % local : une fois la clé obtenue, plus aucun appel au cloud.
/**
 * Reprise de la clé LAN mémorisée lors d'une découverte précédente (table `meta`, clé `lanKey`).
 * C'est du matériel secret : le fichier `data/lan-server.db` doit être traité comme tel.
 */
function restoreLanKey() {
  if (CFG.lanKey.length) return;
  try {
    const s = getLanKey();
    if (s?.lanip_key && s?.lanip_key_id) {
      CFG.lanKey = Buffer.from(String(s.lanip_key), "utf8");
      CFG.lanKeyId = Number(s.lanip_key_id);
      CFG.lanKeySource = `cache local (découverte du ${new Date(s.at).toISOString().slice(0, 10)})`;
      L("sys", `clé LAN reprise du cache (key_id ${CFG.lanKeyId})`);
    }
  } catch {}
}

/**
 * Appel REST Gigya. Le centre de données compte : la clé API De'Longhi est servie par **eu1**
 * (`us1` répond `301001 This API key is served by another data center`). Réglable par
 * `GIGYA_DATACENTER`.
 *
 * Gigya répond toujours HTTP 200 : c'est `errorCode` qui porte le verdict.
 */
async function gigyaCall(method, params) {
  const dc = APP.gigyaDatacenter;
  const r = await fetch(`https://accounts.${dc}.gigya.com/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, format: "json" }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`${method} : réponse illisible (HTTP ${r.status})`);
  // On ne réécrit pas les messages de Gigya : ils sont plus précis que ce qu'on inventerait.
  // Relevés en sonde : 403042 « invalid loginID or password », 301001 mauvais centre de données,
  // 403005 jeton de session refusé.
  if (j.errorCode) {
    const detail = j.errorDetails ? ` — ${j.errorDetails}` : "";
    throw new Error(`${method} (${dc}) : ${j.errorMessage} [${j.errorCode}]${detail}`);
  }
  return j;
}

/**
 * Obtient la clé LAN de la machine à partir des identifiants du compte De'Longhi.
 *
 * Quatre sauts, tous vérifiés contre les vrais serveurs (voir ETAT.md) :
 *   1. Gigya `accounts.login`      e-mail + mot de passe → `sessionInfo.cookieValue`
 *   2. Gigya `accounts.getJWT`     `login_token`         → `id_token` (JWT RS256)
 *   3. Ayla  `token_sign_in.json`  JWT + app_id/secret   → `access_token` (24 h)
 *   4. Ayla  `dsns/<DSN>/lan.json` access_token          → `lanip_key` + `lanip_key_id`
 *
 * Un `jwt` déjà en main (celui que `docs/secrets.md` documente, valable 90 jours) court-circuite
 * les deux premiers sauts — c'est aussi ce qui permet de tester la moitié Ayla sans mot de passe.
 *
 * ⚠️ **Le mot de passe ne sort pas de cette fonction** : il n'est ni journalisé, ni mémorisé, ni
 * renvoyé. Les jetons intermédiaires (session Gigya, JWT, token Ayla) ne sont pas conservés non
 * plus — seule la clé LAN l'est, dans `data/lan-server.db` (table `meta`, clé `lanKey`, gitignoré).
 *
 * Les valeurs statiques de l'APK (clé API Gigya, app_id/app_secret Ayla) ne sont plus à saisir :
 * elles ne sont pas secrètes et vivent dans `src/lib/cloud-app.json`. Voir `APP`.
 */
async function discoverLanKey({ email, password, jwt: givenJwt }) {
  const apiKey = APP.gigyaApiKey;
  const appId = APP.aylaAppId;
  const appSecret = APP.aylaAppSecret;
  // Le contrôle reste : les valeurs sont fournies par défaut, mais une variable mise à la chaîne
  // vide — ou un cloud-app.json amputé — doit dire pourquoi la découverte ne part pas, plutôt que
  // d'échouer trois requêtes plus loin sur un message de Gigya.
  // (Un JWT fourni court-circuite Gigya : seules les valeurs Ayla sont alors nécessaires.)
  const missing = [
    !givenJwt && !apiKey && "clé API Gigya",
    !appId && "app_id Ayla",
    !appSecret && "app_secret Ayla",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`configuration de découverte incomplète : ${missing.join(", ")} — valeurs statiques de l'APK, normalement fournies par src/lib/cloud-app.json`);
  }
  const dsn = await resolveDsn();
  // Le DSN est la seule dépendance de la découverte envers la machine — et une fois mémorisé,
  // elle n'a plus besoin d'elle du tout. Le message doit donc désigner l'action qui débloque.
  if (!dsn) throw new Error("DSN inconnu : la clé est rangée sous le numéro de série de la machine, que le serveur obtient en l'interrogeant. Renseigner l'adresse de la machine (page « Clé LAN »), ou forcer MACHINE_DSN dans .env.local.");

  let jwt = givenJwt;
  if (jwt) {
    L("sys", "clé LAN : JWT fourni, Gigya court-circuité");
  } else {
    L("sys", "clé LAN : connexion au compte De'Longhi…");
    // ⚠️ PAS de `targetEnv: "mobile"`. Sondé sur les vrais serveurs, avec le même compte :
    //   targetEnv=mobile  → sessionInfo = { sessionToken, sessionSecret, expires_in }
    //   défaut (browser)  → sessionInfo = { cookieName, cookieValue }
    // Une session mobile est une session OAuth1 : son `sessionToken` sert à SIGNER les requêtes
    // suivantes, ce n'est pas un `login_token`. Le passer tel quel à `accounts.getJWT` répond
    // « Unauthorized user [403005] » — c'est exactement ce qui faisait échouer la découverte
    // alors que l'app Android fonctionnait (elle, elle signe, via le SDK Gigya mobile).
    const login = await gigyaCall("accounts.login", { apiKey, loginID: email, password });
    // Uniquement `cookieValue` : l'ancien repli sur `sessionToken` ne rattrapait rien, il
    // transmettait un jeton du mauvais type au lieu d'échouer avec un message clair.
    const loginToken = login?.sessionInfo?.cookieValue;
    if (!loginToken) throw new Error("accounts.login : pas de sessionInfo.cookieValue dans la réponse (session non navigateur ?)");

    jwt = (await gigyaCall("accounts.getJWT", { apiKey, login_token: loginToken }))?.id_token;
    if (!jwt) throw new Error("accounts.getJWT : aucun id_token dans la réponse");
    L("sys", "clé LAN : identité De'Longhi obtenue, échange vers Ayla…");
  }

  const tr = await fetch(`${APP.aylaUserUrl}/api/v1/token_sign_in.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: jwt, app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(20000),
  });
  const tj = await tr.json().catch(() => null);
  const accessToken = tj?.access_token;
  if (!accessToken) throw new Error(`token_sign_in : pas de access_token (HTTP ${tr.status}${tj?.error ? " " + tj.error : ""})`);

  L("sys", `clé LAN : lecture de lan.json pour ${dsn}…`);
  const lr = await fetch(`${APP.aylaDeviceUrl}/apiv1/dsns/${dsn}/lan.json`, {
    headers: { Authorization: `auth_token ${accessToken}` },
    signal: AbortSignal.timeout(20000),
  });
  const lj = await lr.json().catch(() => null);
  const lanip = lj?.lanip;
  if (!lanip?.lanip_key || lanip?.lanip_key_id === undefined) {
    throw new Error(`lan.json : réponse inattendue (HTTP ${lr.status})`);
  }
  return { key: String(lanip.lanip_key), keyId: Number(lanip.lanip_key_id), status: lanip.status, keepAlive: lanip.keep_alive };
}

/**
 * Applique une clé LAN fraîchement obtenue. La session en cours a été dérivée de l'ANCIENNE clé :
 * elle devient inutilisable, on la jette pour forcer un nouveau key exchange.
 */
function applyLanKey({ key, keyId }, source) {
  const changed = key !== CFG.lanKey.toString("utf8") || keyId !== CFG.lanKeyId;
  CFG.lanKey = Buffer.from(key, "utf8");
  CFG.lanKeyId = keyId;
  CFG.lanKeySource = source;
  if (changed && S.session) {
    S.session = null;
    L("sys", "clé LAN changée : session LAN abandonnée, un nouveau key exchange est nécessaire");
  }
  setLanKey(key, keyId);
  L("sys", `clé LAN ${changed ? "mise à jour" : "confirmée"} (key_id ${keyId}, source : ${source})`);
  return changed;
}

/**
 * Résout le DSN. Trois sources, par ordre de priorité :
 *
 *   1. `MACHINE_DSN` dans `.env.local` — un réglage explicite gagne toujours ;
 *   2. **la machine elle-même** : `GET /regtoken.json` (le seul endpoint que le module expose hors
 *      mode AP) renvoie `host_symname`, qui EST le DSN — vérifié sur cette machine. Sans
 *      authentification, sans cloud ;
 *   3. le cache local (`restoreDsn`), pour redémarrer quand la machine ne répond pas.
 *
 * `compare: true` interroge la machine même si le DSN est déjà connu, pour signaler une divergence
 * au lieu de la laisser passer.
 */
let dernierEssaiDsn = 0;
async function resolveDsn({ compare = false } = {}) {
  if (CFG.dsn && !compare) return CFG.dsn;
  // Sans cela, la resolution paresseuse en tete de handleApi lance une sonde de 4 s a CHAQUE
  // appel d API tant que le DSN est inconnu — or les pages interrogent /api/status toutes les
  // 3 s. Resultat : le reseau martele et le journal noye sous des lignes identiques. Une
  // tentative toutes les 30 s suffit ; `compare` (action explicite) n est jamais bride.
  if (!compare) {
    if (Date.now() - dernierEssaiDsn < 30000) return CFG.dsn;
    dernierEssaiDsn = Date.now();
  }
  const r = await probeRegtoken();
  // L'adresse a pu changer pendant la requête (saisie d'une nouvelle machine, oubli). Attribuer
  // le DSN d'un ancien appareil à la nouvelle adresse serait faux — et c'est arrivé : une sonde
  // lancée au démarrage a repeuplé, 186 ms plus tard, un DSN qu'un changement d'adresse venait
  // d'effacer.
  if (r?.host && r.host !== CFG.machineIp) {
    L("sys", `sonde ignorée : la réponse venait de ${r.host}, l'adresse est maintenant ${CFG.machineIp ?? "inconnue"}`);
    return CFG.dsn;
  }
  const found = r?.regtoken?.host_symname;
  if (typeof found !== "string" || !/^[A-Za-z0-9-]{6,}$/.test(found)) {
    // « Joignable » ne veut pas dire « c'est la machine » : n'importe quel serveur HTTP à cette
    // adresse répond quelque chose. Distinguer les deux cas est ce qui rend le diagnostic possible.
    if (!CFG.dsn) {
      L("sys", r?.reachable
        ? `DSN inconnu : ${r.host} a répondu HTTP ${r.status} à /regtoken.json, mais sans host_symname — ce n'est probablement pas la cafetière`
        : `DSN inconnu : aucune réponse de ${r?.host ?? "(adresse non configurée)"} (${r?.error ?? "pas de détail"}), et MACHINE_DSN n'est pas défini`);
    }
    return CFG.dsn;
  }
  if (CFG.dsn && CFG.dsn !== found) {
    L("sys", `⚠ DSN divergent : ${CFG.dsnSource} donne ${CFG.dsn}, la machine annonce ${found}. Le réglage explicite reste prioritaire — retirer MACHINE_DSN de .env.local pour suivre la machine.`);
  } else if (!CFG.dsn) {
    CFG.dsn = found;
    CFG.dsnSource = "machine (regtoken.json)";
    L("sys", `DSN découvert sur la machine : ${found}`);
  }
  // Mémorisé pour pouvoir redémarrer sans la machine.
  try { setMeta("dsn", { value: found, at: Date.now() }); } catch {}
  return CFG.dsn;
}

/**
 * Adresse de la machine : nom d'hôte ou IPv4. On accepte les deux — le champ `host` de `node:http`
 * ne fait pas la différence, et un nom d'hôte protège d'un changement de bail DHCP.
 */
const MACHINE_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
function validMachineHost(v) {
  return typeof v === "string" && MACHINE_HOST_RE.test(v.trim());
}

/** Reprise de l'adresse saisie précédemment. `MACHINE_IP` reste prioritaire. */
function restoreMachineIp() {
  if (CFG.machineIp) return;
  try {
    const saved = getMeta("machineIp");
    if (saved?.value) {
      CFG.machineIp = saved.value;
      CFG.machineIpSource = "saisie dans l'interface";
      L("sys", `adresse de la machine reprise du cache : ${saved.value}`);
    }
  } catch {}
}

/**
 * Applique une adresse saisie. Changer de machine invalide deux choses dérivées de l'ancienne :
 * la session LAN (dérivée d'un échange de clés avec elle) et le DSN mémorisé, qui est le numéro
 * de série de l'ANCIEN appareil. Un `MACHINE_DSN` explicite, lui, reste prioritaire.
 */
function applyMachineIp(ip) {
  const value = ip.trim();
  const changed = value !== CFG.machineIp;
  // On n'efface le DSN que si l'on REMPLACE une adresse connue par une autre : ce peut alors être
  // un autre appareil. Passer de « aucune adresse » à une adresse n'indique rien de tel — et
  // l'effacer là faisait perdre un DSN parfaitement valide juste après un oubli d'adresse, laissant
  // la récupération de clé sans rien à quoi se raccrocher.
  const remplace = changed && CFG.machineIp !== null;
  CFG.machineIp = value;
  CFG.machineIpSource = "saisie dans l'interface";
  setMeta("machineIp", { value, at: Date.now() });
  if (remplace) {
    S.session = null;
    if (!process.env.MACHINE_DSN) {
      CFG.dsn = null;
      CFG.dsnSource = "inconnu";
      clearMeta("dsn");
    }
    L("sys", `adresse de la machine changée : ${value} — session et DSN mémorisé abandonnés`);
  } else {
    L("sys", `adresse de la machine confirmée : ${value}`);
  }
  return changed;
}

/** Reprise du DSN mémorisé, avant toute interrogation de la machine. */
function restoreDsn() {
  if (CFG.dsn) return;
  try {
    const saved = getMeta("dsn");
    if (saved?.value) {
      CFG.dsn = saved.value;
      CFG.dsnSource = "cache local";
      L("sys", `DSN repris du cache : ${saved.value}`);
    }
  } catch {}
}

/**
 * Enregistre l'identification déduite de `d270_serialnumber`.
 *
 * ⚠️ Le modèle détecté n'est **pas** appliqué au catalogue. `machine-model.json` reste la seule
 * table active : la faire dépendre d'une détection changerait l'adressage des propriétés de
 * recette (`d{39+i+(p-1)*21}` — ce 21 est le nombre de recettes standard DU modèle), donc les
 * lectures elles-mêmes. Ici on identifie, on mémorise, et on SIGNALE un écart. Basculer le
 * catalogue est une décision, pas un effet de bord.
 */
function applyIdentity(b64) {
  const r = identifyModel(b64);
  if (!r.ok) {
    S.identity = { at: Date.now(), ok: false, reason: r.reason, hex: r.hex };
    L("in", `${SERIAL_PROP} : ${r.reason} — trame ${r.hex || "(vide)"}`);
    return;
  }
  S.identity = { at: Date.now(), ok: true, serial: r.serial, machineName: r.machineName, modelKey: r.modelKey, hex: r.hex };
  // La propriété est rangée comme les autres : `/api/system` expose déjà
  // `machineState.serialNumber` depuis `props.d270_serialnumber`, et la trame brute permet de
  // rejuger la découpe sans redemander à la machine.
  putProp(SERIAL_PROP, { at: Date.now(), kind: "serialNumber", serial: r.serial, machineName: r.machineName, modelKey: r.modelKey, hex: r.hex });
  setMeta("model", { key: r.modelKey, serial: r.serial, machineName: r.machineName, at: Date.now() });
  if (!process.env.MACHINE_MODEL_KEY) {
    CFG.modelKey = r.modelKey;
    CFG.modelSource = "lu sur la machine";
  }
  const lu = r.model
    ? `${r.model.type} — ${r.model.appModelId}, ${r.model.recipeCount} recettes, ${r.model.nProfiles} profils`
    : `modèle absent de la table v${MODELS_TABLE_VERSION} (${Object.keys(MODELS).length} modèles connectés connus)`;
  L("in", `${SERIAL_PROP} : ${r.machineName} → clé ${r.modelKey} → ${lu}`);
  const attendu = MODEL.productCode.slice(-5);
  if (r.modelKey !== attendu) {
    L("sys", `⚠ écart de modèle : la machine dit ${r.modelKey}, le catalogue actif est ${MODEL.type} (${attendu}). Les identifiants de boisson et les noms de propriétés de recette ne correspondent probablement pas — voir la page Système.`);
  }
}

/** Le modèle survit à un redémarrage : sinon la page Système redeviendrait muette hors session. */
function restoreModel() {
  if (CFG.modelKey) return;
  try {
    const saved = getMeta("model");
    if (!saved?.key) return;
    CFG.modelKey = saved.key;
    CFG.modelSource = "cache local";
    const m = findModel(saved.key);
    S.identity = { at: saved.at ?? null, ok: true, serial: saved.serial ?? null, machineName: saved.machineName ?? null, modelKey: saved.key, hex: null, restored: true };
    L("sys", `modèle repris du cache : ${saved.key}${m ? ` (${m.type})` : " (inconnu de la table)"}`);
  } catch {}
}

/** Ce que les pages affichent : le modèle lu, le catalogue actif, et l'écart entre les deux. */
function modelState() {
  const detected = CFG.modelKey ? findModel(CFG.modelKey) : null;
  const catalogKey = MODEL.productCode.slice(-5);
  return {
    key: CFG.modelKey,
    source: CFG.modelSource,
    serialProp: SERIAL_PROP,
    tableVersion: MODELS_TABLE_VERSION,
    knownModels: Object.keys(MODELS).length,
    detected,
    // Le catalogue réellement utilisé pour bâtir les trames et nommer les propriétés.
    catalog: { key: catalogKey, productCode: MODEL.productCode, type: MODEL.type, appModelId: MODEL.appModelId, nProfiles: MODEL.nProfiles, nStandardRecipes: MODEL.nStandardRecipes, nCustomRecipes: MODEL.nCustomRecipes },
    // null = pas encore lu. false = écart, et alors le catalogue actif est probablement faux.
    matchesCatalog: CFG.modelKey ? CFG.modelKey === catalogKey : null,
    serial: S.identity?.serial ?? null,
    machineName: S.identity?.machineName ?? null,
    at: S.identity?.at ?? null,
    restored: S.identity?.restored === true,
    lastError: S.identity && S.identity.ok === false ? { reason: S.identity.reason, hex: S.identity.hex } : null,
  };
}

/**
 * Vérification OTA côté cloud. Nécessite un token Ayla dans AYLA_TOKEN — volontairement optionnel :
 * le projet vise le 100 % local, et un token n'a pas à être exigé pour afficher cette page.
 */
async function probeCloudOta() {
  const token = process.env.AYLA_TOKEN;
  if (!token) return { configured: false, note: "AYLA_TOKEN absent de .env.local — vérification cloud désactivée." };
  if (!CFG.dsn) return { configured: false, note: "DSN encore inconnu — la machine n'a pas répondu." };
  const url = `${APP.aylaDeviceUrl}/apiv1/dsns/${CFG.dsn}/ota.json`;
  try {
    const r = await fetch(url, { headers: { Authorization: `auth_token ${token}` }, signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { configured: true, status: r.status, updateAvailable: r.status === 200 && !!parsed, body: parsed, at: Date.now() };
  } catch (e) {
    return { configured: true, error: e.message, at: Date.now() };
  }
}

/**
 * Le profil actif est une **intention de notre part**, pas une observation : la machine ne
 * l'expose pas (aucune réponse à `d286_mach_sett_profile`), et l'app officielle ne le lit pas
 * davantage — `EcamMachine.B()` renvoie un état local initialisé à 1. On persiste donc le dernier
 * profil qu'on a imposé, pour ne pas repartir d'un « profil 1 » faux après un redémarrage du
 * serveur, tout en gardant `confirmed` qui dit s'il vient d'une commande réelle.
 */
function rememberActiveProfile() {
  try {
    setMeta("activeProfile", { id: S.activeProfile, confirmed: S.activeProfileConfirmed, at: Date.now() });
  } catch {}
}

function restoreActiveProfile() {
  try {
    const saved = getMeta("activeProfile");
    if (saved?.id) {
      S.activeProfile = saved.id;
      S.activeProfileConfirmed = saved.confirmed === true;
      L("sys", `profil actif restauré : ${saved.id}${saved.confirmed ? "" : " (non confirmé)"}`);
    }
  } catch {}
}

/**
 * Enchaîne un `0xBA` par index. Un intervalle fixe suffit : la machine répond en 2-3 s, et le
 * programme précédent doit être clos avant le suivant, sinon `startProgram` l'écraserait.
 */
function scanNextBean() {
  const sc = S.beanScan;
  if (!sc?.active) return;
  if (sc.next > sc.to) {
    sc.active = false;
    L("sys", "balayage des grains terminé");
    return;
  }
  const index = sc.next++;
  startProgram(datapointValue(frameBeanSystem(index)), `Bean System ${index}`, 9000, "monitor");
  postLocalReg();
  setTimeout(scanNextBean, 11000);
}

/**
 * Enchaîne les lectures de paramètres, une trame `0xA2` à la fois. Même cadence que le balayage
 * des grains, qui est validée : la machine répond en 2-3 s et le programme précédent doit être clos
 * avant le suivant.
 */
function scanNextStat() {
  const sc = S.statScan;
  if (!sc?.active) return;
  const next = sc.queue.shift();
  if (next === undefined) {
    sc.active = false;
    L("sys", `lecture des statistiques terminée (${countStats()} paramètres connus)`);
    return;
  }
  startProgram(datapointValue(frameParamRead(next.id, next.qty)), `Paramètres ${next.id}${next.qty > 1 ? `+${next.qty - 1}` : ""}`, 9000, "monitor");
  postLocalReg();
  setTimeout(scanNextStat, 11000);
}

// La persistance vit maintenant dans `src/lib/store.mjs` (SQLite). Les écritures sont ciblées
// (`putProp`, `putStats`, `putChecksums`, `setMeta`) ; `machineView()` reste la vue d'ensemble en
// lecture, pour les endpoints qui parcourent tout le cache.

/**
 * Endpoints qui ne peuvent RIEN faire sans les deux prérequis : l'adresse de la machine et la clé
 * LAN. Ils mettent en file une trame que seule une session chiffrée peut transporter. Sans clé, la
 * machine se présente, reçoit un 412 à l'échange de clés et repart ; sans adresse, on ne peut même
 * pas lui annoncer notre existence. Dans les deux cas la commande serait acceptée puis
 * silencieusement perdue, et l'interface annoncerait « envoyé » pour un ordre qui n'atteindra
 * jamais la machine.
 *
 * Seules les écritures (POST) sont bloquées : les lectures continuent de servir le cache déjà
 * constitué, qui reste parfaitement consultable.
 */
const NEEDS_MACHINE = [
  "/api/command",
  "/api/presence",
  "/api/model",
  "/api/register",
  "/api/checksums",
  "/api/stats",
  "/api/beansystem",
  "/api/beanadapt",
  "/api/beverages/import",
  "/api/profiles/import",
];

// --- API de contrôle ---
async function handleApi(req, res) {
  const url = req.url.split("?")[0];
  // Le DSN part dans CHAQUE écriture de propriété servie à la machine : on s'assure de le
  // connaître avant d'agir. Ne coûte une requête que tant qu'il est inconnu.
  if (!CFG.dsn) await resolveDsn();
  // Refus franc plutôt qu'un succès trompeur (voir NEEDS_MACHINE). Les drapeaux permettent à une
  // interface de réagir sans analyser le texte du message.
  if (req.method === "POST" && NEEDS_MACHINE.some((p) => url === p || url.startsWith(`${p}/`))) {
    if (!CFG.machineIp) {
      return raw(res, JSON.stringify({
        error: "adresse de la machine non configurée : la renseigner sur la page « Clé LAN », ou par MACHINE_IP dans .env.local.",
        needsMachineIp: true,
      }), 409);
    }
    if (!CFG.lanKey.length) {
      return raw(res, JSON.stringify({
        error: "clé LAN absente : aucune session chiffrée n'est possible, la commande n'atteindrait jamais la machine. Renseigner LANIP_KEY dans .env.local, ou récupérer la clé depuis la page « Clé LAN ».",
        needsLanKey: true,
      }), 409);
    }
  }
  if (url === "/api/status") {
    return raw(res, JSON.stringify({
      config: { dsn: CFG.dsn, dsnSource: CFG.dsnSource, machineIp: CFG.machineIp, machineIpSource: CFG.machineIpSource, serverIp: CFG.serverIp, serverPort: CFG.port, generation: CFG.gen, lanKeyId: CFG.lanKeyId, lanKeySet: CFG.lanKey.length > 0, lanKeySource: CFG.lanKeySource },
      // Volontairement léger : /api/status est interrogé toutes les 3 s. La fiche complète du
      // modèle est sur /api/model.
      model: { key: CFG.modelKey, source: CFG.modelSource, matchesCatalog: CFG.modelKey ? CFG.modelKey === MODEL.productCode.slice(-5) : null },
      session: { active: !!S.session }, lastRegisterAt: S.lastRegisterAt, activeProfile: S.activeProfile, activeProfileConfirmed: S.activeProfileConfirmed,
      program: S.program ? { active: S.program.active, label: S.program.label, counter: S.program.counter } : null,
      lastMonitor: S.lastMonitor, lastDataResponse: S.lastDataResponse, log: S.log.slice(0, 50),
    }));
  }
  if (url === "/api/command" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    if (b.action === "clear") { S.program = null; L("sys", "programme annulé"); return raw(res, JSON.stringify({ cleared: true })); }
    let frame, label, dur = 75000, refreshOrderFor = null, sustain = "monitor", checksumBefore;
    // DONTCARE (0) est le mode utilisé pour enregistrer/supprimer une recette (voir
    // DeLonghiWifiConnectService:2959) ; START pour préparer.
    const MODE = { DONTCARE: 0, START: 1, STOPV2: 2 };
    const ACT = { SAVE: 1, PREPARE: 2, PREPARE_INVERSION: 6 };
    // `RecipeData.T()` : l'app choisit l'action « inversion » quand le paramètre INVERSION (12)
    // vaut 1 — c'est le cas du flat white, du cappuccino inversé, du cortado, du long black.
    const inverted = (params) => (params ?? []).some((x) => Number(x.id) === 12 && Number(x.value) === 1);
    try {
      if (b.action === "on") { frame = frameTurnOn(); label = "Allumer"; sustain = "profile"; }
      else if (b.action === "off") { frame = frameTurnOff(); label = "Éteindre"; dur = 20000; }
      else if (b.action === "saveToProfile") {
        // Écriture PERSISTANTE dans la machine : remplace la recette enregistrée de ce profil.
        // Port de DeLonghiWifiConnectService:2959 — mode DONTCARE, action SAVE_BEVERAGE, et le
        // profil visé est encodé dans le dernier octet ((profileId << 2) | action).
        const bev = Number(b.beverageId);
        const prof = Number(b.profileId ?? 1);
        const params = b.params ?? [];
        if (!byId(bev)) return raw(res, JSON.stringify({ error: `boisson ${bev} inconnue` }), 400);
        if (!(prof >= 1 && prof <= MODEL.nProfiles)) return raw(res, JSON.stringify({ error: `profil ${prof} invalide` }), 400);
        if (!params.length) return raw(res, JSON.stringify({ error: "aucun paramètre à enregistrer" }), 400);
        frame = frameDispense(bev, prof, MODE.DONTCARE, ACT.SAVE, params);
        label = `Enregistrer ${BEVERAGES[bev] ?? bev} dans le profil ${prof}`;
        dur = 20000;
        // On renvoie la somme de contrôle du profil AVANT écriture : la redemander ensuite
        // (POST /api/checksums) permet de vérifier que la machine a bien enregistré, au lieu de
        // supposer que l'envoi a suffi.
        checksumBefore = getMeta("checksums")?.profiles?.[prof] ?? null;
      }
      else if (b.action === "selectProfile") {
        S.activeProfile = Number(b.profileId ?? 1);
        S.activeProfileConfirmed = true;
        rememberActiveProfile();
        sustain = "profile";
        frame = frameSendProfile(S.activeProfile);
        label = `Profil ${S.activeProfile}`;
        // Fenêtre courte : juste après, on relit l'ordre d'affichage de ce profil pour que
        // l'UI ne montre pas un ordre périmé (une seule propriété, c'est rapide).
        dur = 10000;
        refreshOrderFor = S.activeProfile;
      }
      else if (b.action === "selectBean") { frame = frameSelectBean(Number(b.beanId ?? 1)); label = `Bean ${b.beanId}`; dur = 20000; }
      else if (b.action === "stop") { frame = frameDispense(Number(b.beverageId ?? 1), Number(b.profileId ?? 1), MODE.STOPV2, ACT.PREPARE, []); label = "Arrêt"; dur = 15000; }
      else if (b.action === "dispense") {
        let bev, prof, params;
        if (b.recipeId) { const r = listRecipes().find((x) => x.id === b.recipeId); if (!r) return raw(res, JSON.stringify({ error: "recette inconnue" }), 404); ({ beverageId: bev, profileId: prof, params } = r); }
        else { bev = Number(b.beverageId ?? 1); prof = Number(b.profileId ?? 1); params = b.params ?? []; }
        S.activeProfile = Number(prof) || 1;
        S.activeProfileConfirmed = true;
        rememberActiveProfile();
        const act = inverted(params) ? ACT.PREPARE_INVERSION : ACT.PREPARE;
        frame = frameDispense(bev, prof, MODE.START, act, params);
        label = `Préparer ${BEVERAGES[bev] ?? bev}${act === ACT.PREPARE_INVERSION ? " (lait d'abord)" : ""}`;
      } else return raw(res, JSON.stringify({ error: "action inconnue" }), 400);
    } catch (e) { return raw(res, JSON.stringify({ error: e.message }), 400); }
    const ecamB64 = datapointValue(frame);
    startProgram(ecamB64, label, dur, sustain);
    // La file de lecture est écoulée quand aucun programme n'est actif : elle s'enchaîne donc
    // naturellement après la fenêtre du programme ci-dessus.
    if (refreshOrderFor) {
      const p = refreshOrderFor;
      startImport([`d${String(260 + p).padStart(3, "0")}_${p}_rec_priority`], 45000);
    }

    const reg = await postLocalReg();
    return raw(res, JSON.stringify({ program: label, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg, ...(checksumBefore !== undefined ? { checksumBefore } : {}) }));
  }
  // Catalogue des boissons de la machine + ce qui a été lu dessus.
  if (url === "/api/beverages" && req.method === "GET") {
    const store = machineView();
    const profileId = Number(new URL(req.url, "http://x").searchParams.get("profile") ?? 1);
    // Une recette perso renommée sur la machine doit s'afficher sous son nom, pas sous le
    // libellé générique du catalogue.
    const machineNames = machineBeverageNames(store);
    const bean = activeBeanSystem(store);
    const beverages = ALL_BEVERAGES.map((b) => {
      const boundsProp = b.bounds;
      const valuesProp = profileProp(b, profileId);
      const bounds = boundsProp ? store.props[boundsProp] ?? null : null;
      const values = valuesProp ? store.props[valuesProp] ?? null : null;
      const named = machineNames[b.id];
      return {
        ...b,
        // Compteur d'usage de la CATÉGORIE de cette boisson (la machine ne compte pas par tasse).
        counter: beverageCounter(store, b),
        // La boisson Bean System porte la configuration de grains active comme ATTRIBUT.
        beanSystem: b.id === 200 ? bean : null,
        label: named?.name ?? b.label,
        catalogLabel: b.label, // libellé générique conservé pour référence
        machineName: named?.name ?? null,
        machineNameProp: named?.prop ?? null,
        icon: named?.icon ?? null,
        boundsProp,
        valuesProp,
        bounds,
        values,
      };
    });
    // Ordre d'affichage de la machine pour ce profil (propriété de priorité), s'il est connu.
    const prioProp = `d${String(260 + profileId).padStart(3, "0")}_${profileId}_rec_priority`;
    const order = store.props[prioProp]?.beverageIds ?? null;
    return raw(res, JSON.stringify({
      model: { type: MODEL.type, appModelId: MODEL.appModelId, productCode: MODEL.productCode, nProfiles: MODEL.nProfiles, protocolVersion: MODEL.protocolVersion },
      categories: CATEGORIES, profileId, beverages, order, orderProp: prioProp,
      importedAt: store.importedAt,
      import: S.import ? { active: S.import.active, remaining: S.import.queue.length, ok: S.import.ok.length, fail: S.import.fail.length, pending: S.import.pending } : null,
    }));
  }

  // Import : lit sur la machine les bornes et/ou les recettes du profil, en LAN pur.
  if (url === "/api/beverages/import" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const profileId = Number(b.profileId ?? 1);
    const what = b.what ?? "all"; // "bounds" | "values" | "all"
    const ids = Array.isArray(b.beverageIds) && b.beverageIds.length ? b.beverageIds.map(Number) : ALL_BEVERAGES.map((x) => x.id);
    const queue = [];
    for (const id of ids) {
      const bev = byId(id);
      if (!bev) continue;
      if (what !== "values" && bev.bounds) queue.push(bev.bounds);
      if (what !== "bounds") { const vp = profileProp(bev, profileId); if (vp) queue.push(vp); }
    }
    if (!queue.length) return raw(res, JSON.stringify({ error: "rien à lire" }), 400);

    // Le nom d'un Bean Adapt ne vient pas d'une propriété de recette mais de la commande ECAM
    // 0xBA. Si la lecture concerne la boisson 200, on l'enchaîne : programme court d'abord, puis
    // la file de lecture s'écoule.
    const beanIndex = ids.includes(200) ? 1 : null;
    startImport(queue, Math.max(60000, queue.length * 3000));
    if (beanIndex !== null) startProgram(datapointValue(frameBeanSystem(beanIndex)), `Bean System ${beanIndex}`, 12000, "monitor");
    const reg = await postLocalReg();
    return raw(res, JSON.stringify({ queued: queue.length, profileId, what, beanSystem: beanIndex, register: reg }));
  }

  // Profils : noms, icônes, noms des recettes perso, ordre des favoris.
  if (url === "/api/profiles" && req.method === "GET") {
    const store = machineView();
    const names = readNames(store, "profileNames");
    const customNames = readNames(store, "customNames");
    // La machine nomme d'office les profils jamais personnalisés (« Profil 4 »). On distingue
    // ce nom par défaut d'un vrai nom choisi par l'utilisateur : la page / n'affiche que
    // les profils réellement renommés.
    const isDefaultName = (n) => n == null || /^profil(e)?\s*\d+$/i.test(n.trim());
    const profiles = Array.from({ length: MODEL.nProfiles }, (_, i) => {
      const id = i + 1;
      const prio = PRIORITY_PROPS.filter((x) => x.profileId === id)
        .map((x) => store.props[x.prop])
        .find((d) => d?.beverageIds?.length);
      const name = names[id]?.name ?? null;
      return {
        id,
        name,
        renamed: name != null && !isDefaultName(name),
        icon: names[id]?.icon ?? null,
        source: names[id]?.prop ?? null,
        order: prio
          ? prio.beverageIds.map((bid) => ({ id: bid, label: byId(bid)?.label ?? null }))
          : null,
      };
    });
    const customs = [1, 2, 3, 4, 5, 6].map((n) => ({
      slot: n,
      beverageId: 229 + n,
      name: customNames[n]?.name ?? null,
      icon: customNames[n]?.icon ?? null,
      source: customNames[n]?.prop ?? null,
    }));
    return raw(res, JSON.stringify({
      model: { type: MODEL.type, nProfiles: MODEL.nProfiles, customizableProfiles: MODEL.customizableProfiles, nCustomRecipes: MODEL.nCustomRecipes },
      profiles, customs,
      props: ALL_PROFILE_PROPS.map((x) => {
        const d = store.props[x.prop];
        return { prop: x.prop, kind: x.kind, stride: x.stride ?? null, state: !d ? "unread" : d.absent ? "absent" : "read" };
      }),
      importedAt: store.importedAt,
      import: S.import ? { active: S.import.active, remaining: S.import.queue.length, ok: S.import.ok.length, fail: S.import.fail.length, pending: S.import.pending } : null,
    }));
  }

  if (url === "/api/profiles/import" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const what = b.what ?? "all"; // "names" | "customNames" | "order" | "all"
    const force = b.force === true;

    // Optimisation par sommes de contrôle (réponse 0xA3) : si la somme des noms n'a pas bougé
    // depuis le dernier import réussi, les relire ne peut rien apprendre. `force` court-circuite.
    const store = machineView();
    const stale = staleFromChecksums(store);
    const skipped = [];
    const namesFresh = !force && stale?.names === false;
    const customFresh = !force && stale?.customRecipes === false;

    const queue = [];
    if (what === "all" || what === "names") {
      if (namesFresh) skipped.push("noms (somme inchangée)");
      else queue.push(...PROFILE_NAME_PROPS.map((x) => x.prop));
    }
    if (what === "all" || what === "customNames") {
      // Les noms des recettes perso sont couverts par la même somme « noms ».
      if (namesFresh) skipped.push("noms des recettes perso (somme inchangée)");
      else queue.push(...CUSTOM_NAME_PROPS.map((x) => x.prop));
    }
    // Les sommes ne couvrent PAS l'ordre des favoris : rien ne permet de le court-circuiter.
    if (what === "all" || what === "order") queue.push(...PRIORITY_PROPS.map((x) => x.prop));

    if (!queue.length) {
      return raw(res, JSON.stringify({ queued: 0, what, skipped, upToDate: true, customFresh }));
    }
    startImport(queue, Math.max(60000, queue.length * 3000));
    // La marque « à jour » est posée à la FIN de l'import (`applyChecksumMark`), et seulement sur
    // les familles que cet import lit vraiment.
    //
    // ⚠️ Avant, tout `store.checksums` était recopié dans `checksumsAtImport` dès l'ENVOI. Deux
    // conséquences fausses : un import qui échouait (machine injoignable) marquait quand même les
    // noms comme frais, et un import `what:"order"` — qui ne lit aucun nom — les marquait aussi.
    // Dans les deux cas la relecture des noms était ensuite sautée (« somme inchangée »), et seul
    // `force:true` s'en sortait. Les sommes ne couvrant pas l'ordre des favoris, `what:"order"`
    // ne marque désormais rien du tout.
    const covered = queue.filter((p) => NAME_PROPS.has(p));
    if (S.import && store.checksums && covered.length) {
      S.import.covered = covered;
      S.import.checksumMark = { names: store.checksums.names };
    }
    const reg = await postLocalReg();
    return raw(res, JSON.stringify({ queued: queue.length, what, skipped, register: reg }));
  }

  // Sommes de contrôle : demande la trame 0xA3 à la machine.
  if (url === "/api/checksums" && req.method === "POST") {
    const frame = frameChecksums();
    startProgram(datapointValue(frame), "Sommes de contrôle", 15000, "monitor");
    const reg = await postLocalReg();
    return raw(res, JSON.stringify({ sent: true, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg }));
  }
  if (url === "/api/checksums" && req.method === "GET") {
    const store = machineView();
    return raw(res, JSON.stringify({
      checksums: store.checksums ?? null,
      previous: store.checksumsPrev ?? null,
      changed: diffChecksums(store.checksumsPrev, store.checksums),
      // Ce qu'on avait relevé au moment du dernier import réussi de chaque famille.
      atImport: store.checksumsAtImport ?? null,
      stale: staleFromChecksums(store),
    }));
  }

  // Fiche technique : ce qu'on peut lire en local + le relevé cloud figé + notre état protocole.
  if (url === "/api/system" && req.method === "GET") {
    const store = machineView();
    // Sondes indépendantes : en série, la page cumulait les délais d'attente (4 s + 8 s).
    const [live, cloud] = await Promise.all([probeRegtoken(), probeCloudOta()]);
    return raw(res, JSON.stringify({
      deviceSheet: DEVICE_SHEET,
      model: MODEL,
      identification: modelState(),
      network: {
        machineIp: CFG.machineIp,
        serverIp: CFG.serverIp,
        serverPort: CFG.port,
        generation: CFG.gen,
        dsn: CFG.dsn,
        dsnSource: CFG.dsnSource,
        note: "La machine est sur un VLAN IoT isolé ; le LAN mode exige que machine → serveur soit permis.",
      },
      local: live,
      protocol: {
        lanKeyId: CFG.lanKeyId,
        lanKeySet: CFG.lanKey.length > 0,
        lanKeySource: CFG.lanKeySource,
        sessionActive: !!S.session,
        lastRegisterAt: S.lastRegisterAt,
        keepaliveMs: 2500,
        sendProperty: SEND,
        monitorProperty: MON,
        crypto: "AES-256-CBC en flux persistant, clés dérivées par double HMAC-SHA256",
        activeProfile: S.activeProfile,
        activeProfileConfirmed: S.activeProfileConfirmed,
      },
      ota: {
        lanRequests: S.otaRequests,
        lanNote: "En LAN mode c'est la machine qui vient chercher l'image chez nous. Aucune requête reçue = aucun OTA en cours de distribution par nous.",
        cloud,
      },
      // Le stockage fait partie de la fiche technique : savoir quel moteur tourne, dans quelle
      // version de schéma et avec combien de lignes évite d'ouvrir le fichier pour le vérifier.
      storage: storageInfo(),
      machineState: {
        lastMonitor: S.lastMonitor,
        lastDataResponse: S.lastDataResponse,
        checksums: store.checksums ?? null,
        serialNumber: store.props?.d270_serialnumber ?? null,
        propsRead: Object.keys(store.props ?? {}).length,
        importedAt: store.importedAt ?? null,
      },
    }));
  }

  // Lecture d'un profil Bean System (nom + mouture/température/arôme) — commande ECAM 0xBA.
  if (url === "/api/beansystem" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const index = Number(b.index ?? 1);
    const frame = frameBeanSystem(index);
    startProgram(datapointValue(frame), `Bean System ${index}`, 15000, "monitor");
    const reg = await postLocalReg();
    return raw(res, JSON.stringify({ sent: true, index, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg }));
  }
  if (url === "/api/beansystem" && req.method === "GET") {
    return raw(res, JSON.stringify({ beanSystems: allBeanSystems() }));
  }

  /**
   * Identification du modèle. GET rapporte ce qu'on sait (y compris avant toute lecture) ; POST
   * demande `d270_serialnumber` à la machine — une LECTURE, aucune préparation, aucune écriture.
   */
  if (url === "/api/model" && req.method === "GET") {
    return raw(res, JSON.stringify(modelState()));
  }
  if (url === "/api/model" && req.method === "POST") {
    startImport([SERIAL_PROP], 30000);
    const reg = await postLocalReg();
    return raw(res, JSON.stringify({ queued: true, prop: SERIAL_PROP, register: reg }));
  }

  // Lecture de propriétés Ayla arbitraires — outil d'exploration, et brique de /api/presence.
  if (url === "/api/read" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const props = Array.isArray(b.props) ? b.props.filter((x) => typeof x === "string" && x) : [];
    if (!props.length) return raw(res, JSON.stringify({ error: "aucune propriété demandée" }), 400);
    startImport(props, Math.max(30000, props.length * 3000));
    const reg = await postLocalReg();
    return raw(res, JSON.stringify({ queued: props.length, props, register: reg }));
  }

  /**
   * Établit une session LAN pour rafraîchir l'état : on s'annonce, la machine se connecte, et on
   * lui sert une demande de monitor (lecture pure) pour qu'elle nous pousse son état marche/veille.
   * Appelé quand une page s'ouvre — sans ça le monitor peut dater de plusieurs heures.
   *
   * Volontairement **idempotent et étranglé** : plusieurs onglets qui s'ouvrent ne doivent pas
   * déclencher plusieurs programmes concurrents ni marteler la machine.
   */
  if (url === "/api/presence" && req.method === "POST") {
    const now = Date.now();
    const fresh = S.lastMonitor && now - S.lastMonitor.at < 30000;
    const busyAlready = S.program?.active === true || S.import?.active === true;
    if (fresh || busyAlready) {
      return raw(res, JSON.stringify({ skipped: true, reason: fresh ? "monitor récent" : "programme en cours", lastMonitor: S.lastMonitor }));
    }
    // 8 s : assez pour ne pas marteler, assez court pour qu'une relance de la page passe. La
    // machine ne pousse pas toujours son monitor à la première session (comportement transitoire
    // déjà observé), donc une seconde tentative doit être possible.
    if (now - (S.lastPresenceAt ?? 0) < 8000) {
      return raw(res, JSON.stringify({ skipped: true, reason: "présence déjà demandée récemment", lastMonitor: S.lastMonitor }));
    }
    S.lastPresenceAt = now;
    startProgram(datapointValue(frameMonitorRequest()), "Présence", 12000, "monitor");
    const reg = await postLocalReg();
    return raw(res, JSON.stringify({ started: true, register: reg }));
  }

  // Bean Adapt : bornes + profils lus, et la règle d'ajustement rejouée LOCALEMENT.
  /**
   * Lit toute la liste des grains d'un coup. Chaque profil exige sa propre commande `0xBA` : la
   * propriété `d(250+n)_beansystem_n` reste vide tant qu'on ne l'a pas envoyée. On enchaîne donc
   * les programmes, un par index.
   */
  if (url === "/api/beanadapt/scan" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const from = Number(b.from ?? 0);
    const to = Number(b.to ?? 5);
    if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= 9 && to >= from)) {
      return raw(res, JSON.stringify({ error: "plage d'index invalide" }), 400);
    }
    if (S.beanScan?.active) return raw(res, JSON.stringify({ error: "un balayage est déjà en cours" }), 409);
    S.beanScan = { active: true, next: from, to, startedAt: Date.now() };
    scanNextBean();
    return raw(res, JSON.stringify({ started: true, from, to }));
  }

  if (url === "/api/beanadapt" && req.method === "GET") {
    const store = machineView();
    const beans = Object.entries(store.beanSystems ?? {}).map(([index, bs]) => ({
      index: Number(index),
      name: bs.name,
      grinder: bs.grinder,
      temperature: bs.temperature,
      aroma: bs.aroma,
      at: bs.at,
      visible: bs.visible ?? null,
      active: bs.active ?? null,
      // L'index 0 est l'entrée « Bean Adapt (ON/OFF) », pas une configuration de café.
      isToggle: Number(index) === 0,
    }));
    return raw(res, JSON.stringify({
      beans,
      bounds: {
        grinder: { min: GRINDER_MIN, max: GRINDER_MAX, verified: true },
        aroma: { min: AROMA_MIN, max: AROMA_MAX, verified: true },
        temperature: { min: TEMPERATURE_MIN, max: TEMPERATURE_MAX, verified: false },
      },
      activeProfile: S.activeProfile,
      scan: S.beanScan?.active ? { next: S.beanScan.next, to: S.beanScan.to } : null,
    }));
  }

  // Simulation : ce que la règle donnerait, sans rien envoyer à la machine.
  if (url === "/api/beanadapt/simulate" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const current = { grinder: Number(b.grinder), temperature: Number(b.temperature), aroma: Number(b.aroma) };
    if (![current.grinder, current.temperature, current.aroma].every(Number.isFinite)) {
      return raw(res, JSON.stringify({ error: "réglages actuels incomplets" }), 400);
    }
    const flowTime = Number(b.flowTime);
    if (!Number.isFinite(flowTime) || flowTime < 0 || flowTime > 120) {
      return raw(res, JSON.stringify({ error: "temps d'écoulement invalide" }), 400);
    }
    return raw(res, JSON.stringify(computeBeanAdapt(current, { flowTime, crema: Number(b.crema), taste: Number(b.taste) })));
  }

  // Écriture d'un profil Bean System dans la machine (0xBB). Persistant.
  if (url === "/api/beanadapt/save" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const index = Number(b.index);
    const grinder = Number(b.grinder);
    const temperature = Number(b.temperature);
    const aroma = Number(b.aroma);
    if (!Number.isInteger(index) || index < 0 || index > 5) return raw(res, JSON.stringify({ error: `index ${b.index} invalide` }), 400);
    if (!(grinder >= GRINDER_MIN && grinder <= GRINDER_MAX)) return raw(res, JSON.stringify({ error: `mouture hors bornes (${GRINDER_MIN}–${GRINDER_MAX})` }), 400);
    if (!(aroma >= AROMA_MIN && aroma <= AROMA_MAX)) return raw(res, JSON.stringify({ error: `arôme hors bornes (${AROMA_MIN}–${AROMA_MAX})` }), 400);
    if (!(temperature >= TEMPERATURE_MIN && temperature <= TEMPERATURE_MAX)) return raw(res, JSON.stringify({ error: `température hors bornes (${TEMPERATURE_MIN}–${TEMPERATURE_MAX})` }), 400);
    const name = typeof b.name === "string" ? b.name : "";
    const visible = b.visible !== false;
    const frame = frameBeanSystemSave(index, name, grinder, temperature, aroma, visible);
    startProgram(datapointValue(frame), `Bean System ${index} → mouture ${grinder}, temp ${temperature}, arôme ${aroma}`, 20000, "monitor");
    const reg = await postLocalReg();
    return raw(res, JSON.stringify({
      sent: true,
      frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(),
      wrote: { index, name: name.slice(0, 20), grinder, temperature, aroma, visible },
      register: reg,
    }));
  }

  /**
   * État de la clé LAN. Ne renvoie JAMAIS la clé — seulement de quoi savoir si elle est là et
   * d'où elle vient. Le key_id, lui, n'est pas un secret : il circule en clair dans le
   * key exchange.
   */
  if (url === "/api/lankey" && req.method === "GET") {
    // Uniquement la date de découverte : la clé elle-même ne sort jamais d'ici.
    const cachedAt = getLanKey()?.at ?? null;
    return raw(res, JSON.stringify({
      set: CFG.lanKey.length > 0,
      keyId: CFG.lanKeyId || null,
      source: CFG.lanKeySource,
      cachedAt,
      // Ce qu'il manque pour pouvoir interroger le cloud.
      // Normalement vide : les valeurs viennent de src/lib/cloud-app.json. Ne se remplit que si
      // ce fichier a été amputé, ou une variable mise à la chaîne vide.
      missingConfig: [!APP.gigyaApiKey && "clé API Gigya", !APP.aylaAppId && "app_id Ayla", !APP.aylaAppSecret && "app_secret Ayla"].filter(Boolean),
      dsn: CFG.dsn,
    }));
  }

  /**
   * Découverte de la clé LAN par le compte De'Longhi. Le mot de passe sert le temps de la
   * requête et n'est ni journalisé, ni stocké, ni renvoyé.
   */
  if (url === "/api/lankey" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const email = typeof b.email === "string" ? b.email.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const jwt = typeof b.jwt === "string" && b.jwt.trim() ? b.jwt.trim() : null;
    if (!jwt && (!email || !password)) return raw(res, JSON.stringify({ error: "e-mail et mot de passe requis (ou un jwt)" }), 400);
    try {
      const found = await discoverLanKey({ email, password, jwt });
      const changed = applyLanKey(found, jwt ? "JWT fourni (cloud Ayla)" : "compte De'Longhi (cloud)");
      return raw(res, JSON.stringify({
        ok: true,
        keyId: found.keyId,
        keyLength: found.key.length,
        lanStatus: found.status,
        keepAlive: found.keepAlive,
        changed,
        source: CFG.lanKeySource,
      }));
    } catch (e) {
      // Le message d'erreur vient de Gigya/Ayla et ne contient pas d'identifiant.
      L("sys", `clé LAN : échec de la découverte (${e.message})`);
      return raw(res, JSON.stringify({ error: e.message }), 502);
    }
  }

  /** Oubli de la clé mémorisée. La clé d'environnement, elle, reprend la main au redémarrage. */
  if (url === "/api/lankey" && req.method === "DELETE") {
    const removed = clearLanKey();
    if (!process.env.LANIP_KEY) {
      CFG.lanKey = Buffer.alloc(0);
      CFG.lanKeyId = 0;
      CFG.lanKeySource = "inconnue";
      S.session = null;
    }
    L("sys", `clé LAN : cache ${removed ? "supprimé" : "déjà absent"}`);
    return raw(res, JSON.stringify({ removed, set: CFG.lanKey.length > 0, source: CFG.lanKeySource }));
  }

  /**
   * Statistiques d'utilisation. Ce sont des PARAMÈTRES machine lus par la commande `0xA2`, pas des
   * propriétés Ayla : les `d7xx_tot_*` que l'app connaît ne renvoient rien tant qu'on n'a pas
   * envoyé la commande (même piège que les Bean Systems).
   *
   * `ids` : liste d'identifiants. `from`+`qty` : une plage consécutive en une seule trame.
   */
  if (url === "/api/stats" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    if (S.statScan?.active) return raw(res, JSON.stringify({ error: "une lecture est déjà en cours" }), 409);
    let queue = [];
    if (Array.isArray(b.ids) && b.ids.length) {
      queue = b.ids.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff).map((id) => ({ id, qty: 1 }));
    } else if (Number.isInteger(Number(b.from))) {
      const qty = Math.min(Math.max(Number(b.qty ?? 1), 1), 40);
      queue = [{ id: Number(b.from), qty }];
    }
    if (!queue.length) return raw(res, JSON.stringify({ error: "fournir ids[] ou from(+qty)" }), 400);
    const requests = queue.length;
    S.statScan = { active: true, queue, total: requests, startedAt: Date.now() };
    // scanNextStat() consomme la file : on compte AVANT de la lancer.
    scanNextStat();
    return raw(res, JSON.stringify({ started: true, requests }));
  }

  if (url === "/api/stats" && req.method === "GET") {
    const store = machineView();
    const stats = store.stats ?? {};
    return raw(res, JSON.stringify({
      // Identifiant brut → valeur. La signification de chaque id n'est PAS établie : l'app les
      // demande sans les nommer, il n'existe aucune table de correspondance dans l'APK.
      stats: Object.fromEntries(Object.entries(stats).map(([id, v]) => [id, v.value])),
      readAt: Object.fromEntries(Object.entries(stats).map(([id, v]) => [id, v.at])),
      count: Object.keys(stats).length,
      scan: S.statScan?.active ? { remaining: S.statScan.queue.length, total: S.statScan.total } : null,
      // Ce que l'app demande (p258z7/w.java et le viewmodel des statistiques).
      appIds: APP_STAT_IDS,
      // Les seuls dont la signification est établie. `raw` reste la valeur brute ; `value` est
      // convertie quand il y a une unité (eau : 0,5 ml → litres).
      known: Object.entries(STAT_MEANINGS)
        .filter(([id]) => stats[id] !== undefined)
        .map(([id, m]) => ({
          id: Number(id),
          key: m.key,
          raw: stats[id].value,
          value: m.divisor ? Math.round(stats[id].value / m.divisor) : stats[id].value,
          unit: m.divisor ? "L" : null,
          at: stats[id].at,
        })),
    }));
  }

  /**
   * Adresse de la machine. `GET` renvoie l'état, `POST {ip}` l'enregistre puis la teste tout de
   * suite (`regtoken.json` est le seul endpoint que le module expose hors mode AP, et il répond
   * sans authentification), `DELETE` oublie la valeur mémorisée.
   */
  if (url === "/api/machine" && req.method === "GET") {
    const saved = getMeta("machineIp");
    return raw(res, JSON.stringify({
      ip: CFG.machineIp,
      source: CFG.machineIpSource,
      envForced: !!process.env.MACHINE_IP,
      cachedAt: saved?.at ?? null,
      dsn: CFG.dsn,
      dsnSource: CFG.dsnSource,
      serverIp: CFG.serverIp,
      serverPort: CFG.port,
    }));
  }
  if (url === "/api/machine" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const ip = typeof b.ip === "string" ? b.ip.trim() : "";
    if (!validMachineHost(ip)) {
      return raw(res, JSON.stringify({ error: "adresse invalide : attendu une IPv4 ou un nom d'hôte, sans schéma ni port ni chemin." }), 400);
    }
    if (process.env.MACHINE_IP && ip !== process.env.MACHINE_IP) {
      L("sys", `⚠ adresse saisie (${ip}) différente de MACHINE_IP (${process.env.MACHINE_IP}) — le réglage explicite reste prioritaire au redémarrage`);
    }
    const changed = applyMachineIp(ip);
    // On vérifie immédiatement : une adresse enregistrée mais muette doit être signalée comme
    // telle, pas laissée à découvrir au premier échec de commande.
    const probe = await probeRegtoken();
    const dsn = probe.reachable ? await resolveDsn({ compare: true }) : CFG.dsn;
    // Trois verdicts, pas deux : injoignable / quelque chose répond mais ce n'est pas la cafetière /
    // c'est bien elle. Le cas du milieu est le plus trompeur — une adresse ou un nom d'hôte qui
    // désigne un autre serveur répond très bien, en 404.
    const isMachine = probe.reachable && typeof probe.regtoken?.host_symname === "string";
    return raw(res, JSON.stringify({
      ok: true,
      ip: CFG.machineIp,
      source: CFG.machineIpSource,
      changed,
      probe: { reachable: probe.reachable, isMachine, status: probe.status ?? null, error: probe.error ?? null },
      dsn,
      dsnSource: CFG.dsnSource,
    }));
  }
  if (url === "/api/machine" && req.method === "DELETE") {
    const had = getMeta("machineIp") !== null;
    clearMeta("machineIp");
    if (!process.env.MACHINE_IP) {
      CFG.machineIp = null;
      CFG.machineIpSource = "inconnue";
      S.session = null;
    }
    L("sys", `adresse de la machine : cache ${had ? "supprimé" : "déjà absent"}`);
    return raw(res, JSON.stringify({ removed: had, ip: CFG.machineIp, source: CFG.machineIpSource }));
  }

  if (url === "/api/register" && req.method === "POST") { const r = await postLocalReg(); return raw(res, JSON.stringify(r)); }
  if (url === "/api/recipes") {
    if (req.method === "GET") return raw(res, JSON.stringify({ recipes: listRecipes() }));
    if (req.method === "POST") {
      const r = JSON.parse((await readBody(req)).toString("utf8"));
      // L'id est la clé primaire : sans lui, l'ancien code écrivait une recette anonyme que la
      // suivante écrasait en silence.
      if (!r?.id) return raw(res, JSON.stringify({ error: "id de recette manquant" }), 400);
      putRecipe(r);
      return raw(res, JSON.stringify({ recipes: listRecipes() }));
    }
    if (req.method === "DELETE") { const id = new URL(req.url, "http://x").searchParams.get("id"); deleteRecipe(id); return raw(res, JSON.stringify({ recipes: listRecipes() })); }
  }
  return raw(res, JSON.stringify({ error: "not found" }), 404);
}
// Aucune recette d'usine : le catalogue réel des 28 boissons vit sur la page /, lu sur la
// machine. La table `recipes` ne contient que les recettes créées par l'utilisateur, et démarre
// donc vide — plus besoin d'amorcer un fichier au premier lancement.

// --- bootstrap Next + serveur ---
// `--dev` active le mode dev de Next (HMR sur les pages) TOUT EN gardant nos endpoints
// device-facing en HTTP brut : `next dev` seul ne passerait pas par server.mjs et l'ESP32
// rejetterait le framing de l'App Router.
const DEV = process.argv.includes("--dev");
const app = next({ dev: DEV, hostname: "0.0.0.0", port: CFG.port });
const handle = app.getRequestHandler();
await app.prepare();
createServer((req, res) => {
  const u = req.url || "";
  // La machine réclame une image OTA à notre serveur (voir S.otaRequests). On ne lui en sert
  // aucune — on enregistre l'événement, qui est le seul indicateur local d'un OTA en attente.
  if (u.startsWith("/ota_status.json") || u.startsWith("/local_lan/lan_ota")) {
    S.otaRequests.unshift({ at: Date.now(), url: u, method: req.method, from: req.socket.remoteAddress });
    if (S.otaRequests.length > 20) S.otaRequests.pop();
    L("in", `requête OTA de la machine : ${req.method} ${u}`);
    return raw(res, JSON.stringify({ ota: "none" }), 404);
  }
  if (u.startsWith("/local_lan/")) return handleLan(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
  if (u.startsWith("/api/")) return handleApi(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
  return handle(req, res);
}).listen(CFG.port, "0.0.0.0", () => {
  console.log(`De'Longhi LAN server (custom${DEV ? ", dev/HMR" : ""}) sur http://0.0.0.0:${CFG.port}  — machine ${CFG.machineIp ?? "à configurer"}, DSN ${CFG.dsn ?? "à découvrir"}`);
  for (const m of storeBootMessages) L("sys", m);
  restoreActiveProfile();
  restoreMachineIp();
  restoreDsn();
  restoreModel();
  restoreLanKey();
  if (!CFG.machineIp) L("sys", "adresse de la machine inconnue : la renseigner sur la page « Clé LAN », ou par MACHINE_IP dans .env.local");
  if (!CFG.lanKey.length) L("sys", "clé LAN absente : la renseigner dans .env.local, ou la faire découvrir depuis la page « Clé LAN » (compte De'Longhi)");
  // `compare` : on interroge la machine même quand le DSN est déjà connu, pour signaler une
  // divergence au démarrage plutôt que de la découvrir au premier échec de commande.
  if (CFG.machineIp) resolveDsn({ compare: true }).catch(() => {});
});
