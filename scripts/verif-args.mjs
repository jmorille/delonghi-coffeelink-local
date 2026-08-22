/**
 * Vérifie le décodage des arguments de trames ECAM — sans machine, sans réseau.
 *
 * Cinquième script de cette famille, après `verif-tasks`, `verif-monitor`, `verif-lansession` et
 * `verif-apps`, et il existe pour la même raison : `ecam-args.mjs` est pur, donc il se prouve.
 *
 * **Ce qu'il teste vraiment, ce sont les DÉCALAGES d'octets.** Les trames sont construites ici par
 * les formules mêmes des constructeurs de `server.mjs` puis relues à l'envers : un décalage d'un
 * octet entre les deux ne lèverait aucune erreur à l'exécution, il produirait des valeurs
 * plausibles et fausses — le pire résultat possible dans un journal dont on se sert pour décider
 * si une vraie cafetière vient de lancer un café ou d'écraser une recette.
 *
 * La première assertion porte sur une trame **réellement relevée** sur l'application officielle.
 *
 * Aucune dépendance : `node scripts/verif-args.mjs`.
 */
import { TWO, argumentsTrame } from "../src/lib/ecam-args.mjs";

let ko = 0;
const test = (nom, fn) => {
  try { fn(); console.log("  ok   ", nom); }
  catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); }
};
const eq = (a, b, quoi) => { if (a !== b) throw new Error(`${quoi}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

// Les deux tables injectées, réduites à ce que les cas ci-dessous demandent.
const PARAMS = {
  0: { label: "Température café", unit: "niveau" }, 1: { label: "Café", unit: "ml" },
  2: { label: "Arôme", unit: "niveau" }, 9: { label: "Lait", unit: "ml" },
  12: { label: "Inversion", unit: "" },
};
const NOMS = { 1: "Espresso", 7: "Cappuccino" };
const ctx = {
  boisson: (id) => NOMS[id] ?? `boisson ${id}`,
  reglage: (a) => ({ 61: "réglage temperature (61)", 63: "réglage userConf (63)" })[a] ?? `réglage ${a}`,
  params: PARAMS,
};
const lire = (t) => argumentsTrame(Buffer.from(t), ctx);

// --- copies conformes des constructeurs de `server.mjs`. Le CRC est laissé à zéro : il ne change
// --- aucun décalage, et le décodeur ne le lit pas.
function frameDispense(bev, prof, mode, action, params, check = false) {
  const body = [];
  for (const p of params) { body.push(p.id & 0xff); if (TWO.has(p.id)) body.push((p.value >> 8) & 0xff, p.value & 0xff); else body.push(p.value & 0xff); }
  const total = body.length + 9; const b = new Array(total).fill(0);
  b[0] = 0x0d; b[1] = total - 1; b[2] = 0x83; b[3] = 0xf0; b[4] = bev & 0xff;
  b[5] = check ? (mode | 0x80) & 0xff : mode & 0xff;
  for (let i = 0; i < body.length; i++) b[6 + i] = body[i];
  b[6 + body.length] = ((prof << 2) | action) & 0xff;
  return b;
}
const frameTurnOn = () => [0x0d, 0x07, 0x84, 0x0f, 0x02, 0x01, 0, 0];
const frameTurnOff = () => [0x0d, 0x07, 0x84, 0x0f, 0x01, 0x01, 0, 0];
const frameParamRead = (id, qty = 1) => [0x0d, 0x08, 0xa2, 0x0f, (id >> 8) & 0xff, id & 0xff, qty & 0xff, 0, 0];
const frameRecipeQty = (p, b) => [0x0d, 0x07, 0xa6, 0xf0, p & 0xff, b & 0xff, 0, 0];
const frameSelectBean = (id) => [0x0d, 0x06, 0xb9, 0xf0, id & 0xff, 0, 0];
const frameBeanSystem = (i) => [0x0d, 0x06, 0xba, 0xf0, i & 0xff, 0, 0];
const frameParamWrite = (id, v) => [0x0d, 0x0b, 0x90, id < 1000 ? 0x0f : 0xf0, (id >> 8) & 0xff, id & 0xff,
  (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, 0, 0];
function frameBeanSave(id, g, t, a, visible = true) {
  const b = new Array(52).fill(0);
  b[0] = 0x0d; b[1] = 0x33; b[2] = 0xbb; b[3] = 0xf0; b[4] = id & 0xff;
  b[45] = g; b[46] = t; b[47] = a; b[48] = 0; b[49] = visible ? 1 : 0;
  return b;
}

console.log("\n— une trame RÉELLE, relevée sur l'application officielle —");

test("0xA9 : la sélection de profil que l'apk envoie à l'ouverture de session", () => {
  // Relevée deux fois, à deux sessions distinctes. L'application impose son profil courant, pris
  // d'une préférence du téléphone dont 1 est la valeur par défaut.
  eq(lire([0x0d, 0x06, 0xa9, 0xf0, 0x01, 0xd7, 0xc0]), "profil 1", "profil");
});

console.log("\n— décalages d'octets, contre les constructeurs eux-mêmes —");

test("0x83 : préparer une boisson, avec ses paramètres et leurs unités", () => {
  eq(lire(frameDispense(7, 2, 1, 2, [{ id: 1, value: 40 }, { id: 9, value: 120 }, { id: 2, value: 3 }])),
    "préparer Cappuccino · profil 2 · Café 40 ml, Lait 120 ml, Arôme 3", "préparation");
});

test("0x83 : les paramètres 16 bits ne décalent pas les suivants", () => {
  // Café (1) et lait (9) tiennent sur deux octets, l'arôme (2) sur un. Confondre les deux décale
  // tout ce qui suit ET le profil, qui est le DERNIER octet avant le CRC.
  eq(lire(frameDispense(1, 5, 1, 2, [{ id: 9, value: 300 }, { id: 0, value: 2 }])),
    "préparer Espresso · profil 5 · Lait 300 ml, Température café 2", "16 bits puis 8 bits");
});

test("0x83 : l'ÉCRITURE persistante se distingue d'un café lancé, à un octet près", () => {
  // Mode DONTCARE (0) + action SAVE (1) remplace la recette d'un profil DANS l'appareil.
  eq(lire(frameDispense(1, 3, 0, 1, [{ id: 1, value: 30 }])),
    "ENREGISTRER dans le profil Espresso · profil 3 · Café 30 ml", "enregistrement");
  eq(lire(frameDispense(1, 3, 1, 2, [{ id: 1, value: 30 }])),
    "préparer Espresso · profil 3 · Café 30 ml", "préparation, mêmes paramètres");
});

test("0x83 : l'arrêt et le drapeau de vérification", () => {
  eq(lire(frameDispense(1, 1, 2, 2, [])), "ARRÊTER Espresso · profil 1", "arrêt");
  eq(lire(frameDispense(7, 2, 1, 2, [{ id: 12, value: 1 }], true)),
    "préparer Cappuccino · profil 2 · vérification · Inversion 1", "bit 0x80");
});

test("0x84 : allumer le dit, parce que ce n'est pas anodin", () => {
  eq(lire(frameTurnOn()), "ALLUMER (déclenche un rinçage à l'eau chaude)", "allumage");
  eq(lire(frameTurnOff()), "ÉTEINDRE", "extinction");
});

test("lectures : paramètres, recette d'un profil, grains", () => {
  eq(lire(frameParamRead(3001, 10)), "paramètres 3001 … +9", "plage de compteurs");
  eq(lire(frameParamRead(105)), "paramètres 105", "un seul compteur, pas de « +0 »");
  eq(lire(frameRecipeQty(2, 7)), "profil 2 · Cappuccino", "valeurs d'une recette");
  eq(lire(frameBeanSystem(3)), "grain 3", "lecture d'un grain");
  eq(lire(frameSelectBean(2)), "grain actif 2", "sélection du grain");
});

test("0xBB : la suppression est la même trame à visible = 0, et se voit", () => {
  eq(lire(frameBeanSave(3, 4, 2, 5)), "grain 3 · mouture 4, température 2, arôme 5", "écriture");
  eq(lire(frameBeanSave(3, 4, 2, 5, false)),
    "grain 3 · mouture 4, température 2, arôme 5 · SUPPRESSION (visible = 0)", "suppression");
});

test("0x90 : l'octet de poids fort est MULTIPLIÉ, jamais décalé", () => {
  // `0x80 << 24` est négatif en JS. Ce projet a déjà publié un champ de bits signé pour cela.
  eq(lire(frameParamWrite(61, 3)), "réglage temperature (61) ← 3", "petite valeur");
  eq(lire(frameParamWrite(63, 0x80000000)), "réglage userConf (63) ← 2147483648", "bit de poids fort");
});

console.log("\n— ce qu'il refuse de deviner —");

test("une commande sans argument, ou inconnue, rend null", () => {
  eq(lire([0x0d, 0x05, 0x75, 0x0f, 0xda, 0x25]), null, "monitor : aucun argument");
  eq(lire([0x0d, 0x05, 0xa3, 0xf0, 0, 0]), null, "sommes de contrôle : aucun argument");
  // Une trame jamais observée doit garder ses octets bruts dans le journal plutôt que recevoir une
  // glose inventée, qui se lirait comme un fait.
  eq(lire([0x0d, 0x06, 0xc7, 0xf0, 0x01, 0, 0]), null, "commande inconnue : rien d'inventé");
  eq(lire([0x0d]), null, "trame tronquée");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
