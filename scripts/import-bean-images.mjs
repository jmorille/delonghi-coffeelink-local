/**
 * Importe les VISUELS DE GRAINS de l'application officielle, et la table qui dit lequel va avec
 * quoi.
 *
 * Frère de `extract-images.mjs`, avec une seule différence de nature : la source n'est pas l'APK
 * mais un **service distant**. L'application ne livre pas ces images dans son paquet — elle les
 * télécharge, et le lien qui les nomme est un JSON public :
 *
 *     https://delonghibe.s3-eu-west-1.amazonaws.com/CoffeeLink/BS/questions/
 *       BeanSystemQuestions_app_millcore_1.0.json
 *
 * (`p257z6/C2201d1.b()` construit ce Retrofit, `p137n6/b.a()` nomme le fichier.)
 *
 * ## Ce que ce script produit, et ce qu'il ne committe pas
 *
 * - **`src/lib/bean-images.json`** — la CORRESPONDANCE, versionnée : des rôles, des noms de
 *   fichiers, une empreinte. Aucune œuvre graphique.
 * - **`public/grains/*.png`** — les IMAGES, dans un répertoire **gitignoré**.
 * - **`public/grains/questions.json`** — la réponse du service, telle quelle, à côté des images.
 *   C'est elle qui rend `--json` possible, donc le script rejouable **sans réseau**.
 *
 * ⚠️ **La même séparation que pour les dessins de boisson, et pour la même raison.** Ces visuels
 * appartiennent à De'Longhi ; `lan-server` est publié — image GHCR, archive de release, dépôt
 * public. Qu'ils viennent d'un S3 ouvert ne les rend pas redistribuables : un seau public autorise
 * à lire, pas à republier. Le dépôt transporte le savoir — la table.
 *
 * ## Les octets ne sont PAS ré-encodés
 *
 * `extract-images.mjs` copie du WebP parce que l'APK en contient déjà. Ici la source est du PNG
 * RGBA, et le convertir demanderait un encodeur : `pnpm-workspace.yaml` bloque les scripts
 * d'installation tiers (c'est ce qui impose déjà `puppeteer-core` plutôt que `puppeteer`), donc
 * `sharp` est hors de portée, et ajouter une dépendance native pour 7 fichiers de 38 kio serait
 * payer cher un gain qu'on ne mesurerait pas. Les octets sont donc copiés **verbatim** — ce qui a
 * en prime le mérite de rendre l'empreinte comparable à la source.
 *
 * ## D'où vient la correspondance grain → image
 *
 * Elle n'est pas devinée d'un nom de fichier, et surtout **pas de l'ordre des questions**. Elle est
 * relue dans l'application :
 *
 * - `I6/V.java`, `case "roast"` : l'écran de torréfaction affiche `prequestion_2_answer_1` à
 *   `_answer_4`. La question `prequestion_2` **est** donc la question « torréfaction », et ses
 *   quatre réponses portent chacune son image (`basic/q2/Beans1..4.png`).
 * - `question_1` est l'aspect de la crema, et ses trois réponses (`adv/q2/{light,dark,no_crema}`)
 *   sont exactement les trois options que `bean-adapt.mjs` connaît déjà sous `crema` 1, 2 et 3.
 *
 * D'où l'appariement par `id_title`, jamais par la position dans le tableau : une question insérée
 * en tête décalerait tout, et un décalage entre quatre nuances de brun ne se verrait pas.
 *
 * ## ⚠️ Le contrôle qui compte : les quatre grains se ressemblent
 *
 * Quatre torréfactions, c'est quatre bruns voisins. Si le service réordonne ses réponses, la table
 * associe le mauvais brun au bon niveau, et **rien ne le signale** — ni une erreur, ni un trou dans
 * la page : une image s'affiche, simplement pas la bonne. C'est le même genre de panne silencieuse
 * qu'un offset d'un octet dans une trame, et elle se traite pareil : on VÉRIFIE que la réponse
 * numéro N porte bien l'image nommée `Beans<N>`, et on s'arrête sinon. Idem pour la crema, dont les
 * noms de fichiers (`light`, `dark`, `no_crema`) disent le rôle attendu.
 *
 * ## Usage
 *
 *   node scripts/import-bean-images.mjs                     # télécharge tout
 *   node scripts/import-bean-images.mjs --json <fichier>    # SANS RÉSEAU (voir ci-dessous)
 *   node scripts/import-bean-images.mjs --base <url>        # autre origine (miroir, test)
 *
 * `--json` ne remplace pas seulement le questionnaire : il fait aussi relire les images **déjà
 * présentes** dans `public/grains/` au lieu de les retélécharger. Sans cela l'option n'aurait
 * évité qu'une requête sur huit, et n'aurait donc jamais rendu l'import hors-ligne — ce qu'elle
 * annonce. Une image absente est quand même téléchargée, faute de mieux, et le script le dit.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ICI, "..");

const arg = (nom, defaut = null) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

const BASE = arg("base", "https://delonghibe.s3-eu-west-1.amazonaws.com/CoffeeLink/BS/questions/");
const FICHIER_QUESTIONS = "BeanSystemQuestions_app_millcore_1.0.json";
const JSON_LOCAL = arg("json");
const SORTIE_IMG = join(RACINE, "public", "grains");
const SORTIE_MAP = join(RACINE, "src", "lib", "bean-images.json");
const SORTIE_QUESTIONS = join(SORTIE_IMG, "questions.json");

const stop = (code, ...lignes) => {
  for (const l of lignes) console.error(l);
  process.exit(code);
};

/**
 * Les deux familles qu'on importe, et **ce qu'on exige de chacune**.
 *
 * `fichierAttendu` est le contrôle décrit dans l'en-tête : le nom de base de l'URL que le service
 * associe à la réponse `id`. C'est lui qui transforme un réordonnancement silencieux en arrêt net.
 *
 * `role` nomme le fichier de sortie dans NOTRE vocabulaire, pas dans celui du service : la page
 * parle de torréfaction 1 à 4 et de crema claire / foncée / absente, et une table qui dirait
 * `Beans3` obligerait l'interface à traduire un nom de fichier étranger.
 */
const FAMILLES = [
  {
    cle: "torrefaction",
    question: "prequestion_2_title",
    quoi: "torréfaction",
    /* Quatre niveaux, du plus clair au plus foncé — l'ordre des réponses de l'écran « roast ». */
    attendu: [
      { id: "1", role: "torrefaction-1", fichierAttendu: "Beans1" },
      { id: "2", role: "torrefaction-2", fichierAttendu: "Beans2" },
      { id: "3", role: "torrefaction-3", fichierAttendu: "Beans3" },
      { id: "4", role: "torrefaction-4", fichierAttendu: "Beans4" },
    ],
  },
  {
    cle: "crema",
    question: "question_1_title",
    quoi: "aspect de la crema",
    /* Les identifiants sont ceux que `bean-adapt.mjs` reçoit déjà sous `crema` : 1 claire,
       2 foncée, 3 absente. Ils ne sont pas dans l'ordre dans le JSON, et c'est sans importance
       puisqu'on apparie par `id` — mais le nom de fichier attendu, lui, le prouve. */
    attendu: [
      { id: "1", role: "crema-claire", fichierAttendu: "light" },
      { id: "2", role: "crema-foncee", fichierAttendu: "dark" },
      { id: "3", role: "crema-absente", fichierAttendu: "no_crema" },
    ],
  },
];

// ─── 1. le questionnaire ────────────────────────────────────────────────────
async function lireQuestions() {
  if (JSON_LOCAL) {
    try {
      return { texte: readFileSync(JSON_LOCAL, "utf8"), origine: JSON_LOCAL };
    } catch (e) {
      stop(2, `Introuvable ou illisible : ${JSON_LOCAL}`, `  ${e.message}`);
    }
  }
  const url = BASE + FICHIER_QUESTIONS;
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    stop(
      2,
      `Impossible de joindre ${url}`,
      `  ${e.message}`,
      "Sans réseau, rejouer une copie : node scripts/import-bean-images.mjs --json public/grains/questions.json",
    );
  }
  if (!r.ok) stop(2, `${url} répond ${r.status} ${r.statusText}`);
  return { texte: await r.text(), origine: url };
}

// ─── 2. la jointure, et ses contrôles ───────────────────────────────────────
/**
 * Apparie les réponses d'une question à leurs images, en **refusant** tout écart.
 *
 * Rend `{ parNiveau: { [id]: role }, urls: { [role]: url } }` — deux tables, deux usages, et c'est
 * la première que l'interface consulte : elle connaît un NIVEAU (torréfaction 3, crema 2), jamais
 * un nom de fichier. Les faire tenir dans une seule table obligerait la page à savoir comment un
 * rôle se nomme, ce qui est exactement ce que ce script est là pour décider tout seul.
 *
 * S'arrête — plutôt que de produire une table plausible — dès qu'une réponse manque, n'a pas
 * d'image, ou porte une image dont le nom n'est pas celui attendu.
 */
function joindre(questions, famille) {
  const q = questions.find((x) => x.id_title === famille.question);
  if (!q) {
    stop(
      3,
      `Question « ${famille.question} » absente du questionnaire.`,
      `  Elle porte l'association ${famille.quoi} → image (voir l'en-tête de ce script).`,
      `  Présentes : ${questions.map((x) => x.id_title).join(", ")}`,
    );
  }
  const parId = new Map((q.answers ?? []).map((a) => [String(a.id), a]));
  if (parId.size !== famille.attendu.length) {
    stop(
      3,
      `« ${famille.question} » a ${parId.size} réponse(s), attendu ${famille.attendu.length}.`,
      "  Le questionnaire a changé de forme : relire l'application avant de suivre.",
    );
  }
  const parNiveau = {};
  const urls = {};
  for (const { id, role, fichierAttendu } of famille.attendu) {
    const a = parId.get(id);
    if (!a) stop(3, `« ${famille.question} » n'a pas de réponse d'identifiant ${id}.`);
    if (!a.img) {
      stop(
        3,
        `La réponse ${id} de « ${famille.question} » n'a pas d'image (\`img\` absent).`,
        "  C'est cette image qui EST l'association : sans elle il n'y a rien à importer.",
      );
    }
    /* Le contrôle qui compte. Voir l'en-tête : quatre bruns voisins, un décalage invisible. */
    const nom = basename(String(a.img)).replace(/\.[a-z0-9]+$/i, "");
    if (nom !== fichierAttendu) {
      stop(
        4,
        `Association inattendue : la réponse ${id} de « ${famille.question} » porte « ${nom} », attendu « ${fichierAttendu} ».`,
        "  Le service a réordonné ou renommé ses visuels. Poursuivre associerait le mauvais",
        "  visuel au bon niveau, sans qu'aucune erreur ne le signale — d'où l'arrêt.",
      );
    }
    parNiveau[id] = role;
    urls[role] = String(a.img);
  }
  return { parNiveau, urls };
}

// ─── 3. les octets ──────────────────────────────────────────────────────────
const MAGIQUE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Le magique PNG, vérifié sur huit octets. Voir `obtenir()` pour la raison. */
function exigerPng(octets, quoi) {
  if (!octets.subarray(0, 8).equals(MAGIQUE_PNG)) {
    stop(5, `${quoi} n'est pas un PNG (${octets.length} octets).`);
  }
  return octets;
}

/**
 * Les octets d'un visuel : relus sur le disque sous `--json`, téléchargés sinon.
 *
 * ⚠️ **Le contrôle du magique PNG s'applique aussi au fichier local.** Un seau public peut servir
 * une page d'erreur en 200 — c'est la raison d'origine — mais un fichier tronqué par un import
 * interrompu produirait exactement la même empreinte fausse, et celle-ci serait promise pour un an
 * par la règle de cache. Se fier au `Content-Type` ferait par ailleurs confiance à ce qu'on veut
 * justement vérifier.
 */
async function obtenir(role, url) {
  const local = join(SORTIE_IMG, `${role}.png`);
  if (JSON_LOCAL) {
    try {
      return { octets: exigerPng(readFileSync(local), local), source: "disque" };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      console.warn(`  ! ${role} absent du disque : téléchargé malgré --json`);
    }
  }
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    stop(5, `Impossible de télécharger ${url}`, `  ${e.message}`);
  }
  if (!r.ok) stop(5, `${url} répond ${r.status} ${r.statusText}`);
  return { octets: exigerPng(Buffer.from(await r.arrayBuffer()), url), source: "réseau" };
}

// ─── assemblage ─────────────────────────────────────────────────────────────
const { texte, origine } = await lireQuestions();
let questionnaire;
try {
  questionnaire = JSON.parse(texte);
} catch (e) {
  stop(3, `${origine} n'est pas du JSON valide`, `  ${e.message}`);
}
const questions = questionnaire.questions;
if (!Array.isArray(questions)) stop(3, `${origine} n'a pas de tableau \`questions\`.`);

const jointures = Object.fromEntries(FAMILLES.map((f) => [f.cle, joindre(questions, f)]));

mkdirSync(SORTIE_IMG, { recursive: true });
/* La copie du questionnaire, écrite AVANT les images : si un téléchargement échoue, on garde de
   quoi rejouer sans réseau plutôt que de repartir de rien.

   Pas quand on la relit — réécrire `--json` par lui-même n'apporte rien et écraserait la copie
   par elle-même si le chemin passé EST celui de la copie, ce qui est le cas d'usage annoncé. */
if (!JSON_LOCAL) writeFileSync(SORTIE_QUESTIONS, texte);

/* **L'empreinte du jeu, mot pour mot celle de `extract-images.mjs`** — nom, séparateur, octets,
   séparateur, dans l'ordre trié des rôles. Elle a le même rôle et la même raison d'être : ces
   fichiers portent un nom stable, donc leur URL ne peut pas être `immutable` sans un `?v=` qui
   change quand le CONTENU change. Une empreinte pour le jeu entier, pas une par fichier : le
   répertoire est régénéré d'un bloc par ce script. */
const empreinteJeu = createHash("sha256");
const roles = Object.values(jointures)
  .flatMap((j) => Object.entries(j.urls))
  .sort(([a], [b]) => (a < b ? -1 : 1));
let copiees = 0;
let duDisque = 0;
for (const [role, url] of roles) {
  const { octets, source } = await obtenir(role, url);
  writeFileSync(join(SORTIE_IMG, `${role}.png`), octets);
  empreinteJeu.update(role).update("\0").update(octets).update("\0");
  copiees++;
  if (source === "disque") duDisque++;
}
/* Huit hexadécimaux : l'empreinte ne défend rien, elle distingue. */
const version = empreinteJeu.digest("hex").slice(0, 8);

writeFileSync(SORTIE_MAP, JSON.stringify({
  _: "Généré par scripts/import-bean-images.mjs — ne pas éditer à la main.",
  chemin: "/grains",
  // L'extension est dans la table et pas dans le code : la source est du PNG, et le jour où elle
  // livre autre chose, c'est ici que ça se lit — pas dans trois `?v=` répartis dans l'interface.
  extension: "png",
  // empreinte du jeu de fichiers écrits : sert de `?v=` et rend le cache immuable honnête
  version,
  // niveau de torréfaction (1 le plus clair, 4 le plus foncé) → nom de fichier, sans extension
  torrefaction: jointures.torrefaction.parNiveau,
  // aspect de la crema, MÊMES identifiants que `bean-adapt.mjs` : 1 claire, 2 foncée, 3 absente
  crema: jointures.crema.parNiveau,
  /* D'où viennent ces octets. Pas un ornement : c'est ce qui permet de relancer l'import, et de
     constater qu'une image a changé d'adresse sans avoir à relire l'APK. */
  source: { questionnaire: BASE + FICHIER_QUESTIONS, images: Object.fromEntries(roles) },
}, null, 1) + "\n");

console.log(`questionnaire : ${origine}`);
console.log(`  ${copiees} visuel(s) écrit(s) dans public/grains/${duDisque ? ` (${duDisque} relu(s) sur le disque)` : ""}`);
console.log(`  empreinte du jeu : ${version}`);
for (const { cle, quoi, attendu } of FAMILLES) {
  const j = jointures[cle];
  console.log(`  ${quoi} : ${attendu.map((a) => `${a.id}→${j.parNiveau[a.id]}`).join(", ")}`);
}
