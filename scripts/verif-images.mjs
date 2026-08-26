/**
 * Vérifie la chaîne de l'empreinte des visuels de boissons : un producteur, trois consommateurs.
 *
 * **Pourquoi ce contrôle existe.** `beverage-images.json` porte une `version` — l'empreinte du jeu
 * de fichiers copiés depuis l'APK. Elle sert à une seule chose : rendre l'URL d'une vignette
 * `/boissons/x.webp?v=<empreinte>` immuable pour de bon, ce qui épargne vingt et une requêtes
 * conditionnelles à chaque navigation. Trois pièces doivent s'accorder :
 *
 *   1. `scripts/extract-images.mjs` écrit `version` en même temps qu'il copie les fichiers ;
 *   2. `src/app/BeverageImage.tsx` la pose sur chaque URL ;
 *   3. `next.config.mjs` déclare `immutable` pour cette valeur — et pour elle seule.
 *
 * **Aucune de ces trois ruptures ne se voit.** Un `?v=` oublié : les images s'affichent, la page
 * est identique, seul le cache retombe silencieusement à `max-age=0`. Une empreinte recopiée en dur
 * dans `next.config.mjs` : tout marche jusqu'à la prochaine ré-extraction, après quoi plus rien
 * n'est mis en cache, sans erreur ni message. Une empreinte périmée dans la table : les URL
 * pointent vers un jeu qui n'existe plus, et le cache est promis pour un an à des dessins qu'on
 * n'a pas. Ni `tsc`, ni `eslint`, ni `pnpm build` n'en disent un mot.
 *
 * **Ce qu'il voit sans les images.** `public/boissons/` est gitignoré — la CI n'en a aucune. Les
 * quatre premiers contrôles ne portent donc que sur le code et la table, et passent partout. Le
 * cinquième, la recomputation de l'empreinte, n'a lieu que si les fichiers sont là ; il est
 * annoncé comme sauté sinon, plutôt que compté comme réussi.
 *
 * Aucune dépendance : `node scripts/verif-images.mjs`.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (p) => readFileSync(join(RACINE, p), "utf8");

let ko = 0;
let saute = 0;
const ok = (quoi, detail = "") => console.log(`  ✓ ${quoi}${detail ? `  ${detail}` : ""}`);
const echec = (quoi, detail) => { console.log(`  ✗ ${quoi}\n      ${detail}`); ko++; };
const passe = (quoi, pourquoi) => { console.log(`  · ${quoi} — sauté : ${pourquoi}`); saute++; };

const table = JSON.parse(lire("src/lib/beverage-images.json"));

/* ── 1. La table porte une empreinte, et elle en a la forme ────────────────────────────────── */
if (typeof table.version !== "string" || !/^[0-9a-f]{8}$/.test(table.version)) {
  echec(
    "src/lib/beverage-images.json porte une empreinte",
    `\`version\` vaut ${JSON.stringify(table.version)} ; attendu huit hexadécimaux. ` +
      "Régénérer avec `node scripts/extract-images.mjs`.",
  );
} else {
  ok("la table porte une empreinte", table.version);
}

/* ── 2. L'extracteur la produit ────────────────────────────────────────────────────────────── */
{
  const src = lire("scripts/extract-images.mjs");
  if (!/empreinteJeu\s*=\s*createHash\(/.test(src) || !/^\s*version,$/m.test(src)) {
    echec(
      "scripts/extract-images.mjs produit l'empreinte",
      "le calcul (`createHash`) ou son écriture dans la table (`version,`) a disparu — " +
        "la valeur committée deviendrait un vestige que plus rien ne met à jour.",
    );
  } else {
    ok("l'extracteur produit l'empreinte");
  }
}

/* ── 3. La vignette la pose sur son URL ────────────────────────────────────────────────────── */
{
  const src = lire("src/app/BeverageImage.tsx");
  if (!/src=\{`\$\{IMAGES\.chemin\}\/\$\{fichier\}\.webp\?v=\$\{IMAGES\.version\}`\}/.test(src)) {
    echec(
      "src/app/BeverageImage.tsx pose `?v=` sur l'URL",
      "sans lui, la règle de `next.config.mjs` ne s'applique à rien et le cache retombe " +
        "silencieusement à `max-age=0` — vingt et une requêtes conditionnelles par navigation.",
    );
  } else {
    ok("la vignette pose l'empreinte sur son URL");
  }
}

/* ── 4. La configuration la LIT, et ne la recopie pas ──────────────────────────────────────── */
{
  const src = lire("next.config.mjs");
  const litLaTable = /beverage-images\.json/.test(src) && /version:\s*VERSION_IMAGES/.test(src);
  const compareLaValeur = /key:\s*"v",\s*value:\s*VERSION_IMAGES/.test(src);
  if (!litLaTable) {
    echec(
      "next.config.mjs lit l'empreinte dans la table",
      "une empreinte écrite en dur ici est une deuxième déclaration : elle survit à la " +
        "ré-extraction suivante, et le cache s'éteint sans que rien ne le dise.",
    );
  } else if (!compareLaValeur) {
    echec(
      "next.config.mjs compare la VALEUR de `v`",
      "un `has` sur la seule présence de `v` promet un an à n'importe quelle empreinte, " +
        "y compris celle d'un jeu qu'on n'a plus.",
    );
  } else {
    ok("la configuration lit l'empreinte et compare sa valeur");
  }
}

/* ── 5. L'empreinte décrit les fichiers présents ───────────────────────────────────────────── */
{
  const dossier = join(RACINE, "public", "boissons");
  if (!existsSync(dossier) || readdirSync(dossier).length === 0) {
    passe(
      "l'empreinte décrit les fichiers présents",
      "public/boissons/ est vide ou absent (gitignoré : les visuels appartiennent à De'Longhi)",
    );
  } else {
    /* Exactement l'algorithme de `extract-images.mjs` : nom, séparateur, octets, séparateur,
       dans l'ordre trié des noms VOULUS — pas de ceux trouvés, sans quoi un fichier étranger
       déposé à la main ferait diverger le calcul sans que l'extracteur en sache rien. */
    const voulues = new Set([...Object.values(table.parId), ...table.choixRecettePerso]);
    const h = createHash("sha256");
    let n = 0;
    const absents = [];
    for (const nom of [...voulues].sort()) {
      const p = join(dossier, `${nom}.webp`);
      if (!existsSync(p)) { absents.push(nom); continue; }
      h.update(nom).update("\0").update(readFileSync(p)).update("\0");
      n++;
    }
    const calculee = h.digest("hex").slice(0, 8);
    if (calculee !== table.version) {
      echec(
        "l'empreinte décrit les fichiers présents",
        `table ${table.version}, calculé ${calculee} sur ${n} fichier(s). ` +
          "Les URL versionnées pointent vers un jeu qui n'est plus celui-ci — et sont promises " +
          "pour un an. Régénérer avec `node scripts/extract-images.mjs`.",
      );
    } else {
      ok("l'empreinte décrit les fichiers présents", `${n} fichier(s)`);
    }
    if (absents.length) {
      console.log(`      (${absents.length} nom(s) cité(s) sans fichier : normal sur une extraction partielle)`);
    }
  }
}

console.log(
  ko
    ? `\n${ko} problème(s) dans la chaîne de l'empreinte des visuels.\n`
    : `\nChaîne de l'empreinte des visuels vérifiée${saute ? ` (${saute} contrôle sauté)` : ""}.\n`,
);
process.exit(ko ? 1 : 0);
