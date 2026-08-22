/**
 * Extrait de l'APK les VISUELS DE BOISSONS, et la table qui dit lequel va avec quoi.
 *
 * Complète `extract-catalogs.mjs` (les recettes d'un modèle) et `extract-models.mjs` (la table
 * d'identification). Ici on prend les images — 58 boissons plus la liste de 20 icônes que l'écran
 * de création propose pour une recette personnalisée.
 *
 * ## Ce que ce script produit, et ce qu'il ne committe pas
 *
 * - **`src/lib/beverage-images.json`** — la CORRESPONDANCE, versionnée. C'est une table de noms
 *   dérivée par analyse, au même titre que `machine-catalogs.json` : elle ne contient aucune
 *   œuvre graphique, seulement des identifiants et des noms de fichiers.
 * - **`public/boissons/*.webp`** — les IMAGES elles-mêmes, dans un répertoire **gitignoré**.
 *
 * ⚠️ **Cette séparation est délibérée.** Les visuels appartiennent à De'Longhi, et `lan-server`
 * est publié — image GHCR, archive de release, dépôt public. Les committer les redistribuerait.
 * `apk/` et `decompiled/` sont gitignorés pour exactement cette raison ; les images qui en sortent
 * héritent de la même règle. Qui possède l'application extrait sa propre copie en lançant ce
 * script ; le dépôt, lui, ne transporte que le savoir — la table.
 *
 * ## D'où vient la correspondance
 *
 * Elle n'est PAS déduite de la ressemblance des noms. Elle est la jointure de trois tables de
 * l'application, chacune relevée dans le code décompilé :
 *
 * 1. `p127m6.a$C0391a.a(int)` — identifiant de boisson → constante d'énumération. C'est un
 *    `switch` explicite, branché sur la génération (`s.r()` pour Striker), donc sans ambiguïté :
 *    plusieurs constantes partagent un même identifiant (`CUSTOM_01(19)` et `RISTRETTO(19)`) et
 *    c'est cette table, pas l'ordre de déclaration, qui tranche. On prend la branche *classic*,
 *    identifiée par ses valeurs connues — thé 22, cortado 24, brew over ice 27, celles-là mêmes
 *    que `doc/commandes-cafe.md` § 2 documente déjà.
 * 2. `p258z7.z$a.f35759a` — constante → numéro de `case`. ⚠️ Ce tableau est rempli sous **deux
 *    noms** dans le code décompilé (`iArr6` avant l'affectation au champ, `f35759a` après) ; ne
 *    lire que le second en perd une partie, silencieusement.
 * 3. `p258z7.z.B(int, Resources)` — numéro de `case` → `R.drawable.<nom>`.
 *
 * La jointure se valide elle-même : les seuls identifiants sans image sont les six emplacements
 * Bean System (200-205) et les dix recettes personnalisées (230-239) — précisément ceux dont
 * l'icône ne vient pas de là.
 *
 * ## La liste de l'écran de création
 *
 * `CreateBeverageViewModel.J()` construit un tableau de **20** images pour la recette perso, et
 * l'écran compare l'icône enregistrée à l'INDEX de position (`gVar.n() != i10`). La valeur
 * stockée est donc un index 0-19 dans cette liste, pas un identifiant de ressource. L'ordre
 * compte, il est conservé tel quel.
 *
 * ⚠️ **Ce que ce script n'établit PAS** : que l'octet d'icône transporté dans le bloc de noms
 * (`0xAA` / `0xAB`, offset 20 de l'entrée de 21 octets — voir `profiles.mjs`) soit bien cet
 * index-là. C'est plausible et non vérifié. À confirmer en renommant une recette perso avec une
 * icône choisie, puis en relisant le bloc.
 *
 * ## Usage
 *
 *   node scripts/extract-images.mjs                    # densité xhdpi par défaut
 *   node scripts/extract-images.mjs --densite xxhdpi   # plus lourd, plus net
 *   node scripts/extract-images.mjs --res <chemin>     # arbre res/ décompilé
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ICI, "..");

const arg = (nom, defaut = null) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

const RES = arg("res", join(RACINE, "..", "decompiled", "resources", "res"));
const SRC = join(RACINE, "..", "decompiled", "sources");
const DENSITE = arg("densite", "xhdpi");
const SORTIE_IMG = join(RACINE, "public", "boissons");
const SORTIE_MAP = join(RACINE, "src", "lib", "beverage-images.json");

function lire(p) {
  if (!existsSync(p)) {
    console.error(`Introuvable : ${p}`);
    console.error("Ce script a besoin de l'APK décompilé. Voir CLAUDE.md, § « What is in this workspace ».");
    process.exit(2);
  }
  return readFileSync(p, "utf8");
}

// ─── 1. identifiant → constante d'énumération (branche classic) ─────────────
function tableIdEnum(src) {
  const d0 = src.slice(src.indexOf("public final a a(int i9)"));
  const d = d0.slice(0, d0.indexOf("\n    }\n\n"));
  // Les gardes découpent les branches ; on retient la plus fournie, puis on la VÉRIFIE.
  let meilleure = {};
  for (const bloc of d.split(/if \(!s\.r\(\)\)|if \(!g\.h\(\)\.o\(\)\)|\} else \{/)) {
    const paires = [...bloc.matchAll(/case (\d+):\s*return a\.([A-Z_0-9]+);/g)];
    if (paires.length > Object.keys(meilleure).length) {
      meilleure = Object.fromEntries(paires.map((m) => [Number(m[1]), m[2]]));
    }
  }
  // Contrôle : trois identifiants dont `doc/commandes-cafe.md` § 2 donne la valeur. Si la branche
  // retenue n'est pas la classic, ils ne tombent pas — mieux vaut s'arrêter que produire une
  // table d'images fausses, qui ne se verrait qu'à l'œil, boisson par boisson.
  const attendu = { 22: "TEA", 24: "CORTADO", 27: "BREW_OVER_ICE" };
  for (const [id, nom] of Object.entries(attendu)) {
    if (meilleure[id] !== nom) {
      console.error(`Branche inattendue : l'identifiant ${id} donne ${meilleure[id]}, attendu ${nom}.`);
      process.exit(3);
    }
  }
  return meilleure;
}

// ─── 2. constante → numéro de case, 3. case → drawable ──────────────────────
function tableEnumImage(z) {
  // ⚠️ Les DEUX noms du même tableau. Voir l'en-tête.
  const enumCase = Object.fromEntries(
    [...z.matchAll(/(?:iArr6|f35759a)\[p127m6\.a\.([A-Z_0-9]+)\.ordinal\(\)\]\s*=\s*(\d+)/g)]
      .map((m) => [m[1], Number(m[2])]),
  );
  const b0 = z.slice(z.indexOf("public static int B(int i9, Resources resources)"));
  const b = b0.slice(0, b0.indexOf("public static String C("));
  const caseImg = {};
  for (const m of b.matchAll(/case (\d+):\s*return\s+(?:s\.f35736a\.s\(\) \? )?R\.drawable\.(\w+)/g)) {
    if (caseImg[m[1]] === undefined) caseImg[Number(m[1])] = m[2];
  }
  return { enumCase, caseImg };
}

// ─── 4. la liste de l'écran de création ─────────────────────────────────────
function listeChoix(vm) {
  const m = vm.match(/int\[\] iArr = \{((?:\s*R\.drawable\.\w+,?)+)\};/);
  if (!m) { console.error("Liste d'icônes introuvable dans CreateBeverageViewModel."); process.exit(4); }
  return [...m[1].matchAll(/R\.drawable\.(\w+)/g)].map((x) => x[1]);
}

// ─── assemblage ─────────────────────────────────────────────────────────────
const z = lire(join(SRC, "p258z7", "z.java"));
const en = lire(join(SRC, "p127m6", "a.java"));
const vm = lire(join(SRC, "it", "delonghi", "striker", "homerecipe", "beverages", "viewmodel", "creation", "CreateBeverageViewModel.java"));

const idEnum = tableIdEnum(en);
const { enumCase, caseImg } = tableEnumImage(z);
const choix = listeChoix(vm);

const parId = {};
const sansImage = [];
for (const [id, nom] of Object.entries(idEnum)) {
  const img = caseImg[enumCase[nom]];
  if (img) parId[id] = img; else sansImage.push(Number(id));
}

// Les images à copier : celles citées, et elles seules.
const voulues = new Set([...Object.values(parId), ...choix]);
const dossier = join(RES, `drawable-${DENSITE}`);
if (!existsSync(dossier)) {
  console.error(`Densité inconnue : ${dossier}`);
  console.error(`Disponibles : ${readdirSync(RES).filter((d) => d.startsWith("drawable-")).join(", ")}`);
  process.exit(5);
}

mkdirSync(SORTIE_IMG, { recursive: true });
let copiees = 0;
const absentes = [];
for (const nom of [...voulues].sort()) {
  const src = join(dossier, `${nom}.webp`);
  if (!existsSync(src)) { absentes.push(nom); continue; }
  copyFileSync(src, join(SORTIE_IMG, `${nom}.webp`));
  copiees++;
}

writeFileSync(SORTIE_MAP, JSON.stringify({
  _: "Généré par scripts/extract-images.mjs — ne pas éditer à la main.",
  densite: DENSITE,
  chemin: "/boissons",
  // identifiant de boisson → nom de fichier, sans extension
  parId,
  // index 0-19 → nom de fichier : la liste de l'écran de création, DANS L'ORDRE
  choixRecettePerso: choix,
}, null, 1) + "\n");

console.log(`densité ${DENSITE}`);
console.log(`  ${Object.keys(parId).length} identifiants avec image, ${copiees} fichiers copiés dans public/boissons/`);
console.log(`  ${choix.length} icônes proposées pour une recette perso`);
if (sansImage.length) {
  // Attendu : Bean System (200-205) et recettes perso (230-239) tirent leur icône d'ailleurs.
  console.log(`  sans image (normal pour les grains et les recettes perso) : ${sansImage.join(", ")}`);
}
if (absentes.length) console.log(`  ⚠ citées mais absentes de cette densité : ${absentes.join(", ")}`);
