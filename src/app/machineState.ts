/**
 * L'état de la machine, lu dans l'octet 4 du monitor — nommé une seule fois.
 *
 * **Pourquoi ce fichier existe.** Le même quadruplet de cas était écrit deux fois : une fonction
 * `stateLabel` sur l'accueil, et une cascade de ternaires sur `/pilotage`. Les deux disaient les
 * mêmes mots, mais pas de la même façon — `/pilotage` préfixait les siens de `⚪`, `🟢` et `🟠`,
 * trois émojis coloriés par le système, quatre lignes sous une rangée qui rendait le même genre de
 * fait avec une pastille. Le même état de la même machine avait donc deux apparences selon la page.
 *
 * `ton` rend la classe de pastille, pas une couleur : le vocabulaire (`on` vert, `info` ambre,
 * neutre) est celui de `globals.css`, et la veille y est **neutre** — une machine endormie n'est ni
 * un succès ni une panne, et la peindre en vert ou en rouge serait une affirmation de plus que ce
 * qu'on sait.
 *
 * `0x04` est le seul état certain (veille) ; `0x00` chauffe, `0x02` est prête, et tout le reste est
 * « allumée », état affiché tel quel plutôt que traduit en devinette.
 */
export type Translator = (key: string, values?: Record<string, string | number>) => string;

/** Le libellé, depuis l'espace de noms `power`. */
export function stateLabel(state: number, t: Translator): string {
  if (state === 0x04) return t("standby");
  if (state === 0x00) return t("heating");
  if (state === 0x02) return t("ready");
  return t("onUnknownState", { state: `0x${state.toString(16).padStart(2, "0")}` });
}

/** La classe de pastille correspondante. Chaîne vide = pastille neutre. */
export function stateTone(state: number): "" | "on" | "info" {
  if (state === 0x04) return "";
  if (state === 0x00) return "info";
  return "on";
}

/**
 * **Un capteur PRÉSENT et un capteur qui RÉCLAME ne sont pas le même fait.**
 *
 * Les treize capteurs du monitor arrivaient tous dans la même pastille verte — le vert que la
 * palette réserve à la marche. Relevé sur la machine : « niveau d'eau bas · bac chocolat » en
 * vert, juste à côté de « alarme signalée » en rouge. Le produit annonçait donc en couleur de
 * succès la seule chose qui empêchait de faire un café.
 *
 * Ces cinq-là décrivent un manque ou une ouverture — c'est leur propre libellé qui le dit, aucune
 * connaissance de protocole n'est ajoutée ici : ce sont les capteurs dont l'état signalé est ce
 * qu'il faut aller corriger sur l'appareil. Les huit autres rapportent une présence ou une
 * position (carafe branchée, molette, verseuse) et ne demandent rien : pastille neutre, parce
 * qu'un fait qui n'appelle aucun geste n'a pas à porter une couleur de rôle.
 *
 * Classé sur le nom d'énum, pas sur le libellé : le serveur envoie l'identifiant de protocole,
 * et c'est ce que les deux pages qui affichent des capteurs (`/` et `/pilotage`) reçoivent.
 */
const CAPTEURS_ATTENTION = new Set([
  "WATER_LEVEL_LOW",
  "WATER_TANK_ABSENT",
  "DOOR_OPENED",
  "PREGROUND_DOOR_OPENED",
  "CLEAN_KNOB",
]);

/** Classe de pastille d'un capteur. Chaîne vide = neutre. */
export function sensorTone(name: string): "" | "off" {
  return CAPTEURS_ATTENTION.has(name) ? "off" : "";
}

/**
 * Sépare les capteurs à traiter de ceux qui ne font que rapporter une présence, pour que les deux
 * groupes puissent être rendus dans deux pastilles au lieu d'une seule, indifférenciée.
 */
export function splitSensors<T extends { name: string }>(sw: T[]): { attention: T[]; presents: T[] } {
  return {
    attention: sw.filter((s) => CAPTEURS_ATTENTION.has(s.name)),
    presents: sw.filter((s) => !CAPTEURS_ATTENTION.has(s.name)),
  };
}
