/**
 * **Le SECOND canal de statistiques : des compteurs portés par des propriétés Ayla NOMMÉES.**
 *
 * Tout ce que `/statistiques` savait faire jusqu'ici passe par `0xA2 0x0F` : des identifiants nus
 * (100, 3000, 23004…) dont dix seulement ont un sens établi, et cinquante-deux qui restent muets.
 * Ce n'est que la moitié de ce que fait l'application officielle. `p258z7/w.java` a deux méthodes :
 *
 *   - `w.a()` lit les compteurs par trame `0xA2` → une carte `id → valeur` — c'est le balayage ;
 *   - `w.b()` lit **quatorze propriétés Ayla nommées** → une carte `nom → valeur`, avec des noms
 *     qui disent ce qu'ils comptent (`d553_water_tot_qty`, `d552_cnt_calc_tot`…).
 *
 * Ces propriétés arrivent déjà ici : en mode LAN une propriété est une propriété, et le serveur
 * les rangeait en `kind: "unknown"` avec leur valeur mot pour mot. Rien n'était perdu ; rien
 * n'était nommé non plus. Ce module leur donne un nom, et surtout **les rend comparables aux
 * compteurs `0xA2`** : six d'entre elles portent la même grandeur qu'un paramètre déjà identifié
 * (`d553` ↔ 106, `d552` ↔ 105, `d554` ↔ 108, `d557` ↔ 115, `d700/d701_tot_bev_b` ↔ 3000,
 * `d701_tot_bev_bw` ↔ 3001). Lire les deux dans le même passage vérifie l'appariement sur un seul
 * relevé — c'est le levier le moins cher qui reste pour attaquer les cinquante-deux muets.
 *
 * ## Deux sources, et elles ne se valent pas
 *
 * `source: "apk"` — le nom est écrit dans le binaire de l'application (`p258z7/w.java`, méthode
 * `b()`). Quatorze noms. C'est une preuve d'existence dans le protocole.
 *
 * `source: "eletta"` — le nom vient d'un **relevé Ayla réel** d'une Eletta Explore 450.65.G, publié
 * par l'intégration Home Assistant `actabi/delonghi_coffeelink` (`const.py`, `COUNTER_SENSORS` ;
 * contribution `kasiom`, issue #7). Ces noms n'apparaissent nulle part dans l'APK : ils prouvent
 * que la propriété existe sur **cet** appareil-là, rien de plus. La distinction voyage jusqu'à
 * l'écran — un nom qui ne vient pas du binaire ne doit pas se présenter comme s'il en venait.
 *
 * ⚠️ **Ce que le relevé Eletta établit, et qui contredit une phrase de cette interface** : les
 * compteurs `d705_tot_id1_espr` … `d730_tot_id27_brew_over_ice` sont des compteurs **par boisson**,
 * et l'identifiant porté par leur nom est celui du catalogue de ce dépôt (15 = cappuccino inversé,
 * 23 = verseuse, 27 = brew over ice — vérifié dans `verif-compteurs.mjs`). « La machine compte par
 * catégorie, pas par boisson » reste vrai de l'espace `0xA2` de l'ECAM 610.75.MB ; ce n'est pas
 * vrai de la gamme.
 *
 * ## Ce qui n'est PAS repris de l'intégration Home Assistant
 *
 * ⚠️ **`d553_water_tot_qty` se divise par 2000, pas par 1000.** L'app applique `u.a(v) = v × 0,5`
 * (l'unité est le demi-millilitre, la même que celle du paramètre 106) puis `/ 1000`, et la
 * branche datapoints de `p018b7/e.java` écrit `Integer.parseInt(str) / 2000` en toutes lettres.
 * `counters.py` côté Home Assistant divise par 1000 en s'appuyant sur `sk7n4k3d/delonghi-ha` et
 * `PyDeLonghiAPI` : ses litres sont deux fois trop grands. C'est l'APK qui tranche.
 *
 * ## Ce qu'on ne convertit pas
 *
 * `d550_water_calc_qty` et `d555_water_filter_qty` sont des volumes d'eau, mais **rien n'établit
 * leur unité** : l'app ne les affiche pas, et le demi-millilitre de `d553` n'est pas transposable
 * par ressemblance de nom. Ils sortent donc bruts, sans unité inventée. Le jour où un relevé les
 * rapproche de `d553`, il suffira d'un `divisor` ici.
 *
 * Module **pur et isomorphe** : pas de `Buffer`, pas d'accès au disque, l'instant n'entre pas.
 * `node scripts/verif-compteurs.mjs` le prouve.
 */

/** D'où vient le nom d'une propriété — voir l'en-tête : les deux sources ne se valent pas. */
export const SOURCE = { APK: "apk", ELETTA: "eletta" };

/**
 * `usage` = ce que la machine a produit depuis toujours (des tasses, de l'eau, des entretiens
 * faits). `entretien` = où elle en est maintenant (marc dans le bac, dureté réglée, détartrage à
 * venir). La distinction n'existe pas dans le protocole, elle est **la nôtre**, et elle ne sert
 * qu'à grouper l'affichage : un pourcentage avant détartrage n'a rien à faire dans une colonne de
 * totaux à vie.
 */
export const FAMILLE = { USAGE: "usage", ENTRETIEN: "entretien" };

/**
 * `nom de propriété → { key, source, famille, divisor?, unit?, beverageId? }`.
 *
 * `key` est un identifiant de traduction (`stat.*` dans `messages/fr.json`) — jamais un libellé :
 * rien de traduisible ne traverse l'API. `beverageId` remplace `key` pour un compteur propre à une
 * boisson : la page l'étiquette alors avec le catalogue, qui est déjà la source unique des noms de
 * boissons. Les deux ensemble n'auraient aucun sens et `verif-compteurs.mjs` le refuse.
 */
export const COMPTEURS = {
  // --- Les quatorze de `w.b()` -------------------------------------------------------------
  // Deux noms pour la même grandeur : les familles Striker publient `d701_tot_bev_b`, les autres
  // `d700_tot_bev_b`. L'app essaie les deux, nous aussi — et la clé de traduction est la même,
  // parce que c'est la même chose qui est comptée.
  d700_tot_bev_b: { key: "beverageBlack", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d701_tot_bev_b: { key: "beverageBlack", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d701_tot_bev_bw: { key: "beverageHotMilk", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d702_tot_bev_other: { key: "bevOther", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d703_tot_bev_w: { key: "bevWater", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d719_id22_tea: { beverageId: 22, source: SOURCE.APK, famille: FAMILLE.USAGE },
  d731_tot_mug_hot: { key: "mugHot", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d732_tot_mug_cold: { key: "mugCold", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d733_tot_bev_counters: { key: "bevCounters", source: SOURCE.APK, famille: FAMILLE.USAGE },
  // Seule conversion établie du lot : demi-millilitres → litres, comme le paramètre 106.
  d553_water_tot_qty: { key: "waterLitres", source: SOURCE.APK, famille: FAMILLE.USAGE, divisor: 2000, unit: "L" },
  d552_cnt_calc_tot: { key: "descales", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d554_cnt_filter_tot: { key: "filters", source: SOURCE.APK, famille: FAMILLE.USAGE },
  d557_milk_cln_cnt: { key: "milkCleans", source: SOURCE.APK, famille: FAMILLE.USAGE },
  // Unité non établie : voir l'en-tête, on ne divise pas par ressemblance de nom.
  d550_water_calc_qty: { key: "waterSinceDescale", source: SOURCE.APK, famille: FAMILLE.ENTRETIEN },

  // --- Le relevé Eletta Explore : agrégats -------------------------------------------------
  d704_tot_bev_espressi: { key: "espressi", source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d735_iced_bev: { key: "icedBev", source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d736_mug_bev: { key: "mugBev", source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d737_mug_iced_bev: { key: "mugIcedBev", source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d738_cold_brew_bev: { key: "coldBrewBev", source: SOURCE.ELETTA, famille: FAMILLE.USAGE },

  // --- Le relevé Eletta Explore : un compteur PAR BOISSON --------------------------------
  // L'identifiant est dans le nom (`_id7_`), et c'est celui du catalogue. `verif-compteurs.mjs`
  // relit le nom pour vérifier que `beverageId` ne s'en est pas écarté — une paire recopiée à la
  // main est exactement le genre de table qui dérive d'un cran sans rien lever.
  d705_tot_id1_espr: { beverageId: 1, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d706_tot_id2_coffee: { beverageId: 2, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d707_tot_id3_long: { beverageId: 3, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d708_tot_id5_doppio_p: { beverageId: 5, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d709_id6_americano: { beverageId: 6, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d710_tot_id7_capp: { beverageId: 7, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d711_id8_lattmacc: { beverageId: 8, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d712_id9_cafflatt: { beverageId: 9, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d713_id10_flatwhite: { beverageId: 10, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d714_id11_esprmacc: { beverageId: 11, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d715_id12_hotmilk: { beverageId: 12, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d716_id13_cappdoppio_p: { beverageId: 13, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d717_id15_caprev: { beverageId: 15, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d718_id16_hotwater: { beverageId: 16, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d720_tot_id23_coffee_pot: { beverageId: 23, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },
  d730_tot_id27_brew_over_ice: { beverageId: 27, source: SOURCE.ELETTA, famille: FAMILLE.USAGE },

  // --- Le relevé Eletta Explore : entretien ------------------------------------------------
  d551_cnt_coffee_fondi: { key: "grounds", source: SOURCE.ELETTA, famille: FAMILLE.ENTRETIEN },
  d555_water_filter_qty: { key: "waterSinceFilter", source: SOURCE.ELETTA, famille: FAMILLE.ENTRETIEN },
  d556_water_hardness: { key: "waterHardness", source: SOURCE.ELETTA, famille: FAMILLE.ENTRETIEN },
  d825_descale_status: { key: "descaleStatus", source: SOURCE.ELETTA, famille: FAMILLE.ENTRETIEN },
  d512_percentage_to_deca: { key: "percentToDescale", source: SOURCE.ELETTA, famille: FAMILLE.ENTRETIEN, unit: "%" },
};

/** Le nom est-il un compteur connu ? Nom EXACT, jamais un motif — voir `handleProperty`. */
export const estCompteur = (nom) => Object.hasOwn(COMPTEURS, nom);

/** Sa description, ou `null`. */
export const compteurInfo = (nom) => COMPTEURS[nom] ?? null;

/**
 * Les deux portées de lecture, dans l'ordre où les pas partent.
 *
 * `app` : les quatorze noms écrits dans le binaire. C'est la lecture par défaut, et la seule dont
 * chaque nom est prouvé exister quelque part dans la gamme.
 *
 * `tous` : plus les vingt-six du relevé Eletta. Sur une machine qui ne les a pas, chacun répond
 * vide une fois, est noté absent, et n'est plus jamais redemandé (voir `nomsARelire`) — le coût
 * d'un essai est donc borné, et son résultat informatif dans les deux sens.
 *
 * L'ordre : `app` d'abord dans `tous`, pour que la lecture large commence par ce qui a le plus de
 * chances de répondre. Une lecture interrompue au milieu aura alors ramené le plus utile.
 */
const NOMS_APK = Object.keys(COMPTEURS).filter((n) => COMPTEURS[n].source === SOURCE.APK);
const NOMS_ELETTA = Object.keys(COMPTEURS).filter((n) => COMPTEURS[n].source === SOURCE.ELETTA);
export const PORTEES = { app: NOMS_APK, tous: [...NOMS_APK, ...NOMS_ELETTA] };

/**
 * Ce qu'il reste à demander dans une portée, connaissant ce qui est déjà en cache.
 *
 * **Une propriété notée absente n'est pas redemandée.** Sur l'ECAM 610.75.MB la majorité des noms
 * Eletta répondront vide : sans ce filtre, « Tous les noms connus » enverrait quarante pas à
 * chaque clic pour ramener les mêmes quatorze réponses. Un pas coûte une visite de la machine, et
 * la machine n'en accorde qu'une commande à la fois.
 *
 * `props` est la vue du magasin (`machineView().props`). Une propriété jamais lue n'y est pas ;
 * une propriété lue avec succès y est **et se redemande** — c'est tout l'intérêt d'un compteur.
 */
export function nomsARelire(portee, props = {}) {
  return (PORTEES[portee] ?? []).filter((nom) => props[nom]?.absent !== true);
}

/**
 * **La valeur d'un compteur, sous les trois formes que la gamme emploie.**
 *
 * 1. un entier (`"314"`, `314`) — le cas ordinaire ;
 * 2. un **objet JSON** de sous-compteurs (`{"espresso": 12, "coffee": 3}`) : les Striker publient
 *    ainsi `d702_tot_bev_other`, `d733_tot_bev_counters`, `d735_iced_bev`, `d738_cold_brew_bev`.
 *    L'état est la somme des sous-valeurs entières, et la ventilation est conservée telle quelle :
 *    c'est elle qui porte l'information, la somme n'est qu'un résumé ;
 * 3. tout le reste → `null`.
 *
 * ⚠️ **`null` plutôt qu'une valeur devinée, et `null` plutôt que zéro.** Un objet dont aucune
 * sous-valeur n'est un entier rend `null`, pas `0` : un total de zéro annoncé sur une machine qui
 * a servi mille tasses est un mensonge tranquille, et il ressemble exactement à un compteur remis
 * à zéro. Même règle que partout ici — ne rien afficher vaut mieux qu'afficher du plausible.
 *
 * Un booléen est refusé explicitement : `Number(true)` vaut 1, et un compteur à 1 sorti d'un
 * `true` serait indiscernable d'une vraie lecture.
 */
export function lireCompteur(valeur) {
  if (valeur === null || valeur === undefined || typeof valeur === "boolean") return null;
  if (typeof valeur === "number") return Number.isInteger(valeur) ? { value: valeur, breakdown: null } : null;
  const s = String(valeur).trim();
  if (s.startsWith("{") && s.endsWith("}")) {
    let objet;
    try { objet = JSON.parse(s); } catch { return null; }
    if (!objet || typeof objet !== "object" || Array.isArray(objet)) return null;
    let total = 0;
    let comptees = 0;
    for (const sous of Object.values(objet)) {
      const n = typeof sous === "boolean" ? NaN : Number(sous);
      if (Number.isInteger(n)) { total += n; comptees++; }
    }
    return comptees ? { value: total, breakdown: objet } : null;
  }
  if (!/^-?\d+$/.test(s)) return null;
  return { value: Number(s), breakdown: null };
}

/**
 * La valeur telle qu'on l'affiche : convertie quand l'unité est établie, brute sinon.
 *
 * Le brut est **conservé à côté**, comme pour les compteurs `0xA2` : c'est lui qu'on recompare à
 * un relevé ultérieur, et c'est lui qui prouve la conversion.
 */
export function valeurAffichee(nom, brut) {
  const info = compteurInfo(nom);
  if (!info || brut === null || brut === undefined) return null;
  return info.divisor ? Math.round(brut / info.divisor) : brut;
}
