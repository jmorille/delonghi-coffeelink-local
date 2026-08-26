/**
 * Vérifie les contrastes du monde visuel, EN LISANT `src/app/globals.css`.
 *
 * ── Pourquoi ce script existe ────────────────────────────────────────────────────────────────
 *
 * Les contrastes de ce produit ont toujours été calculés plutôt qu'estimés, et ils étaient écrits
 * dans un commentaire d'en-tête. Une revue a montré les deux façons dont ça casse :
 *
 * 1. **La table était juste et incomplète.** Chaque encre y était mesurée contre le boîtier — et
 *    presque aucun texte ne vit sur le boîtier : il vit sur une plaque, dans un puits, ou sur le
 *    relief de la carte machine. Mesurés contre les quatre surfaces, trois couples tombaient sous
 *    le seuil, un par finition, donc invisibles à qui ne regarde que la sienne.
 * 2. **Une table écrite à la main dérive.** Changer une rampe ne met pas à jour un commentaire.
 *
 * Ce script lit les valeurs réellement livrées et refait tous les calculs. C'est le même motif que
 * `verif-args.mjs` (les décalages d'octets) et `verif-messages.mjs` (les clés de traduction) : il
 * attrape l'erreur silencieuse — celle qui ne lève rien et produit un résultat plausible et faux.
 *
 * ── Deux métriques, et il faut les deux ──────────────────────────────────────────────────────
 *
 * - **WCAG** pour ce qui doit être IDENTIFIÉ (une encre sur son fond, l'arête d'une commande).
 * - **ΔL\*** (CIE Lab) pour ce qui doit être DISTINGUÉ (une plaque sur son boîtier, un biseau, un
 *   perçage). Un rapport WCAG s'écrase aux deux bouts de l'échelle : deux gris clairs parfaitement
 *   distincts affichent 1,05:1, et aucun noir n'atteint 1,5:1 contre le graphite. Sur une surface,
 *   il ment dans les deux sens.
 *
 * Usage : node scripts/verif-contraste.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(racine, "src/app/globals.css"), "utf8");

/* ── Lecture des rampes ──────────────────────────────────────────────────────────────────────
   On ne lit que les rampes BRUTES (`--gr-*`, `--al-*`). Les rôles sont des indirections vers
   elles ; les tester reviendrait à tester `var()`, pas des couleurs. */
function rampe(prefixe) {
  const out = {};
  const re = new RegExp(`--${prefixe}-([a-z-]+):\\s*(#[0-9a-fA-F]{6})\\s*;`, "g");
  let m;
  while ((m = re.exec(css))) out[m[1]] = m[2].toLowerCase();
  return out;
}
const gr = rampe("gr");
const al = rampe("al");

/* Le relief de la carte machine est un `color-mix` déclaré dans surfaces.css : on lit le
   pourcentage là-bas plutôt que de le recopier, sinon ce script devient la prochaine table qui
   dérive. */
const surfaces = readFileSync(join(racine, "src/app/surfaces.css"), "utf8");
const mRaise = surfaces.match(/--raise:\s*color-mix\(in srgb, var\(--releve\) (\d+)%/);
if (!mRaise) throw new Error("--raise introuvable dans surfaces.css");
const PART_RELEVE = Number(mRaise[1]);

/* ── Colorimétrie ────────────────────────────────────────────────────────────────────────────
   sRGB → luminance relative (WCAG 2.x) puis → L* (CIE Lab, illuminant de référence D65 avec
   Yn = 1, ce qui est le cas puisque la luminance relative est déjà normalisée). */
const canaux = (hex) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const versLineaire = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, v, b] = canaux(hex).map(versLineaire);
  return 0.2126 * r + 0.7152 * v + 0.0722 * b;
};
const rapport = (a, b) => {
  const [haut, bas] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (haut + 0.05) / (bas + 0.05);
};
const clarte = (hex) => {
  const y = luminance(hex);
  return 116 * (y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116) - 16;
};
/** Le `color-mix(in srgb, …)` du navigateur : une interpolation linéaire des canaux sRGB. */
const melange = (a, b, part) => {
  const [A, B] = [canaux(a), canaux(b)];
  return (
    "#" +
    A.map((v, i) => Math.round((v * part + B[i] * (100 - part)) / 100))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
};

/* ── Les contrôles ───────────────────────────────────────────────────────────────────────────
   Seuils WCAG : 4,5:1 pour du texte, 3:1 pour l'arête d'un élément interactif (1.4.3 / 1.4.11).
   Seuils ΔL\* : choisis une fois, appliqués aux deux finitions, et documentés dans l'en-tête de
   globals.css — le perçage doit rester SOUS le pas de la plaque, sinon le fond a plus de relief
   que ce qu'il porte. */
let echecs = 0;
let total = 0;

function controle(nom, valeur, seuil, unite) {
  total++;
  const ok = valeur >= seuil;
  if (!ok) echecs++;
  const v = unite === "ΔL*" ? valeur.toFixed(1) : valeur.toFixed(2);
  console.log(
    `  ${ok ? "ok" : "ÉCHEC"}  ${nom.padEnd(44)} ${v.padStart(7)} ${unite.padEnd(4)} (min ${seuil})`,
  );
}

function finition(nom, r) {
  const relief = melange(r.releve, r["arete-haute"], PART_RELEVE);
  const quatre = {
    boîtier: r.boitier,
    creux: r.creux,
    plaque: r.releve,
    relief,
  };
  console.log(`\n══ ${nom.toUpperCase()} ══  relief calculé = ${relief}`);

  /* 1. Les encres, contre les QUATRE surfaces. C'est le défaut que ce script existe pour empêcher
        de revenir : une encre ne se mesure pas contre le fond de page, elle se mesure contre ce
        sur quoi elle est réellement posée. */
  for (const [encre, seuil] of [
    ["encre", 4.5],
    ["encre-faible", 4.5],
    ["arete-commande", 3],
    ["aluminium", 3],
  ]) {
    for (const [s, fond] of Object.entries(quatre)) {
      controle(`${encre} / ${s}`, rapport(r[encre], fond), seuil, ":1");
    }
  }

  /* 2. Les lampes. Le verre est un FOND : sa couleur pleine doit s'y lire. La couleur pleine sert
        aussi d'arête sur la plaque et sur le boîtier. */
  for (const c of ["ambre", "vert"]) {
    controle(`${c} / son verre`, rapport(r[c], r[`${c}-verre`]), 4.5, ":1");
  }
  controle("rouge-encre / son verre", rapport(r["rouge-encre"], r["rouge-verre"]), 4.5, ":1");
  for (const c of ["ambre", "vert", "rouge"]) {
    controle(`${c} plein / plaque`, rapport(r[c], r.releve), 3, ":1");
    controle(`${c} plein / boîtier`, rapport(r[c], r.boitier), 3, ":1");
  }
  controle("encre de lampe / ambre", rapport(r["lampe-encre"], r.ambre), 4.5, ":1");

  /* 3. Les SURFACES, en ΔL*. Un rapport de luminance n'a rien à dire ici. */
  const dL = (a, b) => Math.abs(clarte(a) - clarte(b));
  const pasPlaque = dL(r.releve, r.boitier);
  controle("plaque sur boîtier", pasPlaque, 7, "ΔL*");
  controle("puits sous boîtier", dL(r.creux, r.boitier), 5, "ΔL*");
  controle("biseau clair sur plaque", dL(r["arete-haute"], r.releve), 11, "ΔL*");
  controle("biseau sombre sur plaque", dL(r["arete-basse"], r.releve), 11, "ΔL*");
  controle("relief sur plaque", dL(relief, r.releve), 4, "ΔL*");
  controle("gravure sous le puits", dL(r.gravure, r.creux), 4.5, "ΔL*");
  controle("gravure sous le boîtier", dL(r.gravure, r.boitier), 9, "ΔL*");

  /* Le perçage est le seul contrôle qui soit un PLAFOND, et c'est tout son intérêt : une trame de
     fond qui bat plus fort que les plaques qu'elle porte inverse la figure et le fond. */
  const amplitude = dL(r["perce-levre"], r.perce);
  controle("perçage, amplitude", amplitude, 5, "ΔL*");
  total++;
  const borne = amplitude <= pasPlaque;
  if (!borne) echecs++;
  console.log(
    `  ${borne ? "ok" : "ÉCHEC"}  ${"perçage BORNÉ par la plaque".padEnd(44)} ${amplitude.toFixed(1).padStart(7)} ΔL*  (max ${pasPlaque.toFixed(1)})`,
  );
}

/* Le contrat nomme les deux boîtiers par leur valeur : si une rampe bouge et que la ligne
   OWN-WORLD de `layout.tsx` ne bouge pas, la direction ment sur ce qui est livré. */
function contrat() {
  const layout = readFileSync(join(racine, "src/app/layout.tsx"), "utf8");
  for (const [nom, valeur] of [["graphite", gr.boitier], ["aluminium", al.boitier]]) {
    total++;
    const present = layout.toLowerCase().includes(`${nom} ${valeur}`);
    if (!present) echecs++;
    console.log(
      `  ${present ? "ok" : "ÉCHEC"}  ${`contrat : ${nom} ${valeur}`.padEnd(44)}         ${present ? "" : "absent de CONTRAT_DIRECTION"}`,
    );
  }
}

finition("graphite", gr);
finition("aluminium", al);
console.log("\n══ CONTRAT ══");
contrat();

console.log(`\n${total} contrôles, ${echecs} échec(s).`);
process.exit(echecs === 0 ? 0 : 1);
