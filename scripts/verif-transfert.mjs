/**
 * Vérifie **le report d'une recette locale dans un emplacement perso de la machine** — quels
 * réglages partent, lesquels sont retirés, lesquels sont écrits « absents », et quand le transfert
 * doit être refusé.
 *
 * Sixième script de cette famille, après `verif-tasks`, `verif-monitor`, `verif-lansession`,
 * `verif-apps` et `verif-args`, et il existe pour la même raison : `transfert.mjs` est pur, donc il
 * se prouve sans machine.
 *
 * **Ce qu'il protège vraiment est une écriture PERSISTANTE dans une vraie cafetière.** Un transfert
 * écrase la recette enregistrée d'un emplacement ; une erreur ici ne lève rien, elle produit une
 * boisson plausible et fausse — un café resté dans un emplacement censé n'en plus contenir, ou un
 * emplacement rendu invisible parce qu'on aura mis `VISIBLE` à zéro en croyant bien faire.
 *
 * Aucune dépendance : `node scripts/verif-transfert.mjs`.
 */
import { CROISES, INGREDIENTS, OPTION_SANS_OBJET, QUANTITE_ABSENTE, composable, croiseDe, groupeDe, valeurAbsente } from "../src/lib/ingredients.mjs";
import { QUANTITES, planTransfert } from "../src/lib/transfert.mjs";
// Le decodeur de PRODUCTION : les trames figees plus bas sont relues par celui qui tourne, et
// non par une copie de test. Meme discipline que `verif-monitor.mjs` avec ses captures.
import { decodeRecipeBounds } from "../src/lib/beverages.mjs";
import { TWO, encodeRecipeBounds, hexEspace } from "../src/lib/trame-bornes.mjs";

let ko = 0;
const test = (nom, fn) => {
  try { fn(); console.log("  ok   ", nom); }
  catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); }
};
const eq = (a, b, quoi) => { if (a !== b) throw new Error(`${quoi}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
const vrai = (x, quoi) => { if (!x) throw new Error(quoi); };
const memes = (a, b, quoi) => eq(JSON.stringify(a), JSON.stringify(b), quoi);

/**
 * Ce qu'un emplacement perso déclare RÉELLEMENT sur une ECAM 610.75.MB — les six emplacements, lus
 * sur l'appareil par `0xB0`, donnent tous exactement cette liste. Elle est reprise verbatim de
 * `src/lib/ingredients.mjs`, où les trois vérifications concordantes sont écrites.
 */
const PERSO = [1, 2, 4, 9, 12, 24, 25, 28];
/** Une boisson du catalogue à base d'eau chaude : `HOT_WATER` (15), que nul emplacement perso ne déclare. */
const EAU = [15];

const valeur = (plan, id) => plan.params.find((p) => p.id === id)?.value;

console.log("\n— report des réglages —");

test("café + lait vers un emplacement perso : tout passe, rien n'est retiré", () => {
  const plan = planTransfert({
    params: [{ id: 1, value: 40 }, { id: 2, value: 4 }, { id: 4, value: 0 }, { id: 9, value: 100 }, { id: 12, value: 0 }, { id: 28, value: 2 }],
    cibleParams: PERSO,
  });
  vrai(plan.possible, "le transfert doit être possible");
  eq(plan.raison, null, "aucune raison de refus");
  eq(plan.retires.length, 0, "rien de retiré");
  eq(valeur(plan, 1), 40, "café");
  eq(valeur(plan, 9), 100, "lait");
});

test("une valeur passe VERBATIM : rien n'est ramené dans des bornes ici", () => {
  // Ce module ne reçoit pas les bornes de la cible — seulement la liste de ce qu'elle déclare —
  // donc il ne borne rien, et cette assertion est là pour qu'un ajout de bornage soit un choix
  // DÉLIBÉRÉ plutôt qu'un effet de bord. 250 est justement HORS des bornes de `COFFEE` sur un
  // emplacement perso (20-180), ce qui rend le report verbatim visible.
  // ⚠️ La justification qui tenait ici — « les bornes sont les mêmes d'une boisson à l'autre » —
  // était fausse : voir le test des bornes variables plus bas, et doc/format-trame-boisson.md § 2.6.
  const plan = planTransfert({ params: [{ id: 1, value: 250 }], cibleParams: PERSO });
  eq(valeur(plan, 1), 250, "café reporté tel quel");
});

test("un réglage que la cible ne déclare pas est retiré ET listé", () => {
  const plan = planTransfert({ params: [{ id: 1, value: 40 }, { id: 13, value: 2 }], cibleParams: PERSO });
  eq(valeur(plan, 13), undefined, "13 ne doit pas partir");
  memes(plan.retires, [{ id: 13, value: 2 }], "13 doit être listé comme retiré");
});

console.log("\n— l'ingrédient absent s'écrit, il ne s'omet pas —");

test("une recette SANS lait écrit le lait absent, elle ne le laisse pas en place", () => {
  // C'est le défaut que ce module existe pour empêcher : omettre `MILK` laisserait le lait de la
  // recette PRÉCÉDENTE dans l'emplacement, donc un transfert « réussi » rendrait une boisson qui
  // n'est pas celle qu'on a transférée.
  const plan = planTransfert({ params: [{ id: 1, value: 40 }, { id: 2, value: 4 }], cibleParams: PERSO });
  eq(valeur(plan, 9), QUANTITE_ABSENTE, "quantité de lait");
  eq(valeur(plan, 12), OPTION_SANS_OBJET, "inversion sans objet");
  eq(valeur(plan, 28), OPTION_SANS_OBJET, "accessoire sans objet");
  vrai(plan.absents.includes(9), "le lait doit être annoncé absent");
});

test("une recette SANS café écrit le café absent, arôme et mélange compris", () => {
  const plan = planTransfert({ params: [{ id: 9, value: 100 }], cibleParams: PERSO });
  eq(valeur(plan, 1), QUANTITE_ABSENTE, "quantité de café");
  eq(valeur(plan, 2), OPTION_SANS_OBJET, "arôme sans objet");
  eq(valeur(plan, 4), OPTION_SANS_OBJET, "mélange sans objet");
});

test("un réglage SANS groupe est omis, jamais mis à zéro", () => {
  // `PROGRAMABLE` (24) et `VISIBLE` (25) ne sont pas des ingrédients : ils décrivent l'emplacement,
  // pas la tasse. Les écrire « absents » mettrait `VISIBLE` à 0, c'est-à-dire ferait DISPARAÎTRE de
  // la machine l'emplacement qu'on vient de remplir. Omis, la machine garde les siens.
  const plan = planTransfert({ params: [{ id: 1, value: 40 }], cibleParams: PERSO });
  eq(valeur(plan, 24), undefined, "programmable ne doit pas partir");
  eq(valeur(plan, 25), undefined, "visible ne doit pas partir");
  vrai(!plan.absents.includes(25), "et il ne doit pas être annoncé absent non plus");
});

test("les réglages partent dans l'ordre déclaré par la cible", () => {
  const plan = planTransfert({ params: [{ id: 9, value: 100 }, { id: 1, value: 40 }], cibleParams: PERSO });
  memes(plan.params.map((p) => p.id), [1, 2, 4, 9, 12, 28], "ordre de la trame");
});

console.log("\n— les refus, et ils doivent DIRE pourquoi —");

test("une recette d'eau chaude est refusée, et nommément", () => {
  // Un emplacement perso ne déclare ni `HOT_WATER` (15) ni `THE_TEMP` (13) : c'est une limite de la
  // cafetière, pas de l'interface. La retirer en silence donnerait un emplacement vide.
  const plan = planTransfert({ params: [{ id: 15, value: 200 }], cibleParams: PERSO });
  vrai(!plan.possible, "doit être refusé");
  eq(plan.raison, "hotWaterNotInCustomSlot", "raison");
  eq(plan.params.length, 0, "rien ne doit être proposé quand c'est refusé");
});

test("un thé est refusé pour la même raison", () => {
  const plan = planTransfert({ params: [{ id: 15, value: 200 }, { id: 13, value: 3 }], cibleParams: PERSO });
  eq(plan.raison, "hotWaterNotInCustomSlot", "raison");
});

test("une recette dont tous les ingrédients sont à zéro est refusée", () => {
  const plan = planTransfert({ params: [{ id: 1, value: 0 }, { id: 9, value: 0 }], cibleParams: PERSO });
  vrai(!plan.possible, "doit être refusé");
  eq(plan.raison, "nothingTransferable", "raison");
});

test("une cible qui ne déclare rien est refusée sans inventer de raison d'eau chaude", () => {
  const plan = planTransfert({ params: [{ id: 1, value: 40 }], cibleParams: [] });
  vrai(!plan.possible, "doit être refusé");
  eq(plan.raison, "nothingTransferable", "raison");
});

test("une recette d'eau chaude vers une cible QUI la déclare passe", () => {
  // La raison du refus est la CIBLE, pas la boisson : le module ne doit pas avoir appris que
  // « eau chaude = refus ».
  const plan = planTransfert({ params: [{ id: 15, value: 200 }], cibleParams: EAU });
  vrai(plan.possible, "doit passer");
  eq(valeur(plan, 15), 200, "eau chaude reportée");
});

console.log("\n— la table des quantités reste d'accord avec celle des ingrédients —");

test("toute quantité d'ingrédient est déclarée comme quantité", () => {
  // Ajouter un ingrédient sans l'ajouter aux quantités rendrait `possible` faux pour une recette
  // qui ne contient que lui : le transfert refuserait une recette parfaitement valable.
  for (const g of INGREDIENTS) vrai(QUANTITES.includes(g.quantite), `quantité ${g.quantite} absente de QUANTITES`);
});

console.log("\n— les réglages croisés restent une règle d'AFFICHAGE —");

test("un réglage croisé garde son groupe, donc sa valeur d'absence", () => {
  // C'est tout l'enjeu : `CROISES` déplace « ordre lait/café » hors du bloc « Lait » à l'écran.
  // S'il perdait son groupe au passage, décocher le lait cesserait de l'écrire « sans objet » et
  // laisserait en place la valeur de la recette précédente — sans que rien ne le signale.
  for (const c of CROISES) vrai(groupeDe(c.id) !== null, `le croisé ${c.id} a perdu son groupe`);
  const plan = planTransfert({ params: [{ id: 1, value: 40 }], cibleParams: PERSO });
  eq(valeur(plan, 12), OPTION_SANS_OBJET, "ordre lait/café sans objet quand le lait est absent");
});

test("un réglage croisé nomme des ingrédients qui existent", () => {
  const cles = INGREDIENTS.map((g) => g.cle);
  for (const c of CROISES) {
    vrai(c.ingredients.length >= 2, `${c.id} : un croisé porte au moins deux ingrédients`);
    for (const cle of c.ingredients) vrai(cles.includes(cle), `${c.id} : ingrédient « ${cle} » inconnu`);
  }
});

test("croiseDe ne reconnaît que les croisés", () => {
  vrai(croiseDe(12) !== null, "12 est croisé");
  vrai(croiseDe(9) === null, "la quantité de lait ne l'est pas");
  vrai(croiseDe(28) === null, "l'accessoire ne l'est pas");
});

console.log("\n— la COMPOSABILITÉ est mesurée, et elle se prouve sur de vraies trames —");

/**
 * **Des trames `0xB0` réellement lues sur une ECAM 610.75.MB, le 2026-08-23.** Elles sont relues ici
 * par `decodeRecipeBounds`, le décodeur de production : ce que ce bloc prouve, c'est le comportement
 * du code qui tourne face à ce que l'appareil envoie, et non face à ce qu'on aurait voulu qu'il
 * envoie. Même discipline que `verif-monitor.mjs` avec ses captures de préparations.
 *
 * Elles couvrent les formes qui décident de la règle : une boisson à une seule quantité (espresso),
 * deux à deux quantités toutes configurées d'usine (cappuccino, cappuccino doppio+), deux à une
 * seule quantité d'eau (eau chaude, thé), et les deux seules du modèle dont aucune quantité n'a de
 * défaut utilisable — le mug de voyage et un emplacement perso.
 *
 * Elles servent aussi à figer ce que la comparaison a démoli : les bornes d'un réglage **changent**
 * d'une boisson à l'autre. Parcours octet par octet dans `doc/format-trame-boisson.md` § 1 et § 2.
 */
const TRAMES = {
  espresso: "0CWw8AEIAAABGAABAQEAFAAoALQbAAEEAgAEBQQAAAAZAAEBuZY=",
  cappuccino: "0Cyw8AccAgICGAABARkAAQEBABQAQQC0GwABBAIAAwUJADIAqgQ4BAAAAKQ2",
  cappDoppio: "0Ciw8A0cAgICGAABARkAAQEBAFAAZAC0GwABBAkAMgCWBDgEAAAAmt4=",
  eauChaude: "0Bmw8BAYAAEBGQABAQ8AFAD6AaQbAAEEN5Y=",
  the: "0B2w8BYYAAEBGQACAg8AFACWAaQbAAEEDQABA64W",
  mugVoyage: "0Dew8BoYAAEBAQAoAAAA8AIBAwUJADwAAAHMBAAAAAwAAAEcAAAEGQACAg8AMgAAAQQbAP8EmiU=",
  lacteso: "0Cyw8OYYAAEBAQAUAAAAtAIA/wUJADIAAAQ4BAAAAAwAAAEcAAAEGQAAATmS",
};
const bornes = (nom) => {
  const r = decodeRecipeBounds(TRAMES[nom]);
  vrai(r !== null, `${nom} : trame indécodable`);
  return r.params;
};

test("les trames de référence se décodent, et disent bien ce qu'on croit", () => {
  eq(decodeRecipeBounds(TRAMES.mugVoyage).beverageId, 26, "la trame du mug de voyage est celle du 26");
  const q = new Map(bornes("mugVoyage").filter((p) => [1, 9, 15].includes(p.id)).map((p) => [p.id, p]));
  eq(q.size, 3, "le mug de voyage est la seule boisson du modèle à déclarer les trois quantités");
  // Trois défauts à 0 sous des minimums de 40, 60 et 50 : « jamais configuré par le modèle ».
  for (const [id, min] of [[1, 40], [9, 60], [15, 50]]) {
    eq(q.get(id).min, min, `borne basse de ${id}`);
    eq(q.get(id).def, 0, `défaut de ${id}`);
    vrai(q.get(id).def < q.get(id).min, `le défaut de ${id} doit tomber hors bornes`);
  }
});

test("composable ne retient que le mug de voyage et les emplacements perso", () => {
  vrai(composable(bornes("mugVoyage")), "le mug de voyage compose : trois quantités, aucun défaut utilisable");
  vrai(composable(bornes("lacteso")), "un emplacement perso compose, comme avant cette règle");
  vrai(!composable(bornes("espresso")), "un espresso ne compose pas : on ne décoche pas son café");
  vrai(!composable(bornes("cappuccino")), "un cappuccino ne compose pas : ses deux quantités ont un défaut d'usine");
  vrai(!composable(bornes("eauChaude")), "« Eau chaude » ne compose pas : une seule quantité");
  vrai(!composable(bornes("the")), "le thé ne compose pas : une seule quantité, l'eau chaude");
  vrai(!composable(bornes("cappDoppio")), "le cappuccino doppio+ ne compose pas : café 100 et lait 150 d'usine");
});

test("les bornes d'un réglage CHANGENT d'une boisson à l'autre", () => {
  /**
   * Garde, et non décoration : `transfert.mjs` et ce fichier justifiaient tous deux l'absence de
   * bornage par l'inverse — « les mêmes bornes partout, sinon la machine ne saurait pas préparer ».
   * Les trames ci-dessus le démentent, donc la réfutation est figée ici pour que la justification
   * fausse ne puisse pas revenir sous la plume de quelqu'un qui la trouve évidente.
   */
  const b = (nom, id) => bornes(nom).find((p) => p.id === id);
  eq(b("eauChaude", 15).max, 420, "« Eau chaude » monte à 420 ml");
  eq(b("mugVoyage", 15).max, 260, "le mug de voyage plafonne à 260 ml — même réglage, autre borne");
  eq(b("the", 15).max, 420, "le thé partage la borne de l'eau chaude, pas celle du mug");
  const mins = [b("espresso", 1).min, b("mugVoyage", 1).min, b("cappDoppio", 1).min];
  memes(mins, [20, 40, 80], "trois minimums de café différents sur trois boissons");
  eq(b("mugVoyage", 9).max, 460, "lait plafonné à 460 sur le mug de voyage");
  eq(b("cappDoppio", 9).max, 1080, "et à 1080 sur le cappuccino doppio+");
  // Corollaire pratique : une valeur légale ici est illégale là, et rien dans planTransfert ne le
  // voit — il ne reçoit que les identifiants de la cible.
  vrai(b("cappDoppio", 9).max > b("mugVoyage", 9).max, "un lait de 1000 ml ne rentre pas dans un mug de voyage");
});

test("un réglage à min == max existe, et reste un réglage", () => {
  // `ACCESSORIO` vaut 2/2/2 sur le cappuccino doppio+ : imposé, non réglable, et il doit quand même
  // partir dans la trame — même règle que l'INVERSION d'un flat white, qui sélectionne l'action.
  const acc = bornes("cappDoppio").find((p) => p.id === 28);
  vrai(acc !== undefined, "le cappuccino doppio+ déclare ACCESSORIO");
  eq(acc.min, acc.max, "min == max");
  eq(acc.def, 2, "et le défaut est cette valeur unique");
});

test("composable lit les DÉFAUTS, jamais la valeur enregistrée", () => {
  /**
   * C'est ce qui empêche la règle de basculer sous les pieds de l'utilisateur. Fondée sur la valeur
   * du profil, le mug de voyage aurait cessé d'être composable au premier réglage écrit dedans —
   * une boisson qui perd sa composition parce qu'on vient justement de la composer.
   */
  const avec = bornes("mugVoyage").map((p) => ({ ...p, value: p.id === 1 ? 100 : 0 }));
  vrai(composable(avec), "une valeur écrite ne doit rien changer");
  // Et à l'inverse : un seul défaut utilisable suffit à refuser, quelle que soit la valeur.
  const configure = bornes("mugVoyage").map((p) => (p.id === 1 ? { ...p, def: 100 } : p));
  vrai(!composable(configure), "un seul défaut utilisable suffit à ne plus composer");
});

test("moins de deux quantités ne compose jamais", () => {
  eq(composable([]), false, "aucune quantité");
  eq(composable([{ id: 15, min: 50, def: 0, max: 260 }]), false, "une seule quantité, même sans défaut");
});

console.log("\n— le marqueur 255 reste propre aux emplacements perso —");

test("l'eau chaude n'a AUCUNE option, donc aucun 255 à extrapoler", () => {
  const eau = INGREDIENTS.find((g) => g.quantite === 15);
  vrai(eau !== undefined, "l'eau chaude est un ingrédient");
  eq(eau.options.length, 0, "l'eau chaude n'ouvre aucun réglage");
});

test("sans marqueur, une option garde sa valeur au lieu de recevoir 255", () => {
  /**
   * Le mug de voyage contredit la convention : café absent (0, sous un minimum de 40) et pourtant
   * `TASTE = 3`, là où « Lacteso » — même état de café — porte 255. Écrire 255 dans un `TASTE` borné
   * 1-5 sur la foi d'une analogie produirait une valeur que cette boisson n'a jamais portée.
   */
  const cafe = INGREDIENTS.find((g) => g.quantite === 1);
  eq(valeurAbsente(cafe, 1, false), QUANTITE_ABSENTE, "la quantité vaut 0 des deux côtés : c'est le fait mesuré partout");
  eq(valeurAbsente(cafe, 2, false), null, "sans marqueur, l'arôme n'est pas touché");
  eq(valeurAbsente(cafe, 2, true), OPTION_SANS_OBJET, "avec marqueur, l'arôme est « sans objet »");
  eq(valeurAbsente(cafe, 2), OPTION_SANS_OBJET, "le défaut reste le comportement des emplacements perso");
});

test("QUANTITES ne compte l'eau chaude qu'une fois", () => {
  // Elle y était ajoutée à la main EN PLUS de la table ; devenue ingrédient, elle y figurait deux
  // fois. Le doublon ne cassait rien, et c'est précisément pourquoi il faut une assertion.
  eq(QUANTITES.filter((id) => id === 15).length, 1, "15 apparaît une seule fois");
  eq(QUANTITES.length, INGREDIENTS.length, "une quantité par ingrédient, pas plus");
});

console.log("\n— la trame de bornes se RECONSTRUIT à l'identique —");

/**
 * **L'aller-retour, sur les six trames réelles de `doc/format-trame-boisson.md`.** `/recipes` compose
 * une déclaration de bornes qui ne vient d'aucune lecture et l'affiche sous forme de trame ; sans
 * cette assertion, l'encodeur serait comparé à une idée de ce format et non à ce que l'appareil
 * envoie. Décoder puis réencoder doit rendre **les mêmes octets**, CRC compris.
 *
 * C'est ce qui referme le piège que le document nomme : une largeur mal choisie ne lève rien, elle
 * décale la suite et produit des valeurs plausibles. Ici elle décale aussi le CRC, et le CRC ne
 * pardonne pas.
 */
test("décoder puis réencoder rend la trame d'origine, octet pour octet", () => {
  for (const nom of Object.keys(TRAMES)) {
    const d = decodeRecipeBounds(TRAMES[nom]);
    vrai(d.exact, `${nom} : la trame de référence doit se décoder exactement`);
    eq(encodeRecipeBounds(d.beverageId, d.params).hex, d.hex, `${nom} : la trame réencodée doit être identique`);
    eq(hexEspace(Buffer.from(TRAMES[nom], "base64")), d.hex, `${nom} : le hex du décodeur est bien la trame entière`);
  }
});

test("les largeurs 16 bits sont celles qui font tomber le CRC", () => {
  /**
   * Retirer une quantité de `TWO` rendrait ses trois valeurs sur un octet : la trame raccourcit, le
   * CRC change, et l'aller-retour casse. C'est la seule preuve qu'on ait de ces largeurs — la table
   * n'existe pas dans l'APK, l'application la télécharge.
   */
  eq([...TWO].sort((a, b) => a - b).join(","), "1,9,15", "café, lait, eau chaude — et rien d'autre");
  const d = decodeRecipeBounds(TRAMES.mugVoyage);
  eq(d.params.filter((p) => TWO.has(p.id)).length, 3, "le mug de voyage porte les trois quantités 16 bits");
  eq(encodeRecipeBounds(d.beverageId, d.params).bytes.length, 56, "56 octets, comme la trame lue (§ 1 du document)");
});

test("l'ordre des entrées est celui reçu, jamais trié", () => {
  // La machine n'énonce pas ses paramètres dans l'ordre des identifiants — 24, 1, 2, 9, 4, 12, 28,
  // 25, 15, 27 pour le mug de voyage. Trier resterait décodable et rendrait l'aller-retour faux.
  const d = decodeRecipeBounds(TRAMES.mugVoyage);
  eq(d.params.map((p) => p.id).join(","), "24,1,2,9,4,12,28,25,15,27", "l'ordre du § 1");
  const trie = [...d.params].sort((a, b) => a.id - b.id);
  vrai(encodeRecipeBounds(d.beverageId, trie).hex !== d.hex, "trier doit changer la trame");
});

test("une valeur qui ne tient pas dans sa largeur lève", () => {
  // Tronquer en silence produirait une trame valide portant une autre valeur que celle demandée.
  let leve = false;
  try { encodeRecipeBounds(1, [{ id: 2, min: 0, def: 300, max: 5 }]); } catch { leve = true; }
  vrai(leve, "300 dans un paramètre 8 bits doit lever");
  eq(encodeRecipeBounds(1, [{ id: 1, min: 0, def: 300, max: 400 }]).bytes.length, 5 + 7 + 2, "300 tient dans une quantité 16 bits");
});

console.log(ko ? `\n${ko} échec(s).` : "\nTout passe.");
process.exit(ko ? 1 : 0);
