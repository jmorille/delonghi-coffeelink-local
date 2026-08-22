/**
 * Décodage des ARGUMENTS d'une trame ECAM — l'inverse des constructeurs de `server.mjs`.
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
