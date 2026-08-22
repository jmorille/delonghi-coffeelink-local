/**
 * **Les ingrédients d'une recette perso, et la convention d'« absent ».**
 *
 * Partagé par `/` (l'éditeur d'une carte) et `/recipes` (la bibliothèque locale) : c'est une table
 * dérivée du protocole, et deux copies divergeraient à la première correction sans que rien ne le
 * signale — le défaut contre lequel `CLAUDE.md` met en garde à propos de `TWO`, qui avait fini par
 * exister trois fois.
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
 * ## Ce qui n'y est pas, et pourquoi ce n'est pas un oubli
 *
 * Ni eau chaude ni thé. Pour les six emplacements perso, la machine déclare exactement
 * `[1 COFFEE, 2 TASTE, 4 BLEND, 9 MILK, 12 INVERSION, 24 PROGRAMABLE, 25 VISIBLE, 28 ACCESSORIO]`
 * — ni `HOT_WATER` (15) ni `THE_TEMP` (13). Trois vérifications concordent : la trame `0xB0` lue
 * sur l'appareil pour les six emplacements, la table du catalogue extraite de l'APK, et le fait
 * que les bornes sont **identiques sur un emplacement vide et sur un emplacement configuré** —
 * donc ce jeu ne dépend pas du contenu, il est fixé par le modèle.
 *
 * Que « Eau chaude » (16) existe comme boisson n'y change rien : la liste des paramètres est
 * attachée à la BOISSON, elle ne se compose pas. L'application officielle n'offre rien pour le thé
 * pour cette raison exacte — c'est une limite de la cafetière, pas de son logiciel.
 *
 * **Une recette à base d'eau chaude reste possible**, simplement pas dans un emplacement perso :
 * on choisit la boisson « Eau chaude » ou « Thé », qui portent `HOT_WATER` de 20 à 420 ml.
 */

/** Quantité d'un ingrédient absent. */
export const QUANTITE_ABSENTE = 0;

/** Valeur d'une option dont l'ingrédient est absent — le marqueur « sans objet » de la machine. */
export const OPTION_SANS_OBJET = 255;

export interface Ingredient {
  /** Clé stable, jamais affichée : c'est `groupLabel` qui la traduit. */
  cle: "cafe" | "lait";
  /** Le paramètre de quantité — c'est lui qui porte la présence. */
  quantite: number;
  /** Les réglages que cocher cet ingrédient ouvre. */
  options: number[];
}

export const INGREDIENTS: Ingredient[] = [
  // `BLEND` (4) suit le CAFÉ et non le lait, mesuré : les deux recettes réelles sans café le
  // portent à 255 comme `TASTE`, celle qui a du café l'a à 0. Il n'est pas réglable sur ce modèle
  // (`min == max == 0`) donc il n'affiche aucun contrôle — mais il part dans la trame, et il doit
  // y partir avec la valeur que la machine y met elle-même.
  { cle: "cafe", quantite: 1, options: [2, 4] },
  // `INVERSION` (12) et `ACCESSORIO` (28) vont avec le lait : l'ordre lait/café n'a de sens qu'avec
  // du lait, et `ACCESSORIO` n'apparaît que sur les boissons lactées — 16 sur 16, absent des 12
  // autres.
  { cle: "lait", quantite: 9, options: [12, 28] },
];

/** Le groupe auquel un paramètre appartient, ou `null` s'il n'en a pas — il est alors rendu tel quel. */
export function groupeDe(id: number): Ingredient | null {
  return INGREDIENTS.find((g) => g.quantite === id || g.options.includes(id)) ?? null;
}

/**
 * Ce qu'il faut écrire pour un paramètre dont l'ingrédient est décoché.
 *
 * Un ingrédient absent n'est pas OMIS de la trame : l'omettre laisserait l'ancienne valeur en
 * place sur la machine, donc l'ingrédient présent. Il est écrit absent, avec la convention de
 * l'appareil lui-même.
 */
export function valeurAbsente(g: Ingredient, id: number): number {
  return g.quantite === id ? QUANTITE_ABSENTE : OPTION_SANS_OBJET;
}

/**
 * La présence de chaque ingrédient, lue dans les valeurs enregistrées du profil.
 *
 * Absente de la lecture, une quantité vaut 0, donc « absent » — le côté prudent : on ne prétend
 * pas qu'un ingrédient est là sur la foi d'une lecture qui n'a pas eu lieu.
 */
export function presenceInitiale(valeurs: { id: number; value?: number }[] | undefined): Record<string, boolean> {
  // `value` est optionnel à dessein : les deux pages ne typent pas leurs paramètres de la même
  // façon, et un paramètre lu sans valeur doit compter comme ABSENT plutôt que faire échouer la
  // lecture — le côté prudent, celui qui ne prétend pas qu'un ingrédient est là.
  const par = new Map((valeurs ?? []).map((p) => [p.id, p.value ?? 0]));
  return Object.fromEntries(INGREDIENTS.map((g) => [g.cle, (par.get(g.quantite) ?? 0) > 0]));
}
