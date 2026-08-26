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
 * La jointure se valide elle-même : les seuls identifiants sans `case` sont les six emplacements
 * Bean System (200-205) et les dix recettes personnalisées (230-239) — précisément ceux dont
 * l'icône ne vient pas de là.
 *
 * ## ⚠️ Le `switch` a un `default`, et il donne une image lui aussi
 *
 * Une version précédente de ce script s'arrêtait au `switch` et rangeait ces seize identifiants
 * dans « sans image ». C'était faux, et faux d'une manière que rien ne signalait : l'application
 * officielle, elle, affiche bel et bien quelque chose pour eux.
 *
 * ```java
 * public static int B(int i9, Resources resources) {
 *     switch (a.f35759a[p127m6.a.b(i9).ordinal()]) {
 *         case 1: return R.drawable.regular;
 *         …                                          // 58 cas
 *         default: return J(i9, resources);          // ← la branche oubliée
 *     }
 * }
 *
 * public static int J(int i9, Resources resources) {
 *     identifier = resources.getIdentifier(
 *         g.h().o() ? "beverage_icn_" + i9 : "beverage_icn_" + i9 + "_v1", "drawable", …);
 *     return identifier != 0 ? identifier : R.drawable.espresso;   // ← le repli
 * }
 * ```
 *
 * Donc un identifiant sans `case` est résolu **par nom de ressource** (`beverage_icn_<id>`), et à
 * défaut par `R.drawable.espresso`. Dans cet APK il n'existe **aucun** `beverage_icn_*`, toutes
 * densités confondues : le repli est donc toujours atteint. Ce script reproduit les deux étapes,
 * `repliParNom()` puis la constante, plutôt que d'inscrire « espresso » en dur — le jour où une
 * version de l'application livre un `beverage_icn_200`, l'extraction le prendra.
 *
 * ## Mais seulement pour les Bean System, et c'est le nom de la constante qui tranche
 *
 * Les deux familles sans `case` ne se comportent PAS pareil dans l'application :
 *
 * - `BEAN_01`…`BEAN_06` (200-205) n'ont aucune autre voie. Le décodeur `0xBA` de l'app
 *   (`p097j6.d.G0`) construit un `BeanSystem` dont le champ `image` reçoit `""` et dont
 *   `optimalId` vaut `z.K(bArr[4])` — une fonction qui ignore son argument et rend toujours
 *   `BEAN_01.c()`, soit 200. Ces identifiants tombent donc sur `B()`, donc sur le repli.
 * - `CUSTOM_01_V2`…`CUSTOM_10_V2` (230-239) ont la leur : `U6/j.java` choisit
 *   `recipeData.P() ? z.z(recipeData.q(), res) : z.B(recipeData.p(), res)` — une recette perso
 *   passe par `z.z()` avec son INDEX d'icône, et n'atteint jamais le repli. Leur donner
 *   « espresso » ici afficherait six tasses d'espresso à la place des icônes choisies sur la
 *   machine : une régression, pas une fidélité.
 *
 * D'où le tri sur le préfixe de la constante (`BEAN_`) et non sur une plage d'identifiants : c'est
 * la distinction que fait l'application, pas un intervalle qu'on aurait deviné.
 *
 * ## La liste de l'écran de création
 *
 * `CreateBeverageViewModel.J()` construit un tableau de **20** images pour la recette perso, et
 * l'écran compare l'icône enregistrée à l'INDEX de position (`gVar.n() != i10`). La valeur
 * stockée est donc un index 0-19 dans cette liste, pas un identifiant de ressource. L'ordre
 * compte, il est conservé tel quel.
 *
 * ✅ **C'est bien cet index que transporte le bloc de noms** (`0xAA` / `0xAB`, offset 20 de
 * l'entrée de 21 octets — voir `profiles.mjs`). Longtemps noté ici comme « plausible et non
 * vérifié », avec une écriture sur l'appareil pour le confirmer. **L'écriture n'a pas été
 * nécessaire** : le code de l'application le dit de bout en bout, et cette version-là est
 * réfutable à bas coût.
 *
 *   1. `J()` ci-dessus : la case sélectionnée est celle dont la POSITION vaut `gVar.n()`.
 *   2. `Q6.g.n()` rend `f6459b`, que le `toString` de la classe nomme `recipeImageIndex`.
 *   3. `CreateBeverageViewModel.m0()`, cas `SET_NAME_ICON` : `f0(idBoisson, nom, gVar2.n())`.
 *   4. `DeLonghiWifiConnectService.f0` journalise `"saveRecipeName … iconIndex:"` et appelle
 *      `p097j6.d.f0`, qui pose `bArr[2] = 0xAB` puis `bArr[i12] = (byte) iArr[i13]` — le 21e
 *      octet de l'entrée, donc l'offset 20.
 *
 * La règle de méthode est la même que pour la constante `0x37` : quand une hypothèse peut être
 * réfutée en lisant, on lit avant d'écrire sur un appareil réel.
 *
 * ## Usage
 *
 *   node scripts/extract-images.mjs                    # densité xhdpi par défaut
 *   node scripts/extract-images.mjs --densite xxhdpi   # plus lourd, plus net
 *   node scripts/extract-images.mjs --res <chemin>     # arbre res/ décompilé
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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

/**
 * **`J(int, Resources)` reproduit** : la résolution par NOM de ressource, tentée quand le `switch`
 * de `B()` n'a pas de `case`. Les deux orthographes que l'application essaie selon `g.h().o()`,
 * dans cet ordre, puis `null` si aucune n'existe — c'est alors l'appelant qui applique la
 * constante de repli, comme le fait `J()` avec `R.drawable.espresso`.
 */
function repliParNom(id, dossier) {
  for (const nom of [`beverage_icn_${id}`, `beverage_icn_${id}_v1`]) {
    if (existsSync(join(dossier, `${nom}.webp`))) return nom;
  }
  return null;
}

/** La constante de repli de `J()`. Nommée, parce qu'elle est un fait de l'APK et pas un choix. */
const REPLI_J = "espresso";

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

// Le dossier de densité est résolu AVANT la jointure : `repliParNom()` a besoin d'y chercher.
const dossier = join(RES, `drawable-${DENSITE}`);
if (!existsSync(dossier)) {
  console.error(`Densité inconnue : ${dossier}`);
  console.error(`Disponibles : ${readdirSync(RES).filter((d) => d.startsWith("drawable-")).join(", ")}`);
  process.exit(5);
}

const parId = {};
const sansImage = [];
/** Les identifiants servis par le `default` de `B()`, à distinguer d'un dessin dédié. */
const replis = [];
for (const [id, nom] of Object.entries(idEnum)) {
  const img = caseImg[enumCase[nom]];
  if (img) { parId[id] = img; continue; }
  // Pas de `case` : c'est le `default` de `B()`. Voir l'en-tête, § « Le switch a un default ».
  if (nom.startsWith("BEAN_")) {
    parId[id] = repliParNom(Number(id), dossier) ?? REPLI_J;
    replis.push(Number(id));
    continue;
  }
  sansImage.push(Number(id));
}

// Les images à copier : celles citées, et elles seules.
const voulues = new Set([...Object.values(parId), ...choix]);

mkdirSync(SORTIE_IMG, { recursive: true });
let copiees = 0;
const absentes = [];
/* **L'empreinte du jeu d'images, et pourquoi elle est ici.**
   Ces fichiers ne changent jamais entre deux extractions — mais leurs NOMS non plus. Servis sous
   une URL stable, ils ne peuvent donc pas être mis en cache pour de bon : une image redessinée
   dans une version suivante de l'application garderait son nom et resterait invisible. D'où
   `?v=<empreinte>` : l'URL change quand le CONTENU change, et rien d'autre ne la fait changer.
   C'est ce qui autorise `immutable` côté serveur (voir `next.config.mjs`), et sans lui les 21
   vignettes de l'accueil repartaient en requêtes conditionnelles à chaque navigation.

   Une empreinte pour le JEU ENTIER, pas une par fichier : le répertoire est régénéré d'un bloc
   par ce script, jamais fichier par fichier. Cinquante-huit empreintes auraient décrit une
   granularité qui n'existe pas, et le seul coût de celle-ci est de retélécharger 1,2 Mio après
   une ré-extraction — un geste de développeur, pas un chemin d'utilisateur. */
const empreinteJeu = createHash("sha256");
for (const nom of [...voulues].sort()) {
  const src = join(dossier, `${nom}.webp`);
  if (!existsSync(src)) { absentes.push(nom); continue; }
  const octets = readFileSync(src);
  copyFileSync(src, join(SORTIE_IMG, `${nom}.webp`));
  empreinteJeu.update(nom).update("\0").update(octets).update("\0");
  copiees++;
}
/* Huit hexadécimaux : l'empreinte ne défend rien, elle distingue. */
const version = empreinteJeu.digest("hex").slice(0, 8);

writeFileSync(SORTIE_MAP, JSON.stringify({
  _: "Généré par scripts/extract-images.mjs — ne pas éditer à la main.",
  densite: DENSITE,
  chemin: "/boissons",
  // empreinte du jeu de fichiers copiés : sert de `?v=` et rend le cache immuable honnête
  version,
  // identifiant de boisson → nom de fichier, sans extension
  parId,
  /* Les identifiants dont l'image vient du `default` de `B()` et non d'un `case` : une image de
     REPLI, pas un dessin dédié. Sans cette liste, rien ne distinguerait « 200 → espresso » de
     « 1 → espresso » dans la table, et la prochaine relecture conclurait à nouveau que la boisson
     200 a son propre visuel. C'est aussi ce qui permet à l'interface de le dire. */
  repliParDefaut: replis,
  // index 0-19 → nom de fichier : la liste de l'écran de création, DANS L'ORDRE
  choixRecettePerso: choix,
}, null, 1) + "\n");

console.log(`densité ${DENSITE}`);
console.log(`  ${Object.keys(parId).length} identifiants avec image, ${copiees} fichiers copiés dans public/boissons/`);
console.log(`  empreinte du jeu : ${version}`);
console.log(`  ${choix.length} icônes proposées pour une recette perso`);
if (replis.length) {
  // Dire « repli » et non « avec image » : ces identifiants n'ont pas de dessin à eux, ils
  // héritent de celui d'`espresso` par le `default` de `B()`. Le taire les ferait passer pour
  // des visuels dédiés dans le compte de la ligne précédente.
  console.log(`  ${replis.length} par le repli de B() → ${replis.map((id) => `${id}:${parId[id]}`).join(", ")}`);
}
if (sansImage.length) {
  // Attendu : les recettes perso (230-239) tirent leur icône de leur index, pas de cette table.
  console.log(`  sans image (normal pour les recettes perso) : ${sansImage.join(", ")}`);
}
if (absentes.length) console.log(`  ⚠ citées mais absentes de cette densité : ${absentes.join(", ")}`);
