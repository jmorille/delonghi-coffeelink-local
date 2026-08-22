/**
 * Vérifie le registre d'applications et l'analyse des charges utiles — sans téléphone, sans
 * machine, sans réseau.
 *
 * Troisième script de cette famille après `verif-tasks.mjs` et `verif-monitor.mjs`, et il existe
 * pour la même raison : la partie du multiplexeur qui décide quelque chose est pure, donc elle se
 * prouve. Ce qui reste impur — les requêtes HTTP vers l'application — est vérifié par
 * `scripts/faux-app.mjs`, qui fait tourner les deux moitiés en vrai sur la boucle locale.
 *
 * Aucune dépendance : `node scripts/verif-apps.mjs`.
 */
import { nouveauRegistre, annoncer, etablir, oublier, expirer, toucher, refuser, vue, cleApp,
         echouer, GARDE_REFUS, DELAI_APP_MUETTE, SEUIL_ECHECS } from "../src/lib/appregistry.mjs";
import { analyserCommandes, estRefus } from "../src/lib/appproxy.mjs";

let ko = 0;
const test = (nom, fn) => {
  try { fn(); console.log("  ok   ", nom); }
  catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); }
};
const eq = (a, b, quoi) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`);
};
const vrai = (c, quoi) => { if (!c) throw new Error(quoi); };

/** Un instant fixe : l'horloge est un paramètre partout, exactement comme dans l'ordonnanceur. */
const T0 = 1_700_000_000_000;
const uneApp = (port = 8888, ip = "192.168.1.50") => ({ ip, port, uri: "/local_lan", notify: 0, keyId: 42 });

console.log("\n— le registre : plusieurs applications, ce que le créneau de la machine interdit —");

test("deux applications coexistent, ce qui EST la fonctionnalité", () => {
  const r = nouveauRegistre();
  annoncer(r, uneApp(8888), T0);
  annoncer(r, uneApp(9999), T0);
  eq(r.apps.size, 2, "nombre d'applications");
  // Le contraste avec la machine, mesuré le 2026-08-22 : là-bas la seconde annonce EFFACE la
  // première, sans erreur et sans trace. Ici les deux existent — c'est tout le propos.
  eq([...r.apps.values()].map((a) => a.id), ["a1", "a2"], "identifiants distincts");
});

test("une seconde annonce du même couple adresse:port rafraîchit, elle ne duplique pas", () => {
  const r = nouveauRegistre();
  const un = annoncer(r, uneApp(), T0);
  const deux = annoncer(r, uneApp(), T0 + 3000);
  vrai(un.nouvelle, "la première est nouvelle");
  vrai(!deux.nouvelle, "la seconde ne l'est pas");
  eq(r.apps.size, 1, "toujours une seule");
  eq(deux.app.annonces, 2, "annonces comptées");
  eq(deux.app.vueA, T0 + 3000, "dernier contact repoussé");
});

test("« nouvelle » est ce qui déclenche l'échange de clés — un PUT ne doit jamais le relancer", () => {
  // Le piège que cette assertion verrouille : relancer un échange de clés à chaque
  // rafraîchissement remplacerait la session, donc le flux AES en cours, donc tout ce que
  // l'application est en train de lire. Le symptôme serait une app qui « décroche » toutes les
  // quelques secondes, sans la moindre erreur.
  const r = nouveauRegistre();
  annoncer(r, uneApp(), T0);
  for (let i = 1; i <= 5; i++) {
    vrai(!annoncer(r, uneApp(), T0 + i * 1000).nouvelle, `annonce #${i} ne relance pas`);
  }
});

test("l'identité est adresse:port — un même téléphone sur deux ports fait deux applications", () => {
  const r = nouveauRegistre();
  annoncer(r, uneApp(8888, "192.168.1.50"), T0);
  annoncer(r, uneApp(8889, "192.168.1.50"), T0);
  eq(r.apps.size, 2, "deux entrées");
  eq(cleApp("192.168.1.50", 8888), "192.168.1.50:8888", "forme de la clé");
});

console.log("\n— cycle de vie —");

test("établir fait passer de « annoncee » à « etablie »", () => {
  const r = nouveauRegistre();
  const { app } = annoncer(r, uneApp(), T0);
  eq(app.etat, "annoncee", "état initial");
  etablir(r, app, { faux: true }, T0 + 500);
  eq(app.etat, "etablie", "état après échange");
  eq(app.sessionA, T0 + 500, "instant de session");
});

test("une application muette est oubliée, une application active ne l'est pas", () => {
  const r = nouveauRegistre();
  const a = annoncer(r, uneApp(8888), T0).app;
  const b = annoncer(r, uneApp(9999), T0).app;
  toucher(b, T0 + DELAI_APP_MUETTE);
  const partis = expirer(r, T0 + DELAI_APP_MUETTE + 1);
  eq(partis.map((x) => x.id), [a.id], "seule la muette part");
  eq(partis[0].etat, "expiree", "état marqué");
  vrai(r.apps.has(cleApp(b.ip, b.port)), "l'active est restée");
});

test("oublier retire, et le dit", () => {
  const r = nouveauRegistre();
  const { app } = annoncer(r, uneApp(), T0);
  vrai(oublier(r, app), "retirée");
  vrai(!oublier(r, app), "retirer deux fois ne ment pas");
});

console.log("\n— les refus, c'est-à-dire la surveillance —");

test("les refus identiques CONSÉCUTIFS se replient au lieu de chasser le reste", () => {
  const r = nouveauRegistre();
  refuser(r, { from: "10.0.0.9", motif: "dsnInconnu" }, T0);
  for (let i = 1; i <= 11; i++) refuser(r, { from: "10.0.0.9", motif: "dsnInconnu" }, T0 + i * 100);
  eq(r.refus.length, 1, "une seule ligne");
  eq(r.refus[0].repetitions, 12, "comptées");
  // L'horodatage suit la DERNIÈRE occurrence : « ça continue » est le fait utile.
  eq(r.refus[0].at, T0 + 1100, "horodatage de la dernière");
});

test("un refus différent ne se replie pas sur le précédent", () => {
  const r = nouveauRegistre();
  refuser(r, { from: "10.0.0.9", motif: "dsnInconnu" }, T0);
  refuser(r, { from: "10.0.0.9", motif: "sansCle" }, T0 + 100);
  refuser(r, { from: "10.0.0.8", motif: "dsnInconnu" }, T0 + 200);
  eq(r.refus.length, 3, "trois lignes distinctes");
  eq(r.refus[0].motif, "dsnInconnu", "la plus récente en tête");
  eq(r.refus[0].from, "10.0.0.8", "et c'est bien la dernière");
});

test("la liste des refus est bornée", () => {
  const r = nouveauRegistre();
  for (let i = 0; i < GARDE_REFUS + 15; i++) refuser(r, { from: `10.0.0.${i}`, motif: "dsnInconnu" }, T0 + i);
  eq(r.refus.length, GARDE_REFUS, "plafonnée");
});

test("la vue ne laisse JAMAIS sortir une session", () => {
  // La règle non négociable du projet : aucun endpoint ne renvoie la clé LAN. Une session est
  // dérivée d'elle ; la laisser fuir dans /api/apps reviendrait au même.
  const r = nouveauRegistre();
  const { app } = annoncer(r, uneApp(), T0);
  etablir(r, app, { crypto: "SECRET", encapsulate() {} }, T0);
  const v = vue(r, T0 + 5000);
  const texte = JSON.stringify(v);
  vrai(!texte.includes("SECRET"), "aucune trace de la session");
  vrai(!("session" in v.apps[0]), "pas de champ session");
  eq(v.apps[0].ageSec, 5, "âge en secondes");
  eq(v.etablies, 1, "compte des sessions établies");
});

console.log("\n— analyse des charges utiles, relevées dans l'APK et non devinées —");

test("une lecture : {cmds:[{cmd:{GET property.json?name=…}}]}", () => {
  const c = JSON.stringify({ cmds: [{ cmd: { cmd_id: 7, method: "GET", resource: "property.json?name=d302_monitor", data: "", uri: "/local_lan/property/datapoint.json" } }] });
  eq(analyserCommandes(c), [{ type: "lecture", cmdId: 7, nom: "d302_monitor", uri: "/local_lan/property/datapoint.json" }], "intention");
});

test("une écriture : {properties:[{property:{name,value}}]}", () => {
  const c = JSON.stringify({ properties: [{ property: { base_type: "string", name: "data_request", value: "DQV1Dw==", dsn: "AC000W0XXXXXXXX", metadata: {} } }] });
  const r = analyserCommandes(c);
  eq(r.length, 1, "une intention");
  eq(r[0].type, "ecriture", "type");
  eq(r[0].nom, "data_request", "propriété");
  eq(r[0].ackId, null, "pas d'accusé demandé");
});

test("le champ `id` EST la demande d'accusé", () => {
  // `CreateDatapointCommand` ne pose `id` que si `isAckEnabled()`. Sa présence est donc le seul
  // signal, et ne pas répondre laisse l'application attendre puis conclure à un échec.
  const c = JSON.stringify({ properties: [{ property: { name: "data_request", value: "AA==", id: "a1b2c3d4" } }] });
  eq(analyserCommandes(c)[0].ackId, "a1b2c3d4", "identifiant d'accusé relevé");
});

test("l'accusé est dû même à une propriété que nous ne relayons PAS", () => {
  // ⚠️ Relevé sur la vraie application, et ça bloquait tout : elle ouvre chaque session en
  // écrivant `device_connected`, propriété que nous n'avons aucune raison de relayer à la
  // cafetière — et le serveur sortait par la branche « ignorée » sans jamais accuser. Du point
  // de vue du téléphone, la machine à qui il vient de se présenter ne répond pas : il n'allait
  // pas plus loin et AUCUNE commande ne partait. Le registre le montrait sans qu'on sache le
  // lire — session établie, datapoints reçus, `commandes = 0` pendant toute la vie de l'entrée.
  //
  // L'accusé porte le TRANSPORT (« reçu »), pas l'exécution (« fait »). Le décodage de la
  // charge est donc le seul juge de ce qui atteint l'appareil ; l'accusé, lui, est dû dans les
  // deux cas dès que `id` est là.
  const c = JSON.stringify({ properties: [{ property: { name: "device_connected", value: 1787413302, id: "d7e8" } }] });
  const r = analyserCommandes(c)[0];
  eq(r.type, "ecriture", "c'est bien une écriture");
  eq(r.nom, "device_connected", "et elle ne porte pas de trame ECAM");
  eq(r.ackId, "d7e8", "l'accusé reste dû : rien dans l'analyse ne dépend de ce qu'on relaie");
});

test("l'enveloppe {seq_no, data} est acceptée comme son contenu", () => {
  // `decapsulate` rend l'enveloppe entière ; certains appelants passent déjà `data`. Accepter les
  // deux évite un dépliage en double, qui rendrait « vide » une charge parfaitement valide.
  const dedans = { cmds: [{ cmd: { cmd_id: 1, method: "GET", resource: "property.json?name=x" } }] };
  eq(analyserCommandes(JSON.stringify({ seq_no: 3, data: dedans })), analyserCommandes(JSON.stringify(dedans)), "même résultat");
});

test("la fin de session est reconnue", () => {
  const c = JSON.stringify({ cmds: [{ cmd: { cmdId: 0, method: "DELETE", resource: "local_reg.json", data: "delete_session", uri: "/local_lan" } }] });
  eq(analyserCommandes(c)[0].type, "finSession", "type");
});

test("plusieurs intentions dans un même bloc sont toutes rendues", () => {
  const c = JSON.stringify({
    cmds: [{ cmd: { cmd_id: 1, method: "GET", resource: "property.json?name=a" } }],
    properties: [{ property: { name: "data_request", value: "AA==" } }],
  });
  eq(analyserCommandes(c).map((x) => x.type), ["lecture", "ecriture"], "les deux formes cohabitent");
});

test("l'inconnu ressort NOMMÉ, il ne disparaît pas", () => {
  // Une application qui nous demande quelque chose que nous ne savons pas faire doit apparaître
  // dans le journal. Le silence est le pire des comportements : il se lit comme un succès.
  eq(analyserCommandes(JSON.stringify({ cmds: [{ cmd: { method: "PUT", resource: "autre.json" } }] }))[0].type, "inconnu", "commande inconnue");
  eq(analyserCommandes("pas du json")[0].type, "illisible", "corps illisible");
  eq(analyserCommandes("{}")[0].type, "vide", "bloc vide");
});

console.log("\n— l'injoignabilité : un port fermé est une preuve, pas un silence —");

test("il faut SEUIL_ECHECS échecs d'affilée pour déclarer une application injoignable", () => {
  const r = nouveauRegistre();
  const { app } = annoncer(r, uneApp(10275), T0);
  for (let i = 1; i < SEUIL_ECHECS; i++) vrai(!echouer(app), "pas encore au seuil");
  vrai(echouer(app), "injoignable au seuil");
});

test("un seul succès efface les échecs — un téléphone en veille n'est pas un téléphone parti", () => {
  const r = nouveauRegistre();
  const { app } = annoncer(r, uneApp(10275), T0);
  echouer(app); echouer(app);
  toucher(app, T0 + 1000);
  eq(app.echecs, 0, "compteur remis à zéro");
  vrai(!echouer(app), "le décompte repart de zéro");
});

test("l'entrée d'un lancement précédent part BIEN avant DELAI_APP_MUETTE", () => {
  // Le cas rapporté : l'application relancée prend un nouveau port, l'ancienne entrée reste
  // « établie » et affiche une seconde application fantôme. À la cadence de sonde (2 s), le seuil
  // tombe en une douzaine de secondes ; expirer() aurait mis une minute et demie.
  vrai(SEUIL_ECHECS * 2000 < DELAI_APP_MUETTE / 4, "le seuil doit trancher bien avant l'expiration");
});

test("un même téléphone sur deux ports reste DEUX applications", () => {
  // Garde-fou de conception : la tentation, devant un doublon, est d'évincer sur l'adresse.
  // Ce serait détruire la fonctionnalité — les deux faux-app.mjs de la démonstration tournent
  // sur 127.0.0.1, et deux applications sur un même téléphone partagent aussi une adresse.
  const r = nouveauRegistre();
  const { app: vieille } = annoncer(r, uneApp(37067), T0);
  annoncer(r, uneApp(10275), T0 + 1000);
  eq(r.apps.size, 2, "les deux coexistent, l'arrivée n'évince pas");
  for (let i = 0; i < SEUIL_ECHECS; i++) echouer(vieille);
  oublier(r, vieille);
  eq([...r.apps.values()].map((a) => a.port), [10275], "seule l'injoignable est partie");
});

test("seul un REFUS compte comme échec — un délai dépassé est un silence", () => {
  // La justification de toute l'éviction rapide, et le code la contredisait : un délai dépassé
  // et un ECONNREFUSED arrivaient au même endroit sous la même forme. Mesuré sur la vraie
  // application — évincée en 16 s après trois délais, revenue 9 s plus tard sur le MÊME port.
  vrai(estRefus({ code: "ECONNREFUSED" }), "un port fermé est une preuve");
  vrai(estRefus({ code: "EHOSTUNREACH" }), "un hôte injoignable aussi");
  vrai(!estRefus({ code: "ETIMEDOUT" }), "un délai dépassé ne prouve rien : téléphone verrouillé");
  vrai(!estRefus(null), "pas d'erreur, pas de refus");
  vrai(!estRefus(new Error("délai dépassé")), "le message ne fait pas foi, seul le code compte");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
