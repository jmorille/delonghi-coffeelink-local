/**
 * Profils utilisateur de la machine : noms, icônes, noms des recettes perso, ordre des favoris.
 *
 * Sources (décompilé APK 4.9.6) :
 *   - `it/delonghi/service/DeLonghiWifiConnectService.java:1700+` (`loadProfiles`) et `:3679+`
 *     (`loadCustomRecipeNames`) — quelles propriétés Ayla lire, et avec quel parser.
 *   - `p097j6/d.java:599` `J0()` / `:630` `K0()` — décodage des noms.
 *   - `p097j6/d.java:584` `I0()` — décodage de l'ordre des favoris.
 *   - `p258z7/z.java:1476` `u()` — gabarit des propriétés de priorité.
 *
 * ⚠️ **Cette machine n'est pas « Striker »** (logcat : `isStriker = false`), donc :
 *   - noms de profils → `d034_profiles_1_3` / `d035_profiles_4_5`, parser **`J0()` (pas de 21
 *     octets)** ; les variantes `d051_profile_name1_3` / `d052_profile_name4` et le parser
 *     `K0()` (stride 22, avec octet « mug ») sont le chemin Striker.
 *   - noms de recettes perso → `d036_recipe_custom_name_1_3` / `d037_recipe_custom_name_4_5`
 *     (les `d053_custom_name_13` / `d054_custom_name_46` sont Striker).
 *
 * Par prudence on interroge quand même les deux variantes : une propriété absente renvoie une
 * valeur vide, ce qui est sans conséquence, et ça évite de se tromper de génération.
 */

/** Stride du bloc « nom » : 21 octets en classic (20 de nom + icône), 22 en Striker (+ mug). */
export const STRIDE_CLASSIC = 21;
export const STRIDE_STRIKER = 22;

/** Noms des profils. `first` = numéro du premier profil du bloc. */
export const PROFILE_NAME_PROPS = [
  { prop: "d034_profiles_1_3", first: 1, stride: STRIDE_CLASSIC, kind: "profileNames" },
  { prop: "d035_profiles_4_5", first: 4, stride: STRIDE_CLASSIC, kind: "profileNames" },
  // Variantes Striker, interrogées par sécurité.
  { prop: "d051_profile_name1_3", first: 1, stride: STRIDE_STRIKER, kind: "profileNames" },
  { prop: "d052_profile_name4", first: 4, stride: STRIDE_STRIKER, kind: "profileNames" },
];

/** Noms des 6 recettes personnalisées (ids de boisson 230..235). */
export const CUSTOM_NAME_PROPS = [
  { prop: "d036_recipe_custom_name_1_3", first: 1, stride: STRIDE_CLASSIC, kind: "customNames" },
  { prop: "d037_recipe_custom_name_4_5", first: 4, stride: STRIDE_CLASSIC, kind: "customNames" },
  { prop: "d053_custom_name_13", first: 1, stride: STRIDE_STRIKER, kind: "customNames" },
  { prop: "d054_custom_name_46", first: 4, stride: STRIDE_STRIKER, kind: "customNames" },
];

/** Ordre d'affichage des boissons par profil (« favoris »). Deux gabarits coexistent. */
export const PRIORITY_PROPS = [1, 2, 3, 4, 5].flatMap((p) => {
  const list = [{ prop: `d${String(260 + p).padStart(3, "0")}_${p}_rec_priority`, profileId: p, kind: "priority" }];
  if (p <= 4) list.push({ prop: `d${String(264 + p).padStart(3, "0")}_favorite_priority_${p}`, profileId: p, kind: "priority" });
  return list;
});

export const ALL_PROFILE_PROPS = [...PROFILE_NAME_PROPS, ...CUSTOM_NAME_PROPS, ...PRIORITY_PROPS];

/** Retrouve la description d'une propriété de profil à partir de son nom. */
export const profilePropInfo = (name) => ALL_PROFILE_PROPS.find((p) => p.prop === name) ?? null;

/** Vrai si le nom de propriété relève des profils (noms ou priorités). */
export function isProfileProp(name) {
  return profilePropInfo(name) !== null;
}

/**
 * Décode un bloc de noms — port de `J0()` / `K0()`.
 *
 * ```
 * 0      0xD0
 * 1      len = taille totale − 1
 * 2      0xA4 (profils) ou 0xAA (recettes perso)
 * 3      0xF0
 * off..  entrées de `stride` octets : 20 octets de nom UTF-16BE (zéros de fin ignorés,
 *        tout-à-zéro = emplacement vide), puis 1 octet d'icône, puis 1 octet « mug »
 *        en Striker seulement
 * −2..   CRC16
 * ```
 *
 * **Vérifié sur les trames réelles de cette machine** (`d034_profiles_1_3`,
 * `d035_profiles_4_5`, `d036_recipe_custom_name_1_3`) :
 *   - les entrées commencent à l'**offset 6** ;
 *   - les octets **4 et 5 portent le premier et le dernier index** du bloc
 *     (`01 03` = profils 1 à 3, `04 05` = profils 4 et 5) — c'est de là qu'on tire le nombre
 *     d'entrées, plus fiable qu'un calcul de taille ;
 *   - le bloc peut laisser **un octet résiduel** avant le CRC : `J0()` fait une division
 *     entière `(len − 7) / 21` et l'ignore. Une première version de ce décodeur exigeait un
 *     ajustement exact et rejetait donc `d034` (3 entrées, 1 octet de reste).
 */
export function decodeNames(b64, stride = STRIDE_CLASSIC) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) throw new Error("trame trop courte");
  const len = buf[1] + 1;
  const offset = 6;
  const first = buf[4];
  const last = buf[5];
  // Nombre d'entrées annoncé par la trame, borné par ce que la place permet réellement.
  const capacity = Math.floor((buf[1] - (offset + 1)) / stride);
  const declared = last >= first ? last - first + 1 : 0;
  const count = Math.min(declared, capacity);

  const out = {
    cmd: buf[2],
    stride,
    offset,
    first,
    last,
    declared,
    capacity,
    exact: declared > 0 && declared === capacity,
    entries: [],
    hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim(),
  };

  for (let i = 0; i < count; i++) {
    const base = offset + i * stride;
    const raw = buf.subarray(base, base + 20);
    const empty = raw.every((b) => b === 0);
    // UTF-16BE ; c'est `decodeUtf16be` qui retire le remplissage (z.h0), par paires d'octets.
    out.entries.push({
      name: empty ? null : decodeUtf16be(raw),
      icon: buf[base + 20],
      mug: stride === STRIDE_STRIKER ? buf[base + 21] : null,
    });
  }
  return out;
}

/**
 * Java décode « UTF-16 » sans BOM en big-endian ; Node ne sait faire que le little-endian.
 *
 * Le remplissage se retire par **paires** d'octets, jamais octet par octet : un nom finissant par
 * un caractère U+xx00 (« Ā ») laissait sinon un tampon de longueur impaire, et `swap16()` lève
 * `ERR_INVALID_BUFFER_SIZE` — ce qui faisait perdre le bloc de noms **entier**, pas seulement ce
 * nom-là. L'ancien garde-fou (« écrire 0 sur le dernier octet ») ne changeait pas la longueur, il
 * ne pouvait donc rien empêcher.
 */
function decodeUtf16be(buf) {
  let end = buf.length - (buf.length % 2);
  while (end >= 2 && buf[end - 1] === 0 && buf[end - 2] === 0) end -= 2;
  const swapped = Buffer.from(buf.subarray(0, end));
  swapped.swap16();
  // Le caractère de contrôle est VOLONTAIRE : c'est le remplissage à zéro du bloc de noms, et
  // c'est exactement ce que cette expression retire. Voir la règle des unités de 2 octets
  // ci-dessus, qui est ce qui empêche `swap16()` de lever sur un tampon de longueur impaire.
  // eslint-disable-next-line no-control-regex
  return swapped.toString("utf16le").replace(/\u0000+$/, "").trim();
}

/**
 * Décode un ordre de favoris — port de `I0()`.
 *
 * ```
 * 4      profileId
 * 5..    (len − 6) identifiants de boisson, dans l'ordre d'affichage
 * ```
 */
export function decodePriorities(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 7) throw new Error("trame trop courte");
  const len = buf[1] + 1;
  const n = buf[1] - 6;
  const ids = [];
  for (let i = 0; i < n && 5 + i < len - 2; i++) ids.push(buf[5 + i]);
  return {
    cmd: buf[2],
    profileId: buf[4],
    beverageIds: ids,
    hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim(),
  };
}

/**
 * Décode la réponse `0xA3` — sommes de contrôle (port de `p097j6.d.L()` case `-93` et du
 * handler `it/delonghi/handlers/b.java:387` qui en donne la sémantique).
 *
 * Requête : `0D 05 A3 F0 <crc>` (`p097j6.d.J()`), 6 octets.
 *
 * ```
 * 0        0xD0
 * 1        len = taille totale − 1
 * 2        0xA3
 * 3        0xF0
 * 4..      `size` sommes de 16 bits big-endian : quantités de recettes du profil 1..size
 * +2       somme des quantités des recettes personnalisées
 * +2       somme des noms
 * 2 dern.  CRC16
 * ```
 *
 * `size` n'est pas dans la trame — l'app le tient de son propre modèle (6 par défaut). On le
 * déduit de la taille : total = 10 + 2·size, donc `size = (len − 9) / 2`.
 *
 * Sémantique (d'après `b.java`) : `namesOk = names === cache`, `quantitiesOk = custom === cache`
 * **et** la somme du profil actif doit correspondre. C'est ainsi que l'app évite de relire les
 * recettes quand rien n'a bougé.
 */
export function decodeChecksums(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 10) throw new Error("trame trop courte");
  const len = buf[1] + 1;
  if (buf[2] !== 0xa3) throw new Error(`commande inattendue 0x${buf[2].toString(16)}`);
  const size = Math.floor((buf[1] - 9) / 2);
  if (size < 1 || size > 10) throw new Error(`nombre de profils invalide (${size})`);
  const be = (o) => (buf[o] << 8) | buf[o + 1];
  const profiles = {};
  for (let k = 0; k < size; k++) profiles[k + 1] = be(4 + 2 * k);
  return {
    size,
    profiles, // profileId → somme des quantités de ses recettes
    customRecipes: be(4 + 2 * size),
    names: be(6 + 2 * size),
    hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim(),
  };
}

/**
 * Décode la réponse `0xBA` — profil Bean System (Bean Adapt) — port de `p097j6.d.G0()`.
 *
 * Requête : `0D 06 BA F0 <index> <crc>`.
 *
 * ```
 * 4        index du Bean System
 * 5..44    nom, 40 octets UTF-16 big-endian (tout-à-zéro = sans nom)
 * 45       mouture (grinder)
 * 46       température
 * 47       arôme
 * 48       réservé
 * 49       visible / non supprimé   (G0 : `isDeleted = octet49 != 1`)
 * 50       ACTIF — le grain sélectionné  (G0 : `isEnable = octet50 != 0`)
 * ```
 *
 * **L'octet 50 est le grain actif**, établi sur les 6 profils réels de la machine : il ne vaut 1
 * que pour un seul d'entre eux, et c'est celui que l'écran de la machine annonce comme actif.
 * C'est aussi ce qui explique l'écart de taille avec la trame d'écriture `0xBB` (52 octets, où
 * les octets 50-51 sont le CRC) : **l'écriture ne peut pas désigner le grain actif**, c'est le
 * rôle de la commande `0xB9`.
 *
 * C'est la SEULE source du nom d'un Bean System : la propriété `d022_beansystem_1` porte, elle,
 * une trame `0xB0` de bornes (vérifié sur la machine), pas le nom.
 *
 * ⚠️ La propriété `d(250+n)_beansystem_n` n'a de valeur qu'**après** l'envoi de la commande
 * `0xBA` correspondante : la lire seule ne renvoie rien.
 */
export function decodeBeanSystem(b64) {
  const buf = Buffer.from(b64, "base64");
  // On lit jusqu'à l'octet 50 (le grain actif) : exiger 48 laissait passer une trame tronquée, où
  // `buf[49]` et `buf[50]` valent `undefined` — donc `visible: false` et surtout `active: true`,
  // un grain fantôme annoncé comme actif. Les trames réelles font 53 octets.
  if (buf.length < 51) throw new Error(`trame trop courte (${buf.length} octets, 51 minimum)`);
  if (buf[2] !== 0xba) throw new Error(`commande inattendue 0x${buf[2].toString(16)}`);
  const len = buf[1] + 1;
  const raw = buf.subarray(5, 45);
  const empty = raw.every((b) => b === 0);
  return {
    index: buf[4],
    name: empty ? null : decodeUtf16be(raw),
    grinder: buf[45],
    temperature: buf[46],
    aroma: buf[47],
    visible: buf[49] === 1,
    active: buf[50] !== 0,
    hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim(),
  };
}


/**
 * **Le grain sélectionné, en UNE lecture de propriété** — `d260_beansystem_sync_par`.
 *
 * Le drapeau de l'octet 50 de `0xBA` dit lui aussi quel grain est actif, mais il ne le dit
 * qu'index par index : il faut balayer les six configurations pour trouver celle qui le porte, ce
 * qui coûte six trames et une cinquantaine de secondes avec les reprises. Cette propriété-ci porte
 * la réponse directement, en une seconde.
 *
 * Forme : trame `0xA1 0x0F` du **paramètre 500**, exactement celle du numéro de série (paramètre
 * 205), sauf que la charge utile est une suite de mots de 32 bits gros-boutiens et non du texte.
 *
 *   0      0xD0
 *   1      len = taille totale − 1
 *   2      0xA1
 *   3      0x0F
 *   4..5   identifiant de paramètre, big-endian (500 = 0x01F4)
 *   6..    mots de 32 bits big-endian — dix sur cette machine
 *   −2..   CRC16
 *
 * **Les mots sont les paramètres 500 + rang.** Le mot n porte le paramètre `500 + n` : c'est
 * l'identifiant de l'en-tête qui donne le premier, et la suite est consécutive. L'app le dit
 * elle-même dans son journal (`getParametersFromByte = 502 value 9071`), et c'est ce qui permet de
 * nommer un mot par ce qu'il EST plutôt que par ce qu'on l'a vu faire.
 *
 * **Trois mots sur dix sont établis. Les autres voyagent bruts, et c'est délibéré.**
 *
 * ```
 *   mot 2 = paramètre 502   temps d'écoulement du dernier espresso, en MILLISECONDES
 *   mot 4 = paramètre 504   index du grain sélectionné
 *   mot 5 = paramètre 505   espressos tirés depuis la dernière écriture de profil
 * ```
 *
 * ### Le mot 4 — établi par contraste, le 2026-08-26
 *
 * En changeant le grain sur l'écran de la machine puis en relisant :
 *
 * ```
 * grain 3 « Borbone »  …  00 00 24 54 | 00 00 00 03 | 00 00 00 07 | 0 0 0 0
 * grain 2 « Sakura »   …  00 00 24 54 | 00 00 00 02 | 00 00 00 00 | 0 0 0 0
 *                          mot 3        mot 4 ←       mot 5
 * ```
 *
 * Le mot 4 a suivi la sélection, et rien d'autre n'a bougé hormis le mot 5.
 *
 * ### Les mots 2 et 5 — établis le 2026-08-31, par la SOURCE et non par corrélation
 *
 * Une capture `adb logcat` de l'app officielle pendant un affinage (« Affiner vos paramètres de
 * grains ») donne, sur la trame que ce décodeur reçoit **octet pour octet** :
 *
 * ```
 * readBeanSystemPar  d0 2f a1 0f 01 f4 … 00 00 23 6f … 00 00 00 1f …
 * getParametersFromByte = 502 value 9071      →  BeanAdaptDetailViewModel: FlowTime is 9
 * getParametersFromByte = 505 value 31        →  BeanAdaptDetailViewModel: EspressoCounter is 31
 * ```
 *
 * Un café plus tard : 502 passe à 8627 et l'app affiche `FlowTime is 8` — division ENTIÈRE par
 * 1000, `parameter.b() / 1000` dans `L6/k.java`. Le mot 5 passe de 31 à 32. Après l'écriture du
 * profil affiné, il retombe à **0**.
 *
 * C'est ce qui transforme l'ancienne lecture du mot 5 — « vraisemblablement les tasses tirées,
 * remises à zéro à la sélection » — en fait, et qui en précise la cause : la remise à zéro suit
 * **l'écriture d'un profil**, pas seulement le changement de sélection. Les deux observations sont
 * cohérentes, une écriture et une sélection touchant toutes deux au profil courant.
 *
 * ### Les mots 0, 1, 3, 6 à 9 restent anonymes
 *
 * Une quatrième lecture, une heure plus tard, montre pourquoi. Sur trois relevés, les mots 0 à 3
 * semblaient avoir chacun une direction :
 *
 * ```
 * 07:11  42, 6513, 9312,  9300, 3, 6      le 0 monte, les 1 et 2 descendent,
 * 08:27  44, 6363, 9058,  9300, 3, 7      le 3 ne bouge jamais
 * 08:40  44, 6363, 9058,  9300, 2, 0      ← sélection de « Sakura »
 * 09:36  41, 6630, 9558, 10200, 2, 2      les quatre repartent dans l'AUTRE sens
 * ```
 *
 * Le mot 0 a baissé, les 1 et 2 ont monté, et le mot 3 — le seul qu'on croyait figé — a pris 900.
 * Aucune direction n'est tenable, et trois relevés concordants n'auraient pas suffi à en conclure
 * une : c'est le journal de l'app, et lui seul, qui a fini par nommer le mot 2. Les mots 6 à 9 sont
 * restés nuls sur toutes les lectures. Nommer les autres produirait exactement ce que ce projet
 * cherche à éviter — une valeur plausible et fausse.
 *
 * ⚠️ Ne pas confondre avec le paramètre 3009, qui vaut 3 lui aussi : il n'a **pas** suivi le
 * changement de grain (toujours 3 avec « Sakura » sélectionné). C'était une coïncidence de valeur,
 * et c'est précisément pourquoi cette fonction existe plutôt qu'une lecture de statistique.
 */
export const BEAN_SYNC_PROP = "d260_beansystem_sync_par";
export const BEAN_SYNC_PARAM = 500;
/**
 * Les trois rangs nommés. Le rang EST le décalage du paramètre : `500 + rang`.
 *
 * `BEAN_SYNC_MOT_GRAIN` reste le seul dont la présence est EXIGÉE — il commande l'affichage du
 * grain actif sur toute l'interface. Les deux autres servent l'affinage, qui sait se taire quand
 * la machine ne les donne pas ; les exiger ferait échouer un décodage par ailleurs valide.
 */
const BEAN_SYNC_MOT_ECOULEMENT = 2;
const BEAN_SYNC_MOT_GRAIN = 4;
const BEAN_SYNC_MOT_ESPRESSOS = 5;

export function decodeBeanSync(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) throw new Error(`trame trop courte (${buf.length} octets)`);
  if (buf[2] !== 0xa1) throw new Error(`commande inattendue 0x${buf[2].toString(16)}`);
  const param = (buf[4] << 8) | buf[5];
  if (param !== BEAN_SYNC_PARAM) throw new Error(`paramètre ${param} au lieu de ${BEAN_SYNC_PARAM}`);
  const len = buf[1] + 1;
  const fin = len - 2; // début du CRC
  const charge = fin - 6;
  // Exiger que le mot du grain soit ENTIÈREMENT présent, et pas seulement commencé : une trame
  // tronquée juste après l'en-tête rendrait `selected: undefined`, donc un grain « sélectionné »
  // qu'aucun index ne porte — le genre de valeur qui traverse l'interface sans lever un mot.
  if (charge < 4 * (BEAN_SYNC_MOT_GRAIN + 1)) throw new Error(`charge utile trop courte (${charge} octets)`);
  if (charge % 4 !== 0) throw new Error(`charge utile de ${charge} octets, non multiple de 4`);
  const mots = [];
  for (let i = 6; i + 4 <= fin; i += 4) mots.push(buf.readUInt32BE(i));
  return {
    param,
    selected: mots[BEAN_SYNC_MOT_GRAIN],
    /**
     * Le dernier écoulement mesuré PAR LA MACHINE, en millisecondes — et en secondes tronquées
     * comme l'app le fait (`/ 1000` entier). On garde les deux : les millisecondes sont la valeur
     * reçue, les secondes celle que le questionnaire d'affinage attend. Convertir à l'affichage
     * seulement, c'est se condamner à refaire la troncature à chaque appelant.
     *
     * `null` quand la trame est trop courte pour porter le mot : cette famille de paramètres est
     * dimensionnée par le modèle, et une valeur absente doit se lire « absente », jamais « 0 ».
     */
    ecoulementMs: mots.length > BEAN_SYNC_MOT_ECOULEMENT ? mots[BEAN_SYNC_MOT_ECOULEMENT] : null,
    ecoulementS: mots.length > BEAN_SYNC_MOT_ECOULEMENT ? Math.trunc(mots[BEAN_SYNC_MOT_ECOULEMENT] / 1000) : null,
    /** Espressos tirés depuis la dernière écriture de profil — le verrou de l'affinage. */
    espressos: mots.length > BEAN_SYNC_MOT_ESPRESSOS ? mots[BEAN_SYNC_MOT_ESPRESSOS] : null,
    mots,
    hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim(),
  };
}
