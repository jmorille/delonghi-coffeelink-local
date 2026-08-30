/**
 * **Le monitor `0x75` — décodage, et la seule partie du protocole vérifiable sans la machine.**
 *
 * Extrait de `server.mjs` pour cette raison précise : le décodage est pur (des octets entrent, un
 * objet sort — pas d'E/S, pas de journal, pas d'état), donc `scripts/verif-monitor.mjs` peut le
 * rejouer sur des trames RÉELLES capturées pendant trois préparations. C'est le même choix que
 * `src/lib/tasks.mjs` : ce qui peut être prouvé hors appareil doit l'être.
 *
 * ⚠️ Ce module N'EST PAS une des copies fantômes de `src/lib/*.ts` : il tourne, `server.mjs`
 * l'importe.
 */

/**
 * Alarmes du monitor — index de bit → identifiant, port de `p127m6/l` (méthode `a(int)`).
 *
 * ⚠️ La table fait autorité sur les couples (groupe, bit) déclarés dans l'énum : plusieurs index
 * sont explicitement `IGNORE_ALARM` sur cette génération (7, 10, 13, 16, 20, 21, 23, 24, 26-31),
 * alors que l'énum y déclare des alarmes. On les marque « ignorée » au lieu de les nommer à tort.
 *
 * Le champ est un bitfield 32 bits construit par `MonitorDataV2.b()` :
 *   octet 7 | octet 8 << 8 | octet 12 << 16 | octet 13 << 24
 */
export const MONITOR_ALARMS = {
  0: "EMPTY_WATER_TANK",
  1: "COFFEE_WASTE_CONTAINER_FULL",
  2: "DESCALE_ALARM",
  3: "REPLACE_WATER_FILTER",
  4: "COFFE_GROUND_TOO_FINE",
  5: "COFFEE_BEANS_EMPTY",
  6: "MACHINE_TO_SERVICE",
  8: "TOO_MUCH_COFFEE",
  9: "COFFEE_INFUSER_MOTOR_NOT_WORKING",
  11: "EMPTY_DRIP_TRAY",
  12: "HYDRAULIC_CIRCUIT_PROBLEM",
  14: "CLEAN_KNOB",
  15: "COFFEE_BEANS_EMPTY_TWO",
  17: "BEAN_HOPPER_ABSENT",
  18: "GRID_PRESENCE",
  19: "INFUSER_SENSE",
  22: "EXPANSION_SUBMODULES_PROB",
  25: "CONDENSE_FAN_PROBLEM",
};

/**
 * Capteurs rapportés par le monitor — port de l'énum `p127m6/p` (couple groupe/bit) et de
 * `MonitorDataV2.l()` : l'octet est `5 + groupe`, le bit est la position dans l'énum.
 */
export const MONITOR_SWITCHES = [
  { group: 0, bit: 0, name: "WATER_SPOUT", label: "buse à eau" },
  { group: 0, bit: 1, name: "MOTOR_UP", label: "moteur haut" },
  { group: 0, bit: 2, name: "MOTOR_DOWN", label: "moteur bas" },
  { group: 0, bit: 3, name: "COFFEE_WASTE_CONTAINER", label: "bac à marc" },
  { group: 0, bit: 4, name: "WATER_TANK_ABSENT", label: "réservoir d'eau absent" },
  { group: 0, bit: 5, name: "KNOB", label: "molette" },
  { group: 0, bit: 6, name: "WATER_LEVEL_LOW", label: "niveau d'eau bas" },
  { group: 0, bit: 7, name: "COFFEE_JUG", label: "verseuse" },
  { group: 1, bit: 0, name: "IFD_CARAFFE", label: "carafe à lait (mousse)" },
  { group: 1, bit: 1, name: "CIOCCO_TANK", label: "carafe à lait (nettoyage)" },
  { group: 1, bit: 2, name: "CLEAN_KNOB", label: "molette nettoyage" },
  { group: 1, bit: 5, name: "DOOR_OPENED", label: "porte ouverte" },
  { group: 1, bit: 6, name: "PREGROUND_DOOR_OPENED", label: "trappe café moulu ouverte" },
];

/**
 * **La progression d'une préparation — octets 9, 10, 11.**
 *
 * L'app les journalise mot pour mot dans `BrewBeveragesViewModel.P()` :
 * `"Fun OnGoing: " + f() + " Exe Prog: " + e() + " Percent : " + d()`, où pour un monitor de
 * mode 2 (la réponse `0x75`, la seule qu'on demande) `MonitorDataV2` lit respectivement les
 * octets **9**, **10** et **11**.
 *
 * `fonction` est la PHASE en cours, pas le type de boisson : un espresso macchiato passe de 10
 * (lait) à 7 (café) en cours de route. Le pourcentage, lui, couvre la boisson ENTIÈRE — relevé
 * sur la machine : le lait le mène à 38, puis le café reprend à 40 et va jusqu'à 100.
 *
 * ⚠️ **Le retour au repos (`e = 0`, voir `ETAPE_REPOS`) est le seul signal de fin fiable.** Un
 * lait chaud a été relevé s'arrêtant à 90 % avant de retomber directement au repos : une barre
 * qui attendrait `pourcent === 100` resterait bloquée. Voir `doc/commandes-cafe.md` § 11.5.
 *
 * Les libellés `VIEW_C13_PREPARING_STATUS_<f>_<e>` de l'app viennent de son CMS, pas de l'APK :
 * ceux-ci sont les nôtres, déduits des illustrations que `BrewBeveragesViewModel.D()/E()`
 * associe à chaque couple. **Les couples que ni l'app ni nos relevés ne nomment restent
 * `null`** — l'app y garde simplement l'illustration précédente, et inventer un nom pour un
 * octet jamais observé est exactement ce que ce projet paie cher ailleurs.
 */
/**
 * **Le repos se lit sur l'ÉTAPE seule, pas sur le couple.**
 *
 * L'app teste `f == 7 && e == 0` (son predicat `o()`), et c'est ce qu'on faisait. C'est trop
 * etroit : mesure du 2026-08-22, **carafe a lait branchee, machine au repos, la trame dit
 * `f=12, e=0`** — une fonction qui n'apparait dans aucune des quatre preparations enregistrees.
 * Retirer la carafe la ramene a `f=7, e=0` (capture `carafe.json`). Avec la regle de l'app, une
 * machine au repos avec sa carafe en place etait donc lue « preparation en cours, 0 % », et la
 * barre restait affichee en permanence.
 *
 * `e === 0` suffit et se verifie : sur les cinq captures, l'etape 0 n'apparait QUE au repos —
 * jamais au milieu d'une preparation, dont les etapes relevees vont de 1 a 14.
 * `scripts/verif-monitor.mjs` le reverifie a chaque execution.
 *
 * ⚠️ **…mais `e === 0` seul ne suffit PAS : une fonction NULLE est aussi le repos.** Mesure du
 * 2026-08-27, machine **en veille**, reservoir d'eau vide (alarme `EMPTY_WATER_TANK` levee) :
 *
 * ```
 * d0 12 75 0f 04 40 02 01 00 00 02 64 00 00 00 00 00 3f fa
 *             ^^          ^^ ^^ ^^     etat=0x04 · f=0 · e=2 · %=100
 * ```
 *
 * `f=0, e=2, %=100` ne ressemble a AUCUNE preparation reelle : sur les soixante trames capturees
 * la fonction vaut 7, 10 ou 12 — **jamais 0** — et 100 % n'apparait qu'aux etapes 13-14, jamais a
 * l'etape 2. L'octet 9 est « Fun OnGoing » dans le journal de l'app : **zero veut dire qu'aucune
 * fonction ne tourne**, et les octets 10-11 gardent alors les restes de la derniere. Sans ce
 * second cas, une machine endormie etait lue « preparation en cours, 100 % » et, `auRepos ===
 * false` faisant exception a l'octet d'etat (voir `isOn` dans `src/app/page.tsx`), l'accueil
 * affichait l'interrupteur sur ALLUME juste au-dessus de « En veille » — les deux lisant le meme
 * `0x04`, l'un avec l'exception et l'autre sans. Capture `veille-alarme.json`.
 */
export const ETAPE_REPOS = { etape: 0 };
/**
 * Octet 9 a zero : aucune fonction en cours, donc le repos quoi que disent les octets 10-11.
 *
 * Volontairement NARROW — `MONITOR_ETAPES[fonction] === undefined` aurait couvert le meme cas et
 * bien davantage : une fonction inconnue pendant une VRAIE preparation serait alors lue comme du
 * repos, et la barre disparaitrait en pleine boisson. Zero est le seul code dont on sache dire ce
 * qu'il signifie.
 */
export const FONCTION_REPOS = 0;
export const MONITOR_ETAPES = {
  // Fonction 5 : chauffe (table de l'app, non observée ici).
  5: { 2: "chauffe", 4: "chauffe", 6: "chauffe" },
  // Fonction 7 : café. Relevé en direct sur un espresso — 4, 6, 8, 9, 11, 14 — et sur un
  // macchiato, qui ajoute 13. 7 vient de la table de l'app.
  7: { 0: "repos", 4: "mouture", 7: "chauffe", 8: "infusion", 11: "cafe", 13: "fini", 14: "fini" },
  // Fonction 10 : boisson lactée. Relevé en direct — 1, 3, 4, 5. 2 et 7 viennent de l'app.
  10: { 1: "chauffe", 2: "mouture", 4: "lait", 7: "mouture" },
  11: { 3: "eauChaude" },
  16: { 2: "cafe", 4: "cafe" },
  17: { 1: "lait", 2: "lait", 3: "lait" },
};

/**
 * Décode `d302_monitor` — port de `it/delonghi/ecam/model/MonitorDataV2`, où le tableau indexé
 * est la trame complète décodée du base64.
 *
 * ```
 * 4        état machine        (0x04 = veille ; voir MACHINE_STATES)
 * 5, 6     capteurs           champ de bits 16 bits, octet = 5 + groupe
 * 7, 8, 12, 13  alarmes       champ de bits 32 bits (7 | 8<<8 | 12<<16 | 13<<24)
 * 9, 10, 11     progression        fonction, étape, pourcentage (voir MONITOR_ETAPES)
 * ```
 *
 * ⚠️ Les octets 5-6 étaient nommés « progress » dans une première version : c'était faux, ce sont
 * les capteurs. La vraie progression est aux octets 9-11, voir `MONITOR_ETAPES`.
 *
 * ⚠️ **Les deux bits 1.0 et 1.1 disent tous deux « carafe en place » — ce qui les distingue est
 * la POSITION DE LA MOLETTE de la carafe.** Établi en trois mesures sur la machine le
 * 2026-08-22, une seule variable changeant à chaque fois :
 *
 * ```
 * carafe retirée                     octet 6 = 0b00000000   (aucun)
 * carafe en place, molette nettoyage  octet 6 = 0b00000010   bit 1.1  CIOCCO_TANK
 * carafe en place, molette AILLEURS   octet 6 = 0b00000001   bit 1.0  IFD_CARAFFE
 * ```
 *
 * « Ailleurs » et pas « mousse » : le detecteur ne connait qu'UNE frontiere, nettoyage ou pas.
 * Verifie sur trois positions hors nettoyage — mousse au cran courant, mousse au minimum, et la
 * graduation « insert » — qui donnent la MEME trame, octet pour octet, CRC compris.
 *
 * Jamais les deux ensemble, ce que les quatre préparations enregistrées montraient déjà sans
 * qu'on sache l'expliquer : TROIS DES QUATRE ont `IFD_CARAFFE` (l'espresso, le macchiato et le
 * lait chaud) et la quatrieme a `CIOCCO_TANK` (le second espresso). Ce n'est donc pas le lait qui
 * leve le bit — un espresso pur le leve aussi — c'est la molette. Les noms d'énum sont ceux de l'app et
 * induisent en erreur — `CIOCCO_TANK` ne désigne aucun bac à chocolat ici, ce modèle n'a pas de
 * boisson chocolatée. On garde les noms (ils viennent du protocole) et on corrige les libellés.
 *
 * ⛔ Ni le CRAN de mousse ni la position « insert » ne sont rapportés : les deux bits sont des
 * détecteurs tout-ou-rien, aucun octet continu ne varie. Vrai de `0x75`, la seule trame qu'on
 * interroge — inutile de refaire la mesure.
 */
export function decodeMonitor(b64) {
  const raw = Buffer.from(b64, "base64");
  // Une trame exploitable va au moins jusqu'à l'octet 8 (état, capteurs, 2 premiers octets
  // d'alarmes). Sans ce contrôle, une valeur vide donnait `stateByte: undefined` et le
  // `toString(16)` du journal levait une TypeError : les autres propriétés du MÊME datapoint
  // étaient perdues, et le journal accusait à tort le déchiffrement.
  if (raw.length < 9) throw new Error(`trame monitor trop courte (${raw.length} octets)`);
  const n = raw[1] + 1;
  const e = raw.subarray(0, n);
  if (e.length < 9) throw new Error(`trame monitor tronquée (len annoncé ${n}, ${e.length} reçus)`);
  const bits = e[5] + (e[6] << 8);
  const switches = MONITOR_SWITCHES.filter((sw) => (e[5 + sw.group] >> sw.bit) & 1);
  // Octet 13 multiplié, pas décalé : `0x80 << 24` vaut −2147483648 en JS, et l'API publiait alors
  // un champ de bits négatif. La boucle sur les bits utilise déjà `>>>`, seule la valeur exposée
  // était fausse.
  const alarmBits = e[7] + (e[8] << 8) + ((e[12] ?? 0) << 16) + (e[13] ?? 0) * 0x1000000;
  const alarms = [];
  for (let i = 0; i < 32; i++) {
    if (!((alarmBits >>> i) & 1)) continue;
    // `ignored` : l'app écarte explicitement ces index sur cette génération. On les remonte
    // quand même, marqués, plutôt que de les cacher ou de leur coller un nom faux.
    alarms.push({ bit: i, name: MONITOR_ALARMS[i] ?? null, ignored: !MONITOR_ALARMS[i] });
  }
  // Progression : lue défensivement, car le contrôle de longueur ci-dessus n'exige que 9 octets
  // (l'état et les alarmes). Une trame plus courte perd la progression, pas le reste.
  const fonction = e.length > 9 ? e[9] : null;
  const etape = e.length > 10 ? e[10] : null;
  const pourcent = e.length > 11 ? e[11] : null;
  /**
   * **Trois états, pas deux** : au repos, en préparation, ou on ne sait pas. `null` quand la
   * trame est trop courte pour porter la progression — l'interface teste `=== false` pour
   * afficher une barre, donc « inconnu » ne doit surtout pas être rendu comme « en cours », ce
   * qu'un booléen aurait forcé.
   */
  const auRepos = etape == null ? null : etape === ETAPE_REPOS.etape || fonction === FONCTION_REPOS;
  return {
    stateByte: e[4],
    switchBits: bits,
    switches: switches.map((sw) => ({ name: sw.name, label: sw.label })),
    alarmBits,
    alarms,
    fonction,
    etape,
    // Au repos la machine republie un pourcentage de 0 : le rendre `null` évite qu'une barre
    // affiche « 0 % » quand il n'y a rien en cours.
    pourcent: auRepos ? null : pourcent,
    /** Clé d'étape, à traduire côté client ; `null` quand le couple observé n'est pas nommé. */
    etapeCle: auRepos ? null : (MONITOR_ETAPES[fonction]?.[etape] ?? null),
    /** Le seul signal de fin fiable — voir le commentaire de `MONITOR_ETAPES`. */
    auRepos,
    raw: e.toString("hex").replace(/(..)/g, "$1 ").trim(),
  };
}

