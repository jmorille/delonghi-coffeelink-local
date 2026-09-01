/**
 * Vérifie **la table des compteurs nommés** — les propriétés Ayla que `w.b()` et le relevé Eletta
 * portent — sans machine, sans réseau.
 *
 * Même famille que `verif-args` et pour la même raison : `compteurs.mjs` est pur, donc il se
 * prouve, et ce qu'il peut casser est silencieux. Trois défauts précis sont visés ici :
 *
 * 1. **Un `beverageId` qui a glissé d'un cran.** La table apparie à la main un nom de propriété et
 *    un id de boisson (`d717_id15_caprev` → 15). Une erreur d'un rang n'échoue nulle part : elle
 *    étiquette « cappuccino inversé » un compteur d'eau chaude, et personne ne le verra. Le nom
 *    porte l'id, donc le nom peut arbitrer — c'est ce que fait le premier test.
 * 2. **Le diviseur de l'eau.** L'intégration Home Assistant divise `d553_water_tot_qty` par 1000 ;
 *    l'app De'Longhi par 2000 (`u.a(v) = v × 0,5` puis `/1000`). Reprendre le mauvais donnerait des
 *    litres deux fois trop grands, parfaitement plausibles. Le test fige le 2000.
 * 3. **Les trois formes de valeur.** Entier, objet JSON de sous-compteurs, illisible. La troisième
 *    doit rendre `null` et jamais `0` : un total nul sur une machine qui a servi mille tasses
 *    ressemble à un compteur remis à zéro.
 *
 * Aucune dépendance : `node scripts/verif-compteurs.mjs`.
 */
import {
  COMPTEURS, FAMILLE, PORTEES, SOURCE, compteurInfo, estCompteur, lireCompteur, nomsARelire, valeurAffichee,
} from "../src/lib/compteurs.mjs";
import { beverageMeta } from "../src/lib/beverages.mjs";

let ko = 0;
const test = (nom, fn) => {
  try { fn(); console.log("  ok   ", nom); }
  catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); }
};
const eq = (a, b, quoi) => { if (a !== b) throw new Error(`${quoi}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
const vrai = (x, quoi) => { if (!x) throw new Error(quoi); };

console.log("\nCompteurs nommés\n");

test("chaque nom est une propriété Ayla plausible", () => {
  for (const nom of Object.keys(COMPTEURS)) {
    vrai(/^d\d{3}_[a-z0-9_]+$/.test(nom), `nom hors format : ${nom}`);
  }
});

test("chaque entrée porte une source et une famille connues", () => {
  const sources = new Set(Object.values(SOURCE));
  const familles = new Set(Object.values(FAMILLE));
  for (const [nom, info] of Object.entries(COMPTEURS)) {
    vrai(sources.has(info.source), `${nom} : source inconnue « ${info.source} »`);
    vrai(familles.has(info.famille), `${nom} : famille inconnue « ${info.famille} »`);
  }
});

test("une entrée s'étiquette par une clé OU par une boisson, jamais les deux ni aucune", () => {
  for (const [nom, info] of Object.entries(COMPTEURS)) {
    const parCle = typeof info.key === "string" && info.key.length > 0;
    const parBoisson = Number.isInteger(info.beverageId);
    vrai(parCle !== parBoisson, `${nom} : ${parCle && parBoisson ? "les deux à la fois" : "ni l'une ni l'autre"}`);
  }
});

// Le test qui compte : le nom EST la source, `beverageId` n'en est qu'une recopie.
test("l'id porté par le nom est celui de `beverageId`, et la boisson existe", () => {
  let vus = 0;
  for (const [nom, info] of Object.entries(COMPTEURS)) {
    if (!Number.isInteger(info.beverageId)) continue;
    const m = /_id(\d+)_/.exec(nom);
    vrai(m, `${nom} : porte un beverageId mais son nom n'annonce aucun id`);
    eq(Number(m[1]), info.beverageId, `${nom} : l'id du nom et celui de la table divergent`);
    vrai(beverageMeta(info.beverageId), `${nom} : la boisson ${info.beverageId} n'est pas au catalogue`);
    vus++;
  }
  eq(vus, 17, "nombre de compteurs par boisson");
  // Les trois qui ont motivé la vérification croisée du § 12.10 de la doc protocole.
  eq(beverageMeta(15).slug, "capp_reverse", "15 = cappuccino inversé");
  eq(beverageMeta(23).slug, "coffee_pot", "23 = verseuse");
  eq(beverageMeta(27).slug, "brew_over_ice", "27 = brew over ice");
});

test("deux noms peuvent partager une clé quand ils comptent la même chose", () => {
  // `d700_tot_bev_b` (hors Striker) et `d701_tot_bev_b` (Striker) : même grandeur, deux noms.
  // C'est le seul doublon légitime — tout autre partage de clé serait une étiquette recopiée.
  const parCle = {};
  for (const [nom, info] of Object.entries(COMPTEURS)) {
    if (!info.key) continue;
    (parCle[info.key] ??= []).push(nom);
  }
  for (const [cle, noms] of Object.entries(parCle)) {
    if (noms.length === 1) continue;
    eq(cle, "beverageBlack", `clé partagée inattendue : ${cle} → ${noms.join(", ")}`);
    eq(noms.join(","), "d700_tot_bev_b,d701_tot_bev_b", "les deux noms des boissons noires");
  }
});

test("les portées : l'APK d'abord, le relevé Eletta ensuite", () => {
  eq(PORTEES.app.length, 14, "les quatorze noms de w.b()");
  eq(PORTEES.tous.length, Object.keys(COMPTEURS).length, "la portée large couvre toute la table");
  // L'ordre importe : une lecture interrompue doit avoir ramené le plus utile.
  eq(PORTEES.tous.slice(0, PORTEES.app.length).join(","), PORTEES.app.join(","), "app en tête de tous");
  for (const nom of PORTEES.app) eq(compteurInfo(nom).source, SOURCE.APK, `${nom} devrait venir de l'APK`);
  // Les quatorze de `p258z7/w.java$b()`, à la lettre.
  const attendus = [
    "d701_tot_bev_b", "d700_tot_bev_b", "d550_water_calc_qty", "d701_tot_bev_bw", "d719_id22_tea",
    "d731_tot_mug_hot", "d732_tot_mug_cold", "d553_water_tot_qty", "d552_cnt_calc_tot",
    "d557_milk_cln_cnt", "d554_cnt_filter_tot", "d702_tot_bev_other", "d703_tot_bev_w",
    "d733_tot_bev_counters",
  ];
  for (const nom of attendus) vrai(PORTEES.app.includes(nom), `${nom} absent de la portée « app »`);
});

test("un nom inconnu n'est pas un compteur", () => {
  vrai(estCompteur("d553_water_tot_qty"), "un vrai compteur est reconnu");
  vrai(!estCompteur("d270_serialnumber"), "le numéro de série n'en est pas un");
  vrai(!estCompteur("d302_monitor"), "le monitor non plus");
  // Nom EXACT, jamais un motif : c'est le routage par motif qui a déjà produit des désalignements.
  vrai(!estCompteur("d553_water_tot_qty_bis"), "un préfixe ne suffit pas");
  eq(compteurInfo("nawak"), null, "une info inconnue rend null");
});

test("l'eau se divise par 2000, pas par 1000", () => {
  const info = compteurInfo("d553_water_tot_qty");
  eq(info.divisor, 2000, "diviseur de d553");
  eq(info.unit, "L", "unité de d553");
  // 387 213 demi-millilitres = 193,6 L. Home Assistant en annonce 387,2 : c'est le double.
  eq(valeurAffichee("d553_water_tot_qty", 387213), 194, "387213 demi-ml → litres");
  vrai(valeurAffichee("d553_water_tot_qty", 387213) !== 387, "ce n'est PAS la valeur /1000 de HA");
});

test("les volumes d'unité non établie sortent bruts", () => {
  for (const nom of ["d550_water_calc_qty", "d555_water_filter_qty"]) {
    eq(compteurInfo(nom).divisor, undefined, `${nom} ne doit pas être converti`);
    eq(compteurInfo(nom).unit, undefined, `${nom} ne doit pas porter d'unité`);
    eq(valeurAffichee(nom, 12345), 12345, `${nom} ressort tel quel`);
  }
});

console.log("\nLecture d'une valeur\n");

test("un entier passe, sous ses deux formes", () => {
  eq(lireCompteur(314).value, 314, "entier natif");
  eq(lireCompteur("314").value, 314, "entier en chaîne");
  eq(lireCompteur("  314  ").value, 314, "avec des blancs");
  eq(lireCompteur(0).value, 0, "zéro est une valeur");
  eq(lireCompteur(314).breakdown, null, "pas de ventilation");
});

test("un objet JSON est sommé et conservé", () => {
  const r = lireCompteur('{"espresso": 12, "coffee": 3}');
  eq(r.value, 15, "somme des sous-compteurs");
  eq(r.breakdown.espresso, 12, "la ventilation est rendue telle quelle");
  // Les clés réellement observées sur Striker (`p258z7/w.java`), valeurs en CHAÎNES.
  const striker = lireCompteur('{"tot_bev_bw":"40","tot_bev_w":"2","tot_mug_hot_small":"7"}');
  eq(striker.value, 49, "sous-valeurs en chaînes");
  // Une sous-valeur illisible est ignorée, elle n'annule pas le reste.
  eq(lireCompteur('{"a": 5, "b": "n/a"}').value, 5, "sous-valeur illisible ignorée");
});

test("ce qui n'est pas lisible rend null, jamais zéro", () => {
  eq(lireCompteur(null), null, "null");
  eq(lireCompteur(undefined), null, "undefined");
  eq(lireCompteur(""), null, "chaîne vide");
  eq(lireCompteur("n/a"), null, "texte");
  eq(lireCompteur("{pas du json}"), null, "objet malformé");
  eq(lireCompteur("[1,2,3]"), null, "un tableau n'est pas un objet de sous-compteurs");
  eq(lireCompteur('{"a": "x", "b": "y"}'), null, "objet sans aucune sous-valeur entière");
  eq(lireCompteur(1.5), null, "un flottant n'est pas un compteur");
  // Le piège : `Number(true) === 1`, donc un booléen deviendrait un compteur à 1.
  eq(lireCompteur(true), null, "true");
  eq(lireCompteur(false), null, "false");
  eq(lireCompteur('{"a": true}'), null, "un booléen en sous-valeur ne compte pas");
});

console.log("\nCe qu'il reste à relire\n");

test("une propriété notée absente n'est plus redemandée", () => {
  eq(nomsARelire("app", {}).length, 14, "rien en cache : tout est à lire");
  const props = { d719_id22_tea: { absent: true }, d553_water_tot_qty: { at: 1, kind: "counter" } };
  const reste = nomsARelire("app", props);
  vrai(!reste.includes("d719_id22_tea"), "l'absente est sautée");
  vrai(reste.includes("d553_water_tot_qty"), "une valeur déjà lue se relit — c'est un compteur");
  eq(reste.length, 13, "une seule sautée");
  eq(nomsARelire("inconnue", {}).length, 0, "une portée inconnue ne demande rien");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
