/**
 * **Reporter une recette locale dans un emplacement perso de la machine.**
 *
 * Pur : aucune E/S, aucun journal, aucune notion de machine ni de catalogue — la cible arrive sous
 * la forme de la seule chose qui compte, la liste des réglages qu'elle DÉCLARE. C'est ce qui rend
 * `scripts/verif-transfert.mjs` possible, et c'est la même discipline que `tasks.mjs` et
 * `appregistry.mjs`.
 *
 * Ce module décide de ce qui part dans une trame `0x83`/`SAVE_BEVERAGE` visant un emplacement
 * perso, c'est-à-dire d'une **écriture persistante dans un appareil réel**. Trois règles, et chacune
 * répare une manière différente de se tromper en silence :
 *
 * 1. **Ce que la cible ne déclare pas ne part pas** — et se retrouve dans `retires`, jamais écarté
 *    sans le dire. Un emplacement perso ne déclare ni `HOT_WATER` (15) ni `THE_TEMP` (13) ; voir
 *    `ingredients.mjs` pour les trois vérifications qui l'établissent.
 * 2. **Un ingrédient que la recette n'a pas est écrit ABSENT, pas omis.** L'omettre laisserait en
 *    place celui de la recette précédente : le transfert dirait « réussi » et l'emplacement
 *    rendrait une boisson qui n'est pas celle qu'on a transférée. La convention d'absence est celle
 *    de la machine elle-même (quantité 0, option 255), et elle vit dans `ingredients.mjs`.
 * 3. **Ce qui n'est pas un ingrédient est omis.** `PROGRAMABLE` (24) et `VISIBLE` (25) décrivent
 *    l'emplacement, pas la tasse : leur appliquer la convention d'absence mettrait `VISIBLE` à 0 et
 *    ferait disparaître de la machine l'emplacement qu'on vient de remplir. Omis, la machine garde
 *    les siens.
 *
 * **Aucune valeur n'est bornée ici, et la raison n'est PAS celle qui était écrite.** Ce commentaire
 * affirmait que « les bornes d'un réglage sont les mêmes d'une boisson à l'autre, sinon la machine ne
 * saurait pas la préparer ». C'est faux, réfuté par six trames `0xB0` réelles : `HOT_WATER` va de
 * 50-260 sur le mug de voyage à 20-420 sur « Eau chaude », le minimum de `COFFEE` vaut 20, 40 ou 80
 * selon la boisson, et `MILK` plafonne à 460 ici et 1080 là — voir `doc/format-trame-boisson.md`
 * § 2.6. Une valeur reportée telle quelle **peut** donc atterrir hors des bornes de la cible.
 *
 * La conclusion ne change pas, mais elle tient maintenant à un fait vérifiable : **ce module ne
 * reçoit pas les bornes de la cible**, seulement la liste des identifiants qu'elle déclare. Il n'a
 * donc pas de quoi borner, et borner d'après les bornes de la boisson d'ORIGINE serait pire que le
 * report verbatim — on corrigerait vers un intervalle qui n'est pas celui de la cible. L'écart est
 * signalé là où les bornes sont connues (`editor.initialOutOfBounds`, `recipes.freeOutOfTarget`).
 */
import { INGREDIENTS, groupeDe, valeurAbsente } from "./ingredients.mjs";

/**
 * Les réglages qui portent une **quantité**, c'est-à-dire la boisson elle-même. Une recette dont
 * aucune quantité ne survit au report est une recette qui arriverait vide dans l'emplacement : le
 * transfert la refuse plutôt que d'écraser une recette existante par du néant.
 *
 * Les trois viennent de `INGREDIENTS` — café, lait, eau chaude — et `verif-transfert.mjs` vérifie
 * que cette table les suit.
 *
 * ⚠️ `HOT_WATER` (15) était ajoutée ici **à la main**, avec un commentaire affirmant qu'elle n'est
 * pas un ingrédient. Elle l'est depuis que le mug de voyage a été mesuré (voir `ingredients.mjs`),
 * donc l'ajout produisait un doublon et l'affirmation était fausse. Ce que la mesure disait
 * réellement porte sur la CIBLE : aucun emplacement perso ne déclare l'eau chaude, ce qui est la
 * raison du refus `hotWaterNotInCustomSlot` plus bas — pas une propriété de l'ingrédient.
 */
export const QUANTITES = INGREDIENTS.map((g) => g.quantite);

/** `THE_TEMP` — l'autre réglage qu'un emplacement perso ne déclare jamais, et qui va avec le thé. */
const THE_TEMP = 13;

/**
 * Ce qui partira réellement dans la trame, et ce qui n'y sera pas.
 *
 * @param {{params: {id: number, value: number}[], cibleParams: number[]}} arg
 *   `params` : les couples de la recette. `cibleParams` : les identifiants que l'emplacement visé
 *   déclare (`bev.ingredients` du catalogue).
 * @returns {{params: {id: number, value: number}[], retires: {id: number, value: number}[],
 *            absents: number[], possible: boolean, raison: string | null}}
 *   `raison` est une **clé**, jamais une phrase : rien de traduisible ne traverse l'API.
 */
export function planTransfert({ params, cibleParams }) {
  const porte = new Map((params ?? []).map((p) => [Number(p.id), Number(p.value)]));
  const declares = cibleParams ?? [];
  const retires = (params ?? []).filter((p) => !declares.includes(Number(p.id))).map((p) => ({ id: Number(p.id), value: Number(p.value) }));

  // L'ordre suit la déclaration de la CIBLE, pas celle de la recette : la trame se lit alors dans
  // le même ordre que le catalogue l'énonce, quel que soit l'ordre où l'utilisateur a réglé.
  const sortants = [];
  const absents = [];
  for (const id of declares) {
    if (porte.has(id)) { sortants.push({ id, value: porte.get(id) }); continue; }
    const g = groupeDe(id);
    // Règle 3 : pas d'ingrédient, pas de valeur d'absence — on n'en invente pas une.
    if (!g) continue;
    // Règle 2 : l'absence s'écrit avec la convention de la machine.
    sortants.push({ id, value: valeurAbsente(g, id) });
    if (g.quantite === id) absents.push(id);
  }

  // Une quantité à zéro ne compte pas : c'est justement la convention d'« absent ».
  const porteuse = sortants.some((p) => QUANTITES.includes(p.id) && p.value > 0);
  if (porteuse) return { params: sortants, retires, absents, possible: true, raison: null };

  /**
   * Le refus doit nommer sa cause, et la cause est **la cible**, jamais la boisson : ce module n'a
   * pas appris qu'« eau chaude = refus ». Si ce qui a été retiré porte l'eau chaude ou le thé, le
   * transfert bute sur la limite documentée de l'appareil et le dit ainsi ; sinon la recette
   * n'avait tout simplement rien à donner.
   */
  const eau = retires.some((p) => p.id === 15 || p.id === THE_TEMP);
  // ⚠️ Rien n'est proposé quand c'est refusé : un appelant distrait ne doit pas pouvoir envoyer la
  // moitié d'un plan que ce module vient de déclarer inapplicable.
  return { params: [], retires, absents: [], possible: false, raison: eau ? "hotWaterNotInCustomSlot" : "nothingTransferable" };
}
