/**
 * **Les ingrédients d'une recette perso, et la convention d'« absent ».**
 *
 * Partagé par les DEUX côtés : l'éditeur de `/` et de `/recettes` d'un bout, et `server.mjs` de
 * l'autre, qui en a besoin pour reporter une recette dans un emplacement perso (`transfert.mjs`).
 * C'est une table dérivée du protocole, et deux copies divergeraient à la première correction sans
 * que rien ne le signale — le défaut contre lequel `CLAUDE.md` met en garde à propos de `TWO`, qui
 * avait fini par exister trois fois.
 *
 * ⚠️ **Il vit donc en `.mjs` sous `src/lib/`, pas en `.ts` sous `src/app/`** : `server.mjs`
 * l'importe, et un module TypeScript ne lui serait pas atteignable. Le prix est qu'il échappe à
 * ESLint (qui ne voit que les `.mjs` de la racine et de `scripts/`) tout en restant couvert par
 * `tsc`, qui le suit depuis les `.tsx` qui l'importent grâce à `allowJs`.
 *
 * ## Une quantité nulle veut dire « absent », et l'option qui en dépend vaut 255
 *
 * Mesuré sur les six emplacements perso d'une ECAM 610.75.MB, profil 1 :
 *
 * ```
 * Lacteso     café   0  arôme 255  mélange 255  lait 100   ← une recette SANS café
 * Mini Lait   café  20  arôme   0  mélange   0  lait 113   ← les deux
 * test TT     café   0  arôme 255  mélange 255  lait  50
 * Perso 4-6   café   0  arôme 255  mélange   0  lait   0   ← emplacements vides
 * ```
 *
 * C'est aussi la règle de l'application : `Q6.g.i()` n'ajoute le bloc café — quantité puis `TASTE`
 * — que `if (recipeData.k() > 0)`. Cocher un ingrédient, c'est lui donner une quantité ; la
 * présence n'a donc **pas d'état à elle**, elle se lit dans la quantité enregistrée. Deux sources
 * de vérité pour un même fait seraient deux occasions de diverger.
 *
 * ⚠️ **255 (0xFF) marque « sans objet » dans les VALEURS enregistrées**, pas seulement dans les
 * défauts du modèle. Il tombe hors des bornes (`TASTE` va de 0 à 5), donc un filtre « la valeur du
 * profil doit être dans les bornes » le rejette et fait repartir du minimum — ce qui affichait
 * « Arôme 0 » pour une recette sans café, puis **réécrivait 0 là où la machine avait posé 255**.
 *
 * ## Ce qu'un EMPLACEMENT PERSO ne déclare pas, et pourquoi ce n'est pas un oubli
 *
 * Ni eau chaude ni thé. Pour les six emplacements perso, la machine déclare exactement
 * `[1 COFFEE, 2 TASTE, 4 BLEND, 9 MILK, 12 INVERSION, 24 PROGRAMABLE, 25 VISIBLE, 28 ACCESSORIO]`
 * — ni `HOT_WATER` (15) ni `THE_TEMP` (13). Trois vérifications concordent : la trame `0xB0` lue
 * sur l'appareil pour les six emplacements, la table du catalogue extraite de l'APK, et le fait
 * que les bornes sont **identiques sur un emplacement vide et sur un emplacement configuré** —
 * donc ce jeu ne dépend pas du contenu, il est fixé par le modèle.
 *
 * ⚠️ **Ce paragraphe affirmait aussi que `HOT_WATER` n'est pas un ingrédient. C'était une
 * inférence, et elle était fausse.** Le fait mesuré porte sur les EMPLACEMENTS, pas sur la notion
 * d'ingrédient : « aucun emplacement perso ne déclare l'eau chaude » n'entraîne pas « aucune boisson
 * ne la compose ». Le **mug de voyage** (26) déclare `café`, `lait` ET `eau chaude`, et n'a de défaut
 * modèle utilisable pour aucune des trois — voir `composable`. L'eau chaude est donc un ingrédient
 * comme les deux autres ; ce qui reste vrai, c'est qu'aucun emplacement perso ne peut la recevoir,
 * donc qu'une recette qui en porte reste **non transférable**. La limite est celle de la CIBLE.
 *
 * **Une recette à base d'eau chaude reste possible**, simplement pas dans un emplacement perso :
 * on choisit « Eau chaude » ou « Thé » (`HOT_WATER` de 20 à 420 ml), l'Americano ou le Long Black
 * (café + eau, déjà configurés d'usine), ou le mug de voyage pour les trois à la fois.
 */

/** Quantité d'un ingrédient absent. */
export const QUANTITE_ABSENTE = 0;

/** Valeur d'une option dont l'ingrédient est absent — le marqueur « sans objet » de la machine. */
export const OPTION_SANS_OBJET = 255;

/**
 * @typedef {object} Ingredient
 * @property {"cafe"|"lait"|"eauChaude"} cle  Clé stable, jamais affichée : c'est le catalogue de
 *   messages qui la traduit (`nomGroupe` dans `RecipeEditor`, en appels littéraux — une clé
 *   construite échapperait à `verif-messages.mjs`).
 * @property {number} quantite    Le paramètre de quantité — c'est lui qui porte la présence.
 * @property {number[]} options   Les réglages que cocher cet ingrédient ouvre.
 */

/** @type {Ingredient[]} */
export const INGREDIENTS = [
  // `BLEND` (4) suit le CAFÉ et non le lait, mesuré : les deux recettes réelles sans café le
  // portent à 255 comme `TASTE`, celle qui a du café l'a à 0. Il n'est pas réglable sur ce modèle
  // (`min == max == 0`) donc il n'affiche aucun contrôle — mais il part dans la trame, et il doit
  // y partir avec la valeur que la machine y met elle-même.
  { cle: "cafe", quantite: 1, options: [2, 4] },
  // `INVERSION` (12) et `ACCESSORIO` (28) vont avec le lait : l'ordre lait/café n'a de sens qu'avec
  // du lait, et `ACCESSORIO` n'apparaît que sur les boissons lactées — 16 sur 16, absent des 12
  // autres. `INVERSION` est aussi CROISÉ (voir ci-dessous) : il appartient au lait pour la valeur
  // d'absence, mais il s'affiche ailleurs.
  { cle: "lait", quantite: 9, options: [12, 28] },
  /**
   * **`HOT_WATER` (15) est un ingrédient, et le mug de voyage est la raison.**
   *
   * Mesuré le 2026-08-23 sur les 28 boissons d'une ECAM 610.75.MB : cinq déclarent `HOT_WATER` —
   * Americano (6), Eau chaude (16), Thé (22), Long Black (25), Mug de voyage (26) — et **le mug de
   * voyage est la seule boisson du modèle qui déclare les trois quantités à la fois**
   * (`café 40-240`, `lait 60-460`, `eau 50-260`). Café + eau existe déjà, configuré, sur l'Americano
   * (40/110) et le Long Black (80/120) ; les trois ensemble n'existent nulle part ailleurs.
   *
   * ⚠️ **Aucune option.** Le café ouvre `TASTE` et `BLEND`, le lait ouvre `INVERSION` et
   * `ACCESSORIO` ; l'eau chaude n'ouvre rien — sa quantité est tout ce que la machine déclare pour
   * elle. C'est une bonne nouvelle et pas un hasard heureux : la convention « option à 255 » n'a
   * jamais été mesurée hors des emplacements perso (voir `valeurAbsente`), donc ne pas avoir
   * d'option à écrire évite d'avoir à l'extrapoler.
   *
   * ⚠️ **Un emplacement perso ne la déclare toujours pas**, donc une recette qui en porte reste
   * non transférable — la limite documentée plus haut ne bouge pas d'un pouce.
   */
  { cle: "eauChaude", quantite: 15, options: [] },
];

/**
 * **Les réglages qui n'ont de sens qu'avec PLUSIEURS ingrédients à la fois.**
 *
 * `INVERSION` (12) — l'ordre lait/café — ne veut rien dire s'il n'y a pas les deux. Affiché sous
 * « Lait », il proposait de régler l'ordre d'un café qui n'existe pas ; il s'affiche donc **hors
 * des groupes**, et seulement quand tous ses ingrédients sont cochés.
 *
 * ⚠️ **C'est une règle d'AFFICHAGE, et elle ne touche pas à la valeur envoyée.** Le paramètre garde
 * son groupe (`groupeDe(12)` rend toujours le lait), donc décocher le lait continue de l'écrire
 * « sans objet » comme avant. Lui inventer une seconde convention d'absence — 255 dès que le café
 * manque — contredirait la seule mesure dont on dispose : sur cette machine, « Lacteso » (du lait,
 * pas de café) porte `INVERSION = 0`, pas 255.
 *
 * @type {{id: number, ingredients: string[]}[]}
 */
export const CROISES = [{ id: 12, ingredients: ["cafe", "lait"] }];

/** L'entrée de `CROISES` qui décrit ce paramètre, ou `null`. */
export const croiseDe = (id) => CROISES.find((c) => c.id === id) ?? null;

/** Le groupe auquel un paramètre appartient, ou `null` s'il n'en a pas — il est alors rendu tel quel. */
/** @param {number} id @returns {Ingredient | null} */
export function groupeDe(id) {
  return INGREDIENTS.find((g) => g.quantite === id || g.options.includes(id)) ?? null;
}

/**
 * Ce qu'il faut écrire pour un paramètre dont l'ingrédient est décoché.
 *
 * Un ingrédient absent n'est pas OMIS de la trame : l'omettre laisserait l'ancienne valeur en
 * place sur la machine, donc l'ingrédient présent. Il est écrit absent, avec la convention de
 * l'appareil lui-même.
 *
 * ⚠️ **`marqueurOption` existe parce que la convention `255` n'a été mesurée QUE sur les
 * emplacements perso.** Le mug de voyage la contredit : son café est absent (quantité 0, sous un
 * minimum de 40) et il porte pourtant `TASTE = 3` et `BLEND = 0`, là où « Lacteso » — même état de
 * café — porte `TASTE 255` et `BLEND 255`. Deux boissons du même appareil, deux conventions : donc
 * `255` n'est pas une règle du protocole, c'est une règle des emplacements perso, et l'étendre par
 * analogie écrirait 255 dans un `TASTE` borné 1-5 sur la foi d'une extrapolation.
 *
 * La quantité, elle, vaut 0 partout : c'est le seul des deux faits qui soit mesuré des deux côtés
 * (0 est hors bornes pour les trois quantités du mug de voyage comme pour le café d'un perso).
 *
 * @param {Ingredient} g
 * @param {number} id
 * @param {boolean} [marqueurOption] Vrai (défaut) = écrire `255` pour une option, la convention des
 *   emplacements perso. Faux = laisser l'option tranquille, l'appelant garde la valeur lue.
 * @returns {number | null} `null` = ne rien écrire pour ce paramètre, garder sa valeur.
 */
export function valeurAbsente(g, id, marqueurOption = true) {
  if (g.quantite === id) return QUANTITE_ABSENTE;
  return marqueurOption ? OPTION_SANS_OBJET : null;
}

/**
 * **Cette boisson accepte-t-elle qu'on COMPOSE ses ingrédients ?**
 *
 * La règle est mesurée, pas conventionnelle : *déclarer au moins deux quantités, et n'avoir de
 * défaut modèle utilisable pour aucune d'elles.* Un défaut hors de ses propres bornes veut dire
 * « jamais configuré par le modèle » — donc le modèle n'a pas décidé ce qu'il y a dans cette tasse,
 * donc c'est à l'utilisateur de le dire.
 *
 * Éprouvée le 2026-08-23 sur les 28 boissons et les 6 emplacements d'une ECAM 610.75.MB, elle
 * sélectionne **exactement les 6 emplacements perso et le mug de voyage**, et rien d'autre. Un
 * espresso (une seule quantité, défaut 40) n'est pas composable et ne le deviendra jamais : on ne
 * peut pas décocher son café, ce qui était la raison d'être de l'ancienne règle.
 *
 * ⚠️ **Elle lit les DÉFAUTS, jamais les valeurs enregistrées.** Un défaut est une caractéristique du
 * modèle : il ne bouge pas quand on écrit une valeur. Fondée sur la valeur du profil, la règle aurait
 * basculé au premier réglage écrit dans le mug de voyage — une boisson qui cesse d'être composable
 * parce qu'on vient de la régler.
 *
 * Le prédicat « défaut utilisable » est le même que `isSet` / `defautModele` dans
 * `src/app/beverage.ts` ; il est réécrit ici parce que `server.mjs` et les scripts de vérification
 * n'atteignent pas un module TypeScript de `src/app/`.
 *
 * @param {{id: number, min?: number, def?: number, max?: number}[]} params Les bornes lues.
 * @returns {boolean}
 */
export function composable(params) {
  const par = new Map((params ?? []).map((p) => [Number(p.id), p]));
  const quantites = INGREDIENTS.map((g) => par.get(g.quantite)).filter((p) => p !== undefined);
  if (quantites.length < 2) return false;
  return quantites.every((p) => !defautUtilisable(p));
}

/** Un défaut ne vaut que s'il tombe dans ses propres bornes. Voir `isSet` dans `beverage.ts`. */
function defautUtilisable(p) {
  return (
    p.def !== undefined && p.def !== null &&
    p.min !== undefined && p.max !== undefined &&
    p.def >= p.min && p.def <= p.max
  );
}

/**
 * La présence de chaque ingrédient, lue dans les valeurs enregistrées du profil.
 *
 * Absente de la lecture, une quantité vaut 0, donc « absent » — le côté prudent : on ne prétend
 * pas qu'un ingrédient est là sur la foi d'une lecture qui n'a pas eu lieu.
 */
/** @param {{id: number, value?: number}[] | undefined} valeurs @returns {Record<string, boolean>} */
export function presenceInitiale(valeurs) {
  // `value` est optionnel à dessein : les deux pages ne typent pas leurs paramètres de la même
  // façon, et un paramètre lu sans valeur doit compter comme ABSENT plutôt que faire échouer la
  // lecture — le côté prudent, celui qui ne prétend pas qu'un ingrédient est là.
  const par = new Map((valeurs ?? []).map((p) => [p.id, p.value ?? 0]));
  return Object.fromEntries(INGREDIENTS.map((g) => [g.cle, (par.get(g.quantite) ?? 0) > 0]));
}
