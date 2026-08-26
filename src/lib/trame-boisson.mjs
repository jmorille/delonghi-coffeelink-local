/**
 * **Construire une trame `0x83` — la commande de recette.**
 *
 * Pur, et **utilisable dans un navigateur** : rien que des `Uint8Array`, aucun `Buffer`, aucune
 * dépendance hors `trame-bornes.mjs`. C'est la raison d'être du module, exactement celle de son
 * voisin : la carte d'une boisson dépliée montre, dans « Infos techniques », la trame que
 * « Préparer avec ces valeurs » enverrait — et elle la remontre à chaque cran de curseur. Passer
 * par le serveur pour l'obtenir aurait mis un aller-retour réseau sur chaque mouvement de souris ;
 * la recopier dans la page aurait mis un SECOND assembleur de trames dans le dépôt.
 *
 * ⚠️ **`server.mjs` n'assemble plus cette trame lui-même** : son `frameDispense` appelle
 * `encodeDispense` et se contente d'emballer le résultat dans un `Buffer`. C'est ce qui donne son
 * sens à l'affichage — la ligne montrée n'est pas une reconstitution de ce qui partira, c'est la
 * même fonction, sur les mêmes octets. Un décalage entre les deux ne lèverait rien : il servirait
 * un autre café que celui annoncé.
 *
 * Le format est le miroir exact du décodeur `argumentsTrame` (`ecam-args.mjs`, `case 0x83`), et
 * `scripts/verif-trame-boisson.mjs` fait tourner l'aller-retour entre les deux.
 */

import { TWO, crcCcitt, hexEspace } from "./trame-bornes.mjs";

/**
 * Le mode, octet 5. `DONTCARE` (0) est celui de l'enregistrement/suppression d'une recette
 * (`DeLonghiWifiConnectService:2959`) ; `START` (1) prépare ; `STOPV2` (2) arrête.
 *
 * Le bit `0x80` de ce même octet est le drapeau de vérification — voir `check` plus bas.
 */
export const MODE = { DONTCARE: 0, START: 1, STOPV2: 2 };

/**
 * L'action, dans les bits bas du DERNIER octet avant le CRC, sous `(profil << 2) | action`.
 *
 * ⚠️ **`PREPARE_INVERSION` vaut 6, donc il déborde sur les bits du profil.** Ce n'est pas une
 * coquille locale : c'est ce que fait l'application (`RecipeData.T()`), et la trame le porte tel
 * quel. La conséquence se voit au décodage — `argumentsTrame` relit `profil << 2` et rend un
 * profil décalé pour toute inversion hors profil 1. On reporte le comportement de l'app plutôt que
 * de le corriger : la machine est le juge, et rien ici ne prouve qu'elle lise ces bits autrement.
 */
export const ACT = { SAVE: 1, PREPARE: 2, PREPARE_INVERSION: 6 };

/** En-tête d'une REQUÊTE. Une réponse de la machine porte `0xD0` (voir `ENTETE_REPONSE`). */
export const ENTETE_REQUETE = 0x0d;

/** L'identifiant du paramètre INVERSION, celui que `inverted` interroge. */
export const ID_INVERSION = 12;

/**
 * **L'inversion se lit dans les paramètres, elle ne se demande pas.** `RecipeData.T()` : l'app
 * choisit l'action « inversion » quand le paramètre INVERSION (12) vaut 1 — c'est le cas du flat
 * white, du cappuccino inversé, du cortado, du long black. La règle vit ici et pas dans l'appelant
 * pour que la page et le serveur ne puissent pas en avoir deux versions.
 *
 * @param {{id:number,value:number}[]} params
 */
export const inverted = (params) =>
  (params ?? []).some((x) => Number(x.id) === ID_INVERSION && Number(x.value) === 1);

/** L'action de préparation qui convient à ces paramètres — avec ou sans inversion. */
export const actionPreparer = (params) => (inverted(params) ? ACT.PREPARE_INVERSION : ACT.PREPARE);

/**
 * Assemble la trame `0x83`.
 *
 * ```
 * 0        0x0D
 * 1        len = taille totale − 1
 * 2        0x83
 * 3        0xF0
 * 4        la boisson
 * 5        le mode, | 0x80 si vérification
 * 6..      n entrées : id sur 1 octet, puis la valeur sur 1 ou 2 octets (voir `TWO`)
 * n        (profil << 2) | action
 * 2 dern.  CRC16
 * ```
 *
 * L'**ordre des entrées est celui de `params`** : la machine n'énonce pas ses paramètres dans
 * l'ordre des identifiants, et trier ici changerait la trame sans changer ce qu'elle dit.
 *
 * Rien n'est borné ni corrigé — une valeur qui ne tient pas dans sa largeur est une erreur
 * d'appelant et doit se voir, pas se faire tronquer en silence. Même règle que `encodeRecipeBounds`.
 *
 * @param {number} beverageId
 * @param {number} profile
 * @param {number} mode    une valeur de `MODE`
 * @param {number} action  une valeur de `ACT`
 * @param {{id:number,value:number}[]} params
 * @param {boolean} [check]  le drapeau de vérification, bit 0x80 du mode
 * @returns {{bytes: Uint8Array, hex: string, crc: number}}
 */
export function encodeDispense(beverageId, profile, mode, action, params, check = false) {
  const entrees = params ?? [];
  // 6 octets d'en-tête + 2 ou 3 par entrée + 1 pour (profil << 2) | action + 2 de CRC.
  const taille = 6 + entrees.reduce((n, p) => n + (TWO.has(Number(p.id)) ? 3 : 2), 0) + 3;
  const b = new Uint8Array(taille);
  b[0] = ENTETE_REQUETE;
  b[1] = taille - 1; // `len` = taille totale − 1
  b[2] = 0x83;
  b[3] = 0xf0; // flag
  b[4] = beverageId & 0xff;
  b[5] = (check ? mode | 0x80 : mode) & 0xff;
  let i = 6;
  for (const p of entrees) {
    const id = Number(p.id);
    const deux = TWO.has(id);
    const v = Number(p.value ?? 0);
    if (v < 0 || v > (deux ? 0xffff : 0xff)) throw new Error(`valeur ${v} hors largeur pour le paramètre ${id}`);
    b[i++] = id & 0xff;
    if (deux) { b[i++] = (v >> 8) & 0xff; b[i++] = v & 0xff; }
    else b[i++] = v & 0xff;
  }
  b[i] = ((profile << 2) | action) & 0xff;
  const crc = crcCcitt(b);
  b[taille - 2] = (crc >> 8) & 0xff;
  b[taille - 1] = crc & 0xff;
  return { bytes: b, hex: hexEspace(b), crc };
}
