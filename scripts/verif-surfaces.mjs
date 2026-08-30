/**
 * Vérifie **les surfaces**, dans un vrai navigateur — la seule chose de ce dépôt que ni `tsc`, ni
 * ESLint, ni les onze vérifications pures ne regardent.
 *
 * Il existe pour une migration précise : les surfaces passent du CSS écrit à la main aux composants
 * shadcn, et trois comportements qui étaient jusqu'ici des propriétés de la PLATEFORME deviennent
 * du code à écrire — le piège de focus d'un `<dialog>`, la fermeture par Échap, et l'échelle
 * imprimée sur la piste d'un curseur. Ce qui était gratuit devient une chose à prouver.
 *
 * ⚠️ **Il est écrit et vert AVANT la migration, contre l'interface actuelle.** Un test de
 * non-régression écrit après la régression ne prouve rien : il décrit le résultat obtenu. Celui-ci
 * ne vaut que parce qu'il a d'abord capturé la ligne de base.
 *
 * ── Ce sur quoi il affirme, et ce qu'il refuse d'affirmer ────────────────────────────────────
 *
 * Les repères sont **sémantiques** : un titre, un nom accessible, un rôle. Jamais un nom de classe.
 * C'est ce qui rend le script utile de part et d'autre de la migration — les classes vont toutes
 * changer, l'arbre d'accessibilité, lui, ne doit pas bouger. Un test qui aurait cherché `.card`
 * serait devenu rouge au premier fichier migré sans qu'aucun utilisateur ne perde quoi que ce soit.
 *
 * Il ne dit rien du dessin : ni couleur, ni espacement, ni position. `verif-contraste.mjs` couvre
 * les encres, et le reste se regarde. Prétendre le contraire demanderait des captures de référence,
 * donc un dossier d'images binaires à régénérer à chaque retouche — un coût que ce dépôt n'a pas
 * accepté pour les vignettes de boissons et qu'il n'y a pas de raison d'accepter ici.
 *
 * ── Chrome ───────────────────────────────────────────────────────────────────────────────────
 *
 * `puppeteer-core`, et NON `puppeteer` : `pnpm-workspace.yaml` refuse par principe les scripts
 * d'installation tiers, et le paquet complet en fait tourner un qui télécharge 150 Mo de Chromium.
 * On se branche donc sur un Chrome déjà installé — `CHROME_PATH`, sinon les emplacements usuels de
 * la plateforme. Sans Chrome, le script SAUTE en annonçant pourquoi plutôt que d'échouer : une
 * machine sans navigateur n'est pas une régression du produit.
 *
 * Usage : `node scripts/verif-surfaces.mjs` (ajouter `--montre` pour voir la fenêtre).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** La racine du dépôt, depuis ce fichier : `.next` et `src/` s'y trouvent. */
const RACINE_DEPOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MONTRE = process.argv.includes("--montre");
const PORT = 3127;
const BASE = `http://127.0.0.1:${PORT}`;

let ko = 0;
const test = (nom, fn) => Promise.resolve()
  .then(fn)
  .then(() => console.log("  ok   ", nom))
  .catch((e) => { ko++; console.log("  ÉCHEC", nom, "→", e.message); });
const vrai = (x, quoi) => { if (!x) throw new Error(quoi); };
const eq = (a, b, quoi) => { if (a !== b) throw new Error(`${quoi}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   TROUVER CHROME
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Les emplacements usuels, par plateforme. `CHROME_PATH` passe devant : c'est la variable que
 * `puppeteer-core` documente, celle que la CI d'Ubuntu remplit, et celle qu'on veut pouvoir
 * pointer sur un Chromium précis quand la machine en a plusieurs.
 */
const CHEMINS_CHROME = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

function trouverChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of CHEMINS_CHROME[process.platform] ?? []) if (c && existsSync(c)) return c;
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   LE BUILD — CE QUI EST RÉELLEMENT SERVI
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ **Ce script teste le BUILD, jamais les sources.** Il lance `node server.mjs` sans `--dev`,
 * donc `next({ dev: false })` : les pages servies sont celles du dernier `pnpm build`.
 *
 * **Défaut constaté, et c'est pourquoi ce bloc existe.** Une assertion neuve a été écrite contre un
 * composant neuf, lancée ici, et elle a échoué — non pas parce que le composant était faux, mais
 * parce que le `.next` du disque datait d'avant lui. Rien ne le disait : le serveur démarrait,
 * `/api/status` répondait (il est servi par `server.mjs` AVANT Next), les vingt autres assertions
 * restaient vertes, et seule la nouvelle était rouge — la lecture évidente étant « mon composant
 * est cassé ». L'inverse est tout aussi grave : une assertion écrite contre une vieille page peut
 * passer au VERT et ne rien prouver du code présent.
 *
 * D'où deux garde-fous, de sévérité différente et à dessein :
 *
 * - **pas de build du tout → on s'arrête**, et on ne SAUTE pas. Sauter est ce qui a laissé passer
 *   le problème : un contrôle sauté se lit comme « rien à signaler ».
 * - **build plus vieux que les sources → on avertit** sans échouer. La péremption ne se prouve pas
 *   par une date (un fichier peut être touché sans rien changer), et faire rougir la CI sur une
 *   heure de modification aurait produit exactement le genre d'échec qu'on finit par ignorer.
 *
 * ⚠️ `.github/workflows/ci.yml` lance ce script **avant** `pnpm build`. Sur un runner neuf il n'y a
 * donc aucun `.next`, et c'est le premier garde-fou qui parle.
 */
function etatDuBuild() {
  const marque = join(RACINE_DEPOT, ".next", "BUILD_ID");
  if (!existsSync(marque)) return { present: false };
  const dateBuild = statSync(marque).mtimeMs;
  /* La source la plus récemment touchée sous `src/`. Le build lit aussi `messages/` et
     `next.config.mjs`, mais l'interface — la seule chose que ce script regarde — vit là. */
  let plusRecente = 0;
  let coupable = null;
  const parcourir = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { parcourir(p); continue; }
      const m = statSync(p).mtimeMs;
      if (m > plusRecente) { plusRecente = m; coupable = p; }
    }
  };
  parcourir(join(RACINE_DEPOT, "src"));
  return { present: true, perime: plusRecente > dateBuild, coupable, dateBuild, plusRecente };
}

const build = etatDuBuild();
if (!build.present) {
  console.log("Aucun build Next (.next/BUILD_ID absent) — ARRÊT.");
  console.log("Ce script sert les pages du dernier `pnpm build`, pas les sources : sans build, il");
  console.log("ne mesurerait rien. Lancer `pnpm build`, puis relancer.");
  process.exit(2);
}
if (build.perime) {
  console.log("⚠ Le build est plus ancien qu'une source de `src/` — les pages servies peuvent");
  console.log(`  ne pas être celles qu'on croit tester (${build.coupable}).`);
  console.log("  Relancer `pnpm build` avant de conclure quoi que ce soit d'un échec.\n");
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   SEMER UNE BASE, DÉMARRER LE SERVEUR
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * **Des pages vides ne prouvent rien.** Sans identité ni bornes, `/` affiche vingt-huit cartes qui
 * disent toutes « bornes non lues », et le curseur qu'on veut tester n'existe pas. On sème donc le
 * minimum qui fait exister les commandes : le numéro de série (qui choisit le modèle, sans nuage),
 * et les bornes d'une boisson.
 *
 * Les valeurs sont fabriquées et inoffensives — aucune ne sort d'une vraie machine, et rien ici
 * n'atteint un appareil : le serveur démarre sans clé LAN, donc sans session possible.
 */
async function semer(dir) {
  process.env.DATA_DIR = dir;
  const store = await import("../src/lib/store.mjs");
  const { catalogFor, decodeRecipeBounds, paramInfo } = await import("../src/lib/beverages.mjs");
  const { encodeRecipeBounds } = await import("../src/lib/trame-bornes.mjs");
  const s = store.forMachine("m1");
  // 0132217055 → caractères 1-5 « 17055 » → ECAM 610.75.MB, la machine de développement.
  s.putProp("d270_serialnumber", {
    at: Date.now(), kind: "serialNumber",
    serial: "0132217055", machineName: "ECAM 610.75.MB", modelKey: "17055", hex: "",
  });
  const cible = catalogFor("17055").beverages.find((b) => b.id === 7);
  const params = [
    { id: 1, min: 20, def: 40, max: 180 },   // COFFEE, deux octets
    { id: 2, min: 0, def: 3, max: 5 },       // TASTE, un octet — c'est LUI qui porte les crans
    { id: 9, min: 20, def: 120, max: 400 },  // MILK
  ];
  const dec = decodeRecipeBounds(Buffer.from(encodeRecipeBounds(cible.id, params).bytes).toString("base64"));
  s.putProp(cible.bounds, {
    at: Date.now(), kind: "bounds",
    beverageId: dec.beverageId, exact: dec.exact, params: dec.params, hex: dec.hex,
  });
  /**
   * **La deuxième boisson semée, et elle l'est pour un cas que le cappuccino ne peut pas produire :
   * une recette COMPOSABLE.**
   *
   * Ce sont les bornes réelles de `d020_rec_mug_to_go`, défauts compris — et ce sont les DÉFAUTS qui
   * font le cas : les trois quantités en portent un à 0, sous leur propre minimum, donc « jamais
   * configurée par le modèle », donc `composable()` répond vrai et la carte offre des cases à
   * cocher. Les valeurs du profil sont à 0 elles aussi, comme sur l'appareil, donc les trois cases
   * s'ouvrent DÉCOCHÉES — l'état où la carte ne montait aucun curseur et taisait les bornes.
   *
   * Les octets, eux, ne sont pas fabriqués : ils passent par `encodeRecipeBounds` puis
   * `decodeRecipeBounds`, donc la base semée contient ce qu'un import réel y aurait écrit.
   */
  const mug = catalogFor("17055").beverages.find((b) => b.id === 26);
  const bornesMug = [
    { id: 24, min: 0, def: 1, max: 1 },
    { id: 1, min: 40, def: 0, max: 240 },   // COFFEE — défaut hors bornes
    { id: 2, min: 1, def: 3, max: 5 },
    { id: 9, min: 60, def: 0, max: 460 },   // MILK — défaut hors bornes
    { id: 4, min: 0, def: 0, max: 0 },      // BLEND — min == max, donc « imposé »
    { id: 12, min: 0, def: 0, max: 1 },
    { id: 28, min: 0, def: 0, max: 4 },
    { id: 25, min: 0, def: 2, max: 2 },
    { id: 15, min: 50, def: 0, max: 260 },  // HOT_WATER — défaut hors bornes
    { id: 27, min: 0, def: 255, max: 4 },   // INDEX_LENGTH — le marqueur « sans objet »
  ];
  const decMug = decodeRecipeBounds(Buffer.from(encodeRecipeBounds(mug.id, bornesMug).bytes).toString("base64"));
  s.putProp(mug.bounds, {
    at: Date.now(), kind: "bounds",
    beverageId: decMug.beverageId, exact: decMug.exact, params: decMug.params, hex: decMug.hex,
  });
  s.putProp(catalogFor("17055").profileProp(mug, 1), {
    /* Les octets MESURÉS de d058_1_rec_mug_to_go, pas un hex vide : c'est cette chaîne que le
       panneau technique affiche, donc la semer vide aurait rendu l'assertion creuse.
       d0 1c a6 f0 | profil 01 | boisson 1a | (01 0000) (02 03) (09 0000) (04 00) (0c 00) (1c 00)
       (19 02) (0f 0000) (1b ff) | CRC 37 9b — 29 octets, et le parcours tombe pile sur le CRC. */
    at: Date.now(), kind: "values", beverageId: mug.id, profileId: 1, exact: true,
    hex: "d0 1c a6 f0 01 1a 01 00 00 02 03 09 00 00 04 00 0c 00 1c 00 19 02 0f 00 00 1b ff 37 9b",
    params: [1, 2, 9, 4, 12, 28, 25, 15, 27].map((id) => ({
      id, ...paramInfo(id),
      value: id === 2 ? 3 : id === 25 ? 2 : id === 27 ? 255 : 0,
    })),
  });
  /* **Deux emplacements de grain, et ils font exister deux surfaces qui n'étaient pas testables.**
     Sans eux, `/beans` n'affiche que sa bibliothèque locale : ni le bloc « Visuel » d'une carte
     machine, ni l'import cloud qu'il contient n'ont d'endroit où apparaître, et les affirmer
     revenait à constater une absence. L'index 0 est joint exprès : c'est l'interrupteur
     « Bean Adapt (ON/OFF) », le cas qui NE doit pas recevoir de visuel.
     Valeurs fabriquées, comme les bornes ci-dessus — aucune ne sort d'une vraie machine. */
  s.putBeanSystem({ index: 0, name: "Bean Adapt (ON/OFF)", grinder: 0, temperature: 0, aroma: 0, visible: true, active: false });
  s.putBeanSystem({ index: 3, name: "Grain de banc", grinder: 4, temperature: 2, aroma: 3, visible: true, active: true });
  /* **Une photo d'UN pixel sur l'emplacement 3, et elle est nécessaire.** Elle ne montre rien : elle
     fait exister l'état « cet emplacement a une photo », donc la commande de retrait, qui n'a aucun
     endroit où apparaître sans elle. Affirmer son absence n'aurait rien vérifié du tout.
     `s3` et non `b3` — l'espace de noms des emplacements de la machine, distinct de celui des fiches
     mémorisées ; c'est le préfixe qui les tient séparés dans la même colonne. */
  s.putBeanImage("s3", "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
  return cible;
}

function demarrer(dir) {
  const enfant = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, DATA_DIR: dir, SERVER_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let journal = "";
  enfant.stdout.on("data", (d) => { journal += d; });
  enfant.stderr.on("data", (d) => { journal += d; });
  return { enfant, journal: () => journal };
}

/** Attendre que le serveur réponde, plutôt que dormir une durée choisie au hasard. */
async function attendre(ms = 30000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) return true;
    } catch { /* pas encore là */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   LES SURFACES, ET LEURS REPÈRES
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Un repère est un **nom accessible**, pas un sélecteur. `titre` est le `h1` attendu ; `noms` sont
 * des éléments qui doivent exister et être atteignables au clavier comme au lecteur d'écran.
 *
 * Les textes viennent de `messages/fr.json` et sont recopiés ici en toutes lettres délibérément :
 * lire la clé rendrait le test d'accord avec lui-même si quelqu'un vidait le catalogue. C'est la
 * même discipline que `verif-messages.mjs`, prise par l'autre bout.
 */
const SURFACES = [
  { url: "/", titre: "Boissons de la machine", noms: ["Préparer : Cappuccino", "Détails : Cappuccino"] },
  { url: "/machines", titre: "Machines", noms: [] },
  { url: "/systeme", titre: "Système", noms: [] },
  { url: "/profils", titre: "Profils", noms: [] },
  { url: "/beans", titre: "Bean Adapt", noms: [] },
  { url: "/recipes", titre: "Recettes", noms: [] },
  { url: "/reglages", titre: "Réglages de la machine", noms: [] },
  { url: "/statistiques", titre: "Statistiques d'utilisation", noms: [] },
  { url: "/pilotage", titre: "Pilotage local", noms: [] },
];

/**
 * **Deux bruits attendus, nommés — et c'est la seule forme d'exception acceptable.**
 *
 * Un `vrai(erreurs.length === 0)` aveugle aurait deux issues, toutes deux mauvaises : rouge en
 * permanence, donc ignoré, ou assoupli en « moins de trois erreurs », donc capable de laisser
 * passer une vraie. On nomme donc ce qu'on tolère, avec la raison, et **tout le reste échoue**.
 *
 * - `/favicon.ico` : le dépôt n'en contient pas. Chrome le demande de lui-même sur toute page.
 * - `/api/presence` → 409 : le garde-fou de `NEEDS_MACHINE` (`server.mjs:3652`). Sans clé LAN ni
 *   adresse, une écriture serait acceptée puis silencieusement perdue, et l'interface annoncerait
 *   « envoyé » pour un ordre qui n'atteindra jamais la machine. Le script sème délibérément cette
 *   situation — le refus est donc le produit qui marche, pas une régression.
 */
const BRUIT_ATTENDU = [
  { motif: /favicon\.ico/, raison: "le dépôt n'a pas de favicon" },
  { motif: /\/api\/presence/, raison: "409 attendu : ni clé LAN ni adresse dans la base semée" },
];

/** Les trois redirections : elles doivent RESTER des redirections, c'est leur seule fonction. */
const REDIRECTIONS = [
  { url: "/boissons", vers: "/" },
  { url: "/bean-adapt", vers: "/beans" },
  { url: "/cle-lan", vers: "/machines" },
];

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   LE SCRIPT
   ───────────────────────────────────────────────────────────────────────────────────────────── */

const chrome = trouverChrome();
if (!chrome) {
  console.log("Chrome introuvable — vérification SAUTÉE.");
  console.log("Pointer CHROME_PATH sur un binaire Chrome ou Chromium pour l'exécuter.");
  process.exit(0);
}
console.log(`Chrome : ${chrome}\n`);

const dir = mkdtempSync(join(tmpdir(), "verif-surfaces-"));
const cible = await semer(dir);
const serveur = demarrer(dir);
let navigateur;

try {
  if (!(await attendre())) throw new Error(`le serveur n'a pas répondu sur ${BASE}\n${serveur.journal()}`);

  const { default: puppeteer } = await import("puppeteer-core");
  navigateur = await puppeteer.launch({
    executablePath: chrome,
    headless: !MONTRE,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  console.log("Les surfaces — titre, repères, console propre");
  for (const s of SURFACES) {
    await test(`${s.url} — « ${s.titre} »`, async () => {
      const page = await navigateur.newPage();
      const erreurs = [];
      // La ressource fautive n'est PAS dans le texte de la console (« Failed to load resource »
      // et rien d'autre) : c'est la réponse HTTP qui la nomme. On écoute donc les deux, sinon on
      // ne pourrait ni excuser un bruit connu ni décrire une vraie erreur à qui la lira.
      const echecs = [];
      page.on("response", (r) => { if (r.status() >= 400) echecs.push(`${r.status()} ${r.url()}`); });
      page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
      page.on("pageerror", (e) => erreurs.push(String(e.message)));
      const rep = await page.goto(BASE + s.url, { waitUntil: "networkidle2", timeout: 30000 });
      eq(rep.status(), 200, "statut HTTP");
      const titre = await page.$eval("h1", (h) => h.textContent.trim()).catch(() => null);
      eq(titre, s.titre, "titre de niveau 1");
      for (const nom of s.noms) {
        const trouve = await page.$$eval(
          "button, a, [role=button]",
          (els, n) => els.some((e) => (e.getAttribute("aria-label") ?? e.textContent).trim().includes(n)),
          nom,
        );
        vrai(trouve, `repère « ${nom} » absent`);
      }
      // Les avertissements de développement de React ne sont pas des erreurs ; les erreurs, si.
      const restants = echecs.filter((e) => !BRUIT_ATTENDU.some((b) => b.motif.test(e)));
      vrai(restants.length === 0, `requête(s) en échec : ${restants.join(" | ")}`);
      // Une erreur de script n'a pas de réponse HTTP : elle se compte à part, et rien ne l'excuse.
      const scripts = erreurs.filter((e) => !/Failed to load resource/.test(e));
      vrai(scripts.length === 0, `${scripts.length} erreur(s) de script : ${scripts.slice(0, 2).join(" | ")}`);
      await page.close();
    });
  }

  console.log("\nLes redirections restent des redirections");
  for (const r of REDIRECTIONS) {
    await test(`${r.url} → ${r.vers}`, async () => {
      const page = await navigateur.newPage();
      await page.goto(BASE + r.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      const chemin = new URL(page.url()).pathname;
      eq(chemin, r.vers, "destination");
      await page.close();
    });
  }

  console.log("\nLe dialogue — ce que le <dialog> natif donnait gratuitement");

  /**
   * Ouvrir la confirmation d'une préparation. C'est le chemin de TOUTE action physique ou
   * persistante : rien ne part vers l'appareil sans passer par là. Le serveur tourne sans clé LAN,
   * donc rien ne peut partir — ce qui est testé est le dialogue, pas la commande.
   */
  const ouvrirConfirmation = async (page) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    const bouton = await page.$('button[aria-label="Préparer : Cappuccino"]');
    vrai(bouton, "le bouton « Préparer : Cappuccino » est introuvable");
    await bouton.click();
    await page.waitForSelector("dialog[open], [role=dialog], [role=alertdialog]", { timeout: 5000 });
  };

  await test("il s'ouvre, et le focus entre dedans", async () => {
    const page = await navigateur.newPage();
    await ouvrirConfirmation(page);
    const dedans = await page.evaluate(() => {
      const d = document.querySelector("dialog[open], [role=dialog], [role=alertdialog]");
      return d.contains(document.activeElement);
    });
    vrai(dedans, "le focus est resté hors du dialogue");
    await page.close();
  });

  /**
   * **Ce que « piégé » veut dire exactement**, mesuré sur le `<dialog>` natif avant d'être exigé de
   * son remplaçant : entre le dernier élément du dialogue et le premier, Chrome pose le focus sur
   * `<body>` pendant un tour. Le cycle inclut la racine du document, et c'est le comportement
   * NORMAL d'un dialogue modal.
   *
   * L'affirmation juste n'est donc pas « le focus reste dans le dialogue » — elle serait fausse
   * contre le natif lui-même — mais **« aucune tabulation n'atteint une commande du fond »**. Un
   * `<body>` ne s'actionne pas ; un bouton derrière, si. C'est cette seconde formulation qui décrit
   * le danger réel, et c'est la seule qui vaudra encore après la migration.
   */
  await test("le focus y est PIÉGÉ — douze tabulations n'atteignent aucune commande du fond", async () => {
    const page = await navigateur.newPage();
    await ouvrirConfirmation(page);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const fuite = await page.evaluate(() => {
        const d = document.querySelector("dialog[open], [role=dialog], [role=alertdialog]");
        const a = document.activeElement;
        if (!a || a === document.body || a === document.documentElement) return null;
        if (d.contains(a)) return null;
        return a.tagName + (a.getAttribute("aria-label") ?? a.textContent ?? "").trim().slice(0, 30);
      });
      vrai(!fuite, `la tabulation ${i + 1} a atteint « ${fuite} », hors du dialogue`);
    }
    await page.close();
  });

  /**
   * **La garantie qui compte vraiment sur une garde : Entrée ne valide pas.**
   *
   * Le `<dialog>` natif la tenait par un `autoFocus` sur le premier bouton du DOM. Radix, lui, pose
   * le focus sur le premier élément focusable du CONTENU — ce qui dépendrait de la présence de la
   * case « ne plus demander », donc du geste demandé. La promesse serait alors vraie un jour et
   * fausse le lendemain, sans que rien ne change dans ce fichier-ci.
   */
  await test("le focus se pose sur « Annuler », jamais sur « Confirmer »", async () => {
    const page = await navigateur.newPage();
    await ouvrirConfirmation(page);
    const actif = await page.evaluate(() => (document.activeElement?.textContent ?? "").trim());
    eq(actif, "Annuler", "élément focalisé à l'ouverture");
    await page.close();
  });

  await test("Échap le ferme", async () => {
    const page = await navigateur.newPage();
    await ouvrirConfirmation(page);
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));
    const ouvert = await page.$("dialog[open], [role=dialog], [role=alertdialog]");
    vrai(!ouvert, "le dialogue est resté ouvert après Échap");
    await page.close();
  });

  await test("le fond est inerte — un bouton derrière ne se clique pas", async () => {
    const page = await navigateur.newPage();
    await ouvrirConfirmation(page);
    const atteignable = await page.evaluate(() => {
      const d = document.querySelector("dialog[open], [role=dialog], [role=alertdialog]");
      const derriere = [...document.querySelectorAll("button")].find((b) => !d.contains(b));
      if (!derriere) return false;
      const r = derriere.getBoundingClientRect();
      const dessus = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return derriere.contains(dessus) || derriere === dessus;
    });
    vrai(!atteignable, "un bouton du fond reste cliquable sous le dialogue");
    await page.close();
  });

  console.log("\nLe curseur — l'échelle imprimée par --crans");

  await test(`« ${cible.label} » déplié porte ses commandes`, async () => {
    const page = await navigateur.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    await page.click('button[aria-label="Détails : Cappuccino"]');
    await page.waitForSelector('[role=slider], input[type=range]', { timeout: 5000 });
    const n = await page.$$eval('[role=slider], input[type=range]', (e) => e.length);
    vrai(n >= 3, `${n} commande(s) au lieu des 3 réglages semés`);
    await page.close();
  });

  /**
   * **L'échelle n'est pas décorative : elle dit combien de crans la machine a publiés.** Elle est
   * portée par `--crans`, posée sur la piste. Après migration la piste change de nœud — c'est
   * exactement pourquoi ce test cherche la propriété, pas le sélecteur qui la portait hier.
   */
  await test("l'arôme porte ses crans, armés par les bornes publiées", async () => {
    const page = await navigateur.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    await page.click('button[aria-label="Détails : Cappuccino"]');
    await page.waitForSelector('[role=slider], input[type=range]', { timeout: 5000 });
    const crans = await page.evaluate(() => {
      for (const el of document.querySelectorAll('[role=slider], input[type=range], [data-slot=slider]')) {
        for (const n of [el, el.parentElement, el.querySelector?.("*")]) {
          const v = n && getComputedStyle(n).getPropertyValue("--crans").trim();
          if (v) return v;
        }
      }
      return null;
    });
    vrai(crans, "aucune commande ne porte --crans");
    // L'arôme va de 0 à 5 : six positions, donc cinq intervalles.
    vrai(Number(crans) >= 2, `--crans vaut ${crans}, ce qui n'imprime aucune échelle`);
    await page.close();
  });

  /**
   * ── UNE QUANTITÉ DÉCLARÉE, MAIS DÉCOCHÉE ───────────────────────────────────────────────────
   *
   * Le mug de voyage est la seule boisson du catalogue que la machine livre **composable** : ses
   * trois quantités n'ont jamais été configurées, donc elles s'ouvrent décochées, donc aucun de ses
   * curseurs n'est monté. Ce qui restait de la carte ouverte tenait alors en une ligne — « Mélange 0
   * (imposé) » — et les bornes que la trame `0xB0` porte pourtant (40-240, 60-460, 50-260)
   * n'apparaissaient nulle part.
   *
   * **Rien de statique ne voit ça** : le composant rendait `false`, ce qui type-checke, lint et
   * s'affiche. Il faut un navigateur pour constater qu'il n'y a rien à l'écran.
   */
  console.log("\nUne quantité décochée — les bornes lues restent à l'écran");

  const ouvrirMug = async (page) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    await page.click('button[aria-label="Détails : Mug de voyage"]');
    await page.waitForSelector(".blocIngredient", { timeout: 5000 });
  };

  await test("les trois quantités s'ouvrent décochées, et chacune DIT son étendue", async () => {
    const page = await navigateur.newPage();
    await ouvrirMug(page);
    const coches = await page.$$eval(".blocIngredient [role=checkbox]", (e) => e.map((x) => x.getAttribute("aria-checked")));
    eq(coches.length, 3, "le mug de voyage ne présente pas ses trois ingrédients");
    vrai(coches.every((c) => c === "false"), `une case s'ouvre cochée : ${coches.join(", ")}`);
    /* Aucun curseur : c'est la moitié de l'affirmation. Sans elle, un test qui trouve les trois
       lignes resterait vert le jour où les curseurs reviendraient en double. */
    const curseurs = await page.$$eval(".blocEditeur [role=slider], .blocEditeur input[type=range]", (e) => e.length);
    eq(curseurs, 0, "un curseur est monté alors que les trois cases sont décochées");
    const lignes = await page.$$eval(".quantiteDecochee", (e) => e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
    eq(lignes.length, 3, "les lignes d'étendue manquent");
    for (const borne of ["40 à 240 ml", "60 à 460 ml", "50 à 260 ml"]) {
      vrai(lignes.some((l) => l.includes(borne)), `aucune ligne ne porte « ${borne} » — lu : ${lignes.join(" | ")}`);
    }
    await page.close();
  });

  await test("cocher « Café » monte le curseur sur les bornes de la trame, et sur son minimum", async () => {
    const page = await navigateur.newPage();
    await ouvrirMug(page);
    await page.click('.blocIngredient [role=checkbox][aria-label="Café"]');
    await page.waitForSelector(".blocEditeur [role=slider], .blocEditeur input[type=range]", { timeout: 5000 });
    const b = await page.$eval(".blocEditeur [role=slider], .blocEditeur input[type=range]", (e) => ({
      min: e.getAttribute("aria-valuemin") ?? e.min,
      max: e.getAttribute("aria-valuemax") ?? e.max,
      val: e.getAttribute("aria-valuenow") ?? e.value,
    }));
    eq(String(b.min), "40", "le minimum du curseur ne vient pas de la trame");
    eq(String(b.max), "240", "le maximum du curseur ne vient pas de la trame");
    /* Le défaut du modèle vaut 0, hors bornes : `valeurDepart` doit donc tomber sur le minimum, et
       surtout PAS sur 0 — ce serait une quantité que la machine refuse. */
    eq(String(b.val), "40", "le curseur ne part pas du minimum alors qu'aucun défaut n'est utilisable");
    const restantes = await page.$$eval(".quantiteDecochee", (e) => e.length);
    eq(restantes, 2, "cocher un ingrédient ne retire pas sa ligne d'étendue");
    await page.close();
  });

  /**
   * **Une trame lue que la carte ne montre pas est une lecture perdue.** Le panneau technique lisait
   * `bev.bounds ?? bev.values` : dès que les bornes étaient là, la trame de VALEURS (`0xA6`) — la
   * recette du profil, lue et enregistrée — n'apparaissait nulle part. Invisible à `tsc` comme à
   * `eslint` : le `??` est parfaitement typé.
   */
  await test("les DEUX trames lues sont sur la carte — bornes ET valeurs", async () => {
    const page = await navigateur.newPage();
    await ouvrirMug(page);
    /* Le panneau n'est monté qu'ouvert : on passe par le geste réel, le bouton de l'éditeur. */
    let ouvert = false;
    for (const b of await page.$$(".blocEditeur button")) {
      const txt = (await b.evaluate((e) => (e.textContent ?? "").trim())) || "";
      if (txt.includes("Infos techniques")) { await b.click(); ouvert = true; break; }
    }
    vrai(ouvert, "le bouton « Infos techniques » est introuvable sur la carte ouverte");
    await page.waitForSelector(".blocEditeur .kv", { timeout: 5000 });
    const lignes = await page.$$eval(".blocEditeur .kv", (e) => e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
    const bornes = lignes.find((l) => l.includes("Trame lue (bornes 0xB0)"));
    const valeurs = lignes.find((l) => l.includes("Trame lue (valeurs 0xA6)"));
    vrai(bornes, `la trame de bornes n'est pas affichée — lu : ${lignes.join(" | ")}`);
    vrai(valeurs, `la trame de VALEURS lue n'est pas affichée — lu : ${lignes.join(" | ")}`);
    vrai(bornes.includes("d0 37 b0 f0 1a"), "la trame de bornes affichée n'est pas celle qui a été semée");
    vrai(valeurs.includes("d0 1c a6 f0 01 1a"), "la trame de valeurs affichée n'est pas celle qui a été semée");
    await page.close();
  });

  /**
   * ── LE RAIL DE TORRÉFACTION ────────────────────────────────────────────────────────────────
   *
   * Quatre niveaux plus « non précisée », en `RadioGroupCran`. Ce que ce bloc défend est exactement
   * ce que le dépôt a déjà payé ailleurs et qu'aucun outil statique ne voit :
   *
   * 1. **Un `RadioGroupItem` de Radix est un `<button>`.** Son nom accessible vient de son CONTENU.
   *    Retirer le libellé visible sous l'image — parce qu'« on voit bien le grain » — produirait
   *    cinq boutons annoncés « bouton », en silence : la page s'affiche, le clic marche, et le
   *    choix devient inutilisable au lecteur d'écran. `tsc` et `eslint` n'en disent rien.
   * 2. **Les flèches déplacent le choix.** C'est le service que rendaient les `<input
   *    type="radio">` natifs et la seule raison de garder un groupe Radix plutôt que cinq boutons :
   *    si la navigation aux flèches disparaît, le rail reste beau et cesse d'être un choix.
   *
   * Le rail est atteint par le geste réel — ouvrir la carte « Nouvelle configuration » — et non par
   * une URL fabriquée : la base semée n'a aucun grain machine, cette carte-là est toujours présente.
   */
  console.log("\nLe rail de torréfaction — cinq crans, nommés et pilotables aux flèches");

  /** Ouvre le formulaire d'une configuration neuve sur /beans. Rend la poignée du groupe. */
  const RAIL = '[role=radiogroup][aria-labelledby$="-torrefaction-legende"]';
  const ouvrirRailTorrefaction = async (page) => {
    await page.goto(BASE + "/beans", { waitUntil: "networkidle2", timeout: 30000 });
    const boutons = await page.$$("button");
    let ouvert = false;
    for (const b of boutons) {
      const txt = (await b.evaluate((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim())) || "";
      if (txt.includes("Nouveau")) { await b.click(); ouvert = true; break; }
    }
    vrai(ouvert, "le bouton « Nouveau » de la carte de création est introuvable");
    /* ⚠️ **Pas `[role=radiogroup]` tout court.** La bascule de finition en est un aussi, et elle
       est plus haut dans le DOM : le sélecteur large a d'abord mesuré « Thème de l'interface »,
       donc un test vert-puis-rouge qui ne parlait pas du rail. On cible par le contrat du composant
       — l'identifiant de sa propre légende, `<prefixe>-torrefaction-legende`. */
    await page.waitForSelector(RAIL, { timeout: 5000 });
    return page.$(RAIL);
  };

  await test("les cinq crans portent un nom, et le groupe aussi", async () => {
    const page = await navigateur.newPage();
    const groupe = await ouvrirRailTorrefaction(page);
    vrai(groupe, "aucun groupe de radios sur le formulaire");
    // Le groupe est nommé par `aria-labelledby` : un <label> ne nomme pas un groupe.
    const nomGroupe = await page.evaluate((sel) => {
      const g = document.querySelector(sel);
      const id = g.getAttribute("aria-labelledby");
      return id ? (document.getElementById(id)?.textContent ?? "").trim() : (g.getAttribute("aria-label") ?? "").trim();
    }, RAIL);
    eq(nomGroupe, "Torréfaction", "nom accessible du groupe");
    const noms = await page.$$eval(`${RAIL} [role=radio]`, (els) =>
      els.map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim()));
    eq(noms.length, 5, "nombre de crans");
    const muets = noms.filter((n) => !n);
    vrai(muets.length === 0, `${muets.length} cran(s) sans nom accessible — un <button> vide s'annonce « bouton »`);
    // Le libellé du premier niveau est recopié en clair, même discipline que les repères ci-dessus.
    vrai(noms.some((n) => n.includes("Claire")), `« Claire » absent des crans : ${noms.join(" | ")}`);
    await page.close();
  });

  /**
   * **Espace choisit, puis la flèche déplace le choix** — les deux gestes du clavier, dans l'ordre.
   *
   * Trois états ont été mesurés dans un vrai navigateur avant d'écrire cette séquence, et le
   * deuxième est un piège :
   *
   * 1. un clic de souris ne fait pas entrer le focus dans le groupe (les cinq `tabindex` restent
   *    à -1) — une flèche n'a alors aucun point de départ ;
   * 2. un `focus()` posé PAR SCRIPT déplace bien le focus à la flèche, mais **pas la sélection** :
   *    Radix ne considère pas encore le groupe comme piloté au clavier. Affirmer « la flèche
   *    déplace le choix » depuis cet état-là décrivait donc un artefact du banc, pas le produit ;
   * 3. après un appui réel — Espace — la flèche déplace la sélection comme attendu.
   *
   * D'où la séquence : on entre par le cran coché (ce que fait une tabulation), on CHOISIT avec
   * Espace, puis on vérifie que la flèche emporte le choix. Les deux affirmations sont vraies du
   * produit, et chacune tomberait pour une raison distincte — Espace muet, ou rail figé.
   */
  await test("Espace choisit, et la flèche emporte le choix", async () => {
    const page = await navigateur.newPage();
    await ouvrirRailTorrefaction(page);
    // On entre par le cran coché : c'est là qu'une tabulation atterrit, et c'est lui qui porte le
    // pas de tabulation du groupe.
    await page.$eval(RAIL, (g) => {
      const radios = [...g.querySelectorAll("[role=radio]")];
      (radios.find((r) => r.getAttribute("aria-checked") === "true") ?? radios[0]).focus();
    });
    vrai(
      await page.$eval(RAIL, (g) => g.contains(document.activeElement)),
      "le focus n'entre pas dans le rail — aucune touche ne peut le piloter",
    );
    const coche = () => page.$eval(`${RAIL} [role=radio][aria-checked=true]`, (e) => (e.textContent ?? "").trim());
    const depart = await coche();

    // 1. Espace choisit le cran focalisé. On y arrive par la flèche pour ne pas rechoisir le même.
    await page.keyboard.press("ArrowRight");
    await new Promise((r) => setTimeout(r, 150));
    await page.keyboard.press("Space");
    await new Promise((r) => setTimeout(r, 250));
    const choisi = await coche();
    vrai(choisi !== depart, `Espace n'a rien choisi (« ${depart} » avant comme après)`);

    // 2. La flèche emporte alors le choix, ce qui est le geste courant d'un rail de radios.
    await page.keyboard.press("ArrowRight");
    await new Promise((r) => setTimeout(r, 250));
    const deplace = await coche();
    vrai(deplace !== choisi, `la flèche droite n'a pas déplacé le choix (« ${choisi} » avant comme après)`);
    await page.close();
  });

  /**
   * Retourne la carte de l'emplacement semé (index 3, « Grain de banc ») et attend son dos.
   *
   * Par le déclencheur réel et par son contrat — `aria-controls` vers l'identifiant du dos — et non
   * par un libellé : c'est ce contrat que le reste de ce bloc mesure, donc le geste doit l'emprunter.
   */
  const DOS_BANC = '[aria-controls="dos-emplacement-3"]';
  const ouvrirDosEmplacement = async (page) => {
    await page.goto(BASE + "/beans", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector(DOS_BANC, { timeout: 5000 });
    await page.click(DOS_BANC);
    /* Le dos n'est monté qu'à la première ouverture — voir l'en-tête de `CarteGrain.tsx` : sans
       cette attente, tout ce qui suit mesurerait une carte encore fermée. */
    await page.waitForSelector("#dos-emplacement-3", { timeout: 5000 });
    await page.waitForSelector(RAIL, { timeout: 5000 });
  };

  /**
   * ── LE DEMI-TOUR D'UNE CARTE DE GRAIN ──────────────────────────────────────────────────────
   *
   * Deux faces dans le même DOM, dont une invisible. `backface-visibility` ne cache qu'à l'ŒIL :
   * la face retournée reste tabulable et lisible par un lecteur d'écran si rien ne l'en empêche.
   * C'est exactement le genre de défaut qu'aucun outil statique ne voit — `tsc` compile, ESLint
   * passe, la page s'affiche, et le clavier traverse une carte que personne ne regarde.
   *
   * Trois affirmations, et chacune tomberait pour sa propre raison : `inert` retiré, `aria-hidden`
   * oublié, ou `aria-expanded` figé sur le déclencheur.
   */
  console.log("\nLa carte de grain se retourne — une seule face habitée à la fois");

  await test("la face qui n'est pas devant est inerte ET hors de l'arbre d'accessibilité", async () => {
    const page = await navigateur.newPage();
    await ouvrirDosEmplacement(page);
    const etat = await page.evaluate(() => {
      const dos = document.getElementById("dos-emplacement-3");
      const avant = dos.parentElement.querySelector(".grainFace:not(.grainDos)");
      const lire = (e) => ({ inert: e.hasAttribute("inert"), cache: e.getAttribute("aria-hidden") === "true" });
      return { dos: lire(dos), avant: lire(avant) };
    });
    // Le dos est devant : c'est lui qui doit être habité, et l'affiche qui doit se retirer.
    vrai(!etat.dos.inert, "le dos est `inert` alors qu'il fait face — il est inutilisable");
    vrai(!etat.dos.cache, "le dos est `aria-hidden` alors qu'il fait face");
    vrai(etat.avant.inert, "l'affiche retournée n'est pas `inert` — le clavier la traverse en aveugle");
    vrai(etat.avant.cache, "l'affiche retournée n'est pas `aria-hidden` — la carte se lit deux fois");
    await page.close();
  });

  await test("le déclencheur dit s'il est ouvert, et vers quoi", async () => {
    const page = await navigateur.newPage();
    await page.goto(BASE + "/beans", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector(DOS_BANC, { timeout: 5000 });
    /* ⚠️ **Avant l'ouverture il n'y a qu'UN déclencheur**, pas deux : le dos n'est pas monté. C'est
       la garantie qu'une grille fermée n'a aucun pas de tabulation en trop, même si `inert` venait
       à manquer un jour. */
    eq(await page.$$eval(DOS_BANC, (e) => e.length), 1, "déclencheurs avant ouverture");
    eq(await page.$eval(DOS_BANC, (e) => e.getAttribute("aria-expanded")), "false", "aria-expanded fermé");
    await ouvrirDosEmplacement(page);
    const ouverts = await page.$$eval(DOS_BANC, (els) => els.map((e) => e.getAttribute("aria-expanded")));
    eq(ouverts.length, 2, "déclencheurs après ouverture (un par face)");
    vrai(
      ouverts.every((v) => v === "true"),
      `un déclencheur reste annoncé fermé alors que le dos est devant : ${ouverts.join(" | ")}`,
    );
    await page.close();
  });

  /**
   * **La hauteur suit la face visible, et c'est ce qui rend le demi-tour supportable.**
   *
   * Le dos fait deux à trois fois l'affiche. Si le plateau gardait la hauteur de l'affiche, le dos
   * déborderait derrière la carte suivante ; s'il gardait celle du dos, les six affiches fermées
   * seraient trois fois trop hautes. La mesure est faite en JavaScript et posée en pixels — donc
   * elle peut être fausse sans que rien ne lève, et c'est pour ça qu'elle est vérifiée ici.
   */
  await test("le plateau prend la hauteur de la face visible, pas celle de l'autre", async () => {
    const page = await navigateur.newPage();
    await page.goto(BASE + "/beans", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector(DOS_BANC, { timeout: 5000 });
    const hauteurPlateau = () => page.evaluate(() =>
      Math.round(document.querySelector(".carteGrain .grainPlateau").getBoundingClientRect().height));
    const ferme = await hauteurPlateau();
    await ouvrirDosEmplacement(page);
    // La transition dure 340 ms : on lui laisse le temps de finir avant de mesurer.
    await new Promise((r) => setTimeout(r, 700));
    const ouvert = await hauteurPlateau();
    vrai(ouvert > ferme + 100, `le plateau n'a pas suivi le dos (${ferme} px fermé, ${ouvert} px ouvert)`);
    const ecart = await page.evaluate(() => {
      const p = document.querySelector(".carteGrain .grainPlateau");
      const dos = document.getElementById("dos-emplacement-3");
      return Math.abs(Math.round(p.getBoundingClientRect().height) - Math.round(dos.getBoundingClientRect().height));
    });
    vrai(ecart <= 2, `le plateau et le dos ne font pas la même hauteur (${ecart} px d'écart)`);
    await page.close();
  });

  /**
   * **Le demi-tour ne doit pas DÉPLACER la photo, et c'est mesurable.**
   *
   * L'affiche de la face avant et le bouton-photo du dos montent le même `AfficheGrain` : c'est ce
   * qui fait que la carte tourne autour d'un rectangle immobile. Deux cadres déclarés séparément
   * rendraient une carte parfaitement correcte à l'œil fixe et une image qui saute d'un cran au
   * moment de la rotation — un défaut qu'aucun outil statique ne voit, et qu'on ne voit soi-même
   * qu'en regardant la bonne carte au bon moment.
   *
   * Les deux faces coexistent dans la même case de grille, donc les deux rectangles se mesurent
   * ENSEMBLE, carte ouverte. Une rotation de 180° autour de Y sans translation en Z ne change ni la
   * boîte ni l'échelle : les quatre nombres doivent coïncider.
   */
  await test("le dos ouvre sur le même cadre que l'affiche, à la même place", async () => {
    const page = await navigateur.newPage();
    await ouvrirDosEmplacement(page);
    /* ⚠️ **Mesurer à l'ARRÊT, et pas dès que le dos existe.** Sans cette attente, cette assertion
       rendait 126 px une fois sur deux : la carte est encore en train de grandir (transition de
       340 ms) et la grille de se réarranger autour d'elle. Une assertion qui tombe une fois sur
       deux est une assertion qu'on finit par désarmer. */
    await new Promise((r) => setTimeout(r, 700));
    const ecarts = await page.evaluate(() => {
      const dos = document.getElementById("dos-emplacement-3");
      const rotor = dos.parentElement;
      const avant = rotor.querySelector(".grainFace:not(.grainDos) > .afficheGrain");
      const bouton = dos.querySelector("button.photoAffiche");
      if (!avant || !bouton) return { manque: !avant ? "affiche avant" : "bouton photo du dos" };
      const cadre = bouton.querySelector(".afficheGrain");
      if (!cadre) return { manque: "cadre dans le bouton du dos" };
      const a = avant.getBoundingClientRect();
      const b = cadre.getBoundingClientRect();
      return {
        x: Math.abs(a.x - b.x), y: Math.abs(a.y - b.y),
        l: Math.abs(a.width - b.width), h: Math.abs(a.height - b.height),
        largeur: Math.round(b.width),
        /* Le sceau est ce qui dit au DOIGT que ce poster se clique : il n'y a pas de survol sur un
           écran tactile, et l'affiche fait la largeur de la carte. Son absence rendrait le geste
           indevinable sans rien casser. */
        sceau: !!bouton.querySelector(".photoSceau"),
        nom: (bouton.getAttribute("aria-label") ?? "").trim(),
      };
    });
    vrai(!ecarts.manque, `introuvable : ${ecarts.manque}`);
    for (const [cle, libelle] of [["x", "abscisse"], ["y", "ordonnée"], ["l", "largeur"], ["h", "hauteur"]]) {
      vrai(ecarts[cle] <= 2, `le cadre du dos n'a pas la même ${libelle} que l'affiche (${Math.round(ecarts[cle])} px d'écart)`);
    }
    /* Une affiche qui serait retombée à la vignette de 6,5 rem d'avant (104 px) passerait les
       quatre écarts ci-dessus — ils comparent les deux faces entre elles, pas à une taille. */
    vrai(ecarts.largeur > 200, `le cadre du dos ne fait que ${ecarts.largeur} px de large — ce n'est plus une affiche`);
    vrai(ecarts.sceau, "le bouton-photo du dos n'a pas de sceau : rien ne dit à un doigt qu'il se clique");
    vrai(!!ecarts.nom, "le bouton-photo du dos n'a pas de nom accessible");
    await page.close();
  });

  /**
   * **Le titre du dos est parti de l'œil, pas de la structure.**
   *
   * Le nom se lisait trois fois sur une carte retournée ; celui qui a été retiré est le `<h3>`
   * visible. Or l'affiche est `aria-hidden` quand le dos fait face : le retirer tout court aurait
   * fait passer la page de six titres de carte à cinq dès qu'on en ouvre une, sans que rien ne le
   * signale. Il reste donc en `sr-only`, et son remplaçant visuel — le déclencheur en coin — porte
   * un nom qui NOMME LE GRAIN.
   */
  await test("la face retournée garde son titre dans l'arbre, et son bouton nomme le grain", async () => {
    const page = await navigateur.newPage();
    await ouvrirDosEmplacement(page);
    const etat = await page.evaluate(() => {
      const dos = document.getElementById("dos-emplacement-3");
      const h3 = dos.querySelector("h3");
      const coin = dos.querySelector("button.grainDosRetour");
      return {
        titre: (h3?.textContent ?? "").trim(),
        // `sr-only` : présent dans l'arbre, nul à l'écran. Les deux moitiés comptent.
        titreVisible: h3 ? Math.round(h3.getBoundingClientRect().width) : -1,
        nomCoin: (coin?.getAttribute("aria-label") ?? "").trim(),
        libelleCoin: (coin?.textContent ?? "").trim(),
      };
    });
    vrai(!!etat.titre, "le dos n'a plus aucun titre — la carte disparaît du plan des titres une fois retournée");
    vrai(etat.titreVisible <= 2, `le titre du dos occupe ${etat.titreVisible} px : il est redevenu visible, donc le nom se lit deux fois`);
    vrai(!!etat.nomCoin, "le déclencheur en coin n'a pas d'aria-label — un bouton d'icône s'annonce « bouton »");
    vrai(
      etat.nomCoin.includes(etat.titre),
      `le nom du déclencheur ne nomme pas le grain : « ${etat.nomCoin} » ne contient pas « ${etat.titre} »`,
    );
    vrai(!etat.libelleCoin, `le déclencheur du dos a reçu un libellé visible (« ${etat.libelleCoin} ») : il redouble son aria-label`);
    await page.close();
  });

  /**
   * **Retirer la photo est la seule commande destructrice du formulaire, et elle est en icone.**
   *
   * Deux défauts possibles, tous les deux muets. Un bouton d'icône sans `aria-label` s'annonce
   * « bouton » — et celui-ci efface un visuel. Et il est posé EN SURIMPRESSION sur un autre bouton
   * (le poster, qui ouvre le sélecteur de fichiers) : si l'ordre d'empilement se retournait, le
   * poster avalerait le clic, ce qui donne un bouton parfaitement visible et parfaitement mort.
   *
   * ⚠️ **La seconde se vérifie par un VRAI clic à la souris, pas par `elementFromPoint`.** Cette
   * carte vit dans un sous-arbre `transform-style: preserve-3d` doublement retourné (rotor 180°,
   * face 180°), et Chrome y rend le ROTOR pour n'importe quel point : mesuré, et c'est une limite
   * de la fonction, pas un défaut de la page. Un clic aux coordonnées, lui, atteint bien la
   * commande — donc c'est lui qui fait foi, et son EFFET qui est constaté. Ce test-là couvre aussi
   * ce qu'aucune assertion de position ne couvrirait : que le retrait retire.
   */
  await test("retirer la photo : nommé, sur l'image, et le clic l'efface", async () => {
    const page = await navigateur.newPage();
    await ouvrirDosEmplacement(page);
    await new Promise((r) => setTimeout(r, 700));
    const avant = await page.evaluate(() => {
      const dos = document.getElementById("dos-emplacement-3");
      const boutons = dos.querySelectorAll("button.photoRetirer");
      if (boutons.length !== 1) return { nombre: boutons.length };
      const b = boutons[0];
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      const poster = dos.querySelector("button.photoAffiche").getBoundingClientRect();
      return {
        nombre: 1,
        nom: (b.getAttribute("aria-label") ?? "").trim(),
        texte: (b.textContent ?? "").trim(),
        dedans: r.x >= poster.x - 1 && r.y >= poster.y - 1 && r.bottom <= poster.bottom + 1 && r.right <= poster.right + 1,
        /* 36 px, le palier `coquille`. Au-dessous, une cible tactile posée sur une image devient un
           piège : on manque le retrait et on ouvre le sélecteur de fichiers à la place. */
        cote: Math.round(Math.min(r.width, r.height)),
        photo: !!dos.querySelector(".afficheGrainPhoto"),
        clic: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)],
      };
    });
    eq(avant.nombre, 1, "boutons « retirer la photo » dans le dos");
    vrai(!!avant.nom, "le bouton de retrait n'a pas d'aria-label — la commande qui efface s'annonce « bouton »");
    vrai(!avant.texte, `le bouton de retrait a repris un libellé visible (« ${avant.texte} »)`);
    vrai(avant.dedans, "le bouton de retrait n'est pas posé sur l'image");
    vrai(avant.cote >= 32, `la cible du retrait ne fait que ${avant.cote} px`);
    vrai(avant.photo, "l'emplacement semé n'a pas de photo : il n'y a rien à retirer, donc rien à vérifier");

    await page.mouse.click(avant.clic[0], avant.clic[1]);
    /* Rien ne part au serveur : `PhotoGrains` rend `null` à son hôte, et le brouillon change. Ce
       qu'on constate est donc bien la conséquence du clic sur CE bouton — un clic avalé par le
       poster aurait ouvert un sélecteur de fichiers et laissé la photo en place. */
    const apres = await page.evaluate(() => {
      const dos = document.getElementById("dos-emplacement-3");
      return {
        photo: !!dos.querySelector(".afficheGrainPhoto"),
        retrait: dos.querySelectorAll("button.photoRetirer").length,
      };
    });
    vrai(!apres.photo, "le clic n'a pas retiré la photo : le poster a avalé le clic du bouton posé dessus");
    eq(apres.retrait, 0, "le bouton de retrait subsiste alors qu'il n'y a plus de photo à retirer");
    await page.close();
  });

  /**
   * ── L'IMPORT CLOUD, ET SA GARDE ────────────────────────────────────────────────────────────
   *
   * C'est le seul geste de `/beans` qui sorte du réseau local, et il **écrase** la photo locale de
   * l'emplacement. Deux raisons de passer par la confirmation partagée, et une raison de le
   * vérifier dans un navigateur : `window.confirm` rend `false` dans une iframe en bac à sable, et
   * un bouton qui appelle directement l'API se serait comporté correctement partout SAUF là — le
   * genre de régression qu'aucun test pur ne voit.
   *
   * Deux affirmations, et la seconde est celle qui compte : le bouton n'est offert QUE dans le DOS
   * d'un emplacement, et il passe par le dialogue.
   */
  console.log("\nL'import cloud — hors du réseau local, donc sous garde");

  await test("l'import n'est offert QUE dans le dos d'un emplacement", async () => {
    const page = await navigateur.newPage();
    // Le libellé est recopié en clair, même discipline que les repères de SURFACES.
    const compter = () => page.$$eval("button", (els) =>
      els.map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim())
        .filter((t) => t.includes("Importer du cloud")).length);
    await page.goto(BASE + "/beans", { waitUntil: "networkidle2", timeout: 30000 });
    /* Zéro AVANT ouverture : la bibliothèque locale, la carte de création et la grille fermée ne
       parlent à aucun cloud. Un import qui traînerait là serait un appel réseau qu'aucune phrase
       n'annonce. */
    eq(await compter(), 0, "imports offerts avant de retourner une carte");
    await ouvrirDosEmplacement(page);
    eq(await compter(), 1, "imports offerts dans le dos ouvert");
    await page.close();
  });

  await test("il passe par le dialogue, qui prévient que l'appel sort du réseau local", async () => {
    const page = await navigateur.newPage();
    /* **Un `window.confirm` natif ferait échouer ce test, et c'est le but.** Il rend `false` dans
       une iframe en bac à sable, ce qui rendrait le bouton inerte sans un mot. On l'intercepte pour
       le prouver plutôt que de faire confiance au code. */
    let natif = false;
    page.on("dialog", async (d) => { natif = true; await d.dismiss(); });
    await ouvrirDosEmplacement(page);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => ((x.getAttribute("aria-label") ?? x.textContent) ?? "").includes("Importer du cloud"));
      b.click();
    });
    await page.waitForSelector("dialog[open], [role=dialog], [role=alertdialog]", { timeout: 5000 });
    vrai(!natif, "un window.confirm natif s'est ouvert — inerte dans une iframe en bac à sable");
    const texte = await page.$eval("dialog[open], [role=dialog], [role=alertdialog]", (d) => d.textContent ?? "");
    /* L'avertissement doit NOMMER ce qui sort et ce qui est écrasé. Une confirmation qui ne dit que
       « confirmer ? » ne donne pas de quoi décider. */
    vrai(/réseau local/i.test(texte), `le dialogue ne dit pas que l'appel sort du réseau local : « ${texte.slice(0, 120)} »`);
    vrai(/remplace/i.test(texte), `le dialogue ne dit pas que la photo locale est remplacée : « ${texte.slice(0, 120)} »`);
    await page.close();
  });

  console.log("\nLe choix d'un profil");

  /**
   * **Le choix se compte une fois la liste OUVERTE, et c'est la migration qui l'impose.**
   *
   * Un `<select>` natif porte ses `<option>` dans le document en permanence ; une liste déclarative
   * ne les monte qu'à l'ouverture, dans un portail. Compter sans ouvrir aurait donc rendu zéro et
   * on aurait cru la liste vide. Ouvrir est aussi ce que fait un utilisateur — l'assertion décrit
   * maintenant le geste plutôt que la structure.
   */
  await test("les cinq profils sont proposés, et atteignables", async () => {
    const page = await navigateur.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    const natif = await page.$("#profil-actif");
    vrai(natif, "le choix du profil actif est introuvable");
    const n = await page.evaluate(() => document.querySelector("select")?.options.length ?? 0);
    if (n) { vrai(n >= 5, `${n} profil(s) proposé(s) au lieu de 5`); await page.close(); return; }
    await natif.click();
    await page.waitForSelector("[role=option]", { timeout: 5000 });
    const ouverts = await page.$$eval("[role=option]", (e) => e.length);
    vrai(ouverts >= 5, `${ouverts} profil(s) proposé(s) au lieu de 5`);
    await page.close();
  });

  await test("le choix du profil s'annonce comme une liste, au clavier comme au lecteur", async () => {
    const page = await navigateur.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    const role = await page.$eval("#profil-actif", (e) => e.tagName === "SELECT" ? "combobox" : e.getAttribute("role"));
    eq(role, "combobox", "rôle du déclencheur");
    // Une liste qu'on ne peut pas atteindre à la tabulation n'est pas une liste, c'est une image.
    const focusable = await page.$eval("#profil-actif", (e) => e.tabIndex >= 0 || e.tagName === "SELECT");
    vrai(focusable, "le choix du profil n'est pas atteignable au clavier");
    await page.close();
  });

  /**
   * ── LA LIMITE D'UNE TOUCHE DE BOISSON ──────────────────────────────────────────────────────
   *
   * **Ce script est resté vert pendant que la limite valait 1,30:1.** Il vérifiait que la page
   * s'affiche, pas qu'on distingue une boisson de sa voisine — et les 28 touches du clavier se
   * lisaient comme une seule dalle grise. Le défaut a été vu à l'œil, pas attrapé ici. C'est la
   * raison d'être de ce bloc : une limite qui SÉPARE deux commandes est de l'information, et son
   * seuil est 3:1 (WCAG 1.4.11, élément non textuel).
   *
   * Il se mesure **dans les deux finitions**, parce que la parité clair/sombre est une contrainte
   * de produit et que les deux arêtes s'y INVERSENT : en graphite c'est le reflet du bas qui porte
   * la limite, en aluminium c'est l'ombre du haut. Une seule finition mesurée aurait laissé
   * l'autre partir à 1,45:1 sans rien dire.
   */
  console.log("\nLa touche de boisson — une limite qu'on voit");

  /** Luminance relative WCAG d'un `rgb(...)` rendu par le navigateur. */
  const luminance = (rgb) => {
    const [r, v, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number);
    const c = (x) => (x / 255 <= 0.04045 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c(r) + 0.7152 * c(v) + 0.0722 * c(b);
  };
  const contraste = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  for (const finition of ["dark", "light"]) {
    await test(`${finition === "dark" ? "graphite" : "aluminium"} — la touche fermée se détache du panneau`, async () => {
      const page = await navigateur.newPage();
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: finition }]);
      await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
      const m = await page.evaluate(() => {
        const el = document.querySelector('.cards.clavier > [data-slot="card"]');
        if (!el) return null;
        const style = getComputedStyle(el);
        // `box-shadow` calculé : une couche par virgule HORS parenthèses — les `rgb(...)` en
        // contiennent, donc on ne peut pas découper naïvement sur la virgule.
        const couches = [];
        let prof = 0, courant = "";
        for (const ch of style.boxShadow) {
          if (ch === "(") prof++;
          else if (ch === ")") prof--;
          if (ch === "," && prof === 0) { couches.push(courant.trim()); courant = ""; } else courant += ch;
        }
        couches.push(courant.trim());
        return {
          panneau: getComputedStyle(document.body).backgroundColor,
          couches: couches.filter((c) => !/^rgba\(0, 0, 0, 0\)/.test(c)),
        };
      });
      vrai(m, "aucune touche de boisson sur la page d'accueil");

      // Les quatre arêtes, plus le trait de coupe : cinq couches. Deux seulement, c'est le ruban
      // haut/bas d'avant — un creux sans ses côtés.
      vrai(
        m.couches.length >= 5,
        `${m.couches.length} couche(s) d'ombre au lieu de 5 : le fraisage n'a pas ses quatre arêtes`,
      );
      vrai(
        m.couches.filter((c) => /inset/.test(c)).length === 4,
        "le fraisage doit porter exactement quatre arêtes intérieures",
      );

      // La limite est portée par l'arête la PLUS contrastée : c'est elle qu'on voit, et elle
      // change de côté selon la finition. Exiger les deux serait impossible — sous un panneau
      // aussi sombre que #26282a, aucun gris ne peut atteindre 3:1 en descendant.
      const couleurs = m.couches.map((c) => c.match(/rgba?\([^)]*\)/)?.[0]).filter(Boolean);
      const meilleur = Math.max(...couleurs.map((c) => contraste(c, m.panneau)));
      vrai(
        meilleur >= 3,
        `la limite de la touche plafonne à ${meilleur.toFixed(2)}:1 contre le panneau, sous le seuil de 3:1`,
      );
      await page.close();
    });
  }
} finally {
  if (navigateur) await navigateur.close().catch(() => {});
  serveur.enfant.kill();
  // SQLite garde le fichier ouvert un instant après la mort du processus, et Windows refuse alors
  // de l'effacer. Réessayer vaut mieux qu'échouer sur le ménage : une base temporaire oubliée dans
  // le dossier temporaire n'est pas un échec de vérification, et la faire passer pour un échec
  // rendrait le script rouge pour une raison qui ne concerne pas le produit.
  for (let i = 0; i < 10; i++) {
    try { rmSync(dir, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
}

console.log(ko ? `\n${ko} ÉCHEC(S)` : "\nToutes les surfaces sont vertes.");
process.exit(ko ? 1 : 0);
