/**
 * L'image d'une configuration de grains — **format, décodage et garde-fous**, en un seul endroit.
 *
 * Pur, sans dépendance, **et lisible par un navigateur** : ni `Buffer`, ni `node:*`. C'est la
 * raison d'être du module et pas un choix de style — la page `/beans` doit produire exactement le
 * format que le serveur accepte, et deux déclarations de « 300 × 340 » divergeraient au premier
 * ajustement. Même discipline que `trame-bornes.mjs`.
 *
 * ## Pourquoi ce format-là
 *
 * `300 × 340` en WebP est le **format commun du dépôt** : c'est celui des 58 vignettes de boissons
 * extraites de l'APK (`drawable-xhdpi`, rapport 15:17, canal alpha, ~20 kio pièce). Une photo de
 * paquet posée dans la même grille que ces vignettes n'y introduit donc pas un second rapport de
 * forme.
 *
 * ⚠️ **Ce n'est délibérément PAS le format de l'application officielle**, qui a été mesuré et qui
 * a trois défauts qu'on ne reproduit pas (`doc/bean-adapt.md` § images) : JPEG qualité 35, taille
 * de sortie non bornée (moitié de la largeur source, donc ~2000 × 1200 pour une photo de 12 Mpx),
 * et un rapport recadré en 3:2 mais stocké en 5:3 — soit 10 % d'écrasement vertical systématique.
 * L'image y vit d'ailleurs dans un datum Ayla (`BS<id>IMG`), donc dans le cloud, là où la nôtre
 * reste locale.
 *
 * ## Ce que le serveur accepte
 *
 * Le navigateur produit du WebP, mais les trois types sont acceptés : refuser une image déjà au
 * bon format parce qu'elle est en PNG ferait échouer un cas que rien ne rend dangereux. Ce qui est
 * refusé, c'est ce qui n'est pas une image, et ce qui est trop gros — le plafond existe parce que
 * l'octet vient du réseau et finit dans la base.
 */

/**
 * **Les quatre niveaux de torréfaction**, et pourquoi ils vivent dans ce module-ci.
 *
 * Un niveau de torréfaction n'est pas un réglage : la machine ne le connaît pas, ne le mémorise
 * pas, et aucune trame ne le transporte. Il ne sert qu'à une chose — DÉSIGNER UN VISUEL, celui que
 * l'application officielle associe à la réponse « torréfaction » de son questionnaire. C'est donc
 * l'identité d'une image, et sa place est ici, à côté du format de celle qu'on cadre soi-même.
 *
 * ⚠️ **Pas dans `bean-adapt.mjs`**, malgré la parenté apparente : la règle d'ajustement ne lit
 * jamais la torréfaction (elle lit l'écoulement, la crema, le goût). L'y ranger ferait croire à un
 * paramètre du calcul, et le premier à le lire chercherait longtemps où il intervient.
 *
 * Une seule déclaration, lue des deux côtés : `server.mjs` pour valider ce qui entre,
 * `VignetteGrains.tsx` pour dessiner le rail. Deux listes finiraient par autoriser un niveau que
 * la table d'images ne nomme pas — donc une fiche enregistrée sans visuel, et sans erreur.
 */
export const TORREFACTIONS = Object.freeze([1, 2, 3, 4]);

/**
 * `true` si `v` est un niveau acceptable — **`null` compris** : « non précisée » est une valeur,
 * pas une absence de réponse, et c'est le seul moyen de retirer un niveau posé par erreur.
 *
 * Strict sur le type : `"3"` est refusé. Un JSON qui envoie une chaîne serait rangé tel quel, et
 * la table d'images, elle, est indexée par nombre — le visuel disparaîtrait sans rien dire.
 */
export function torrefactionValide(v) {
  return v === null || (typeof v === "number" && TORREFACTIONS.includes(v));
}

/** Le format produit par l'interface. `qualite` ne concerne que l'encodage côté navigateur. */
export const FORMAT_IMAGE = Object.freeze({
  largeur: 300,
  hauteur: 340,
  mime: "image/webp",
  qualite: 0.82,
});

/** Le rapport du cadre de recadrage. Dérivé du format : une seule déclaration décide des deux. */
export const RAPPORT_IMAGE = FORMAT_IMAGE.largeur / FORMAT_IMAGE.hauteur;

/** Types acceptés à l'enregistrement. Voir l'en-tête : on refuse le non-image, pas le PNG. */
export const TYPES_IMAGE = Object.freeze(["image/webp", "image/jpeg", "image/png"]);

/**
 * Plafond en octets **décodés**. Un WebP 300 × 340 pèse une vingtaine de kio ; 512 kio laisse donc
 * une marge d'un facteur vingt tout en fermant la porte à un envoi qui remplirait la base.
 */
export const TAILLE_MAX = 512 * 1024;

/**
 * Décode une data URL en octets, ou explique pourquoi elle est refusée.
 *
 * Rend `{ mime, bytes }`. **Lève** une `Error` dont le message est destiné à l'utilisateur : le
 * serveur le renvoie tel quel en 400, plutôt qu'un « requête invalide » qui n'apprend rien.
 *
 * `atob` plutôt que `Buffer` : c'est ce qui garde le module lisible des deux côtés. Il refuse une
 * base64 malformée en levant, ce qui est le comportement voulu — `Buffer.from(x, "base64")`, lui,
 * ignore silencieusement ce qu'il ne comprend pas et rend des octets plausibles, exactement le
 * piège que ce dépôt a déjà payé deux fois ailleurs.
 */
/**
 * Les octets magiques des trois types acceptés, et **pourquoi on les renifle**.
 *
 * Une data URL déclare son type ; un datum Ayla, non — sa valeur est du base64 nu. Il faut donc
 * établir le type à partir du contenu, et c'est de toute façon la seule façon honnête de le faire :
 * un type déclaré est précisément ce qu'on cherche à vérifier. Même règle que le contrôle du
 * magique PNG dans `scripts/import-bean-images.mjs`.
 *
 * Trois familles, dans l'ordre où on les rencontre : l'app officielle écrit du JPEG, le navigateur
 * du WebP, et le PNG traîne partout.
 */
const MAGIQUES = Object.freeze([
  { mime: "image/jpeg", octets: [0xff, 0xd8, 0xff] },
  { mime: "image/png", octets: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  /* WebP : `RIFF` puis quatre octets de taille — qu'on saute — puis `WEBP`. Ne comparer que
     `RIFF` confondrait un WAV avec une image. */
  { mime: "image/webp", octets: [0x52, 0x49, 0x46, 0x46], suite: { position: 8, octets: [0x57, 0x45, 0x42, 0x50] } },
]);

/** `true` si `bytes` commence par `octets` à partir de `position`. */
function commencePar(bytes, octets, position = 0) {
  if (bytes.length < position + octets.length) return false;
  for (let i = 0; i < octets.length; i++) if (bytes[position + i] !== octets[i]) return false;
  return true;
}

/**
 * Le type d'une image d'après ses octets, ou `null` si aucun des trois ne correspond.
 *
 * Exporté pour être éprouvé seul : c'est la pièce dont une erreur ne lèverait rien — elle rendrait
 * un type plausible et faux, et le navigateur afficherait un cadre vide sans message.
 */
export function typeParOctets(bytes) {
  for (const m of MAGIQUES) {
    if (!commencePar(bytes, m.octets)) continue;
    if (m.suite && !commencePar(bytes, m.suite.octets, m.suite.position)) continue;
    return m.mime;
  }
  return null;
}

/**
 * Décode une base64 **nue** — sans préfixe `data:` — en `{ mime, bytes }`.
 *
 * C'est la forme dans laquelle l'application officielle range la photo d'un grain : un datum Ayla
 * `BS<n>IMG`, dont la valeur est le base64 d'un JPEG, et rien de plus. Aucun type ne l'accompagne,
 * d'où le reniflage.
 *
 * ⚠️ **Ce que ces octets ne sont PAS.** `FORMAT_IMAGE` décrit ce que NOTRE interface produit —
 * 300 × 340, WebP. Une image importée du cloud n'a ni cette taille ni ce rapport : l'app recadre en
 * 3:2 et stocke en 5:3 (donc 10 % d'écrasement vertical), en JPEG qualité 35, à une taille non
 * bornée. Cette fonction ne corrige rien de tout cela et ne le prétend pas — il n'y a pas
 * d'encodeur ici, et « corriger » l'écrasement supposerait que toute image reçue vienne de cette
 * app. Le format commun cesse donc d'être une garantie sur le contenu de la table, et c'est
 * l'interface qui doit le dire là où une image importée s'affiche.
 *
 * Lève une `Error` dont le message est destiné à l'utilisateur, comme `decoderDataUrl`.
 */
export function decoderBase64Nu(b64) {
  if (typeof b64 !== "string" || b64.trim() === "") throw new Error("image absente");
  let binaire;
  try {
    // Les sauts de ligne sont la norme dans une base64 écrite par Android (`Base64.encodeToString`
    // sans `NO_WRAP` en insère tous les 76 caractères) et `atob` les refuse.
    binaire = atob(b64.replace(/\s+/g, ""));
  } catch {
    throw new Error("image illisible : base64 invalide");
  }
  if (binaire.length === 0) throw new Error("image vide");
  if (binaire.length > TAILLE_MAX) {
    throw new Error(`image trop lourde (${Math.round(binaire.length / 1024)} kio, maximum ${TAILLE_MAX / 1024} kio)`);
  }
  const bytes = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) bytes[i] = binaire.charCodeAt(i);
  const mime = typeParOctets(bytes);
  if (!mime) {
    throw new Error(`ces octets ne sont pas une image reconnue (attendu ${TYPES_IMAGE.join(", ")})`);
  }
  return { mime, bytes };
}

export function decoderDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("image absente");
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!m) throw new Error("image illisible : une data URL base64 est attendue");
  const mime = m[1].toLowerCase();
  if (!TYPES_IMAGE.includes(mime)) {
    throw new Error(`type d'image refusé (${mime}) — attendu ${TYPES_IMAGE.join(", ")}`);
  }
  let binaire;
  try {
    binaire = atob(m[2]);
  } catch {
    throw new Error("image illisible : base64 invalide");
  }
  if (binaire.length === 0) throw new Error("image vide");
  if (binaire.length > TAILLE_MAX) {
    throw new Error(`image trop lourde (${Math.round(binaire.length / 1024)} kio, maximum ${TAILLE_MAX / 1024} kio)`);
  }
  const bytes = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) bytes[i] = binaire.charCodeAt(i);
  return { mime, bytes };
}
