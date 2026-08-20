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
 * Protocole binaire ECAM — construction/décodage des trames.
 * Voir docs/commandes-cafe.md et docs/analyse-connexion-wifi.md §4.
 *
 * Trame : 0D <len> <cmd> <flag> <payload…> <crc16>
 *   len = taille totale − 1 ; flag = 0xF0 en envoi ; CRC-CCITT init 0x1D0F.
 */

/** CRC-CCITT orienté octet, init 0x1D0F, sur tous les octets sauf les 2 derniers. */
export function crc16(buf: Buffer | number[]): number {
  const b = Buffer.from(buf as number[]);
  let c = 0x1d0f;
  for (let i = 0; i < b.length - 2; i++) {
    const a = (((c << 8) | (c >>> 8)) & 0xffff) ^ b[i];
    const x = a ^ ((a & 0xff) >> 4);
    const y = x ^ ((x << 12) & 0xffff);
    c = y ^ (((y & 0xff) << 5) & 0xffff);
  }
  return c & 0xffff;
}

/** Ferme une trame en écrivant le CRC dans les 2 derniers octets. */
function seal(bytes: number[]): Buffer {
  const b = Buffer.from(bytes);
  const c = crc16(b);
  b[b.length - 2] = (c >> 8) & 0xff;
  b[b.length - 1] = c & 0xff;
  return b;
}

// --- Commandes simples -----------------------------------------------------

// ATTENTION : vérifié dans le code décompilé (DeLonghiWifiConnectService) —
// turnMachineOn → m0() = ...02 01 ; turnMachineOff → l0() = ...01 01.
export function frameTurnOn(): Buffer {
  return seal([0x0d, 0x07, 0x84, 0x0f, 0x02, 0x01, 0, 0]);
}
export function frameTurnOff(): Buffer {
  return seal([0x0d, 0x07, 0x84, 0x0f, 0x01, 0x01, 0, 0]);
}
export function frameSelectBean(id: number): Buffer {
  return seal([0x0d, 0x06, 0xb9, 0xf0, id & 0xff, 0, 0]);
}
export function frameSendProfile(id: number): Buffer {
  return seal([0x0d, 0x06, 0xa9, 0xf0, id & 0xff, 0, 0]);
}
/**
 * Demande du monitor — trame de **lecture**, sans effet de bord. C'est celle-là qu'il faut pour
 * tenir la présence pendant un démarrage : `frameSendProfile` (`0xA9`) **est** la commande de
 * sélection de profil et ne doit jamais servir de battement de cœur.
 */
export function frameMonitorRequest(): Buffer {
  return seal([0x0d, 0x05, 0x75, 0x0f, 0, 0]);
}

// --- Préparation d'une boisson (commande 0x83) -----------------------------

export const MODE = {
  DONTCARE: 0,
  START: 1,
  START_PROGRAM: 2,
  STOPV2: 2,
  CHECK_START: 3,
  STOP: 4,
} as const;

export const ACTION = {
  DELETE_BEVERAGE: 0,
  SAVE_BEVERAGE: 1,
  PREPARE_BEVERAGE: 2,
  PREPARE_AND_SAVE: 3,
  PREPARE_INVERSION: 6,
} as const;

/** id → nom des paramètres (enum p127m6/i). */
export const PARAM = {
  TEMP: 0,
  COFFEE: 1,
  TASTE: 2,
  GRANULOMETRY: 3,
  BLEND: 4,
  INFUSION_SPEED: 5,
  PREINFUSIONE: 6,
  CREMA: 7,
  DUExPER: 8,
  MILK: 9,
  MILK_TEMP: 10,
  MILK_FROTH: 11,
  INVERSION: 12,
  THE_TEMP: 13,
  THE_PROFILE: 14,
  HOT_WATER: 15,
  ACCESSORIO: 28,
  ICED: 31,
  MUG_SIZE: 32,
  NUM_ICE_CUBES: 37,
  INTENSITY: 38,
  RINSE: 39,
} as const;

/** Paramètres codés sur 2 octets (quantités liquides). Voir docs — à confirmer via DefaultsTable. */
const TWO_BYTE = new Set<number>([PARAM.COFFEE, PARAM.MILK, PARAM.HOT_WATER]);

export interface RecipeParam {
  id: number;
  value: number;
}

/**
 * Construit une trame 0x83 « préparer boisson ».
 * @param beverageId  identifiant (voir BEVERAGES)
 * @param profileId   profil actif (1..5)
 * @param mode        MODE.START pour lancer, MODE.STOPV2 pour arrêter
 * @param action      ACTION.PREPARE_BEVERAGE en général
 * @param params      liste de {id, value}
 * @param checkValues met le bit 0x80 sur l'octet de mode
 */
export function frameDispense(
  beverageId: number,
  profileId: number,
  mode: number,
  action: number,
  params: RecipeParam[],
  checkValues = false,
): Buffer {
  const body: number[] = [];
  for (const p of params) {
    body.push(p.id & 0xff);
    if (TWO_BYTE.has(p.id)) {
      body.push((p.value >> 8) & 0xff, p.value & 0xff);
    } else {
      body.push(p.value & 0xff);
    }
  }
  const total = body.length + 9; // 0D len 83 F0 bev mode [body...] profByte crc crc
  const bytes = new Array(total).fill(0);
  bytes[0] = 0x0d;
  bytes[1] = total - 1;
  bytes[2] = 0x83;
  bytes[3] = 0xf0;
  bytes[4] = beverageId & 0xff;
  bytes[5] = checkValues ? (mode | 0x80) & 0xff : mode & 0xff;
  for (let i = 0; i < body.length; i++) bytes[6 + i] = body[i];
  bytes[6 + body.length] = ((profileId << 2) | action) & 0xff;
  return seal(bytes);
}

// --- Boissons --------------------------------------------------------------

/**
 * Identifiants de boisson de CE modèle (ECAM 610.75.MB).
 *
 * ⚠️ Ils ne sont **pas contigus** : pas de 14, pas de 17-21 ; cappuccino inversé = 15,
 * eau chaude = 16, thé = 22, verseuse = 23, cortado = 24, long black = 25, mug de voyage = 26,
 * brew over ice = 27. Une version précédente de cette table reprenait la numérotation supposée
 * 16..21 : envoyer 21 pour un « brew over ice » aurait visé une autre boisson.
 *
 * La table qui fait foi est `src/lib/beverages.mjs`, construite sur `machine-catalogs.json`
 * (entrée `product_code` 0132217055 de la table constructeur). Celle-ci n'en est qu'un reflet.
 */
export const BEVERAGES: Record<number, string> = {
  1: "Espresso",
  2: "Café",
  3: "Café long",
  4: "Espresso ×2",
  5: "Doppio+",
  6: "Americano",
  7: "Cappuccino",
  8: "Latte macchiato",
  9: "Caffelatte",
  10: "Flat white",
  11: "Espresso macchiato",
  12: "Lait chaud",
  13: "Cappuccino doppio+",
  15: "Cappuccino inversé",
  16: "Eau chaude",
  22: "Thé",
  23: "Verseuse",
  24: "Cortado",
  25: "Long black",
  26: "Mug de voyage",
  27: "Brew over ice",
  200: "Espresso Bean Adapt",
  230: "Recette perso 1",
  231: "Recette perso 2",
  232: "Recette perso 3",
  233: "Recette perso 4",
  234: "Recette perso 5",
  235: "Recette perso 6",
};

// --- Décodage du monitor (d302_monitor, commande 0x75) ---------------------

export interface MonitorState {
  raw: string; // hex
  stateByte: number; // offset 4
  // Octets 5-6 : champ de bits des CAPTEURS (octet = 5 + groupe). Nommés « progress » dans une
  // première version — c'était faux : la valeur 256 relevée sur la machine signifie « groupe 1,
  // bit 0 » = carafe à lait connectée, ce que confirmait son écran.
  switchBits: number;
  alarms: number[]; // offsets 7..10
  ts?: number; // timestamp unix (queue 4 octets) si présent
}

/** Décode la valeur base64 de d302_monitor. */
export function decodeMonitor(b64: string): MonitorState {
  const raw = Buffer.from(b64, "base64");
  const len = raw[1] + 1;
  const ecam = raw.subarray(0, len);
  const tail = raw.subarray(len);
  return {
    raw: ecam.toString("hex").replace(/(..)/g, "$1 ").trim(),
    stateByte: ecam[4],
    switchBits: ecam[5] + (ecam[6] << 8),
    alarms: [ecam[7], ecam[8], ecam[9], ecam[10]].filter((x) => x !== undefined),
    ts: tail.length === 4 ? tail.readUInt32BE(0) : undefined,
  };
}

/** Encapsule une trame ECAM en valeur base64 de datapoint (classic : trame || ts_be32). */
export function toDatapointValue(frame: Buffer): string {
  const ts = Math.floor(Date.now() / 1000);
  const tsBuf = Buffer.alloc(4);
  tsBuf.writeUInt32BE(ts >>> 0, 0);
  return Buffer.concat([frame, tsBuf]).toString("base64");
}
