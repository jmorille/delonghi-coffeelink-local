// Vérification de l'ordonnanceur, sans machine et sans horloge : l'instant est un paramètre.
import { RANG, DELAIS, nouvelleFile, tache, pasLecture, pasTrame, enfiler, aServir, reponse, tic, vue, annuler, courante } from "../src/lib/tasks.mjs";

let ko = 0;
const test = (nom, fn) => { try { fn(); console.log("  ok   ", nom); } catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); } };
const eq = (a, b, quoi) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`); };

const lecture = (label, props) => tache({ label, rang: RANG.LECTURE, pas: props.map((p) => pasLecture(p)), cle: `r:${props.join(",")}` });
const commande = (label, rang = RANG.COMMANDE) => tache({ label, rang, pas: [pasTrame(label, "AAA=", { attente: "fenetre", ms: 20000 })] });
const stats = (label, n = 2) => tache({ label, rang: RANG.LECTURE_BASSE, pas: Array.from({ length: n }, (_, i) => pasTrame(`${label} ${i}`, "AAA=", { attente: "reponse" })), cle: `s:${label}` });

console.log("\n— priorités et insertion —");
test("une commande passe devant une lecture, un arrêt devant tout", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  enfiler(f, lecture("Balayage", ["c"]), 0);
  enfiler(f, commande("Allumer"), 0);
  enfiler(f, commande("Arrêt", RANG.URGENT), 0);
  eq(f.liste.map((t) => t.label), ["Arrêt", "Allumer", "Import", "Balayage"], "ordre");
});
test("un balayage de statistiques passe DERRIÈRE les autres lectures", () => {
  const f = nouvelleFile();
  enfiler(f, stats("Statistiques"), 0);
  enfiler(f, lecture("Profils", ["a"]), 0);
  enfiler(f, commande("Allumer"), 0);
  eq(f.liste.map((t) => t.label), ["Allumer", "Profils", "Statistiques"], "ordre");
});
test("une lecture ordinaire SUSPEND un balayage entamé, qui reprend ensuite", () => {
  const f = nouvelleFile();
  enfiler(f, stats("Statistiques", 2), 0);
  aServir(f, 0);                                  // sert la 1re requête
  reponse(f, { reponse: true }, 1000);            // elle répond
  eq(courante(f).faits, 1, "une requête faite");
  enfiler(f, lecture("Profils", ["a"]), 2000);
  eq(courante(f).label, "Profils", "la lecture prend la tête");
  eq(f.liste[1].faits, 1, "le balayage garde ce qu'il a fait");
  aServir(f, 2000);
  reponse(f, { prop: "a" }, 2500);
  tic(f, 2600);
  eq(courante(f).label, "Statistiques", "le balayage reprend");
  eq(courante(f).i, 1, "à la requête où il en était");
});
test("deux commandes restent en FIFO entre elles", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Allumer"), 0);
  enfiler(f, commande("Préparer"), 0);
  eq(f.liste.map((t) => t.label), ["Allumer", "Préparer"], "ordre");
});
test("une lecture suspendue REPREND après la commande qui l'a doublée", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  aServir(f, 0);                       // sert « a »
  reponse(f, { prop: "a" }, 1000);     // a lu
  enfiler(f, commande("Allumer"), 2000);
  eq(courante(f).label, "Allumer", "la commande prend la tête");
  eq(f.liste[1].faits, 1, "l'import garde son pas déjà fait");
  // La commande finit (fenêtre atteinte = succès), l'import redevient tête avec son reste.
  aServir(f, 2000);
  tic(f, 2000 + 20001);
  eq(courante(f).label, "Import", "l'import reprend");
  eq(courante(f).pas[courante(f).i].nom, "b", "au pas où il en était");
});

console.log("\n— fusion et plafond —");
test("deux demandes identiques en attente n'en font qu'une", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Allumer"), 0);           // occupe la tête
  const a = enfiler(f, lecture("Présence", ["m"]), 0);
  const b = enfiler(f, lecture("Présence", ["m"]), 0);
  eq(b.fusion, true, "fusion signalée");
  eq(b.tache.id, a.tache.id, "même tâche");
  eq(f.liste.length, 2, "rien d'ajouté");
});
test("la file plafonne au lieu de gonfler", () => {
  const f = nouvelleFile();
  for (let i = 0; i < 32; i++) enfiler(f, commande(`c${i}`), 0);
  eq(enfiler(f, commande("de trop"), 0), { ok: false, raison: "pleine" }, "refus");
});

console.log("\n— échéances, reprise, fin —");
test("un pas de lecture manqué repart UNE fois, puis compte comme perdu", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  f.dernierContact = 0;
  aServir(f, 0);                                  // sert « a »
  reponse(f, { prop: "a" }, 100);                 // contact établi
  aServir(f, 200);                                // sert « b »
  let ev = tic(f, 200 + DELAIS.prop + 1);         // « b » manque
  eq(ev.map((e) => e.type), ["repris"], "repris une fois");
  eq(courante(f).pas.length, 3, "le pas est remis en queue");
  aServir(f, 9000);                               // re-sert « b »
  ev = tic(f, 9000 + DELAIS.prop + 1);            // manque encore
  eq(ev.map((e) => e.type), ["perdu", "echouee"], "perdu, puis tâche échouée");
  eq(f.finies[0].nonLus, ["b"], "b est non lu");
});
test("une fenêtre atteinte est un SUCCÈS, pas une panne", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Allumer"), 0);
  f.dernierContact = 0;
  aServir(f, 0);
  const ev = tic(f, 20001);
  eq(ev.map((e) => e.type), ["faite"], "réussie");
  eq(f.finies[0].nonLus.length, 0, "rien de manquant");
});

console.log("\n— coupe-circuit —");
test("machine muette : la tête échoue et le reste est annulé, une seule fois", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b", "c"]), 0);
  enfiler(f, lecture("Autre", ["d"]), 0);
  enfiler(f, lecture("Encore", ["e"]), 0);
  aServir(f, 0);                                   // la machine ne viendra jamais
  const ev = tic(f, DELAIS.muet + 1);
  eq(ev[0].type, "muette", "verdict");
  eq(ev[0].restantes, 2, "les deux autres sont nommées");
  eq(f.liste.length, 0, "file vidée");
  eq(f.finies.map((t) => t.etat), ["annulee", "annulee", "echouee"], "états");
});
test("un contact repousse le coupe-circuit", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  aServir(f, 0);
  reponse(f, { prop: "a" }, DELAIS.muet - 1000);   // contact tardif mais réel
  eq(tic(f, DELAIS.muet + 1).length, 0, "pas de verdict");
});

test("une tache JAMAIS servie declenche quand meme le coupe-circuit", () => {
  // Le cas reel : la machine ne vient pas chercher la commande, donc `aServir` n'est jamais appele
  // et rien ne promeut la tache. Elle restait « en attente » pour toujours, sans verdict.
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  enfiler(f, lecture("Autre", ["c"]), 0);
  eq(tic(f, 1000).length, 0, "rien avant l'echeance");
  const ev = tic(f, DELAIS.muet + 2000);
  eq(ev[0].type, "muette", "verdict rendu sans qu'aucun pas ait ete servi");
  eq(f.liste.length, 0, "file videe");
});

console.log("\n— annulation —");
test("annuler garde une trace au lieu de faire disparaître", () => {
  const f = nouvelleFile();
  const a = enfiler(f, lecture("Import", ["a"]), 0).tache;
  annuler(f, a.id, "demandée", 500);
  eq(f.liste.length, 0, "sortie de file");
  eq([f.finies[0].etat, f.finies[0].motif], ["annulee", "demandée"], "tracée");
});

console.log("\n— vue —");
test("la vue distingue en cours, en attente et terminées", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  enfiler(f, lecture("Autre", ["c"]), 0);
  aServir(f, 0);
  reponse(f, { prop: "a" }, 100);
  const v = vue(f);
  eq([v.encours.label, v.encours.faits, v.encours.total, v.encours.pasCourant], ["Import", 1, 2, "b"], "en cours");
  eq(v.attente.map((t) => t.label), ["Autre"], "en attente");
});

test("la clé de traduction du libellé traverse la vue", () => {
  const f = nouvelleFile();
  // Le serveur envoie un identifiant, le client traduit : si `vue()` laisse tomber `i18n`, le
  // panneau « Activité » retombe silencieusement sur le français du serveur et personne ne le voit.
  enfiler(f, tache({ label: "Boissons · profil 2", rang: RANG.LECTURE, pas: [pasLecture("a")], i18n: { k: "beverages", p: { profil: 2 } } }), 0);
  enfiler(f, tache({ label: "Allumer", rang: RANG.COMMANDE, pas: [pasLecture("b")] }), 0);
  const v = vue(f);
  const tout = [v.encours, ...v.attente].filter(Boolean);
  eq(tout.find((t) => t.label.startsWith("Boissons")).i18n, { k: "beverages", p: { profil: 2 } }, "clé transmise");
  // Sans clé, le champ vaut null — c'est ce qui déclenche le repli sur le libellé du serveur.
  eq(tout.find((t) => t.label === "Allumer").i18n, null, "absence de clé explicite");
});

console.log("");
console.log("— repli des terminées —");
// Cas reel signale sur /pilotage : un coupe-circuit annule toute la file d'un coup, donc cinq
// « Presence » echouees ; la presence suivante reussit mais n'occupe qu'une des cinq lignes, et
// les quatre verdicts perimes restent affiches alors qu'ils decrivent un etat revolu.
const presence = () => tache({ label: "Présence", rang: RANG.LECTURE, pas: [pasLecture("p")], cle: "presence" });
test("une même demande ne laisse qu'UN verdict, le dernier", () => {
  const f = nouvelleFile();
  for (let i = 0; i < 4; i++) {
    enfiler(f, presence(), i * 100);
    annuler(f, null, "muette", i * 100 + 50);
  }
  eq(vue(f).finies.length, 1, "une seule ligne");
  eq(vue(f).finies[0].repetitions, 4, "le compte est gardé");
  // Puis elle reussit : c'est CE verdict qui doit rester.
  enfiler(f, presence(), 1000);
  aServir(f, 1000);
  reponse(f, { prop: "p" }, 1100);
  tic(f, 1100);
  eq(vue(f).finies.map((t) => [t.label, t.etat, t.repetitions]), [["Présence", "faite", 5]], "dernier verdict");
});
test("le repli ne masque pas une AUTRE demande", () => {
  const f = nouvelleFile();
  enfiler(f, presence(), 0);
  enfiler(f, tache({ label: "Sommes", rang: RANG.LECTURE, pas: [pasLecture("s")], cle: "checksums" }), 0);
  annuler(f, null, "muette", 50);
  eq(vue(f).finies.map((t) => t.label), ["Sommes", "Présence"], "deux lignes distinctes");
});
test("sans clé, aucun repli : deux cafés font deux lignes", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Préparer Espresso"), 0);
  annuler(f, null, "annulée", 10);
  enfiler(f, commande("Préparer Espresso"), 20);
  annuler(f, null, "annulée", 30);
  eq(vue(f).finies.map((t) => [t.label, t.repetitions]), [["Préparer Espresso", 1], ["Préparer Espresso", 1]], "deux lignes");
});
test("le repli libère de la place : cinq demandes distinctes restent visibles", () => {
  const f = nouvelleFile();
  for (const c of ["presence", "checksums", "reglages", "initiale", "profils"]) {
    enfiler(f, tache({ label: c, rang: RANG.LECTURE, pas: [pasLecture("p")], cle: c }), 0);
  }
  annuler(f, null, "muette", 50);
  // Une nouvelle presence se replie sur l'ancienne au lieu de chasser la plus vieille des cinq.
  enfiler(f, presence(), 100);
  annuler(f, null, "muette", 150);
  eq(vue(f).finies.length, 5, "cinq lignes");
  eq(new Set(vue(f).finies.map((t) => t.label)).size, 5, "cinq demandes distinctes");
});

console.log("\n— la réponse à 0x75 arrive en poussée de monitor, pas en data_response —");

test("une poussée de monitor satisfait un pas 0x75", () => {
  // Le défaut mesuré sur la machine : le pas « Présence » ne pouvait être satisfait que par un
  // data_response, que la machine n'envoie pas pour cette commande — elle répond en poussant
  // d302_monitor. État reçu et affiché à l'écran, tâche déclarée « sans réponse » puis échouée.
  const f = nouvelleFile();
  const pres = tache({ label: "Présence", rang: RANG.LECTURE, genre: "lecture",
    pas: [pasTrame("Présence", "AAA=", { attente: "reponse", cmd: 0x75 })] });
  enfiler(f, pres, 1000);
  aServir(f, 1000);
  eq(reponse(f, { reponse: true, cmd: 0x75 }, 2000)?.label, "Présence", "le monitor apparie le pas 0x75");
  eq(pres.faits, 1, "pas fait");
});

test("un monitor SPONTANÉ ne valide pas un pas qui attend autre chose", () => {
  // Pendant une préparation la machine pousse un monitor toutes les 1 à 3 s. Apparier largement
  // déclarerait lus des compteurs jamais lus — le pire des résultats, silencieux et faux.
  const f = nouvelleFile();
  const st = tache({ label: "Statistiques", rang: RANG.LECTURE_BASSE, genre: "lecture",
    pas: [pasTrame("Paramètres 3001", "AAA=", { attente: "reponse", cmd: 0xa2 })] });
  enfiler(f, st, 1000);
  aServir(f, 1000);
  eq(reponse(f, { reponse: true, cmd: 0x75 }, 2000), null, "le monitor n'apparie pas le pas 0xA2");
  eq(st.faits, 0, "pas intact");
  // Sans cmd, comportement d'origine conservé : restreindre à l'aveugle ferait échouer des
  // lectures qui fonctionnent aujourd'hui.
  eq(reponse(f, { reponse: true }, 3000)?.label, "Statistiques", "un data_response non qualifié apparie encore");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
