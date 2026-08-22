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

/**
 * **Le libellé d'un capteur, traduit côté client.**
 *
 * Le serveur envoie l'identifiant de protocole (`IFD_CARAFFE`, `COFFEE_WASTE_CONTAINER`…) *et*
 * un libellé français — mais ce libellé-là ne sert qu'au **journal du terminal**, exactement comme
 * ceux de `beverages.mjs` et `profiles.mjs`. Rien de traduisible ne doit traverser l'API : c'est ce
 * qui permet d'ajouter une langue sans toucher au serveur. Les deux pages qui affichent des
 * capteurs (`/` et `/pilotage`) rendaient `sw.label` directement, donc le français du serveur
 * arrivait tel quel dans l'interface. Les alarmes, elles, passaient déjà par l'espace `alarm`.
 *
 * Repli sur le libellé du serveur quand la clé manque — même règle que `labels.ts` pour les
 * boissons : un capteur ajouté au protocole s'affiche avec son nom du serveur plutôt que de
 * disparaître ou de montrer un identifiant brut.
 */
export function sensorLabel(sw: { name: string; label?: string }, t: HasTranslator): string {
  return t.has(sw.name) ? t(sw.name) : (sw.label ?? sw.name);
}

/** Un traducteur d'espace de noms, avec le `has` que next-intl expose pour tester une clé. */
export type HasTranslator = Translator & { has: (key: string) => boolean };

/**
 * **L'étape d'une préparation en cours.** Le serveur envoie une clé de protocole (`etapeCle`,
 * dérivée du couple fonction/étape des octets 9-10 du monitor) ou `null` quand le couple observé
 * n'est nommé ni par la table de l'app ni par nos relevés. `null` n'est pas une erreur : cinq
 * valeurs d'étape sur un espresso ne portent aucun nom connu, et l'app officielle y garde
 * simplement l'illustration précédente. On dit « en cours » plutôt que d'inventer.
 *
 * Libellés dans l'espace de noms `power`, préfixés `step_`.
 */
export function stepLabel(cle: string | null, t: Translator): string {
  return cle ? t(`step_${cle}`) : t("step_encours");
}

/**
 * **L'âge d'une lecture, formaté une seule fois pour toute l'application.**
 *
 * Cette fonction vivait dans `page.tsx`, non exportée, alors que `/pilotage` affiche exactement le
 * même fait sur sa ligne « État de la machine » : depuis combien de temps le monitor qu'on montre a
 * été reçu. La recopier aurait produit deux barèmes qui divergent à la première retouche — et le
 * seuil de 90 s n'est pas cosmétique, c'est lui qui décide quand un état cesse d'être présenté
 * comme actuel. Il est ici, avec les libellés d'état qu'il accompagne.
 *
 * Les paliers : sous 90 s en secondes (on suit une machine qui répond), sous 90 min en minutes,
 * au-delà en heures. Les libellés viennent de l'espace de noms `power`.
 */
export function fmtAge(sec: number, t: Translator): string {
  if (sec < 90) return t("ageSeconds", { n: sec });
  if (sec < 5400) return t("ageMinutes", { n: Math.round(sec / 60) });
  return t("ageHours", { n: Math.round(sec / 3600) });
}

/** Au-delà, un état lu n'est plus présenté comme actuel. Même seuil sur `/` et sur `/pilotage`. */
export const AGE_PERIME = 90;

/**
 * **La progression se périme BEAUCOUP plus vite que l'état, et le seuil est mesuré.**
 *
 * `AGE_PERIME` vaut 90 s parce qu'un état machine reste plausible longtemps : « prête » il y a une
 * minute est encore une information. Une progression, non — pendant une préparation la machine
 * pousse une trame toutes les 1 à 3 s, donc un pourcentage vieux de vingt secondes ne veut pas dire
 * « ça avance lentement », il veut dire « on a perdu le contact ».
 *
 * Le défaut a été observé en vrai : la machine a quitté le réseau treize secondes après le départ
 * d'une commande, et l'accueil a gardé « Mouture — 0 % » à l'écran, immobile. **Une barre figée est
 * pire que pas de barre** : elle affirme qu'une préparation progresse alors qu'on ne sait plus rien.
 *
 * 20 s = 2,6 × le pire écart entre deux trames jamais relevé (7,6 s, sur trois préparations
 * enregistrées dans `scripts/captures/`). `scripts/verif-monitor.mjs` vérifie que cette constante
 * reste au-dessus du pire écart des captures : la resserrer sous la cadence réelle ferait
 * clignoter la barre.
 */
export const AGE_PROGRESSION = 20;

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
 * palette réserve à la marche. Relevé sur la machine : « niveau d'eau bas · carafe à lait » en
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
