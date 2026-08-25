/**
 * **Construire une trame `0xB0` — l'inverse exact de `decodeRecipeBounds`.**
 *
 * Pur, et **utilisable dans un navigateur** : rien que des `Uint8Array`, aucun `Buffer`, aucune
 * dépendance. C'est la raison d'être du module. `/recipes` compose une déclaration de bornes qui ne
 * vient d'aucune lecture (voir `declarationLibre` dans `recipes/page.tsx`) et doit pouvoir la
 * montrer sous la forme où le reste du dépôt lit une déclaration : une trame. `ecam-args.mjs`,
 * le référentiel ECAM, exécute un `Buffer.from` au chargement du module (la constante `0x37`) et ne
 * peut donc pas être importé côté client — d'où ce module-ci, et **`TWO` y est DÉPLACÉE, pas
 * recopiée** : `ecam-args.mjs` la ré-exporte, exactement comme `beverages.mjs` la ré-exporte déjà
 * sous son ancien nom `TWO_BYTE`. Ce dépôt a déjà payé le prix d'une table de protocole en trois
 * exemplaires ; il n'y en aura pas un quatrième.
 *
 * Le format est déroulé octet par octet dans `doc/format-trame-boisson.md` § 1, et
 * `scripts/verif-transfert.mjs` prouve l'aller-retour sur les **six trames réelles** de ce document :
 * décoder puis réencoder rend les mêmes octets, CRC compris. C'est l'assertion la plus forte
 * disponible ici — elle ne compare pas l'encodeur à une idée de la trame, mais à ce que l'appareil
 * a réellement envoyé.
 */

/**
 * Les paramètres dont les valeurs tiennent sur **2 octets** (big-endian) : les quantités liquides
 * `COFFEE` (1), `MILK` (9), `HOT_WATER` (15). Tout le reste tient sur un octet.
 *
 * ⚠️ Une largeur mal choisie ne lève rien : elle décale tout ce qui suit et produit des valeurs
 * plausibles. C'est ce que `exact: false` signale au décodage — le parcours ne tombe plus sur le CRC.
 * La table n'est pas dans l'APK (l'application la télécharge) ; ces trois-là ont été établies par le
 * décodage exact de six trames, pas par une source.
 */
export const TWO = new Set([1, 9, 15]);

/** En-tête d'une RÉPONSE de la machine. Une requête porte `0x0D`. */
export const ENTETE_REPONSE = 0xd0;

/**
 * CRC-CCITT, init **`0x1D0F`**, sur tous les octets **sauf les deux derniers** — la même fonction
 * que `crc16` dans `server.mjs`, réécrite ici sur un `Uint8Array` plutôt que sur un `Buffer`.
 * @param {Uint8Array} b la trame ENTIÈRE, les deux octets de CRC compris (ils sont ignorés)
 */
export function crcCcitt(b) {
  let c = 0x1d0f;
  for (let i = 0; i < b.length - 2; i++) {
    const a = (((c << 8) | (c >>> 8)) & 0xffff) ^ b[i];
    const x = a ^ ((a & 0xff) >> 4);
    const y = x ^ ((x << 12) & 0xffff);
    c = y ^ (((y & 0xff) << 5) & 0xffff);
  }
  return c & 0xffff;
}

/** `"d0 37 b0 …"` — le même espacement que le `hex` des décodeurs, pour que les deux se comparent. */
export function hexEspace(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
}

/**
 * Assemble la trame `0xB0` d'une déclaration de bornes.
 *
 * L'**ordre des entrées est celui de `params`**, et c'est voulu : la machine n'énonce pas ses
 * paramètres dans l'ordre des identifiants (le mug de voyage donne 24, 1, 2, 9, 4, 12, 28, 25, 15,
 * 27), donc trier ici rendrait l'aller-retour faux tout en restant décodable. On reporte l'ordre
 * qu'on a reçu.
 *
 * Rien n'est borné ni corrigé : une valeur qui ne tient pas dans sa largeur est une erreur d'appelant
 * et doit se voir, pas se faire tronquer en silence.
 *
 * @param {number} beverageId  l'identifiant de boisson, octet 4
 * @param {{id:number,min?:number,def?:number,max?:number}[]} params
 * @param {{entete?:number, cmd?:number}} [o]
 * @returns {{bytes: Uint8Array, hex: string, crc: number}}
 */
export function encodeRecipeBounds(beverageId, params, o = {}) {
  const entete = o.entete ?? ENTETE_REPONSE;
  const cmd = o.cmd ?? 0xb0;
  const entrees = params ?? [];
  // 5 octets d'en-tête + 4 ou 7 par entrée + 2 de CRC — l'arithmétique du § 1 du document.
  const taille = 5 + entrees.reduce((n, p) => n + (TWO.has(Number(p.id)) ? 7 : 4), 0) + 2;
  const b = new Uint8Array(taille);
  b[0] = entete;
  b[1] = taille - 1; // `len` = taille totale − 1
  b[2] = cmd;
  b[3] = 0xf0; // flag
  b[4] = beverageId & 0xff;
  let i = 5;
  for (const p of entrees) {
    const id = Number(p.id);
    b[i++] = id & 0xff;
    const deux = TWO.has(id);
    for (const v of [p.min, p.def, p.max]) {
      const n = Number(v ?? 0);
      if (n < 0 || n > (deux ? 0xffff : 0xff)) throw new Error(`valeur ${n} hors largeur pour le paramètre ${id}`);
      if (deux) { b[i++] = (n >> 8) & 0xff; b[i++] = n & 0xff; }
      else b[i++] = n & 0xff;
    }
  }
  const crc = crcCcitt(b);
  b[taille - 2] = (crc >> 8) & 0xff;
  b[taille - 1] = crc & 0xff;
  return { bytes: b, hex: hexEspace(b), crc };
}
