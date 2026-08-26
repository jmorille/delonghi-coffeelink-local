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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const { catalogFor, decodeRecipeBounds } = await import("../src/lib/beverages.mjs");
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

  console.log("\nLe choix d'un profil");

  await test("les cinq profils sont proposés, et atteignables", async () => {
    const page = await navigateur.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    const n = await page.evaluate(() => {
      const natif = document.querySelector("select");
      if (natif) return natif.options.length;
      const decl = document.querySelector('[role=combobox]');
      return decl ? Number(decl.getAttribute("data-options") ?? 0) : 0;
    });
    vrai(n >= 5, `${n} profil(s) proposé(s) au lieu de 5`);
    await page.close();
  });
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
