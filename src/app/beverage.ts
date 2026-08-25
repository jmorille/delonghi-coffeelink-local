/**
 * **Le vocabulaire d'une boisson, partagé par `/` et `/recipes`.**
 *
 * Ces types décrivent la réponse de `/api/beverages` — une seule réponse, donc un seul type. Les
 * deux pages en tenaient chacune leur version : `/recipes` déclarait `values.params` comme de
 * simples couples `{id, value}` là où le serveur renvoie des paramètres complets, ce qui
 * l'empêchait de réutiliser quoi que ce soit de l'éditeur de `/`. C'est la divergence habituelle
 * de ce dépôt, cette fois sur la forme des données plutôt que sur une table de protocole.
 *
 * Les quatre règles de valeur qui suivent (`defautModele`, `valeurProfil`, `valeurDepart`,
 * `valeurSure`) répondent chacune à une question distincte, et elles vivent ici pour la même
 * raison : deux implémentations de « quelle valeur pour ce paramètre ? » font deux cafés
 * différents sous une seule et même confirmation.
 */

export interface Param {
  id: number;
  name: string;
  label: string;
  unit: string;
  kind: "user" | "meta" | "maint";
  min?: number;
  def?: number;
  max?: number;
  value?: number;
}
export interface Decoded {
  at: number;
  kind: "bounds" | "values";
  exact: boolean;
  params: Param[];
  hex: string;
  /**
   * **Vraie quand la trame a été ASSEMBLÉE ici, pas lue sur la machine.** `/recipes` compose une
   * déclaration de bornes qui ne vient d'aucune lecture ; l'afficher sous l'étiquette « Trame lue »
   * serait affirmer que l'appareil l'a envoyée. Absente ou fausse = lue, ce qui laisse tout appelant
   * existant inchangé.
   */
  calculee?: boolean;
}
export interface Beverage {
  id: number;
  label: string;
  factoryName: string;
  slug: string;
  category: string;
  ingredients: number[];
  milk: boolean;
  boundsProp: string | null;
  valuesProp: string | null;
  bounds: Decoded | null;
  values: Decoded | null;
  /**
   * Compteur d'usage de la CATEGORIE de cette boisson. La machine ne compte pas tasse par tasse :
   * `scope` vaut « category », et l'interface doit le dire.
   */
  counter: { id: number; value: number; category: string; scope: string } | null;
  /**
   * Configuration de grains active, pour la boisson Bean System uniquement. C'est un ATTRIBUT de
   * la boisson — le nom du grain n'est pas le nom de la tasse.
   */
  beanSystem: { index: number; name: string | null; grinder: number; temperature: number; aroma: number } | null;
  /** Nom SAISI sur la machine, s'il y en a un. C'est lui que réécrit une écriture d'icône. */
  machineName: string | null;
  /**
   * Index 0-19 de l'image, tel que la machine le stocke (octet 20 du bloc `0xAA`) — vérifié
   * dans le code de l'app, voir le commentaire de `/api/beverages` côté serveur. Non nul pour
   * les seules recettes perso nommées.
   */
  icon: number | null;
  /** Emplacement perso 1-6. Le serveur le calcule ; ne pas le redériver de `id` ici. */
  customSlot: number | null;
}

/** Couple (paramètre, valeur) tel qu'envoyé à la machine — distinct de `Param`, qui décrit un
 *  paramètre décodé avec ses bornes. */
export interface RecipeParam {
  id: number;
  value: number;
}

/**
 * Tous les paramètres que le modèle déclare pour cette boisson, avec leurs bornes — **sans
 * filtrer sur `kind`**. C'est l'appelant qui décide de regrouper ; filtrer ici masquait des
 * options réellement réglables.
 */
export function beverageParams(bev: Beverage): Param[] {
  const src = bev.bounds?.params ?? bev.values?.params ?? [];
  return bev.ingredients.map((id) => src.find((p) => p.id === id)).filter((p): p is Param => !!p);
}

/**
 * Un défaut n'est exploitable que s'il tombe dans ses propres bornes. La machine renvoie 0 ou
 * 255 (0xFF) pour un paramètre non configuré — constaté sur les 6 recettes perso vides et sur
 * le mug de voyage lors de l'import réel.
 */
export function isSet(p: Param): boolean {
  return p.def !== undefined && p.min !== undefined && p.max !== undefined && p.def >= p.min && p.def <= p.max;
}

/**
 * Le défaut du **modèle**, ou `null` s'il ne tombe pas dans ses propres bornes — auquel cas il n'y
 * a pas de valeur d'usine à proposer, et on n'en invente pas.
 */
export function defautModele(b: Param): number | null {
  const d = b.def;
  if (d === undefined || d === null) return null;
  return d >= (b.min as number) && d <= (b.max as number) ? d : null;
}

/** Ce que le **profil** a enregistré sur la machine, si c'est utilisable. */
export function valeurProfil(bev: Beverage, b: Param): number | undefined {
  const v = bev.values?.params.find((p) => p.id === b.id)?.value;
  if (v === undefined) return undefined;
  return v >= (b.min as number) && v <= (b.max as number) ? v : undefined;
}

/** Valeur de départ d'un réglage : celle du profil, sinon celle du modèle, sinon le minimum. */
export function valeurDepart(bev: Beverage, b: Param): number {
  return valeurProfil(bev, b) ?? defautModele(b) ?? (b.min as number);
}

/**
 * Ce qu'on peut **honnêtement** envoyer pour un paramètre, et d'où ça vient.
 *
 * `null` = ni valeur de profil ni défaut utilisable : on n'envoie rien pour ce paramètre, et la
 * machine applique le sien. C'est ce qui évite d'envoyer « Café = 0 ml » sur un mug de voyage
 * jamais configuré, tout en cessant d'ignorer la recette du profil quand elle existe.
 */
export function valeurSure(bev: Beverage, b: Param): { value: number; from: "profil" | "modele" } | null {
  const p = valeurProfil(bev, b);
  if (p !== undefined) return { value: p, from: "profil" };
  const d = defautModele(b);
  if (d !== null) return { value: d, from: "modele" };
  return null;
}

/** Paramètre décodé (avec son identifiant d'énum) pour cette boisson — la traduction du libellé
 *  se fait ensuite via `useParamLabel`. */
export const paramOf = (bev: Beverage, id: number): Param | undefined =>
  bev.bounds?.params.find((p) => p.id === id) ?? bev.values?.params.find((p) => p.id === id);

/**
 * Les réglages d'une commande, en français, avec leurs unités.
 *
 * Remplace un `params.map(p => nom + " = " + valeur)` qui vidait huit couples dont quatre ne sont
 * pas des réglages d'utilisateur (« Programmable = 1 », « Visible = 1 ») et dont aucun ne portait
 * son unité — dans le dialogue même qui existait pour ne plus faire ce que faisait
 * `window.confirm()`. Les paramètres techniques ne quittent pas la **trame**, ils sont comptés au
 * lieu d'être énumérés : la règle « ne jamais filtrer les paramètres sur `kind` » porte sur ce
 * qu'on envoie, pas sur ce qu'on donne à relire avant de confirmer.
 */
export function resumeReglages(
  bev: Beverage,
  params: RecipeParam[],
  paramLabel: (p: { name?: string; label?: string; id?: number }) => string,
  unitLabel: (u: string) => string,
  autres: (n: number) => string,
): string {
  const lisibles: string[] = [];
  let techniques = 0;
  for (const p of params) {
    const meta = paramOf(bev, p.id);
    if (meta && meta.kind === "user") {
      lisibles.push(paramLabel(meta) + " " + p.value + (meta.unit ? " " + unitLabel(meta.unit) : ""));
    } else techniques++;
  }
  if (!techniques) return lisibles.join(" · ");
  const queue = autres(techniques);
  return lisibles.length ? lisibles.join(" · ") + " · " + queue : queue;
}
