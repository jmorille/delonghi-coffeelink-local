/**
 * Vérifie le décodage d'une photo de grain **venue du cloud** : reniflage du type et garde-fous.
 *
 * L'application officielle range la photo d'un grain dans un datum Ayla `BS<n>IMG`, dont la valeur
 * est du **base64 nu** — aucun type ne l'accompagne. `decoderBase64Nu` doit donc établir le type à
 * partir des octets eux-mêmes, et c'est exactement le genre de pièce que ce dépôt éprouve : elle
 * est pure, et son erreur est MUETTE.
 *
 * **Ce qu'une erreur ici produirait.** Pas une exception, pas une page blanche : un `mime` plausible
 * et faux rangé en base, puis un `<img>` que le navigateur refuse d'afficher — un cadre vide, sans
 * message, sur une carte par ailleurs normale. Et à l'inverse, un refus trop strict rejetterait la
 * photo légitime de l'utilisateur en la faisant passer pour un défaut de notre côté.
 *
 * **Le piège que ce script existe pour tenir.** WebP commence par `RIFF` — comme un WAV, un AVI et
 * quelques autres. Ne comparer que ces quatre octets accepterait donc un son comme une image. Le
 * contrôle porte sur `RIFF` **et** sur `WEBP` en position 8, et c'est le cas `riffPasWebp`
 * ci-dessous qui le prouve : sans la seconde moitié, il passerait au vert.
 *
 * Aucune dépendance : `node scripts/verif-datum-grains.mjs`.
 */
import { decoderBase64Nu, typeParOctets, TAILLE_MAX, TYPES_IMAGE } from "../src/lib/image-grains.mjs";

let ko = 0;
const ok = (quoi, detail = "") => console.log(`  ✓ ${quoi}${detail ? `  ${detail}` : ""}`);
const echec = (quoi, detail) => { console.log(`  ✗ ${quoi}\n      ${detail}`); ko++; };

/**
 * Base64 d'un tableau d'octets, sans dépendance et sans `Buffer` — le module éprouvé est isomorphe,
 * son banc le reste.
 *
 * **Par tranches, et ce n'est pas une précaution en l'air** : `String.fromCharCode(...octets)`
 * étale le tableau en arguments, et le cas du plafond en compte 512 Ki + 1. Écrit en une ligne, ce
 * banc mourait donc d'un `RangeError: Maximum call stack size exceeded` sur son propre outillage —
 * pas sur ce qu'il mesure.
 */
function b64(octets) {
  let s = "";
  for (let i = 0; i < octets.length; i += 8192) {
    s += String.fromCharCode(...octets.slice(i, i + 8192));
  }
  return btoa(s);
}

/** Complète un en-tête jusqu'à `taille` : le reniflage ne lit que le début, le reste est du lest. */
const avecLest = (entete, taille = 64) => [...entete, ...new Array(Math.max(0, taille - entete.length)).fill(0)];

/* Les en-têtes réels des trois types acceptés. Ce ne sont pas des images valides — la fonction
   éprouvée ne prétend pas les décoder, seulement les IDENTIFIER — mais leurs premiers octets sont
   ceux que produisent un encodeur JPEG, un PNG et un WebP. */
const JPEG = avecLest([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = avecLest([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = avecLest([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
/* `RIFF` sans `WEBP` : un WAV. C'est le faux positif que le contrôle en deux morceaux écarte. */
const RIFF_PAS_WEBP = avecLest([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);

/* ── 1. Les trois types se reconnaissent à leurs octets ────────────────────────────────────── */
for (const [nom, octets, attendu] of [
  ["JPEG", JPEG, "image/jpeg"],
  ["PNG", PNG, "image/png"],
  ["WebP", WEBP, "image/webp"],
]) {
  const trouve = typeParOctets(new Uint8Array(octets));
  if (trouve !== attendu) echec(`${nom} se reconnaît à ses octets`, `rendu ${JSON.stringify(trouve)}, attendu ${attendu}`);
  else ok(`${nom} se reconnaît à ses octets`, attendu);
}

/* ── 2. `RIFF` seul ne suffit PAS ──────────────────────────────────────────────────────────────
   Le contrôle du dépôt : quatre octets communs à plusieurs conteneurs ne désignent pas un type. */
{
  const trouve = typeParOctets(new Uint8Array(RIFF_PAS_WEBP));
  if (trouve !== null) {
    echec(
      "un conteneur RIFF qui n'est pas du WebP est refusé",
      `rendu ${JSON.stringify(trouve)} pour un en-tête WAVE — le contrôle ne regarde donc que ` +
        "`RIFF` et accepterait un son comme une image.",
    );
  } else {
    ok("un conteneur RIFF qui n'est pas du WebP est refusé");
  }
}

/* ── 3. Un décodage complet rend le type ET les octets ─────────────────────────────────────── */
{
  const r = decoderBase64Nu(b64(JPEG));
  if (r.mime !== "image/jpeg") echec("le décodage rend le type", `rendu ${r.mime}`);
  else if (r.bytes.length !== JPEG.length) echec("le décodage rend tous les octets", `${r.bytes.length} au lieu de ${JPEG.length}`);
  else if (r.bytes[0] !== 0xff || r.bytes[1] !== 0xd8) echec("le décodage rend les BONS octets", "le début ne correspond pas");
  else ok("le décodage rend le type et les octets", `image/jpeg, ${r.bytes.length} octets`);
}

/* ── 4. La base64 d'Android arrive avec des sauts de ligne ─────────────────────────────────────
   `Base64.encodeToString(bytes, 0)` — le drapeau que l'app emploie — insère un saut tous les 76
   caractères. `atob` les refuse, donc les ignorer n'est pas une tolérance : c'est la forme NORMALE
   de la donnée qu'on vient chercher. Sans ce nettoyage, l'import échouerait sur toute photo
   dépassant 57 octets, c'est-à-dire sur toutes. */
{
  const brut = b64(PNG);
  const decoupe = brut.replace(/(.{20})/g, "$1\n");
  try {
    const r = decoderBase64Nu(decoupe);
    if (r.mime !== "image/png") echec("une base64 en lignes se décode", `rendu ${r.mime}`);
    else ok("une base64 en lignes se décode", `${decoupe.split("\n").length} lignes`);
  } catch (e) {
    echec("une base64 en lignes se décode", `refusée : ${e.message}`);
  }
}

/* ── 5. Ce qui doit être refusé l'est, et le message le dit ────────────────────────────────── */
const refus = [
  ["une valeur absente", undefined, /absente/i],
  ["une chaîne vide", "", /absente/i],
  ["une base64 invalide", "!!!pas du base64!!!", /base64/i],
  ["des octets qui ne sont pas une image", b64(avecLest([0x68, 0x65, 0x6c, 0x6c, 0x6f])), /pas une image/i],
  ["un conteneur RIFF non WebP", b64(RIFF_PAS_WEBP), /pas une image/i],
  /* Le plafond, éprouvé au-delà d'un octet : c'est lui qui empêche un datum de remplir la base. */
  ["une image trop lourde", b64(avecLest(JPEG, TAILLE_MAX + 1)), /trop lourde/i],
];
for (const [quoi, valeur, motif] of refus) {
  let leve = null;
  try {
    decoderBase64Nu(valeur);
  } catch (e) {
    leve = e.message;
  }
  if (leve === null) echec(`${quoi} est refusée`, "acceptée sans un mot — des octets douteux entreraient dans la base");
  else if (!motif.test(leve)) echec(`${quoi} est refusée avec un message qui l'explique`, `message : « ${leve} »`);
  else ok(`${quoi} est refusée`, `« ${leve.slice(0, 58)}${leve.length > 58 ? "…" : ""} »`);
}

/* ── 6. Les types annoncés sont ceux qu'on sait reconnaître ────────────────────────────────────
   `TYPES_IMAGE` est la liste que le serveur accepte et que les messages d'erreur citent ; le
   reniflage est ce qui la met en œuvre. Si l'une gagne un type que l'autre ignore, un envoi
   légitime serait refusé en citant ce type-là dans le message — un refus qui se contredit. */
{
  const reconnus = [JPEG, PNG, WEBP].map((o) => typeParOctets(new Uint8Array(o)));
  const manquants = TYPES_IMAGE.filter((t) => !reconnus.includes(t));
  if (manquants.length) {
    echec(
      "chaque type annoncé est reconnaissable aux octets",
      `${manquants.join(", ")} figure(nt) dans TYPES_IMAGE mais aucun en-tête connu ne le(s) rend.`,
    );
  } else {
    ok("chaque type annoncé est reconnaissable aux octets", TYPES_IMAGE.join(", "));
  }
}

console.log(
  ko
    ? `\n${ko} problème(s) dans le décodage des photos de grains du cloud.\n`
    : "\nDécodage des photos de grains du cloud vérifié.\n",
);
process.exit(ko ? 1 : 0);
