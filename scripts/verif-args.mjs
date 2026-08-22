/**
 * Vérifie **le référentiel des commandes ECAM** — table des opérations, lecture d'une trame,
 * décodage de ses arguments — sans machine, sans réseau.
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
import {
  ECAM_OPS, TWO, argumentsTrame, cleFusion, describeFrame, natureTrame, opReponse, octetsEcam, profilVise,
} from "../src/lib/ecam-args.mjs";

let ko = 0;
const test = (nom, fn) => {
  try { fn(); console.log("  ok   ", nom); }
  catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); }
};
const eq = (a, b, quoi) => { if (a !== b) throw new Error(`${quoi}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
const vrai = (x, quoi) => { if (!x) throw new Error(quoi); };

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

console.log("\n— la table des opérations, qui décide aussi comment on ATTEND la machine —");

// `datapointValue` ajoute 4 octets d'horodatage à ce que NOUS envoyons ; `opTrame` et ses
// dérivées les retirent. Les oublier ici testerait autre chose que ce qui tourne.
const sortante = (t) => Buffer.from([...t, 1, 2, 3, 4]).toString("base64");

test("la nature d'une trame décide de l'attente : réponse ou fenêtre de présence", () => {
  // C'est `startProgram` qui lit ceci. Une lecture classée « action » attendrait une fenêtre au
  // lieu de la réponse qui arrive — et l'inverse ferait expirer un pas que rien ne satisfera.
  eq(natureTrame(sortante(frameParamRead(3001, 10))), "lecture", "0xA2 est une lecture");
  eq(natureTrame(sortante([0x0d, 0x05, 0x75, 0x0f, 0, 0])), "lecture", "0x75 est une lecture");
  eq(natureTrame(sortante(frameTurnOn())), "action", "0x84 agit");
  eq(natureTrame(sortante(frameBeanSave(1, 4, 2, 5))), "écriture", "0xBB écrit dans l'appareil");
  // Une trame jamais vue est traitée comme une action : choix prudent, il fait tenir la présence
  // au lieu d'attendre une réponse qui ne viendra peut-être jamais.
  eq(natureTrame(sortante([0x0d, 0x06, 0xc7, 0xf0, 1, 0, 0])), "action", "commande inconnue");
});

test("0x83 change de nature selon son octet de mode, et c'est tout ce qui sépare", () => {
  // ⚠️ Le MÊME octet de commande prépare un café et écrase une recette dans l'appareil.
  eq(natureTrame(sortante(frameDispense(1, 3, 0, 1, [{ id: 1, value: 30 }]))), "écriture", "SAVE");
  eq(natureTrame(sortante(frameDispense(1, 3, 1, 2, [{ id: 1, value: 30 }]))), "action", "préparation");
});

test("describeFrame : la forme courte perd les octets, jamais l'opération", () => {
  const t = sortante(frameTurnOn());
  eq(describeFrame(t, { octets: false }), "action · marche / arrêt (0x84)", "forme courte");
  eq(describeFrame(t).startsWith("action · marche / arrêt (0x84) · trame 0d 07 84 0f 02 01"), true, "forme longue");
  // Les 4 octets d'horodatage ne sont PAS des octets de commande : les afficher tromperait qui
  // compare la ligne aux tables de `doc/commandes-cafe.md`.
  eq(describeFrame(t).includes("01 02 03 04"), false, "horodatage retiré");
});

test("une commande hors table est CRIÉE et garde ses octets, même en forme courte", () => {
  // C'est le matériau de la rétro-ingénierie : l'application officielle est le seul émetteur au
  // monde à produire des trames que nous n'avons jamais vues, et elle ne les rejoue pas. Une
  // ligne discrète les perdrait.
  const t = sortante([0x0d, 0x06, 0xc7, 0xf0, 0x01, 0, 0]);
  eq(describeFrame(t, { octets: false }), "commande NON IDENTIFIÉE (0xc7) · trame 0d 06 c7 f0 01 00 00", "courte");
  eq(describeFrame(t).includes("NON IDENTIFIÉE"), true, "longue");
});

test("profilVise lit les DEUX dispositions, et rien d'autre", () => {
  // La toute première commande qu'une application officielle nous a relayée était une sélection
  // de profil : sans cette lecture, un téléphone qui se branche déplace le profil actif de
  // l'appareil pendant que nos pages affichent l'ancien.
  eq(profilVise(sortante([0x0d, 0x06, 0xa9, 0xf0, 0x03, 0, 0])), 3, "0xA9, octet 4 en clair");
  eq(profilVise(sortante(frameDispense(1, 4, 1, 2, [{ id: 1, value: 30 }]))), 4, "0x83, (profil << 2) | action");
  eq(profilVise(sortante(frameTurnOn())), null, "une trame qui ne vise aucun profil");
});

console.log("\n— les trames ENTRANTES : ce que la machine répond, ce qu'une app reçoit —");

// Une réponse ne porte PAS les 4 octets d'horodatage : c'est nous qui les ajoutons.
const entrante = (t) => Buffer.from(t).toString("base64");

test("opReponse nomme la commande d'une réponse, sans rien retirer", () => {
  const r = opReponse(entrante([0xd0, 0x08, 0xa2, 0x0f, 0x0b, 0xb9, 0, 0, 0, 1, 0, 0]));
  eq(r.cmd, 0xa2, "octet de commande");
  eq(r.op.nom, "paramètres et compteurs", "nom lu dans la table");
  eq(r.trame.length, 12, "aucun octet retiré");
});

test("opReponse refuse ce qui n'est pas une trame plutôt que d'inventer des octets", () => {
  // ⚠️ `Buffer.from(x, "base64")` ne lève JAMAIS : il ignore ce qui n'en est pas et rend des
  // octets qui ont l'air de quelque chose. Relevé en direct sur la vraie application, qui écrit
  // `device_connected = 1787407876` — un horodatage unix en clair, affiché « d7 bf 3b e3 4e fc ».
  eq(opReponse("1787407876"), null, "un nombre en clair");
  eq(opReponse(""), null, "vide");
  eq(opReponse(null), null, "absent");
  // Un base64 valide dont l'en-tête n'est ni 0x0D ni 0xD0 n'est pas de l'ECAM.
  eq(opReponse(entrante([0x01, 0x02, 0x03, 0x04])), null, "en-tête étranger");
});

test("une réponse hors table rend son octet, pas une glose", () => {
  const r = opReponse(entrante([0xd0, 0x06, 0xc7, 0xf0, 1, 0, 0]));
  eq(r.cmd, 0xc7, "l'octet est rendu");
  eq(r.op, undefined, "et rien n'est inventé autour");
});

test("les réponses que le serveur sait décoder sont TOUTES nommées", () => {
  // Les octets de réponse qu'`handleProperty` route vers un décodeur. Une entrée manquante ici
  // ferait dire « commande NON IDENTIFIÉE » d'une trame que le serveur décode parfaitement —
  // c'est-à-dire un faux signal de découverte, exactement ce que ce mécanisme ne doit pas produire.
  for (const cmd of [0xa1, 0xa2, 0xa3, 0xa4, 0xa6, 0xa8, 0xaa, 0xb0, 0xba, 0x95]) {
    if (!ECAM_OPS[cmd]) throw new Error(`0x${cmd.toString(16)} absente de ECAM_OPS`);
  }
});
test("une valeur qui n'est pas une trame ne se voit PAS attribuer une commande", () => {
  // ⚠️ Relevé en direct sur l'application officielle, dans le journal des applications :
  //     commande NON IDENTIFIÉE (0x37) · trame 45 da 37 88 34 eb af ff ff fa 93 81
  // Or une trame ECAM commence par 0x0D, et celle-ci commence par 0x45. Le marqueur de
  // découverte pointait donc une commande qui n'existe pas — c'est-à-dire exactement le
  // contraire de ce à quoi il sert, puisqu'il existe pour faire ressortir le vrai inconnu.
  //
  // Le défaut avait déjà été corrigé dans le sens ENTRANT (`opReponse`) et pas dans le sens
  // SORTANT — où il compte davantage : c'est une valeur qu'on relaie à une VRAIE cafetière.
  const brute = "Rdo3iDTrr///+pOB";
  eq(octetsEcam(brute), null, "l'en-tête n'est ni 0x0D ni 0xD0");
  eq(describeFrame(brute).startsWith("valeur non-trame"), true, "elle est nommée pour ce qu'elle est");
  eq(describeFrame(brute).includes("45 da 37 88"), true, "les octets sont conservés");
  eq(describeFrame(brute).includes(brute), true, "le base64 aussi — il se recolle dans un test");
  eq(profilVise(brute), null, "aucun profil n'en est tiré");
  // `Buffer.from(x, "base64")` ne lève jamais : un horodatage unix ressortait en « commande ».
  eq(octetsEcam("1787407876"), null, "un entier n'est pas une trame");
  eq(octetsEcam(""), null, "le vide non plus");
  eq(octetsEcam(null), null, "ni l'absence de valeur");
});

test("une vraie trame traverse le garde-fou sans être touchée", () => {
  // Le filtre ne doit rien coûter au cas normal : un faux positif ici effacerait du journal la
  // commande la plus importante qui y passe.
  const allumer = Buffer.from([0x0d, 0x07, 0x84, 0x0f, 0x02, 0x01, 0x55, 0x12, 0, 0, 0, 0]).toString("base64");
  eq(octetsEcam(allumer) !== null, true, "en-tête 0x0D accepté");
  eq(describeFrame(allumer).includes("(0x84)"), true, "la commande est nommée");
  // Les 4 octets d'horodatage sont retirés d'une VRAIE trame, et seulement d'elle : sur un
  // non-trame on ne sait pas ce que sont les 4 derniers octets, donc on les garde.
  eq(!describeFrame(allumer).includes("55 12 00"), true, "l'horodatage est retiré d'une trame");
  const reponse = Buffer.from([0xd0, 0x08, 0xa2, 0x0f, 0, 0, 0, 0]).toString("base64");
  eq(octetsEcam(reponse) !== null, true, "en-tête 0xD0 accepté aussi — c'est le sens entrant");
});
test("la fusion ne prend que ce dont la répétition est sans effet", () => {
  // ⚠️ Défaut constaté en usage réel : six « sélection de profil (0xa9) · profil 1 » identiques
  // en file, chacune partant redire à la machine ce que la précédente venait de lui dire.
  // L'application officielle impose son profil courant à chaque ouverture de session.
  const horo = [0x11, 0x22, 0x33, 0x44];
  const b64 = (o) => Buffer.from([...o, ...horo]).toString("base64");
  const profil1 = b64([0x0d, 0x06, 0xa9, 0xf0, 0x01, 0x5f, 0x2a]);
  const profil1bis = b64([0x0d, 0x06, 0xa9, 0xf0, 0x01, 0x5f, 0x2a]);
  const profil3 = b64([0x0d, 0x06, 0xa9, 0xf0, 0x03, 0x11, 0x22]);
  eq(cleFusion(profil1), "profil:1", "une sélection de profil porte le profil visé");
  eq(cleFusion(profil1bis), cleFusion(profil1), "deux fois le même profil : une seule clé");
  vrai(cleFusion(profil3) !== cleFusion(profil1), "deux profils différents ne fusionnent pas");

  // Une LECTURE répétée est la même lecture. `0x75` porte le nom que la file emploie déjà
  // partout pour cet état-là, sans quoi la demande d'une application et celle du bouton
  // « Lire l'état » feraient deux tâches pour une seule question.
  eq(cleFusion(b64([0x0d, 0x05, 0x75, 0x0f, 0xda, 0x25])), "presence", "le monitor rejoint la présence");

  // ⚠️ **L'absence de clé est une décision, pas un oubli** : demander deux cafés n'est pas
  // demander un café. Une préparation, un arrêt, un allumage gardent chacun leur ligne.
  vrai(cleFusion(b64([0x0d, 0x12, 0x83, 0xf0, 0x01, 0x01, 0x00, 0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x11, 0x22])) === null,
       "une préparation ne fusionne jamais");
  vrai(cleFusion(b64([0x0d, 0x07, 0x84, 0x0f, 0x02, 0x01, 0x55, 0x12])) === null,
       "marche / arrêt non plus : son idempotence n'est pas établie");

  // Et une trame qu'on ne sait pas nommer est une trame dont on ignore l'effet : la fusionner
  // supprimerait une commande sur une supposition. Même règle pour ce qui n'est pas une trame.
  vrai(cleFusion(b64([0x0d, 0x05, 0x37, 0x0f, 0x00, 0x00])) === null, "commande non identifiée : aucune clé");
  vrai(cleFusion("MTc4NzQwNzg3Ng==") === null, "une valeur non-trame : aucune clé");
  vrai(cleFusion(null) === null, "rien du tout : aucune clé");
});
console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
