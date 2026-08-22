/**
 * Rejoue le décodage du monitor sur des trames RÉELLES, sans la machine.
 *
 * `scripts/captures/*.json` sont trois préparations enregistrées sur l'appareil le 2026-08-22 :
 * un espresso (café seul), un espresso macchiato (lait puis café) et un lait chaud (lait seul).
 * Ces trois formes couvrent tous les cas que la progression peut prendre, et deux d'entre eux
 * ont livré un piège qu'aucune lecture du code décompilé n'aurait donné :
 *
 *   1. la fonction (octet 9) CHANGE en cours de boisson — 10 pour le lait, puis 7 pour le café ;
 *   2. le pourcentage est GLOBAL, il ne repart pas à zéro entre les deux phases ;
 *   3. **un lait chaud s'arrête à 90 % et retombe au repos sans jamais publier 100.**
 *
 * Le point 3 est la raison d'être de ce fichier : une barre de progression qui attendrait
 * `pourcent === 100` resterait bloquée sur cette boisson. Le seul signal de fin est le retour à
 * `f=7, e=0` (`auRepos`), et il faut qu'un futur remaniement ne puisse pas le casser en silence.
 *
 * Aucune dépendance : `node scripts/verif-monitor.mjs`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeMonitor, MONITOR_ETAPES, MONITOR_SWITCHES, MONITOR_ALARMS } from "../src/lib/monitor.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const CAPTURES = join(ICI, "captures");

let echecs = 0;
const ok = (nom, cond, detail = "") => {
  if (cond) return;
  echecs++;
  console.error(`  ÉCHEC — ${nom}${detail ? ` : ${detail}` : ""}`);
};

/** Les captures sont stockées en hexadécimal lisible ; le décodeur, lui, prend du base64. */
const b64 = (hex) => Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("base64");

const charger = (nom) =>
  JSON.parse(readFileSync(join(CAPTURES, `${nom}.json`), "utf8")).map((l) => ({
    ms: l.ms,
    ...decodeMonitor(b64(l.raw)),
  }));

// ── Le décodage lui-même, sur la trame de repos la plus souvent relevée ──────────────────────
{
  const m = decodeMonitor(b64("d0 12 75 0f 02 00 01 08 00 07 00 00 00 00 00 00 00 ce 67"));
  ok("état lu dans l'octet 4", m.stateByte === 0x02, `reçu ${m.stateByte}`);
  ok("fonction lue dans l'octet 9", m.fonction === 7, `reçu ${m.fonction}`);
  ok("étape lue dans l'octet 10", m.etape === 0, `reçu ${m.etape}`);
  ok("f=7,e=0 est le repos", m.auRepos === true);
  ok("au repos le pourcentage est null, pas 0", m.pourcent === null, `reçu ${m.pourcent}`);
  ok("au repos aucune étape n'est nommée", m.etapeCle === null, `reçu ${m.etapeCle}`);
}

// ── Une trame tronquée perd la progression, pas le reste ─────────────────────────────────────
{
  // Neuf octets : le minimum que `decodeMonitor` accepte (état + alarmes), pas de quoi lire 9-11.
  const m = decodeMonitor(b64("d0 12 75 0f 02 00 01 08 00"));
  ok("trame courte : l'état survit", m.stateByte === 0x02);
  ok("trame courte : fonction null", m.fonction === null, `reçu ${m.fonction}`);
  ok("trame courte : pourcentage null", m.pourcent === null, `reçu ${m.pourcent}`);
  // « Inconnu », pas « en cours » : l'interface teste `=== false` pour montrer une barre.
  ok("trame courte : au repos INCONNU, pas faux", m.auRepos === null, `reçu ${m.auRepos}`);
}

// ── Espresso : café seul, la fonction ne bouge pas ───────────────────────────────────────────
{
  const t = charger("espresso");
  const prepa = t.filter((x) => !x.auRepos);
  ok("espresso : une préparation est visible", prepa.length > 0);
  ok(
    "espresso : la fonction reste 7 du début à la fin",
    prepa.every((x) => x.fonction === 7),
    [...new Set(prepa.map((x) => x.fonction))].join(","),
  );
  ok("espresso : le pourcentage atteint 100", prepa.some((x) => x.pourcent === 100));
  ok(
    "espresso : le pourcentage ne décroît jamais",
    prepa.every((x, i) => i === 0 || x.pourcent >= prepa[i - 1].pourcent),
  );
  ok("espresso : la mouture est nommée", prepa.some((x) => x.etapeCle === "mouture"));
  ok("espresso : l'infusion est nommée", prepa.some((x) => x.etapeCle === "infusion"));
  ok("espresso : l'écoulement du café est nommé", prepa.some((x) => x.etapeCle === "cafe"));
  // Cinq étapes relevées (5, 6, 9, 10) ne sont nommées ni par l'app ni par nous : c'est VOULU.
  ok("espresso : les étapes inconnues restent null", prepa.some((x) => x.etapeCle === null));
  ok("espresso : la capture se termine au repos", t[t.length - 1].auRepos === true);
}

// ── Espresso macchiato : lait PUIS café, pourcentage continu ─────────────────────────────────
{
  const t = charger("espresso-macchiato");
  const prepa = t.filter((x) => !x.auRepos);
  const fonctions = prepa.map((x) => x.fonction);
  ok("macchiato : la fonction passe par 10 (lait)", fonctions.includes(10));
  ok("macchiato : puis par 7 (café)", fonctions.includes(7));
  ok(
    "macchiato : le lait vient AVANT le café",
    fonctions.lastIndexOf(10) < fonctions.indexOf(7),
    fonctions.join(","),
  );
  ok("macchiato : l'écoulement du lait est nommé", prepa.some((x) => x.etapeCle === "lait"));
  // Le point qui n'était pas devinable : le pourcentage ne se remet pas à zéro au changement de
  // phase. Relevé : le lait mène à 38, le café REPREND à 40.
  const finLait = prepa.filter((x) => x.fonction === 10).at(-1).pourcent;
  const debutCafe = prepa.find((x) => x.fonction === 7).pourcent;
  ok(
    "macchiato : le pourcentage est global, il ne repart pas de zéro",
    debutCafe >= finLait,
    `lait finit à ${finLait} %, café démarre à ${debutCafe} %`,
  );
  ok(
    "macchiato : le pourcentage ne décroît jamais, changement de phase compris",
    prepa.every((x, i) => i === 0 || x.pourcent >= prepa[i - 1].pourcent),
  );
  ok("macchiato : le pourcentage atteint 100", prepa.some((x) => x.pourcent === 100));
}

// ── Lait chaud : le cas qui interdit de se fier au 100 % ─────────────────────────────────────
{
  const t = charger("lait-chaud");
  const prepa = t.filter((x) => !x.auRepos);
  ok(
    "lait chaud : la fonction reste 10 du début à la fin",
    prepa.every((x) => x.fonction === 10),
    [...new Set(prepa.map((x) => x.fonction))].join(","),
  );
  ok("lait chaud : la chauffe est nommée", prepa.some((x) => x.etapeCle === "chauffe"));
  ok("lait chaud : l'écoulement du lait est nommé", prepa.some((x) => x.etapeCle === "lait"));
  // LE piège. Si cette assertion se met un jour à échouer parce que la machine publie 100, tant
  // mieux — mais il faudra le constater, pas le supposer.
  ok(
    "lait chaud : le 100 % n'est JAMAIS publié",
    !prepa.some((x) => x.pourcent === 100),
    `max relevé ${Math.max(...prepa.map((x) => x.pourcent))} %`,
  );
  ok(
    "lait chaud : la fin se voit quand même, au retour au repos",
    t[t.length - 1].auRepos === true,
  );
}

// ── Toute clé d'étape que le serveur peut émettre DOIT avoir un libellé ──────────────────────
// next-intl affiche la clé brute (« step_mouture ») quand le message manque : le défaut serait
// visible sur la page d'accueil, pendant une préparation, et invisible partout ailleurs.
{
  const messages = JSON.parse(readFileSync(join(ICI, "..", "messages", "fr.json"), "utf8"));
  const cles = new Set(Object.values(MONITOR_ETAPES).flatMap((f) => Object.values(f)));
  ok("la table d'étapes n'est pas vide", cles.size > 0);
  for (const c of cles) {
    ok(`l'étape « ${c} » a un libellé`, typeof messages.power?.[`step_${c}`] === "string");
  }
  // Le repli, emprunté quand aucun couple ne correspond — cinq étapes réelles sont dans ce cas.
  ok("le repli « en cours » a un libellé", typeof messages.power?.step_encours === "string");

  // **Capteurs et alarmes : le protocole et le catalogue doivent rester en face.** Les deux
  // tables vivent dans `monitor.mjs` et leurs libellés dans `messages/fr.json` ; une entrée
  // ajoutée d'un côté et oubliée de l'autre s'affiche en identifiant brut, et seulement quand ce
  // capteur-là se déclenche — c'est-à-dire rarement, et jamais chez le développeur.
  for (const sw of MONITOR_SWITCHES) {
    ok(`le capteur « ${sw.name} » a un libellé`, typeof messages.sensor?.[sw.name] === "string");
  }
  for (const nom of Object.values(MONITOR_ALARMS)) {
    ok(`l'alarme « ${nom} » a un libellé`, typeof messages.alarm?.[nom] === "string");
  }
}

// ── Le repos se lit sur l'ÉTAPE seule : la fonction 12 existe ────────────────────────────────
// Mesure du 2026-08-22, en retirant physiquement la carafe a lait : au repos avec la carafe
// branchee la machine dit `f=12, e=0`, sans elle `f=7, e=0`. Le predicat de l'app (`f==7 && e==0`)
// lisait donc « preparation en cours » en permanence des que la carafe etait en place.
{
  const t = charger("carafe");
  ok("carafe : deux trames", t.length === 2);
  ok("carafe branchee : la fonction vaut 12", t[0].fonction === 12, `reçu ${t[0].fonction}`);
  ok("carafe branchee : c'est POURTANT le repos", t[0].auRepos === true);
  ok("carafe branchee : aucun pourcentage affiché", t[0].pourcent === null);
  ok("carafe retirée : la fonction revient à 7", t[1].fonction === 7, `reçu ${t[1].fonction}`);
  ok("carafe retirée : toujours le repos", t[1].auRepos === true);
}

// ── Les DEUX bits « carafe » disent la meme chose, a la molette pres ─────────────────────────
// Mesure du 2026-08-22, carafe laissee en place, seule la molette bougeant :
//   nettoyage -> octet 6 = 0b00000010 (bit 1.1 CIOCCO_TANK) ; toute autre position -> 0b00000001
//   (bit 1.0 IFD_CARAFFE) ; carafe retiree -> 0b00000000. Jamais les deux ensemble.
// Le detecteur ne connait qu'UNE frontiere : nettoyage ou pas. Trois positions hors nettoyage
// (mousse au cran courant, mousse au minimum, graduation « insert ») donnent une trame identique
// octet pour octet — elles ne sont donc pas archivees, une capture en double ne prouve rien de
// plus.
//
// Le LIBELLE dit « mousse » et non « hors nettoyage » : c'est un choix d'interface, la position
// de service normale plutot que le predicat exact. Le fait precis vit dans `doc/commandes-cafe.md`
// et dans le commentaire de `monitor.mjs`. Ne pas en deduire que « insert » leverait un autre bit
// — il leve celui-ci.
// Les noms viennent de l'app et induisent en erreur — `CIOCCO_TANK` ne designe aucun bac a
// chocolat sur ce modele, qui n'a pas de boisson chocolatee. Les LIBELLES, eux, doivent dire la
// position ; sans cette assertion un « nettoyage » recolle au mauvais bit passerait inapercu,
// les deux etats etant plausibles.
{
  const t = charger("carafe-molette");
  const noms = (x) => x.switches.map((sw) => sw.name);
  ok("molette : deux trames", t.length === 2);
  ok("molette nettoyage : CIOCCO_TANK seul", JSON.stringify(noms(t[0])) === '["CIOCCO_TANK"]', noms(t[0]).join(","));
  ok("molette mousse : IFD_CARAFFE seul", JSON.stringify(noms(t[1])) === '["IFD_CARAFFE"]', noms(t[1]).join(","));
  ok("molette : les deux positions sont bien au repos", t.every((x) => x.auRepos === true));
  // Le libelle est verifie A PARTIR DE LA TRAME, pas d'un nom ecrit en dur : c'est ce qui fait
  // echouer une interversion des deux libelles, le piege exact que cette section documente.
  const lib = (x) => x.switches[0]?.label ?? "";
  ok("molette nettoyage : libellé « carafe à lait (nettoyage) »", lib(t[0]) === "carafe à lait (nettoyage)", lib(t[0]));
  ok("molette hors nettoyage : libellé « carafe à lait (mousse) »", lib(t[1]) === "carafe à lait (mousse)", lib(t[1]));
  ok("les deux libellés nomment la carafe", [lib(t[0]), lib(t[1])].every((l) => /^carafe à lait /.test(l)));
}

// ── Ce que les QUATRE preparations disent des bits carafe, et de l'alarme de nettoyage ───────
// Le decompte a deja ete ecrit faux une fois (« les trois boissons lactees »), or il n'y a que
// deux boissons lactees : c'est trois preparations sur quatre qui portent IFD_CARAFFE, dont un
// espresso pur. La nuance est le raisonnement lui-meme — si c'etait le lait qui levait le bit,
// la conclusion « c'est la molette » tomberait. On le compte donc plutot que de le redire.
{
  const prepas = ["espresso", "espresso-macchiato", "lait-chaud", "espresso-veille"].map(charger);
  const porte = (t, n) => t.some((x) => x.switches.some((sw) => sw.name === n));
  ok("préparations : 3 sur 4 portent IFD_CARAFFE", prepas.filter((t) => porte(t, "IFD_CARAFFE")).length === 3);
  ok("préparations : 1 sur 4 porte CIOCCO_TANK", prepas.filter((t) => porte(t, "CIOCCO_TANK")).length === 1);
  ok(
    "aucune trame ne porte JAMAIS les deux bits carafe",
    prepas.flat().every((x) => !(porte([x], "IFD_CARAFFE") && porte([x], "CIOCCO_TANK"))),
  );
  // L'alarme CLEAN_KNOB (bit 14) suit le LAIT, pas la molette : levee en cours de macchiato, a la
  // trame ou le lait coule, et jamais sur les deux espressos.
  const ck = (t) => t.map((x) => x.alarms.some((a) => a.name === "CLEAN_KNOB"));
  ok("macchiato : l'alarme de nettoyage se lève EN COURS de boisson", (() => {
    const v = ck(prepas[1]);
    return v[0] === false && v.includes(true) && v[v.length - 1] === true;
  })());
  ok("espresso : l'alarme de nettoyage ne se lève jamais", ck(prepas[0]).every((x) => x === false));
  ok("espresso (2e) : l'alarme de nettoyage ne se lève jamais", ck(prepas[3]).every((x) => x === false));
  // Le CAPTEUR homonyme (groupe 1, bit 2) n'a jamais ete observe, molette sur nettoyage comprise.
  ok(
    "le capteur CLEAN_KNOB n'est levé nulle part",
    [...prepas, charger("carafe"), charger("carafe-molette")].flat()
      .every((x) => !x.switches.some((sw) => sw.name === "CLEAN_KNOB")),
  );
}

// L'invariant qui rend la regle ci-dessus sure : sur TOUTES les captures, l'etape 0 n'apparait
// qu'au repos. Si une preparation utilisait un jour l'etape 0 comme etape de travail, la barre
// disparaitrait en plein milieu — et cette assertion le dirait avant l'utilisateur.
for (const f of readdirSync(CAPTURES)) {
  const t = charger(f.replace(/\.json$/, ""));
  ok(
    `${f} : l'étape 0 ne porte jamais de progression`,
    t.filter((x) => x.etape === 0).every((x) => x.auRepos === true && x.pourcent === null),
  );
  ok(
    `${f} : toute étape non nulle est une préparation`,
    t.filter((x) => x.etape != null && x.etape !== 0).every((x) => x.auRepos === false),
  );
}

// ── Une préparation peut tourner ENTIÈREMENT sous l'octet d'état « veille » ──────────────────
// Relevé le 2026-08-22 : un espresso complet, 49 trames, toutes à `état=0x04`, sans qu'aucune
// commande « Allumer » ne soit passée. L'octet 4 ne dit donc pas « la machine ne fait rien », et
// l'accueil ne doit pas conclure « éteinte » du seul octet d'état — il affichait l'interrupteur
// sur ÉTEINT au-dessus d'une barre à 84 %.
{
  const t = charger("espresso-veille");
  ok(
    "veille : toutes les trames portent bien état=0x04",
    t.every((x) => x.stateByte === 0x04),
    [...new Set(t.map((x) => x.stateByte))].join(","),
  );
  const prepa = t.filter((x) => !x.auRepos);
  ok("veille : une préparation y est pourtant visible", prepa.length > 0);
  ok("veille : elle atteint 100 %", prepa.some((x) => x.pourcent === 100));
  ok("veille : elle se termine au repos", t[t.length - 1].auRepos === true);
}

// ── Le seuil de fraîcheur de la progression doit tenir la cadence RÉELLE ─────────────────────
// `AGE_PROGRESSION` décide au bout de combien de temps l'accueil cesse d'afficher la barre. Trop
// haut, une barre figée survit à une perte de contact (observé : la machine a quitté le réseau
// 13 s après une commande et « Mouture — 0 % » est resté à l'écran). Trop bas, la barre
// clignoterait entre deux trames espacées. Les deux bornes se lisent dans les captures, donc on
// les vérifie ici plutôt que de faire confiance à un nombre écrit une fois.
{
  const ts = readFileSync(join(ICI, "..", "src", "app", "machineState.ts"), "utf8");
  const m = ts.match(/export const AGE_PROGRESSION = (\d+)/);
  ok("AGE_PROGRESSION est déclaré", !!m);
  if (m) {
    const seuil = Number(m[1]);
    let pire = 0;
    for (const f of readdirSync(CAPTURES)) {
      // La première ligne de chaque capture est une trame antérieure au lancement : l'écart qui
      // la sépare de la suivante n'est pas une cadence de préparation.
      const t = JSON.parse(readFileSync(join(CAPTURES, f), "utf8")).slice(1);
      for (let i = 1; i < t.length; i++) pire = Math.max(pire, (t[i].ms - t[i - 1].ms) / 1000);
    }
    ok(
      `le seuil (${seuil} s) dépasse le pire écart mesuré (${pire.toFixed(1)} s)`,
      seuil > pire,
    );
    // Et il reste franchement sous le seuil générique d'état périmé, sinon il ne sert à rien.
    const perime = Number(ts.match(/export const AGE_PERIME = (\d+)/)?.[1] ?? 0);
    ok(`le seuil reste bien sous AGE_PERIME (${perime} s)`, seuil < perime);
  }
}

// ── Aucune capture ne doit contenir de trame indécodable ─────────────────────────────────────
for (const f of readdirSync(CAPTURES)) {
  const nom = f.replace(/\.json$/, "");
  const t = charger(nom);
  ok(`${nom} : toutes les trames se décodent`, t.every((x) => typeof x.stateByte === "number"));
  ok(
    `${nom} : le pourcentage reste dans 0..100`,
    t.every((x) => x.pourcent === null || (x.pourcent >= 0 && x.pourcent <= 100)),
  );
}

if (echecs) {
  console.error(`\n${echecs} assertion(s) en échec.`);
  process.exit(1);
}
console.log("Tout passe.");
