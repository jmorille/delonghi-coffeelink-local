// Vérification du décodage de `d260_beansystem_sync_par` — le grain sélectionné, l'écoulement
// mesuré et le compteur d'espressos, en une lecture.
//
// Les trames ci-dessous sont RÉELLES et viennent de deux campagnes :
//
//   2026-08-26  de part et d'autre d'un changement de grain fait à la main sur l'écran de la
//               machine. C'est ce contraste qui a établi que le mot 4 est l'index du grain.
//   2026-08-31  pendant un affinage mené depuis l'app officielle, avec `adb logcat` en parallèle.
//               L'app journalise la trame ET les valeurs qu'elle en tire : ce script rejoue donc
//               le décodage contre la SOURCE, et non contre une corrélation.
//
// Un décalage d'un mot ne lève rien : il rend un index, un temps et un compteur tous plausibles
// et tous faux. C'est exactement ce que ces rejeux attrapent.
import { decodeBeanSync, BEAN_SYNC_PARAM, BEAN_SYNC_PROP } from "../src/lib/profiles.mjs";
import { affinagePermis, seuilAffinage, SEUIL_ESPRESSOS_CLASSIC, SEUIL_ESPRESSOS_STRIKER } from "../src/lib/bean-adapt.mjs";

let ko = 0;
const test = (nom, fn) => { try { fn(); console.log("  ok   ", nom); } catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); } };
const eq = (a, b, quoi) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`); };
const leve = (fn, motif, quoi) => {
  try { fn(); } catch (e) { if (!String(e.message).includes(motif)) throw new Error(`${quoi}: « ${e.message} » ne contient pas « ${motif} »`, { cause: e }); return; }
  throw new Error(`${quoi}: aucune erreur levée`);
};
const b64 = (hex) => Buffer.from(hex.replace(/ /g, ""), "hex").toString("base64");

// Relevé à 08:27:43, grain 3 « Borbone » sélectionné.
const GRAIN_3 = b64("d0 2f a1 0f 01 f4 00 00 00 2c 00 00 18 db 00 00 23 62 00 00 24 54 00 00 00 03 00 00 00 07"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1f f7");
// Relevé à 08:40:20, après avoir activé le grain 2 « Sakura » sur l'écran de la machine.
const GRAIN_2 = b64("d0 2f a1 0f 01 f4 00 00 00 2c 00 00 18 db 00 00 23 62 00 00 24 54 00 00 00 02 00 00 00 00"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 b8 af");
// Relevé à 07:11 le même jour, grain 3 déjà sélectionné mais compteurs différents : il sert à
// montrer que le mot 4 ne bouge pas quand seuls les compteurs bougent.
const MATIN_GRAIN_3 = b64("d0 2f a1 0f 01 f4 00 00 00 2a 00 00 19 71 00 00 24 60 00 00 24 54 00 00 00 03 00 00 00 06"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1e 17");
// Le numéro de série : même commande `0xA1 0x0F`, autre paramètre (205). Il ne doit PAS passer.
const SERIE = b64("d0 1b a1 0f 00 cd 32 31 37 30 35 35 44 55 32 31 30 33 31 37 34 30 32 39 36 00 c3 6f");

console.log("\n— le mot 4 est le grain sélectionné, établi par contraste —");

test("grain 3 « Borbone »", () => {
  const r = decodeBeanSync(GRAIN_3);
  eq(r.param, BEAN_SYNC_PARAM, "paramètre");
  eq(r.selected, 3, "grain sélectionné");
  eq(r.mots, [44, 6363, 9058, 9300, 3, 7, 0, 0, 0, 0], "les dix mots");
});

test("grain 2 « Sakura », après changement sur la machine", () => {
  const r = decodeBeanSync(GRAIN_2);
  eq(r.selected, 2, "grain sélectionné");
  eq(r.mots, [44, 6363, 9058, 9300, 2, 0, 0, 0, 0, 0], "les dix mots");
});

test("SEULS les mots 4 et 5 changent avec la sélection", () => {
  // C'est l'observation qui fonde le décodage : si un autre mot avait bougé, « mot 4 = grain »
  // ne serait qu'une corrélation parmi plusieurs et ne vaudrait rien.
  const a = decodeBeanSync(GRAIN_3).mots, b = decodeBeanSync(GRAIN_2).mots;
  eq(a.map((v, i) => (v === b[i] ? null : i)).filter((i) => i !== null), [4, 5], "rangs des mots ayant bougé");
});

test("les compteurs bougent sans toucher au grain", () => {
  // Entre 07:11 et 08:27, deux tasses tirées et aucun changement de grain.
  const a = decodeBeanSync(MATIN_GRAIN_3), b = decodeBeanSync(GRAIN_3);
  eq(a.selected, b.selected, "grain identique");
  eq(a.mots[0] !== b.mots[0], true, "le mot 0 a bien bougé");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Campagne du 2026-08-31 — l'affinage mené depuis l'app officielle, logcat à l'appui.
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Les trois trames se suivent dans une seule session : une lecture, un espresso, une lecture, le
// questionnaire, l'écriture du profil, une dernière lecture. Ce que l'app en a tiré est reproduit
// en commentaire — c'est la valeur attendue, et elle ne vient pas de nous.

// 09:19:03 — `getParametersFromByte = 502 value 9071` / `= 505 value 31`
//            puis `FlowTime is 9` et `EspressoCounter is 31`.
const AFFINAGE_AVANT = b64("d0 2f a1 0f 01 f4 00 00 00 2c 00 00 18 c9 00 00 23 6f 00 00 24 54 00 00 00 03 00 00 00 1f"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 25 7d");
// 09:19:54 — après UN espresso. `FlowTime is 8`, le compteur passe à 32.
const AFFINAGE_APRES_CAFE = b64("d0 2f a1 0f 01 f4 00 00 00 2e 00 00 18 14 00 00 21 b3 00 00 24 54 00 00 00 03 00 00 00 20"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ec 6b");
// 09:21:38 — après l'écriture du profil affiné. Le compteur est retombé à ZÉRO.
const AFFINAGE_APRES_ECRITURE = b64("d0 2f a1 0f 01 f4 00 00 00 2e 00 00 18 14 00 00 21 b3 00 00 24 54 00 00 00 03 00 00 00 00"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 d0 69");

console.log("\n— le mot 2 est l'écoulement, le mot 5 le compteur : nommés par la SOURCE —");

test("l'écoulement se lit en ms et se tronque en secondes comme l'app", () => {
  // `L6/k.java` : `parameter.b() / 1000` en division ENTIÈRE. 9071 ms → 9 s, et surtout PAS 9,071
  // arrondi à 9 par chance : 8627 → 8 le prouve, un arrondi donnerait 9.
  const a = decodeBeanSync(AFFINAGE_AVANT);
  eq(a.ecoulementMs, 9071, "millisecondes");
  eq(a.ecoulementS, 9, "secondes tronquées");
  const b = decodeBeanSync(AFFINAGE_APRES_CAFE);
  eq(b.ecoulementMs, 8627, "millisecondes après le café");
  eq(b.ecoulementS, 8, "secondes tronquées après le café");
});

test("le compteur d'espressos suit les tasses", () => {
  eq(decodeBeanSync(AFFINAGE_AVANT).espressos, 31, "compteur avant");
  eq(decodeBeanSync(AFFINAGE_APRES_CAFE).espressos, 32, "compteur après un espresso");
});

test("l'écriture d'un profil remet le compteur à zéro", () => {
  // C'est ce qui réarme le verrou tout seul : après un affinage, il faut de nouveau cinq cafés.
  eq(decodeBeanSync(AFFINAGE_APRES_ECRITURE).espressos, 0, "compteur après écriture");
  // Et elle ne touche à rien d'autre : l'écoulement et le grain ne bougent pas.
  const b = decodeBeanSync(AFFINAGE_APRES_CAFE), c = decodeBeanSync(AFFINAGE_APRES_ECRITURE);
  eq(c.ecoulementMs, b.ecoulementMs, "écoulement inchangé");
  eq(c.selected, b.selected, "grain inchangé");
  eq(b.mots.map((v, i) => (v === c.mots[i] ? null : i)).filter((i) => i !== null), [5], "seul le mot 5 a bougé");
});

test("les mots restent bruts et complets à côté des trois nommés", () => {
  // Nommer trois mots ne doit pas escamoter les sept autres : c'est `mots` qui permettra
  // d'identifier les suivants, et une trame amputée dans le journal ne le permettrait plus.
  eq(decodeBeanSync(AFFINAGE_AVANT).mots, [44, 6345, 9071, 9300, 3, 31, 0, 0, 0, 0], "les dix mots");
});

test("une trame trop courte pour l'écoulement rend null, pas zéro", () => {
  // Le mot du GRAIN reste exigé — l'interface entière en dépend — mais un mot 5 absent doit se
  // lire « absent ». Un 0 fabriqué ici verrouillerait l'affinage en annonçant « 0 espresso ».
  // Cinq mots seulement : assez pour le grain (mot 4) et l'écoulement (mot 2), pas pour le
  // compteur (mot 5). Longueur 28 octets, donc `len` = 27 : 6 d'en-tête + 20 de charge + 2 de CRC.
  const court = b64("d0 1b a1 0f 01 f4 00 00 00 2c 00 00 18 c9 00 00 23 6f 00 00 24 54 00 00 00 03 25 7d");
  const r = decodeBeanSync(court);
  eq(r.selected, 3, "grain toujours lu");
  eq(r.espressos, null, "compteur absent");
  eq(r.ecoulementMs, 9071, "écoulement présent, lui");
});

console.log("\n— le verrou des cinq espressos —");

test("le seuil dépend de la génération", () => {
  // `L6/k.java` : `g() ? 3 : 5`, où `g()` est vrai quand l'appModelId contient « striker ».
  eq(seuilAffinage("classic"), SEUIL_ESPRESSOS_CLASSIC, "seuil classic");
  eq(seuilAffinage("striker"), SEUIL_ESPRESSOS_STRIKER, "seuil striker");
  eq(SEUIL_ESPRESSOS_CLASSIC, 5, "cinq sur une classic");
  eq(SEUIL_ESPRESSOS_STRIKER, 3, "trois sur une striker");
});

test("la comparaison est un >= et non un >", () => {
  // Le cas limite : au cinquième café exactement, l'app ouvre. Un `>` ferait attendre un sixième.
  eq(affinagePermis(4, "classic"), false, "quatre cafés");
  eq(affinagePermis(5, "classic"), true, "cinq cafés");
  eq(affinagePermis(2, "striker"), false, "deux cafés sur striker");
  eq(affinagePermis(3, "striker"), true, "trois cafés sur striker");
});

test("un compteur inconnu n'est pas un refus", () => {
  // Rendre `false` déguiserait « la propriété n'est pas encore arrivée » en « fais des cafés ».
  eq(affinagePermis(null, "classic"), null, "compteur absent");
  eq(affinagePermis(undefined, "classic"), null, "compteur indéfini");
});

test("le compteur remis à zéro reverrouille", () => {
  // Bouclage sur la trame réelle : c'est l'état dans lequel la machine se trouve après l'affinage.
  eq(affinagePermis(decodeBeanSync(AFFINAGE_APRES_ECRITURE).espressos, "classic"), false, "après écriture");
  eq(affinagePermis(decodeBeanSync(AFFINAGE_APRES_CAFE).espressos, "classic"), true, "avant écriture");
});

console.log("\n— ce que le décodeur refuse —");

test("le numéro de série porte la même commande et doit être refusé", () => {
  // Les deux sont des `0xA1 0x0F`. Sans le contrôle du paramètre, la chaîne « 217055DU… » se
  // relisait en mots de 32 bits et rendait un `selected` fabriqué de toutes pièces.
  leve(() => decodeBeanSync(SERIE), "paramètre 205", "paramètre étranger");
});

test("une autre commande est refusée", () => {
  leve(() => decodeBeanSync(b64("d0 34 ba f0 01 00 4d 00 61 00 6c 00 6f 00 6e 00 67 00 6f")), "commande inattendue", "0xBA");
});

test("une trame tronquée AVANT le mot du grain est refusée, pas devinée", () => {
  // Le cas dangereux : sans ce contrôle, `mots[4]` vaut `undefined` et un grain « sélectionné »
  // qu'aucun index ne porte traverse l'interface sans un mot.
  leve(() => decodeBeanSync(b64("d0 13 a1 0f 01 f4 00 00 00 2c 00 00 18 db 00 00 23 62 00 00 00 00")),
    "charge utile trop courte", "tronquée");
});

test("une charge utile non multiple de 4 est refusée", () => {
  // 22 octets de charge utile : assez longue pour couvrir le mot du grain, mais désalignée. Le
  // contrôle de longueur ne la rattrape donc pas, et sans celui d'alignement le dernier mot serait
  // lu à cheval sur le CRC.
  leve(() => decodeBeanSync(b64("d0 1d a1 0f 01 f4 00 00 00 2c 00 00 18 db 00 00 23 62 00 00 24 54 00 00 00 03 00 00 00 00")),
    "non multiple de 4", "alignement");
});

test("le nom de propriété est celui qu'attend le serveur", () => {
  eq(BEAN_SYNC_PROP, "d260_beansystem_sync_par", "nom de propriété");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
