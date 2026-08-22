/**
 * **Le référentiel des commandes ECAM** : la table des opérations, la lecture d'une trame, et le
 * décodage de ses arguments — l'inverse des constructeurs de `server.mjs`.
 *
 * Une SEULE table, et c'est le propos. `ECAM_OPS` décide à la fois du libellé d'une ligne de
 * journal ET de la façon dont l'ordonnanceur attend la machine (`natureTrame`) ; `TWO` est lue
 * par le constructeur de trames, par le décodeur de recettes et par le décodeur d'arguments.
 * Chacune a vécu en plusieurs exemplaires, et une table de protocole dupliquée diverge au
 * premier ajout **sans lever la moindre erreur** : on obtient des valeurs plausibles et fausses.
 *
 * ⚠️ Ce module TOURNE. Ce n'est pas une des copies `.ts` shadowées : `server.mjs` l'importe.
 *
 * ## Pourquoi il existe
 *
 * `describeFrame()` nomme l'opération (« action · sélection de profil (0xa9) ») et montre les
 * octets. C'est suffisant quand on connaît la trame par cœur, illisible autrement : « préparation
 * d'une boisson » ne dit ni laquelle, ni dans quel profil, ni avec quels réglages. Or c'est
 * exactement la question qu'on se pose devant le journal des applications — **une écriture relayée
 * atteint une vraie cafetière**, et « App a1 · préparation d'une boisson » ne permet pas de
 * distinguer un café lancé d'une recette écrasée.
 *
 * ## Pourquoi il est PUR
 *
 * Même discipline que `tasks.mjs`, `appregistry.mjs` et `monitor.mjs`, et pour la même raison :
 * ce qui décide quelque chose se prouve sans machine. `scripts/verif-args.mjs` le vérifie en CI
 * sur des trames construites par les formules mêmes des constructeurs, dont **une trame réelle
 * relevée sur l'application officielle**. Les deux dépendances qui ne sont pas du protocole — le
 * nom d'une boisson, le nom d'un réglage — sont **injectées**, ce qui évite au module de connaître
 * ni le catalogue d'un modèle, ni les noms tapés sur l'appareil.
 *
 * ## La règle qui prime sur les autres
 *
 * **Ne jamais deviner.** Une commande sans cas ici rend `null`, et la ligne de journal garde ses
 * octets bruts — ce qui est précisément la matière utile. Inventer un argument plausible sur une
 * trame jamais observée produirait une ligne qui a l'air d'un fait.
 */

/**
 * Les paramètres de recette qui tiennent sur **16 bits** : café, lait, seconde eau.
 *
 * Vit ici plutôt que dans `server.mjs` parce que c'est du protocole, et parce que le constructeur
 * (`frameDispense`) et ce décodeur doivent lire la MÊME table — un décalage d'un octet entre les
 * deux ne lèverait aucune erreur, il produirait des valeurs plausibles et fausses.
 */
export const TWO = new Set([1, 9, 15]);

/**
 * @param {Buffer} t     la trame ECAM, **sans** les 4 octets d'horodatage
 * @param {object} o
 * @param {(id:number)=>string} o.boisson  le nom d'une boisson pour ce modèle et cette machine
 * @param {(addr:number)=>string} o.reglage  le nom d'un réglage machine
 * @param {Record<number,{label?:string,unit?:string}>} o.params  la table des paramètres de recette
 * @returns {string|null} les arguments en clair, ou `null` si la commande n'en a pas / est inconnue
 */
export function argumentsTrame(t, { boisson, reglage, params = {} }) {
  if (!t || t.length < 6) return null;
  const cmd = t[2];
  const fin = t.length - 2;                       // premier octet du CRC
  const u16 = (i) => (t[i] << 8) | t[i + 1];

  switch (cmd) {
    // Miroir de `frameDispense`. Octet 4 : la boisson. Octet 5 : le mode, bit 0x80 = vérification.
    // Dernier octet avant le CRC : `(profil << 2) | action`.
    case 0x83: {
      const mode = t[5] & 0x7f, verif = (t[5] & 0x80) !== 0;
      const dernier = t[fin - 1];
      const prof = dernier >> 2, act = dernier & 0x03;
      // Le mode DONTCARE (0) avec l'action SAVE (1) est la seule ÉCRITURE PERSISTANTE de cette
      // commande : elle remplace la recette d'un profil dans l'appareil. La dire en capitales,
      // c'est la seule chose qui la distingue d'un café lancé, à un octet près.
      const quoi = mode === 0 ? (act === 1 ? "ENREGISTRER dans le profil" : "écriture profil")
        : mode === 2 ? "ARRÊTER" : "préparer";
      const ps = [];
      for (let i = 6; i < fin - 1;) {
        const id = t[i++];
        if (i >= fin - 1) break;
        const large = TWO.has(id);
        const v = large ? t[i] * 256 + t[i + 1] : t[i];
        i += large ? 2 : 1;
        const p = params[id];
        // L'unité « niveau » n'est pas une unité, c'est notre mot pour « sans unité » : l'écrire
        // donnerait « Arôme 3 niveau ».
        ps.push(`${p?.label ?? `param ${id}`} ${v}${p?.unit && p.unit !== "niveau" ? ` ${p.unit}` : ""}`);
      }
      return `${quoi} ${boisson(t[4])} · profil ${prof}${verif ? " · vérification" : ""}${ps.length ? ` · ${ps.join(", ")}` : ""}`;
    }
    // Miroir de `frameTurnOn` / `frameTurnOff`. Le rinçage est dit : allumer n'est pas anodin.
    case 0x84:
      return t[4] === 2 ? "ALLUMER (déclenche un rinçage à l'eau chaude)"
        : t[4] === 1 ? "ÉTEINDRE"
          : `octet 4 = ${t[4]}, inconnu`;
    case 0xa9: return `profil ${t[4]}`;
    case 0xa2: return `paramètres ${u16(4)}${t[6] > 1 ? ` … +${t[6] - 1}` : ""}`;     // frameParamRead
    case 0xa6: return `profil ${t[4]} · ${boisson(t[5])}`;                            // frameRecipeQty
    case 0xb0: return `bornes · ${boisson(t[4])}`;
    case 0xb9: return `grain actif ${t[4]}`;                                          // frameSelectBean
    case 0xba: return `grain ${t[4]}`;                                                // frameBeanSystem
    // Miroir de `frameBeanSystemSave` : mouture/température/arôme en 45/46/47, visible en 49.
    // La suppression n'est pas une commande distincte — c'est la même trame à `visible = 0`, ce
    // qui vaut d'être crié plutôt que déduit d'un octet.
    case 0xbb: return t.length >= 52
      ? `grain ${t[4]} · mouture ${t[45]}, température ${t[46]}, arôme ${t[47]}${t[49] ? "" : " · SUPPRESSION (visible = 0)"}`
      : `grain ${t[4]}`;
    case 0x95: return `${reglage(u16(4))}${t[6] > 1 ? ` … +${t[6] - 1}` : ""}`;       // frameParamRead95
    // frameParamWrite. L'octet de poids fort est MULTIPLIÉ, jamais décalé : `0x80 << 24` est
    // négatif en JS, et ce projet a déjà publié un champ de bits signé pour cette raison exacte.
    case 0x90: return `${reglage(u16(4))} ← ${t[6] * 0x1000000 + (t[7] << 16) + (t[8] << 8) + t[9]}`;
    // 0xA3, 0x75, 0x60, 0x70 n'ont pas d'argument. Le reste : on ne devine pas.
    default: return null;
  }
}

/**
 * **La table des opérations, par octet de commande.** `nature` est le VERBE, `nom` l'objet : les
 * deux se lisent à la suite (« lecture · monitor »). Les mettre tous les deux au complet donnait
 * « lecture lecture d'un profil de grains ».
 *
 * La nature — lecture, action ou écriture — est ce qui compte le plus quand on cherche pourquoi
 * une machine a fait quelque chose : une lecture n'a aucun effet physique, une action en a un.
 * Elle ne sert d'ailleurs pas qu'au libellé : c'est elle qui décide si un pas de la file attend
 * une réponse ou seulement une fenêtre de présence (voir `startProgram`).
 *
 * ⚠️ **Ce qui n'est pas dans cette table est une découverte, pas une erreur.** L'application
 * officielle est le seul émetteur au monde à produire des trames que nous n'avons jamais vues,
 * et elle ne les rejoue pas : une commande absente d'ici doit se voir dans le journal, en
 * capitales et avec ses octets, plutôt que de se fondre dans les autres lignes.
 */
export const ECAM_OPS = {
  0x75: { nature: "lecture", nom: "monitor" },
  // 0x83 est affiné par son octet de mode : voir `opTrame`. La distinction compte — le même octet
  // de commande sert à préparer une boisson, à arrêter, et à ÉCRIRE une recette dans un profil.
  0x83: { nature: "action", nom: "recette" },
  0x84: { nature: "action", nom: "marche / arrêt" },
  0xa2: { nature: "lecture", nom: "paramètres et compteurs" },
  0xa3: { nature: "lecture", nom: "sommes de contrôle" },
  0xa4: { nature: "lecture", nom: "noms de profils" },
  0xa6: { nature: "lecture", nom: "recette d'un profil" },
  0xa8: { nature: "lecture", nom: "ordre des favoris" },
  0xa9: { nature: "action", nom: "sélection de profil" },
  0xaa: { nature: "lecture", nom: "noms de recettes perso" },
  0xb0: { nature: "lecture", nom: "bornes d'une recette" },
  0xb9: { nature: "action", nom: "sélection du grain actif" },
  0xba: { nature: "lecture", nom: "profil de grains" },
  // Les écritures persistantes de cette table, et c'est ce qu'il faut voir d'un coup d'œil.
  0xbb: { nature: "écriture", nom: "profil de grains" },
  0x90: { nature: "écriture", nom: "réglage machine" },
  0xa5: { nature: "écriture", nom: "noms de profils" },
  0xab: { nature: "écriture", nom: "noms de recettes perso" },
  0xad: { nature: "écriture", nom: "ordre des favoris" },
  // `0x95` lit un réglage machine — pendant exact de l'écriture `0x90`.
  0x95: { nature: "lecture", nom: "réglage machine" },
  // Les deux autres modes de monitor. Nature « lecture » : ils attendent une réponse, comme 0x75.
  0x60: { nature: "lecture", nom: "monitor mode 0" },
  0x70: { nature: "lecture", nom: "monitor mode 1" },
  // `0xA1` n'a pas de décodeur d'arguments : la valeur se lit positionnellement (numéro de série).
  0xa1: { nature: "lecture", nom: "numéro de série" },
};

/** L'octet de commande en hexadécimal à deux chiffres, tel qu'il s'écrit dans `doc/`. */
export const hexCmd = (c) => `0x${Number(c ?? 0).toString(16).padStart(2, "0")}`;

/**
 * L'opération que porte une trame SORTANTE — le journal, pour la nommer, et l'ordonnanceur, pour
 * savoir si la machine RÉPONDRA.
 *
 * ⚠️ `ecamB64` porte la trame **suivie de 4 octets d'horodatage** (voir `datapointValue`) : on
 * les retire, sinon le journal afficherait quatre octets qui n'appartiennent pas à la commande.
 * C'est vrai de ce que NOUS envoyons ; une réponse de la machine n'en porte pas — voir
 * `chargeBrute`, qui ne retire rien parce qu'elle sert à regarder ce qu'on ne comprend pas encore.
 */
/**
 * **Les octets ECAM d'une valeur, ou `null` si ce n'en est pas.**
 *
 * ⚠️ `Buffer.from(x, "base64")` ne lève JAMAIS : il ignore ce qui n'est pas du base64 et rend des
 * octets d'allure plausible. Sans ce filtre, n'importe quelle valeur ressort avec un « octet de
 * commande » inventé — ce qui, dans un journal qui sert à décider si une vraie cafetière vient de
 * couler un café ou d'écraser une recette, est le pire résultat possible. Le défaut a déjà été
 * corrigé dans le sens ENTRANT (`opReponse`) après avoir vu `device_connected = 1787407876`,
 * un horodatage unix, journalisé « commande 0x3b non décodée ».
 *
 * `0x0D` en requête, `0xD0` en réponse : hors de ces deux en-têtes, ce ne sont pas des octets
 * ECAM. Les deux sens partagent donc ce filtre, plutôt que d'en avoir chacun une copie qui
 * divergerait au premier ajout.
 */
export function octetsEcam(valeur) {
  const v = String(valeur ?? "");
  if (!v || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  if (buf.length < 4 || (buf[0] !== 0x0d && buf[0] !== 0xd0)) return null;
  return buf;
}

export function opTrame(ecamB64) {
  const buf = octetsEcam(ecamB64);
  // Une valeur qui n'est pas une trame le DIT, au lieu de se voir attribuer une commande. Elle
  // garde ses octets tels quels — c'est elle, justement, qu'on voudra examiner.
  if (!buf) return { cmd: null, op: null, trame: Buffer.from(String(ecamB64 ?? ""), "base64"), nonTrame: true };
  const trame = buf.subarray(0, Math.max(0, buf.length - 4));
  const cmd = trame[2];
  // `0x83` : l'octet 5 porte le mode, et c'est lui qui dit ce que la commande fait vraiment.
  // Le bit 0x80 est le drapeau « vérification » (`check`), il ne change pas la nature.
  if (cmd === 0x83) {
    const mode = trame[5] & 0x7f;
    const op =
      mode === 0x00
        ? { nature: "écriture", nom: "recette enregistrée dans un profil" }
        : mode === 0x02
          ? { nature: "action", nom: "arrêt de la préparation" }
          : { nature: "action", nom: "préparation d'une boisson" };
    return { cmd, op, trame };
  }
  return { cmd, op: ECAM_OPS[cmd], trame };
}

/**
 * « lecture », « action » ou « écriture ». Décide si le pas attend une réponse ou seulement une
 * fenêtre de présence — voir `startProgram`. Une trame illisible est traitée comme une action :
 * c'est le choix prudent, il fait tenir la présence au lieu d'attendre une réponse qui ne
 * viendra peut-être jamais.
 */
export function natureTrame(ecamB64) {
  try { return opTrame(ecamB64).op?.nature ?? "action"; } catch { return "action"; }
}

/**
 * L'opération et les octets, sans les arguments — voir `decrireCommande` côté serveur, qui
 * insère ces derniers. `octets: false` rend la forme courte, pour un libellé de tâche : le
 * panneau « Activité » nomme ce qui part vers la machine, il n'est pas un dumper d'octets.
 *
 * Une commande absente de la table se dit **NON IDENTIFIÉE**, en capitales et avec ses octets.
 * C'est délibéré : c'est le matériau de la rétro-ingénierie, et une ligne discrète se perd.
 */
export function describeFrame(ecamB64, { octets = true } = {}) {
  try {
    const { cmd, op, trame, nonTrame } = opTrame(ecamB64);
    // ⚠️ **Ni commande, ni octets à rogner : on ne sait pas ce que c'est.** Relevé en direct sur
    // l'application officielle — `commande NON IDENTIFIÉE (0x37) · trame 45 da 37 88 …`, alors
    // qu'une trame ECAM commence par `0x0D` et que celle-ci commençait par `0x45`. Nommer un
    // octet de commande là-dedans fabriquait une découverte qui n'existe pas, et masquait la
    // vraie information : cette valeur n'est pas une trame. Les 4 derniers octets sont conservés
    // (ce ne sont des horodatages que dans une trame), et le base64 est joint parce que c'est ce
    // qui se recolle dans un test — c'est une valeur qu'on relaie à une VRAIE cafetière.
    if (nonTrame) {
      const brut = trame.toString("hex").replace(/(..)/g, "$1 ").trim();
      return `valeur non-trame · ${brut || "(vide)"} · b64 ${String(ecamB64 ?? "").slice(0, 64)}`;
    }
    const nom = op ? `${op.nature} · ${op.nom}` : "commande NON IDENTIFIÉE";
    // Une commande inconnue garde ses octets même en forme courte : sans eux la ligne ne dit
    // rien du tout, alors que c'est justement celle qu'on veut pouvoir analyser.
    if (!octets && op) return `${nom} (${hexCmd(cmd)})`;
    const hex = trame.toString("hex").replace(/(..)/g, "$1 ").trim();
    return `${nom} (${hexCmd(cmd)}) · trame ${hex}`;
  } catch {
    return "trame illisible";
  }
}

/**
 * Le profil que vise une trame, ou `null` si elle n'en vise aucun.
 *
 * Existe pour le multiplexeur, et pour une raison concrète : la **toute première** commande qu'une
 * application officielle nous a relayée était `0D 06 A9 F0 01 …` — une sélection de profil. L'app
 * impose son profil courant à l'appareil dès l'ouverture de session, et ce profil vient d'une
 * préférence stockée dans le téléphone, avec 1 par défaut. Sans cette lecture, une application qui
 * se branche déplace le profil actif de la machine **et notre interface continue d'annoncer
 * l'ancien** — exactement ce que la règle « toute commande qui vise un profil doit poser
 * `m.activeProfile` » existe pour empêcher.
 *
 * Deux dispositions, relevées dans les constructeurs de trames de `server.mjs` :
 * - `0xA9` : `0D 06 A9 F0 <profil> <crc>` — le profil est en clair à l'octet 4 ;
 * - `0x83` : le profil est encodé `(profil << 2) | action` dans le dernier octet avant le CRC.
 */
export function profilVise(ecamB64) {
  try {
    const { cmd, trame } = opTrame(ecamB64);
    if (cmd === 0xa9) return trame[4] ?? null;
    if (cmd === 0x83) return (trame[trame.length - 3] ?? 0) >> 2;
  } catch { /* trame illisible : aucun profil à en tirer */ }
  return null;
}

/**
 * **La clé de fusion d'une trame, ou `null` quand il n'y en a pas.**
 *
 * Deux tâches de même `cle` encore en attente n'en font qu'une (`enfiler` dans `tasks.mjs`).
 * Encore faut-il qu'une clé existe — et **l'absence de clé est une décision, pas un oubli** :
 * demander deux cafés n'est pas demander un café, donc une préparation garde sa ligne. C'est
 * la frontière que `cle` trace déjà partout ailleurs dans ce serveur.
 *
 * On ne fusionne donc que ce dont la répétition est **démontrablement** sans effet :
 *
 * - `0xA9` **sélection de profil** — une affirmation d'état. Réaffirmer le même profil est
 *   idempotent, ce que `server.mjs` dit déjà par ailleurs en réservant `sustain: "profile"` à
 *   ce cas précis. C'est le défaut constaté en usage réel : une application officielle impose
 *   son profil à chaque ouverture de session, et six « sélection de profil · profil 1 »
 *   identiques s'empilaient dans la file, chacune allant redire à la machine ce que la
 *   précédente venait de lui dire.
 * - une **lecture** — demander deux fois la même chose, c'est la demander une fois. La nature
 *   vient d'`ECAM_OPS`, donc aucun appelant n'en décide et il n'y a pas de seconde table.
 *
 * Tout le reste rend `null` : une action, une écriture, et **surtout** une commande absente de
 * la table. Une trame qu'on ne sait pas nommer est une trame dont on ignore l'effet ; la
 * fusionner reviendrait à supprimer une commande sur une supposition.
 *
 * ⚠️ Deux limites à connaître. `0x75` rend `"presence"` — le nom que la file emploie déjà
 * partout pour cette lecture-là — mais les autres lectures nommées côté serveur
 * (`checksums`, `bean:n`, `reglages95:…`) gardent leur clé propre : une même lecture demandée
 * par une application et par une page fera donc deux tâches, comme aujourd'hui. Et la fusion
 * ne prend jamais la tâche **en cours**, seulement celles en attente : le pire cas est deux
 * exemplaires, pas N.
 */
export function cleFusion(ecamB64) {
  try {
    const { cmd, op, trame } = opTrame(ecamB64);
    if (!op) return null;
    if (cmd === 0xa9) return `profil:${trame[4] ?? "?"}`;
    if (cmd === 0x75) return "presence";
    if (op.nature === "lecture") return `lecture:${trame.toString("hex")}`;
    return null;
  } catch { return null; }
}

/**
 * **L'opération que porte une trame ENTRANTE** — une réponse de la machine, ou la valeur d'une
 * propriété Ayla rediffusée à une application.
 *
 * Distincte d'`opTrame` sur deux points qui comptent : rien n'est retiré (une réponse ne porte
 * pas les 4 octets d'horodatage que NOUS ajoutons), et la valeur est d'abord **testée** avant
 * d'être décodée. `Buffer.from(x, "base64")` ne lève jamais : il ignore silencieusement ce qui
 * n'en est pas et rend des octets qui ont l'air de quelque chose — c'est ainsi que
 * `device_connected = 1787407876`, un horodatage unix en clair, s'est affiché « d7 bf 3b e3 ».
 *
 * Rend `null` quand la valeur n'est pas une trame ; sinon `{ cmd, op, trame }`, `op` valant
 * `undefined` pour une commande que la table ne connaît pas — ce qui est une découverte, pas une
 * erreur, et doit se voir.
 */
export function opReponse(valeur) {
  const trame = octetsEcam(valeur);
  if (!trame) return null;
  return { cmd: trame[2], op: ECAM_OPS[trame[2]], trame };
}
