/**
 * Vérifie que chaque clé de traduction écrite en dur dans une page existe dans son catalogue.
 *
 * **Pourquoi ce contrôle existe.** Une clé absente ne se voit ni au `tsc` ni au `pnpm build` : tous
 * les traducteurs `next-intl` ont le même type, et la clé n'est résolue qu'au rendu. La faute sort
 * en `MISSING_MESSAGE` dans la console du navigateur — donc seulement si quelqu'un ouvre la page
 * concernée **et** regarde la console. C'est arrivé : `fmtAge` a reçu le traducteur de l'espace
 * `dashboard` alors que `ageSeconds`/`ageMinutes`/`ageHours` vivent dans `power`.
 *
 * **Ce qu'il voit, et ce qu'il ne voit pas.** Il ne contrôle que les clés **littérales** écrites sur
 * place. Il ne voit pas une clé demandée à l'intérieur d'un helper à qui l'on passe un traducteur
 * (`fmtAge(sec, t)`) — c'est-à-dire précisément la faute qui l'a motivé. Le dire ici plutôt que de
 * laisser croire à une couverture qu'il n'a pas : ce script garde contre les fautes de frappe et
 * les clés supprimées, pas contre un traducteur passé au mauvais endroit.
 *
 * **Union des espaces, et c'est délibéré.** Un même fichier lie souvent `t` à deux espaces dans deux
 * composants (`page.tsx` le fait pour `power` et `editor`). Sans analyse de portée on ne peut pas
 * dire lequel s'applique à un appel donné, donc on accepte la clé si elle existe dans **l'un** des
 * espaces liés à ce nom. Une clé absente de tous est certainement fausse ; une clé présente dans
 * l'un d'eux est plausible. Moins de portée, mais aucun faux positif — et un contrôle de CI qui
 * crie à tort est un contrôle qu'on finit par désarmer.
 *
 * Aucune dépendance : `node scripts/verif-messages.mjs`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const messages = JSON.parse(readFileSync(join(RACINE, "messages/fr.json"), "utf8"));

const fichiers = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) fichiers.push(p);
  }
})(join(RACINE, "src"));

/** Une clé peut être pointée (`a.b`) : on descend dans l'objet plutôt que d'indexer à plat. */
const existe = (cat, cle) => {
  let n = cat;
  for (const part of cle.split(".")) {
    if (n == null || typeof n !== "object") return false;
    n = n[part];
  }
  return n !== undefined;
};

let ko = 0;
let verifiees = 0;
for (const f of fichiers) {
  const src = readFileSync(f, "utf8");
  const court = relative(RACINE, f).replace(/\\/g, "/");

  /** nom de la variable → ensemble des espaces auxquels ce fichier la lie. */
  const espaces = new Map();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*useTranslations\(\s*"([^"]+)"\s*\)/g)) {
    if (!espaces.has(m[1])) espaces.set(m[1], new Set());
    espaces.get(m[1]).add(m[2]);
  }
  if (!espaces.size) continue;

  for (const [nom, ns] of espaces) {
    for (const x of ns) {
      if (messages[x]) continue;
      console.log(`  ESPACE INCONNU  ${court}  ${nom} → "${x}"`);
      ko++;
    }
    const cats = [...ns].map((x) => messages[x]).filter(Boolean);
    if (!cats.length) continue;
    // Le littéral doit être SUIVI de `,` ou `)` : sinon on attrape le premier morceau d'une clé
    // calculée (`t("warning" + genre)`), dont l'existence ne se décide pas ici.
    const re = new RegExp(String.raw`\b` + nom + String.raw`\(\s*"([^"]+)"\s*[,)]`, "g");
    for (const m of src.matchAll(re)) {
      verifiees++;
      if (cats.some((c) => existe(c, m[1]))) continue;
      const ligne = src.slice(0, m.index).split("\n").length;
      console.log(`  CLÉ ABSENTE     ${court}:${ligne}  ${nom}("${m[1]}")  espace(s) ${[...ns].join(" | ")}`);
      ko++;
    }
  }
}

console.log(
  ko
    ? `\n${ko} problème(s) sur ${verifiees} clés littérales.\n`
    : `\n${verifiees} clés littérales vérifiées, toutes résolues.\n`,
);
process.exit(ko ? 1 : 0);
