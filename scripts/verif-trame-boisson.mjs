/**
 * Vérifie **l'assemblage de la trame `0x83`** — la commande de recette : préparer, arrêter,
 * enregistrer dans un profil.
 *
 * Il existe pour une raison précise : cette trame est désormais construite par un module PUR
 * (`src/lib/trame-boisson.mjs`) que le NAVIGATEUR appelle aussi, pour afficher en direct, dans
 * « Infos techniques », ce que « Préparer avec ces valeurs » enverrait. `server.mjs` ne fait plus
 * qu'emballer le résultat dans un `Buffer`. Une seule fonction, donc — et c'est ce script qui
 * prouve qu'elle reste alignée sur le DÉCODEUR de production (`argumentsTrame`, `case 0x83`).
 *
 * L'erreur visée est celle qui ne lève rien : un décalage d'un octet, une largeur mal choisie, un
 * CRC calculé sur la mauvaise étendue. Aucune des trois ne produit d'exception — elles produisent
 * une trame plausible qui sert un autre café, ou une écriture persistante dans le mauvais
 * emplacement.
 *
 * Aucune dépendance : `node scripts/verif-trame-boisson.mjs`.
 */
import { ACT, ENTETE_REQUETE, MODE, actionPreparer, encodeDispense, inverted } from "../src/lib/trame-boisson.mjs";
import { TWO, crcCcitt } from "../src/lib/trame-bornes.mjs";
// Le décodeur de PRODUCTION, celui que lit le journal du serveur. C'est tout l'intérêt : on ne
// compare pas l'encodeur à une idée de la trame, on le compare à ce qui la relira réellement.
import { argumentsTrame } from "../src/lib/ecam-args.mjs";

let ko = 0;
const test = (nom, fn) => {
  try { fn(); console.log("  ok   ", nom); }
  catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); }
};
const eq = (a, b, quoi) => { if (a !== b) throw new Error(`${quoi}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
const vrai = (x, quoi) => { if (!x) throw new Error(quoi); };

/** Le décodeur travaille sur un `Buffer`, l'encodeur rend un `Uint8Array`. */
const buf = (r) => Buffer.from(r.bytes);
/** Les noms que `argumentsTrame` réclame ; ce script ne teste pas les libellés, seulement les octets. */
const NOMS = { boisson: (id) => `boisson ${id}`, reglage: (a) => `réglage ${a}`, params: {} };
const lire = (r) => argumentsTrame(buf(r), NOMS);

/**
 * Un cappuccino tel que l'éditeur le compose : COFFEE (1) et MILK (9) sont sur DEUX octets,
 * TASTE (2) et INVERSION (12) sur un seul. C'est le mélange de largeurs qui casse un encodeur.
 */
const CAPPU = [{ id: 1, value: 40 }, { id: 2, value: 3 }, { id: 9, value: 120 }, { id: 12, value: 0 }];

console.log("Trame 0x83 — en-tête et longueur");

test("l'en-tête d'une REQUÊTE est 0x0d, la commande 0x83, le flag 0xf0", () => {
  const b = buf(encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU));
  eq(b[0], ENTETE_REQUETE, "octet 0");
  eq(b[2], 0x83, "octet 2");
  eq(b[3], 0xf0, "octet 3");
  eq(b[4], 7, "octet 4 = la boisson");
});

test("`len` (octet 1) vaut la taille totale − 1, CRC compris", () => {
  const b = buf(encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU));
  eq(b[1], b.length - 1, "len");
  // 6 d'en-tête + (3 + 2 + 3 + 2) de paramètres + 1 de profil/action + 2 de CRC
  eq(b.length, 19, "taille totale");
});

test("une trame sans paramètre — l'arrêt — tient en 9 octets", () => {
  const b = buf(encodeDispense(1, 1, MODE.STOPV2, ACT.PREPARE, []));
  eq(b.length, 9, "taille");
  eq(b[1], 8, "len");
  eq(b[5], MODE.STOPV2, "mode");
});

console.log("Largeurs — le décalage qui ne lève rien");

test("les paramètres de `TWO` occupent 2 octets, les autres 1", () => {
  const b = buf(encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU));
  // COFFEE (1) = 40 sur deux octets, puis TASTE (2) = 3 sur un.
  eq(b[6], 1, "id COFFEE"); eq(b[7], 0, "COFFEE poids fort"); eq(b[8], 40, "COFFEE poids faible");
  eq(b[9], 2, "id TASTE"); eq(b[10], 3, "TASTE");
  vrai(TWO.has(1) && TWO.has(9) && !TWO.has(2), "la table des largeurs a changé sous ce test");
});

test("une quantité > 255 survit — c'est ce que la largeur de 2 octets sert à porter", () => {
  const b = buf(encodeDispense(7, 1, MODE.START, ACT.PREPARE, [{ id: 9, value: 300 }]));
  eq(b[7], 1, "MILK poids fort"); eq(b[8], 44, "MILK poids faible");
  vrai(argumentsTrame(b, NOMS).includes("300"), "le décodeur ne relit pas 300");
});

test("une valeur hors largeur LÈVE, elle ne se tronque pas", () => {
  let leve = false;
  try { encodeDispense(7, 1, MODE.START, ACT.PREPARE, [{ id: 2, value: 256 }]); }
  catch { leve = true; }
  vrai(leve, "256 sur un octet est passé en silence");
});

test("l'ordre des paramètres est CELUI DE L'APPELANT, jamais trié", () => {
  const b = buf(encodeDispense(7, 1, MODE.START, ACT.PREPARE, [{ id: 12, value: 1 }, { id: 1, value: 40 }]));
  eq(b[6], 12, "premier id");
  eq(b[8], 1, "second id");
});

console.log("Profil, action, vérification");

test("le dernier octet avant le CRC porte (profil << 2) | action", () => {
  const b = buf(encodeDispense(7, 3, MODE.DONTCARE, ACT.SAVE, CAPPU));
  eq(b[b.length - 3], (3 << 2) | 1, "profil/action");
});

test("le bit 0x80 du mode est le drapeau de vérification, et lui seul", () => {
  const sans = buf(encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU));
  const avec = buf(encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU, true));
  eq(sans[5], MODE.START, "sans vérification");
  eq(avec[5], MODE.START | 0x80, "avec vérification");
  vrai(argumentsTrame(avec, NOMS).includes("vérification"), "le décodeur ne voit pas le drapeau");
});

test("l'inversion se déduit du paramètre 12, elle ne se demande pas", () => {
  vrai(!inverted(CAPPU), "un cappuccino droit n'est pas inversé");
  vrai(inverted([...CAPPU.slice(0, 3), { id: 12, value: 1 }]), "INVERSION = 1 non vu");
  eq(actionPreparer(CAPPU), ACT.PREPARE, "action sans inversion");
  eq(actionPreparer([{ id: 12, value: 1 }]), ACT.PREPARE_INVERSION, "action avec inversion");
});

/**
 * ⚠️ **`PREPARE_INVERSION` vaut 6 : son bit 0x04 tombe dans les bits du profil.** Le test l'ÉNONCE
 * plutôt que de le corriger — c'est ce que fait `RecipeData.T()` dans l'app, et la machine est le
 * seul juge de la façon dont elle relit cet octet. Le noter ici évite qu'un futur lecteur prenne
 * le décalage de `argumentsTrame` pour un bug du décodeur : les deux sont fidèles à la trame.
 */
test("l'inversion déborde sur les bits du profil — fait reporté de l'app, pas corrigé", () => {
  const b = buf(encodeDispense(7, 2, MODE.START, ACT.PREPARE_INVERSION, CAPPU));
  eq(b[b.length - 3], (2 << 2) | 6, "octet profil/action brut");
  vrai(argumentsTrame(b, NOMS).includes("profil 3"), "le décodeur ne relit plus profil 3 ici");
});

console.log("CRC");

test("le CRC est posé sur les deux derniers octets et couvre tout le reste", () => {
  const r = encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU);
  const b = r.bytes;
  eq((b[b.length - 2] << 8) | b[b.length - 1], r.crc, "CRC posé");
  eq(crcCcitt(b), r.crc, "CRC recalculé sur la trame entière");
});

test("un octet changé change le CRC — la trame n'est pas scellée à vide", () => {
  const a = encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU);
  const b = encodeDispense(7, 1, MODE.START, ACT.PREPARE, [CAPPU[0], { id: 2, value: 4 }, CAPPU[2], CAPPU[3]]);
  vrai(a.crc !== b.crc, "deux arômes différents donnent le même CRC");
});

console.log("Aller-retour avec le décodeur de production");

test("`argumentsTrame` relit la boisson, le profil et chaque valeur", () => {
  const lu = lire(encodeDispense(7, 2, MODE.START, ACT.PREPARE, CAPPU));
  vrai(lu.includes("préparer"), `mode non relu : ${lu}`);
  vrai(lu.includes("boisson 7"), `boisson non relue : ${lu}`);
  vrai(lu.includes("profil 2"), `profil non relu : ${lu}`);
  for (const p of CAPPU) vrai(lu.includes(`param ${p.id} ${p.value}`), `${p.id} = ${p.value} non relu : ${lu}`);
});

test("l'ÉCRITURE PERSISTANTE se distingue d'un café lancé, à un octet près", () => {
  const save = lire(encodeDispense(7, 1, MODE.DONTCARE, ACT.SAVE, CAPPU));
  const cafe = lire(encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU));
  vrai(save.includes("ENREGISTRER"), `écriture non annoncée : ${save}`);
  vrai(!cafe.includes("ENREGISTRER"), `une préparation s'annonce comme une écriture : ${cafe}`);
});

test("l'arrêt se relit comme un arrêt", () => {
  vrai(lire(encodeDispense(1, 1, MODE.STOPV2, ACT.PREPARE, [])).includes("ARRÊTER"), "arrêt non relu");
});

/**
 * **Le hexadécimal rendu est celui qu'on affiche**, et il doit se comparer à l'œil avec le `hex`
 * des décodeurs — d'où l'espacement, et d'où ce test : c'est la seule chose de ce module qui parte
 * dans une page.
 */
test("`hex` porte l'espacement du reste du dépôt et décrit les MÊMES octets", () => {
  const r = encodeDispense(7, 1, MODE.START, ACT.PREPARE, CAPPU);
  eq(r.hex, Buffer.from(r.bytes).toString("hex").replace(/(..)/g, "$1 ").trim(), "hex");
  vrai(r.hex.startsWith("0d 12 83 f0 07 01 "), `en-tête inattendu : ${r.hex}`);
});

console.log(ko ? `\n${ko} ÉCHEC(S)` : "\nTout est vert.");
process.exit(ko ? 1 : 0);
