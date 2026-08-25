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
