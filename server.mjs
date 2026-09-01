/**
 * Serveur personnalisé : HTTP BRUT pour les endpoints device-facing (/local_lan/*) et
 * l'API de contrôle (/api/*), et délégation à Next.js pour l'UI (pages / et /recipes).
 *
 * Pourquoi un serveur brut ? Le client HTTP de l'ESP32 (ADA 1.5.3) est rudimentaire et
 * rejette les réponses de Next (header `vary: rsc,…`, framing App Router). Les réponses
 * node:http avec Content-Length explicite fonctionnent (validé : la machine s'allume).
 *
 * Tout tourne dans UN process → état partagé en mémoire.
 * Lancer : npm run build && node server.mjs   (ou npm start)
 */
import { createServer, request as httpRequest } from "node:http";
// Résolution explicite du nom de la machine : voir `machineTarget()` — le module refuse un
// en-tête `Host` qui ne soit pas son adresse IP.
import { lookup as dnsLookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import next from "next";
import { CATEGORIES, PARAMS, beverageMeta, catalogFor, customSlotOf, decodeRecipeProperty, modelSheet } from "./src/lib/beverages.mjs";
import { COMPTEURS, PORTEES as PORTEES_COMPTEURS, compteurInfo, estCompteur, lireCompteur, nomsARelire, valeurAffichee } from "./src/lib/compteurs.mjs";
// Le report d'une recette locale dans un emplacement perso : module PUR, prouvé sans machine par
// `scripts/verif-transfert.mjs`. C'est lui qui décide de ce qui part dans une écriture persistante.
import { planTransfert } from "./src/lib/transfert.mjs";
import { decoderDataUrl, decoderBase64Nu, torrefactionValide, TORREFACTIONS, TAILLE_MAX as IMAGE_TAILLE_MAX } from "./src/lib/image-grains.mjs";
// Le référentiel du protocole ECAM : la table des opérations, la lecture d'une trame sortante
// (`opTrame`) ou entrante (`opReponse`), et le décodage des arguments. Tout ce qui nomme une
// commande dans ce fichier — journal, libellé de tâche, ordonnanceur — lit CETTE table.
import {
  argumentsTrame as argsEcam, cleFusion, constanteConnue, describeFrame, hexCmd,
  natureTrame, opReponse, opTrame, profilVise,
} from "./src/lib/ecam-args.mjs";
// Le constructeur de la trame 0x83 vit dans un module PUR et sans `Buffer` : la carte d'une
// boisson en montre le résultat à chaque cran de curseur, et une seconde implémentation côté
// navigateur aurait dérivé en silence. Voir l'en-tête de `trame-boisson.mjs`.
import { encodeDispense, MODE, ACT, actionPreparer } from "./src/lib/trame-boisson.mjs";
import { computeBeanAdapt, encodeBeanName, GRINDER_MIN, GRINDER_MAX, AROMA_MIN, AROMA_MAX, TEMPERATURE_MIN, TEMPERATURE_MAX, seuilAffinage, affinagePermis } from "./src/lib/bean-adapt.mjs";
import { ALL_PROFILE_PROPS, PROFILE_NAME_PROPS, CUSTOM_NAME_PROPS, PRIORITY_PROPS, profilePropInfo, isProfileProp, decodeNames, decodePriorities, decodeChecksums, decodeBeanSystem, decodeBeanSync, BEAN_SYNC_PROP, BEAN_SYNC_PARAM, STRIDE_CLASSIC } from "./src/lib/profiles.mjs";
import { decodeMonitor } from "./src/lib/monitor.mjs";
import { makeLanSession, token } from "./src/lib/lansession.mjs";
// Multiplexeur : lan-server joue la machine auprès de N applications. Voir doc/spec-proxy-multi-app.md.
import { nouveauRegistre, annoncer, etablir, oublier, expirer, toucher, refuser, vue as vueApps,
         cleApp, echouer, DELAI_APP_MUETTE, SEUIL_ECHECS } from "./src/lib/appregistry.mjs";
import { httpJson, echangeClesVersApp, analyserCommandes, paquetDatapoint, paquetAck,
         estRefus, porteUneCharge, encoreDesCommandes, CHEMIN_ACK, cheminAvecCmd,
         PORT_ATTENDU_PAR_APP } from "./src/lib/appproxy.mjs";
// Persistance : SQLite (`data/lan-server.db`). Le module migre tout seul les anciens JSON au
// premier démarrage. Chaque propriété reçue est UNE ligne réécrite, plus 80 ko de cache entier.
import { RANG, DELAIS, MAX_FILE, nouvelleFile, tache, pasLecture, pasTrame, enfiler, aServir,
         reponse as apparier, contact as contactMachine, tic, vue as vueFile, annuler,
         courante, vide } from "./src/lib/tasks.mjs";
import { bootMessages as storeBootMessages, storageInfo, forMachine, listMachines, createMachine, setMachineLabel, deleteMachine, getSetting, setSetting, clearSetting, DEFAULT_MACHINE } from "./src/lib/store.mjs";
// Identification du modele : la machine publie son numero de serie, et les 5 chiffres qui
// indexent la table constructeur sont dedans. Aucun cloud — voir machine-models.mjs.
import { MODELS, MODELS_TABLE_VERSION, SERIAL_PROP, findModel, identify as identifyModel } from "./src/lib/machine-models.mjs";

// --- .env.local ---
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

/**
 * Configuration du SERVEUR — ce qui ne dépend d'aucune machine. Une seule instance écoute, sur un
 * seul port, et annonce une seule adresse : ces valeurs-là sont globales, quel que soit le nombre
 * de cafetières.
 */
const CFG = {
  // Volontairement laissée telle quelle si absente : `serverIpProblem()` la juge, et le
  // démarrage le dit fort. Voir le commentaire de cette fonction.
  serverIp: process.env.SERVER_IP || null,
  serverIpSource: process.env.SERVER_IP ? "SERVER_IP (.env.local)" : "non définie",
  port: Number(process.env.SERVER_PORT ?? "3000"),
};

/**
 * Réglages qui décrivent UNE machine et viennent de l'environnement.
 *
 * Ils s'appliquent à la **première** machine (`m1`), et à elle seule. C'est le seul choix
 * honnête : `MACHINE_IP` ne peut pas désigner deux cafetières à la fois. Une installation
 * mono-machine se comporte donc exactement comme avant ; une installation multi-machines se
 * configure dans l'interface, et chaque valeur saisie est persistée par machine dans la base —
 * qui est sur un volume, donc survit au redémarrage du conteneur.
 *
 * Aucune de ces valeurs n'a de défaut, et c'est délibéré :
 * - le DSN est une donnée d'appareil, découvrable localement (`resolveDsn`) ;
 * - une IP écrite en dur est la configuration de quelqu'un d'autre, et donne l'illusion d'un
 *   serveur configuré alors qu'il parle dans le vide ;
 * - le modèle est DÉCOUVERT : la clé de 5 chiffres est dans le numéro de série que la machine
 *   publie elle-même (`d270_serialnumber`).
 *
 * Priorité, pour chacune : variable d'environnement > cache local (base) > la machine.
 */
const ENV_MACHINE = {
  dsn: process.env.MACHINE_DSN || null,
  ip: process.env.MACHINE_IP || null,
  modelKey: process.env.MACHINE_MODEL_KEY || null,
  lanKey: process.env.LANIP_KEY || null,
  lanKeyId: Number(process.env.LANIP_KEY_ID ?? "0"),
  gen: process.env.MACHINE_GENERATION || "classic",
  // Distinguer « posée à classic » de « non posée » : sans ça, la déduction depuis le modèle ne
  // saurait pas si elle a le droit de s'appliquer.
  genForced: !!process.env.MACHINE_GENERATION,
};
const DEVICE_SHEET = JSON.parse(readFileSync(new URL("./src/lib/device-sheet.json", import.meta.url), "utf8"));
/**
 * Constantes statiques de l'APK servant a la decouverte de la cle LAN.
 *
 * Elles etaient dans `.env.local`, ou elles n'avaient rien a faire : identiques pour tout le
 * monde, lisibles dans un binaire public, et sans pouvoir propre — sans les identifiants d'un
 * compte De'Longhi, elles n'ouvrent rien. Les faire saisir ne protegeait personne, et rendait la
 * decouverte indisponible a qui ne les avait pas sous la main. Le vrai secret, la cle LAN, reste
 * en base ; le mot de passe, lui, ne survit pas a la requete.
 *
 * Chaque valeur reste surchargeable par sa variable d'environnement — compte hors zone
 * europeenne, ou rotation cote De'Longhi.
 */
const CLOUD_APP = JSON.parse(readFileSync(new URL("./src/lib/cloud-app.json", import.meta.url), "utf8"));
const APP = {
  gigyaApiKey: process.env.GIGYA_API_KEY || CLOUD_APP.gigya.apiKey,
  gigyaDatacenter: process.env.GIGYA_DATACENTER || CLOUD_APP.gigya.datacenter,
  aylaAppId: process.env.AYLA_APP_ID || CLOUD_APP.ayla.appId,
  aylaAppSecret: process.env.AYLA_APP_SECRET || CLOUD_APP.ayla.appSecret,
  aylaUserUrl: CLOUD_APP.ayla.userServiceUrl,
  aylaDeviceUrl: CLOUD_APP.ayla.deviceServiceUrl,
  aylaRefreshPath: process.env.AYLA_REFRESH_PATH || CLOUD_APP.ayla.refreshPath,
};
const now = () => new Date().toISOString().slice(11, 23);

/** Machines connues, par identifiant. Peuplée au démarrage par `loadMachines()`. */
const MACHINES = new Map();

/**
 * Journal unique, toutes machines confondues, chaque ligne portant celle qu'elle concerne.
 *
 * Un journal par machine aurait obligé l'interface à en recoudre plusieurs pour dire ce qui vient
 * de se passer — alors que l'ordre chronologique est justement ce qu'on regarde quand une
 * commande ne passe pas.
 */
const LOG = [];
/**
 * Numero de ligne, monotone et jamais reutilise — et PARTAGE par les deux journaux.
 *
 * Il n'est pas decoratif : le journal se remplit par la TETE (`unshift`), donc si l'interface
 * identifie ses lignes par leur rang, une ligne de plus decale les cinquante autres et React
 * reecrit tout le bloc au lieu d'inserer un noeud. `t` ne suffit pas comme identite — deux lignes
 * tombent dans la meme milliseconde des qu'un import defile.
 *
 * ⚠️ **Il porte desormais DEUX roles, et les separer est ce qui rend le flux d'ajouts possible.**
 * `id` nomme la ligne pour toujours ; `n` date sa DERNIERE touche. Un repli mute la tete en place
 * (`repetitions++`) : il lui donne donc un `n` neuf pour qu'elle reparte sur le fil, mais son `id`
 * ne bouge pas et le navigateur REMPLACE la ligne qu'il a deja au lieu d'en empiler une
 * vingt-quatrieme. Sans cette separation, le repli — la seule chose qui rende un journal lisible
 * quand tout va mal — serait exactement ce que le flux casserait.
 *
 * Partage entre `LOG` et `LOG_APPS` parce que le navigateur n'a qu'UN curseur : deux suites
 * independantes obligeraient a en porter deux dans `Last-Event-ID`, et a les recoudre a la
 * reprise. Les deux bacs restent separes ; c'est la numerotation qui est commune.
 */
let journalSeq = 0;
/**
 * Le `n` de la derniere ligne EVINCEE, tous bacs confondus.
 *
 * C'est ce qui permet de repondre honnetement a une reprise : un navigateur qui revient avec un
 * curseur plus vieux que celui-la a rate des lignes qui n'existent plus, et lui envoyer un delta
 * lui laisserait un trou muet dans la chronologie. On lui renvoie la fenetre entiere, et on le
 * DIT (`complet`), pour qu'il remplace au lieu d'ajouter.
 */
let journalEvince = 0;
/** Ce que chaque bac retient. Le journal machine est le plus long : c'est l'instrument. */
const JOURNAL_MAX = { machine: 400, apps: 200 };

/**
 * **Une répétition consécutive n'écrit pas une ligne de plus, elle incrémente un compteur.**
 *
 * Mesuré sur un coupe-circuit réel : 24 lignes « local_reg erreur: socket hang up » sur les 30
 * dernières, et les six lignes qui expliquaient quelque chose — la mise en file des tâches, le
 * verdict — repoussées hors de l'écran. Le journal est l'instrument de diagnostic de ce serveur ;
 * une machine injoignable le remplit mécaniquement (`local_reg` toutes les 2,5 s) et noie
 * exactement ce qu'on vient y chercher.
 *
 * Seules les répétitions **consécutives** et de même origine sont repliées : deux occurrences
 * séparées par autre chose restent deux lignes, parce que leur voisinage est justement
 * l'information. L'horodatage suit la DERNIÈRE occurrence — « ça continue » est ce qu'on veut
 * savoir — et `repetitions` porte le compte.
 *
 * La trame entre dans la comparaison. Deux `data_response` de même opération et de même résumé
 * mais d'octets différents sont deux évènements : les replier ne garderait que les derniers
 * octets sous un compteur qui promettrait vingt-quatre fois les mêmes.
 */
function ligneJournal(bac, source, dir, sujet, resume, m, app, trame) {
  const mid = m?.id ?? null;
  const tete = bac[0];
  if (
    tete && tete.dir === dir && tete.sujet === sujet && tete.resume === resume &&
    tete.m === mid && tete.app === app && tete.trame === trame
  ) {
    tete.repetitions += 1;
    tete.t = Date.now();
    tete.n = ++journalSeq;
    return tete;
  }
  const n = ++journalSeq;
  const e = { id: n, n, t: Date.now(), source, dir, sujet, resume, m: mid, app, repetitions: 1, trame: trame ?? null };
  bac.unshift(e);
  if (bac.length > JOURNAL_MAX[source]) journalEvince = Math.max(journalEvince, bac.pop().n);
  return e;
}

/** La ligne telle qu'elle s'écrit dans le terminal — un seul endroit, les deux journaux. */
function ligneTexte(e) {
  return (e.app ? `${e.app} · ` : "") + e.sujet + (e.resume ? ` · ${e.resume}` : "") +
    (e.repetitions > 1 ? ` (×${e.repetitions})` : "");
}

/**
 * ⚠️ **`sujet` et `resume` sont deux arguments, pas une phrase à découper ensuite.**
 *
 * Le sujet est une COLONNE dans `/pilotage` : il s'aligne d'une ligne à l'autre, et c'est cet
 * alignement qui fait qu'on descend un journal du regard au lieu de relire cinquante phrases.
 * Le déduire au rendu — couper au premier « : » — marchait sur les messages qui suivent la
 * convention et laissait une colonne vide sur les autres, sans que rien ne le signale. Ici la
 * signature l'exige : un appel qui n'a pas de sujet ne compile pas dans la tête de qui l'écrit.
 *
 * `trame` est la valeur base64 telle qu'elle a circulé, jamais un décodage. Ce qui la lit
 * (`opTrame`, `argumentsTrame`) vit dans `ecam-args.mjs` et s'exécute dans le navigateur, à
 * l'ouverture du tiroir : décoder 400 lignes à chaque poussée reviendrait à payer le tiroir sur
 * les 399 qu'on n'ouvre pas.
 */
function L(dir, sujet, resume = "", m = null, trame = null) {
  const e = ligneJournal(LOG, "machine", dir, sujet, resume, m, null, trame);
  // Tout changement d'état significatif passe par ici : c'est donc d'ici qu'on prévient les
  // navigateurs abonnés. Voir sseTouch().
  sseTouch();
  // Le préfixe n'apparaît que s'il y a de quoi confondre : en mono-machine, la sortie du
  // terminal reste exactement celle qu'elle était.
  console.log(now(), dir.toUpperCase(), (m && MACHINES.size > 1 ? `[${m.id}] ` : "") + ligneTexte(e));
}

/**
 * Le journal des APPLICATIONS — le second, et il est séparé pour une raison de lecture.
 *
 * Une application branchée bavarde : elle se réannonce, elle sonde, et nous lui rediffusons
 * chaque état que la machine pousse. Versé dans le journal principal, ce trafic en chasse en
 * quelques secondes ce qu'on vient y chercher — ce que la cafetière, elle, a répondu.
 *
 * **La frontière : le journal principal garde ce qui ATTEINT l'appareil, celui-ci garde la
 * conversation avec les téléphones.** Une commande relayée paraît donc des deux côtés, sous
 * deux angles : ici « a1 a demandé ceci », là-bas « la tâche part vers la machine ». Ce n'est
 * pas une redite : la première ligne dit qui a voulu, la seconde dit ce qu'il en est advenu.
 *
 * Mêmes règles que `L()`, et pour les mêmes raisons : repli des lignes consécutives identiques
 * — le compte survit dans `repetitions` et ne doit jamais se perdre au rendu — et `sseTouch()`,
 * sans quoi la page ne saurait pas qu'il y a du neuf. Une différence : l'identifiant de
 * l'application est une COLONNE, pas un préfixe de message, ce qui permet de suivre un
 * téléphone parmi trois. `app` accepte une entrée du registre ou une simple adresse, parce que
 * les refus arrivent avant qu'une entrée existe — et ce sont eux qu'on veut le plus voir.
 */
const LOG_APPS = [];
function LA(dir, sujet, resume = "", app = null, m = null, trame = null) {
  const qui = app?.id ?? app ?? null;
  const e = ligneJournal(LOG_APPS, "apps", dir, sujet, resume, m, qui, trame);
  sseTouch();
  console.log(now(), "APP", ligneTexte(e));
}

/**
 * État d'exécution d'UNE machine. Tout ce qui était un singleton de processus vit ici : la
 * session chiffrée, le programme en cours, la file de lecture, le dernier monitor, le profil
 * actif. Deux cafetières ont deux sessions et deux files — les confondre enverrait la commande
 * de l'une à l'autre, et c'est une commande qui agit sur un appareil réel.
 */
function makeMachine(row) {
  // Les variables d'environnement ne décrivent qu'une machine : la première. Voir ENV_MACHINE.
  const env = row.id === DEFAULT_MACHINE;
  const gen = env ? ENV_MACHINE.gen : "classic";
  return {
    id: row.id,
    label: row.label ?? null,
    createdAt: row.createdAt,
    /** API de stockage liée à cette machine (`src/lib/store.mjs`). */
    store: forMachine(row.id),

    ip: env ? ENV_MACHINE.ip : null,
    ipSource: env && ENV_MACHINE.ip ? "MACHINE_IP (.env.local)" : "inconnue",
    // Cache de résolution du nom d'hôte, vidé à chaque changement d'adresse. Voir machineTarget().
    dns: null,
    // Adresse source réellement observée pour cette machine, mémorisée au key exchange. Sert
    // à la reconnaître ensuite sur les endpoints qui ne portent aucune identité.
    peerIp: null,

    dsn: env ? ENV_MACHINE.dsn : null,
    dsnSource: env && ENV_MACHINE.dsn ? "MACHINE_DSN (.env.local)" : "inconnu",
    // Étranglement de la résolution du DSN, et dédoublonnage de son verdict dans le journal.
    dsnLastTry: 0,
    dsnLastMsg: null,
    // Dernier verdict de sonde. Il existe pour que le refus adressé à l'utilisateur puisse nommer
    // la cause réelle au lieu de recopier une consigne générique : la même information partait
    // déjà au journal, elle n'atteignait simplement pas l'écran.
    dsnLastProbe: null,

    lanKey: Buffer.from((env ? ENV_MACHINE.lanKey : null) ?? "", "utf8"),
    lanKeyId: env ? ENV_MACHINE.lanKeyId : 0,
    lanKeySource: env && ENV_MACHINE.lanKey ? "LANIP_KEY (.env.local)" : "inconnue",

    modelKey: env ? ENV_MACHINE.modelKey : null,
    modelSource: env && ENV_MACHINE.modelKey ? "MACHINE_MODEL_KEY (.env.local)" : "inconnu",
    /**
     * Catalogue de boissons de CETTE machine, choisi par son modèle.
     *
     * Posé par `applyCatalog()`, réévalué dès que le modèle change (détection, cache, variable).
     * Les noms de propriétés Ayla, eux, ne dépendent pas du modèle — ce sont des créneaux figés —
     * donc un changement de catalogue **n'invalide pas le cache** : seule la liste change.
     */
    catalog: catalogFor(env ? ENV_MACHINE.modelKey : null),
    // Derniere identification du modele (decodage de `d270_serialnumber`). En cas d'echec on garde
    // la raison ET la trame : c'est ce qui rend une decoupe fausse corrigeable en une passe.
    identity: null,

    gen,
    send: gen === "striker" ? "app_data_request" : "data_request",
    mon: gen === "striker" ? "d302_monitor_machine" : "d302_monitor",

    // Jeton d'accès Ayla obtenu pour cette machine, **en mémoire seulement** : il meurt avec le
    // processus. C'est le premier niveau de la cascade — deux vérifications OTA d'affilée ne
    // redemandent donc rien, ni au cloud ni à l'utilisateur.
    aylaToken: null, // { token, expiresAt }

    session: null,
    /**
     * **La file de tâches — l'unique état de « ce qu'on demande à la machine ».**
     *
     * Elle remplace `m.program` et `m.import`, qui étaient deux emplacements UNIQUES écrasés sans
     * sommation : la machine ne prenant qu'une commande par visite, tout ce qui arrivait pendant
     * qu'une lecture tournait la décapitait, silencieusement. Voir `src/lib/tasks.mjs`.
     *
     * Les deux anciens champs survivent en **vues dérivées** (`vueProgramme`, `vueImport`), parce
     * que /machines, /api/beverages et /api/profiles les lisent — les casser n'apportait rien à
     * cette fiabilisation.
     */
    file: nouvelleFile(),
    /** Compteur de visites de commands.json, pour la chorégraphie `device_connected`. */
    visites: 0,
    cmdId: 0,
    /**
     * **La dernière valeur BRUTE de chaque propriété, telle que la machine l'a poussée.**
     *
     * Ni décodée ni interprétée : c'est ce qu'on redonne à une application qui la demande, et
     * une valeur qu'on ne sait pas décoder doit pouvoir être servie comme les autres.
     *
     * Elle existe parce que la lecture d'une application a **5 secondes** pour être servie
     * (`defaultNetworkTimeoutMs`), là où un aller-retour vers la cafetière en demande
     * facilement le double : la machine ne vient chercher qu'une commande par visite, et elle
     * ne visite que toutes les 2,5 s. Répondre depuis ce cache n'est donc pas une optimisation,
     * c'est la seule façon de répondre à temps — et c'est exactement la promesse du
     * multiplexeur : **une lecture réelle, N destinataires.**
     *
     * En mémoire seulement, bornée par le nombre de propriétés distinctes (~60). Un redémarrage
     * la vide, ce qui ne coûte qu'une lecture réelle de plus.
     */
    dernieresValeurs: new Map(),
    lastMonitor: null,
    lastDataResponse: null,
    lastRegisterAt: 0,
    keepalive: null,
    // Dernier profil qu'on a demandé à la machine. La trame de « présence » (0xA9) EST la
    // commande de sélection de profil : si on la figeait sur 1, chaque programme ramènerait la
    // machine au profil 1 quelques secondes après la commande de l'utilisateur.
    activeProfile: 1,
    // Faux tant qu'on n'a pas nous-mêmes imposé un profil dans cette session. La valeur 1
    // ci-dessus n'est qu'un défaut nécessaire à la trame de présence : elle ne prouve pas que
    // la machine est sur le profil 1. On ne sait pas lire son profil courant (piste :
    // `d286_mach_sett_profile`, encodage non vérifié), donc l'UI doit dire qu'elle l'ignore
    // plutôt que d'affirmer un profil arbitraire après un redémarrage du serveur.
    activeProfileConfirmed: false,
    // Dernier appel à /api/presence, pour ne pas marteler la machine quand plusieurs onglets
    // s'ouvrent en même temps.
    lastPresenceAt: 0,
    // Les balayages ne sont plus des états : un balayage EST une tâche à N pas, cadencée par les
    // visites de la machine et non par un `setTimeout(11000)` deviné. Voir scanBeans / scanStats.
    // Requêtes OTA reçues DE la machine. En LAN mode, c'est la machine qui vient chercher l'image
    // chez nous (`LanOTAHandler` sert la route `/ota_status.json` et le chemin de l'image) : une
    // requête ici est donc le seul signal local d'une opération OTA.
    otaRequests: [],
  };
}

/**
 * Cette machine est-elle celle que décrivent les variables d'environnement ?
 *
 * Seule la première l'est (voir ENV_MACHINE). Pour toutes les autres il n'existe aucun forçage
 * par variable, donc le réglage saisi dans l'interface fait autorité sans concurrence — et
 * surtout : un `MACHINE_IP` présent ne doit pas revendiquer l'adresse de la machine numéro 2.
 */
const envForced = (m, champ) => m.id === DEFAULT_MACHINE && !!ENV_MACHINE[champ];

/**
 * (Re)choisit le catalogue d'une machine d'après son modèle, et dit ce qu'il a fait.
 *
 * Trois cas, tous annoncés :
 *   - modèle supporté et différent de celui en place → on **bascule**. C'est le but ;
 *   - modèle connu de la table mais dont les boissons sortent de l'espace de noms vérifié
 *     (familles « iced »/« mug » des Striker), ou dont la table ne donne aucune recette → on
 *     conserve le catalogue par défaut et on le dit. Inventer des noms de propriétés serait pire
 *     que d'avouer la limite ;
 *   - rien de nouveau → silence.
 */
function applyCatalog(m) {
  const avant = m.catalog?.key ?? null;
  m.catalog = catalogFor(m.modelKey);
  const c = m.catalog;

  /**
   * La **génération** se déduit du modèle, exactement comme l'app le fait : `p258z7/s.r()` rend
   * vrai quand l'`appModelId` de la machine **contient** « striker », sans égard à la casse. Ce
   * n'est donc pas une supposition de notre part, c'est la règle de l'app portée telle quelle.
   *
   * Elle décide des propriétés de transport (`data_request` / `d302_monitor` contre
   * `app_data_request` / `d302_monitor_machine`) : s'en remettre à un défaut « classic » sur une
   * machine Striker, c'est parler dans le vide. `MACHINE_GENERATION` garde le dernier mot.
   */
  if (!ENV_MACHINE.genForced || m.id !== DEFAULT_MACHINE) {
    // Depuis le modèle DÉTECTÉ, pas depuis le catalogue : quand le catalogue est un pis-aller (une
    // Striker dont la table ne donne aucune recette), il vient d'un autre modèle et parlerait
    // « classic » à une machine qui ne comprend que « striker ». On sait pourtant qu'elle est
    // Striker — la table d'identification le dit, même sans recettes.
    const identite = (m.modelKey ? modelSheet(m.modelKey)?.appModelId : null) ?? c.model.appModelId;
    const gen = /striker/i.test(identite ?? "") ? "striker" : "classic";
    if (gen !== m.gen) {
      m.gen = gen;
      m.send = gen === "striker" ? "app_data_request" : "data_request";
      m.mon = gen === "striker" ? "d302_monitor_machine" : "d302_monitor";
      L("sys", "modele", `déduite du modèle ${identite} : ${gen} (propriétés ${m.send} / ${m.mon})`, m);
    }
  }
  if (c.fallback && m.modelKey) {
    const fiche = modelSheet(m.modelKey);
    L("sys", "catalogue", fiche
      ? `⚠ modèle ${m.modelKey} (${fiche.type}) reconnu mais son catalogue n'est pas exploitable (${fiche.support === "norecipes" ? "aucune recette dans la table constructeur" : "boissons hors de l'espace de noms vérifié"}) — catalogue ${c.model.type} conservé`
      : `⚠ modèle ${m.modelKey} absent de la table des catalogues — catalogue ${c.model.type} conservé`, m);
  } else if (avant && avant !== c.key) {
    L("sys", "catalogue", `basculé sur ${c.model.type} (${c.key}) : ${c.beverages.length} boissons, ${c.model.nProfiles} profils, ${c.model.nCustomRecipes} recettes perso`, m);
  }
  if (c.unaddressable.length) {
    L("sys", "catalogue", `⚠ ${c.unaddressable.length} boissons de ce modèle n'ont aucune propriété Ayla connue (${c.unaddressable.slice(0, 6).join(", ")}…) : listées, mais ni lisibles ni réglables`, m);
  }
  return c;
}

const machineList = () => [...MACHINES.values()];
const machineById = (id) => MACHINES.get(String(id)) ?? null;

/**
 * Nom affichable, par ordre de préférence : le libellé choisi par l'utilisateur, le modèle lu sur
 * la machine (« ECAM 610.75.MB », le plus parlant des replis), le nom dérivé du numéro de série,
 * le DSN, l'identifiant. Toujours une chaîne non vide.
 */
/**
 * Le nom affiche d'une machine.
 *
 * **Le numero de serie n'est PAS un nom.** Il fermait cette chaine, et comme le modele n'est lu
 * qu'apres la cle LAN, c'est lui qui titrait la carte pendant toute la mise en service — soit
 * exactement le moment ou l'on regarde cette page. Releve : le DSN imprime quatre fois dans une
 * seule carte, dont en titre `h2`, alors qu'il a deja sa propre ligne juste en dessous. Un serie
 * de quinze caracteres ne se prononce pas, ne se retient pas, et ne distingue donc pas deux
 * appareils pour un humain : il identifie, il ne nomme pas.
 *
 * L'identifiant qui ferme la chaine (`m1`) est court, stable, et c'est celui que le journal
 * emploie — la carte le montre d'ailleurs a cote du titre.
 */
function machineLabel(m) {
  return m.label || (m.modelKey ? findModel(m.modelKey)?.type : null) || m.identity?.machineName || m.id;
}

/**
 * La machine visée quand une requête n'en désigne aucune : celle que l'utilisateur a désignée
 * par défaut, sinon la première créée. Ne rend jamais `undefined` — `loadMachines()` garantit
 * qu'il en existe au moins une.
 */
function defaultMachine() {
  const chosen = getSetting("defaultMachine");
  return (chosen && MACHINES.get(chosen)) || machineList()[0];
}

/** Construit le registre à partir de la base. Au moins une machine existe toujours. */
function loadMachines() {
  MACHINES.clear();
  let rows = listMachines();
  if (!rows.length) { createMachine({ label: null }); rows = listMachines(); }
  for (const row of rows) MACHINES.set(row.id, makeMachine(row));
  return machineList();
}

/**
 * Machine visée par une requête d'API : le paramètre `machine` de la query string, sinon celle
 * par défaut.
 *
 * Un identifiant inconnu est une **erreur**, jamais un repli silencieux vers la machine par
 * défaut. Préparer un café sur la mauvaise cafetière parce qu'un onglet portait un identifiant
 * périmé est exactement le genre d'effet qu'on ne peut pas rattraper après coup.
 */
function pickMachine(req) {
  const id = new URL(req.url, "http://x").searchParams.get("machine");
  if (!id) return { m: defaultMachine() };
  const m = machineById(id);
  if (!m) return { m: null, error: `machine « ${id} » inconnue : elle a peut-être été supprimée. Recharger la page, ou en choisir une autre.` };
  return { m };
}

/** Adresse source de la requête, débarrassée du préfixe IPv4-mappé d'IPv6. */
const peerAddress = (req) => String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");

/**
 * Quelle machine nous appelle ?
 *
 * Les endpoints device-facing ne portent **aucune** identité : le `uri` annoncé dans `local_reg`
 * est commun à toutes, et seul `key_exchange.json` transporte un `key_id`. On identifie donc par
 * l'ADRESSE SOURCE, la seule information disponible sur les trois endpoints.
 *
 * Ordre volontaire :
 *   1. une seule machine connue → c'est elle, sans condition. Une installation mono-machine ne
 *      peut ainsi pas régresser, y compris quand l'adresse est saisie en nom d'hôte ou que la
 *      machine sort d'un NAT ;
 *   2. l'adresse source correspond à l'adresse configurée, ou à celle qu'on a résolue ;
 *   3. l'adresse source a déjà été reconnue lors d'un échange de clés (`peerIp`).
 *
 * `null` ne signifie pas « pas la nôtre » : au key exchange, le `key_id` peut encore trancher.
 */
function machineByPeer(req) {
  if (MACHINES.size === 1) return machineList()[0];
  const peer = peerAddress(req);
  if (!peer) return null;
  for (const m of MACHINES.values()) if (m.ip === peer || m.dns?.ip === peer) return m;
  for (const m of MACHINES.values()) if (m.peerIp === peer) return m;
  return null;
}

/**
 * Repli du key exchange : chaque machine a sa propre clé LAN, donc son propre `key_id`. Ambigu
 * (deux machines, même key_id) ⇒ on refuse plutôt que de deviner.
 */
function machineByKeyId(keyId) {
  const id = Number(keyId);
  if (!Number.isFinite(id) || id === 0) return null;
  const hits = machineList().filter((m) => m.lanKeyId === id);
  return hits.length === 1 ? hits[0] : null;
}

// --- crypto ---
/**
 * **La dérivation vit dans `src/lib/lansession.mjs`, et elle y vit pour les DEUX rôles.**
 *
 * Elle était ici, en un seul sens : lan-server ne savait qu'être le client auquel la machine se
 * connecte. Le multiplexeur (`doc/spec-proxy-multi-app.md`) demande l'autre moitié — se faire
 * passer pour l'appareil auprès des applications — et c'est le MÊME protocole, opérandes échangés.
 * En garder une copie ici aurait donné deux implémentations d'une dérivation cryptographique, qui
 * divergent au premier correctif ; le module est en prime PUR, donc `scripts/verif-lansession.mjs`
 * fait dialoguer les deux rôles sans machine ni réseau.
 */
function makeSession(m, kx, time2) {
  return makeLanSession({
    lanKey: m.lanKey,
    random1: kx.random_1,
    random2: token(16),
    time1: kx.time_1,
    time2,
    role: "client",
  });
}

// --- ECAM ---
function crc16(b) { let c = 0x1d0f; for (let i = 0; i < b.length - 2; i++) { const a = (((c << 8) | (c >>> 8)) & 0xffff) ^ b[i]; const x = a ^ ((a & 0xff) >> 4); const y = x ^ ((x << 12) & 0xffff); c = y ^ (((y & 0xff) << 5) & 0xffff); } return c & 0xffff; }
function seal(arr) { const b = Buffer.from(arr); const c = crc16(b); b[b.length - 2] = (c >> 8) & 0xff; b[b.length - 1] = c & 0xff; return b; }
const frameTurnOn = () => seal([0x0d, 0x07, 0x84, 0x0f, 0x02, 0x01, 0, 0]);
const frameTurnOff = () => seal([0x0d, 0x07, 0x84, 0x0f, 0x01, 0x01, 0, 0]);
const frameSendProfile = (id = 1) => seal([0x0d, 0x06, 0xa9, 0xf0, id & 0xff, 0, 0]);
const frameSelectBean = (id) => seal([0x0d, 0x06, 0xb9, 0xf0, id & 0xff, 0, 0]);
// M0() « recipeQtyPacket » : lecture ECAM native d'une recette (profil + boisson).
// Réponse : D0 <len> A6 F0 <profil> <boisson> <paramètres…> <crc>, parsée par u0() dans l'app.
// Gardée sans être appelée : les valeurs d'un profil sont lues par propriété Ayla
// (`d{39+i+(p-1)*21}_{p}_rec_*`), pas par cette trame. Elle documente le format de la requête
// 0xA6 côté ECAM, qui est la seule autre façon de l'obtenir — la supprimer ferait perdre la
// correspondance avec `doc/commandes-cafe.md` §6.
// eslint-disable-next-line no-unused-vars
const frameRecipeQty = (prof, bev) => seal([0x0d, 0x07, 0xa6, 0xf0, prof & 0xff, bev & 0xff, 0, 0]);
// J() « checksums » : sommes de contrôle des quantités par profil + perso + noms. Une seule
// petite trame permet de savoir si le cache est encore valable, au lieu de tout relire.
const frameChecksums = () => seal([0x0d, 0x05, 0xa3, 0xf0, 0, 0]);
// V(data2) : demande du monitor. Trame de LECTURE, sans aucun effet de bord — c'est ce qu'il
// faut pour tenir la présence, contrairement à 0xA9 qui sélectionne un profil.
const frameMonitorRequest = () => seal([0x0d, 0x05, 0x75, 0x0f, 0, 0]);

/**
 * Échéance d'un pas « Présence », et elle ne peut PAS valoir `DELAIS.reponse`.
 *
 * `0x75` ne rend aucun `data_response` : il est satisfait par la prochaine poussée périodique de
 * `d302_monitor`. Or cette poussée a une **cadence mesurée de 12 à 13 secondes** (12,4 s le
 * 2026-08-22 : 16:36:42,297 puis 16:36:54,740 ; et 13 s, 12 s, 13 s sur les relevés précédents),
 * c'est-à-dire exactement l'échéance de 12 s qu'on lui opposait. La réussite se jouait donc à
 * l'endroit où la demande tombait dans le cycle de la machine — un tirage au sort, gagné ce jour-là
 * avec 1,7 s de marge, perdu les fois d'avant.
 *
 * Le contraste avec `0xA2` dit tout : une lecture de statistiques répond dans la **même seconde**,
 * parce qu'elle rend un vrai `data_response`. Les deux ne sont pas de la même famille, et leur
 * donner la même échéance revenait à traiter une attente d'horloge comme une attente de réponse.
 *
 * Même raisonnement que `AGE_PROGRESSION`, qui est tenu strictement au-dessus du pire écart mesuré
 * entre deux trames : une échéance sous la cadence réelle ne mesure pas une panne, elle en fabrique.
 * 30 s laisse plus de deux cycles, et c'est aussi le plafond que `startProgram` s'autorise.
 */
const DELAI_PRESENCE = 30000;
// U(index) « BEAN_SYSTEM_READ » : seule source du NOM d'un profil Bean Adapt.
const frameBeanSystem = (index) => seal([0x0d, 0x06, 0xba, 0xf0, index & 0xff, 0, 0]);
/**
 * d0(paramAddress, qty) « readSettingsParameter » : lecture des PARAMÈTRES machine, dont les
 * compteurs d'utilisation (nombre de boissons, détartrages, filtres, litres d'eau…).
 *
 * `0D 08 A2 0F <idHi> <idLo> <qty> <crc>` — l'identifiant est sur 16 bits, `qty` demande autant de
 * paramètres CONSÉCUTIFS à partir de là. Noter le flag `0x0F` (comme la demande de monitor), pas
 * `0xF0`. Trame de lecture pure, aucun effet sur la machine.
 */
const frameParamRead = (id, qty = 1) => seal([0x0d, 0x08, 0xa2, 0x0f, (id >> 8) & 0xff, id & 0xff, qty & 0xff, 0, 0]);

/**
 * **Les réglages de la machine — `0x95` en lecture, `0x90` en écriture.**
 *
 * Portés de `p097j6/d.b0()` (`getPacketForReadParameter`) et `d.n0()`
 * (`getPacketForWriteParameter`), les deux seules trames de configuration que l'app envoie par
 * Wi-Fi et que ce serveur ignorait. Le flag suit la même règle dans les deux sens : `0x0F` sous
 * l'adresse 1000, `0xF0` au-delà — recopié tel quel de l'app, dont la table d'adresses connue
 * tient entièrement sous 1000.
 *
 * Les deux parlent bien de la même taille : `0x95` demande `qty` adresses consécutives et la
 * réponse rend **4 octets par adresse** (voir `decodeSettings`), `0x90` en écrit 4. Tous les
 * réglages connus tiennent en réalité dans l'octet de poids faible — c'est là que l'app va
 * chercher les bits de l'adresse 63 (`Parameter.f()` : `b[3] & 1`).
 */
const frameParamRead95 = (id, qty = 1) =>
  seal([0x0d, 0x08, 0x95, id < 1000 ? 0x0f : 0xf0, (id >> 8) & 0xff, id & 0xff, qty & 0xff, 0, 0]);
const frameParamWrite = (id, value) =>
  seal([0x0d, 0x0b, 0x90, id < 1000 ? 0x0f : 0xf0, (id >> 8) & 0xff, id & 0xff,
        (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff, 0, 0]);

/**
 * **Écriture d'un bloc de noms — `0xA5` (profils) et `0xAB` (recettes perso).**
 *
 * Ports de `d.j0()` / `d.f0()`. C'est le pendant exact des lectures `0xA4` / `0xAA` que
 * `profiles.mjs` décode déjà, **même pas de 21 octets** : 20 octets de nom UTF-16BE puis 1 octet
 * d'icône. Les octets 4 et 5 portent le premier et le dernier index, comme en lecture — ce qui
 * permet de n'écrire qu'une entrée sans toucher aux autres.
 *
 * La variante Striker (`d.k0()`) a un pas de 22 : une seconde valeur par entrée. Elle n'est pas
 * portée ici — cette machine est « classic », et écrire un bloc au mauvais pas décalerait tous les
 * noms suivants sur un appareil réel.
 */
function frameSetNames(cmd, first, last, entrees) {
  const corps = entrees.length * 21;
  const bytes = new Array(corps + 8).fill(0);
  bytes[0] = 0x0d;
  bytes[1] = corps + 7;
  bytes[2] = cmd & 0xff;
  bytes[3] = 0xf0;
  bytes[4] = first & 0xff;
  bytes[5] = last & 0xff;
  let o = 6;
  for (const e of entrees) {
    const n = encodeBeanName(e.name);         // même encodage : 20 caractères, UTF-16BE, complété de zéros
    for (let i = 0; i < 20; i++) bytes[o + i] = n[i];
    bytes[o + 20] = e.icon & 0xff;
    o += 21;
  }
  return seal(bytes);
}

/**
 * **Ordre des favoris — `0xAD`** (`d.i0()`, `getPacketForSetFavoriteBeverage`).
 *
 * `0D 12 AD F0 <profil> <12 identifiants de boisson> <crc16>` — longueur fixe de 19 octets, donc
 * exactement 12 entrées, complétées de zéros si la liste est plus courte. Pendant de la lecture
 * `0xA8` (`d{260+p}_{p}_rec_priority`), que `/` utilise déjà pour ordonner ses cartes.
 */
function frameSetFavorites(profile, ordre) {
  const bytes = new Array(19).fill(0);
  bytes[0] = 0x0d;
  bytes[1] = 0x12;
  bytes[2] = 0xad;
  bytes[3] = 0xf0;
  bytes[4] = profile & 0xff;
  for (let i = 0; i < 12; i++) bytes[5 + i] = (ordre[i] ?? 0) & 0xff;
  return seal(bytes);
}

/**
 * **Les trois modes de monitor** (`d.V()`, `getByteMonitorMode`) : `0x60`, `0x70`, `0x75`.
 *
 * Seul `0x75` est utilisé par le service Wi-Fi de l'app ; les deux autres n'apparaissent que dans
 * le constructeur de trames, côté Bluetooth. Leur contenu de réponse est **inconnu** et rien ne
 * garantit que le module y réponde en LAN — d'où `POST /api/monitormode`, qui les envoie et se
 * contente de journaliser la réponse brute. Trames de lecture, sans effet de bord connu.
 */
const MONITOR_MODES = { 0: 0x60, 1: 0x70, 2: 0x75 };
const frameMonitorMode = (mode) => seal([0x0d, 0x05, MONITOR_MODES[mode] ?? 0x75, 0x0f, 0, 0]);

/**
 * a0() « bean system save or delete » — 52 octets (docs/bean-adapt.md §5.1) :
 *
 *   4       id du profil
 *   5..44   nom, 40 octets UTF-16 big-endian
 *   45      mouture      46  température      47  arôme
 *   48      réservé (0)  49  visible (1 actif / 0 supprimé)
 *   50,51   CRC16
 *
 * La suppression n'est pas une commande distincte : c'est la même trame avec `visible = 0`.
 * ⚠️ Le doublement de la mouture (`grinder * 2`) est un cas **Striker** — pas cette machine.
 */
function frameBeanSystemSave(id, name, grinder, temperature, aroma, visible = true) {
  const bytes = new Array(52).fill(0);
  bytes[0] = 0x0d;
  bytes[1] = 0x33;
  bytes[2] = 0xbb;
  bytes[3] = 0xf0;
  bytes[4] = id & 0xff;
  const n = encodeBeanName(name);
  for (let i = 0; i < 40; i++) bytes[5 + i] = n[i];
  bytes[45] = grinder & 0xff;
  bytes[46] = temperature & 0xff;
  bytes[47] = aroma & 0xff;
  bytes[48] = 0;
  bytes[49] = visible ? 1 : 0;
  return seal(bytes);
}
/**
 * **L'assemblage a déménagé dans `src/lib/trame-boisson.mjs`, et il n'en reste ici que l'emballage.**
 *
 * Ce n'est pas un rangement : la carte d'une boisson affiche cette trame en direct pendant qu'on
 * bouge les curseurs, donc le navigateur doit pouvoir la construire — et le seul moyen que la ligne
 * affichée soit bien celle qui partira est qu'il n'y ait qu'UNE fonction. Le module est pur et sans
 * `Buffer` pour cette raison ; le `seal` n'a plus rien à sceller, le CRC est déjà posé.
 */
function frameDispense(bev, prof, mode, action, params, check = false) {
  return Buffer.from(encodeDispense(bev, prof, mode, action, params, check).bytes);
}
function datapointValue(frame) { const t = Buffer.alloc(4); t.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0); return Buffer.concat([frame, t]).toString("base64"); }
/**
 * Décode la réponse `0xA2` — port de `p097j6.d.L()` case `-94`.
 *
 * ```
 * 0        0xD0
 * 1        len = taille totale − 1
 * 2        0xA2
 * 3        0x0F
 * 4..      n entrées de 6 octets : id sur 16 bits big-endian, puis valeur sur 32 bits
 * 2 dern.  CRC16
 * ```
 *
 * `n = (len − 5) / 6`. Une seule réponse peut donc porter plusieurs paramètres — c'est ce que
 * `qty` demande. Les valeurs sont lues en big-endian comme tout le reste du protocole (`z.g0()`).
 */
function decodeParameters(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 12) throw new Error(`trame trop courte (${buf.length} octets)`);
  if (buf[2] !== 0xa2) throw new Error(`commande inattendue 0x${buf[2].toString(16)}`);
  const count = Math.floor((buf[1] - 5) / 6);
  if (count < 1) throw new Error(`aucune entrée (len ${buf[1]})`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 6;
    if (o + 6 > buf.length - 2) break;
    entries.push({ id: (buf[o] << 8) | buf[o + 1], value: buf.readUInt32BE(o + 2) });
  }
  return { count, entries, hex: buf.subarray(0, buf[1] + 1).toString("hex").replace(/(..)/g, "$1 ").trim() };
}

/**
 * **Réponse `0x95` — les réglages machine.** Port de `p097j6/d.q0()`
 * (`getParametersFromByte`), et le format n'est PAS celui de `0xA2` :
 *
 *   octet 1     len
 *   octets 4-5  adresse du PREMIER réglage (16 bits)
 *   octets 6…   n × 4 octets de valeur, adresses consécutives ; n = (len − 7) / 4
 *
 * L'identifiant n'est donc pas répété devant chaque valeur, contrairement à `0xA2` : il faut
 * l'incrémenter soi-même. Confondre les deux formats décalerait chaque valeur d'un cran, ce qui
 * donnerait des réglages plausibles et faux — l'espèce d'erreur qui ne se voit qu'à l'usage.
 */
function decodeSettings(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) throw new Error(`trame trop courte (${buf.length} octets)`);
  if (buf[2] !== 0x95) throw new Error(`commande inattendue 0x${buf[2].toString(16)}`);
  const count = Math.floor((buf[1] - 7) / 4);
  if (count < 1) throw new Error(`aucune entrée (len ${buf[1]})`);
  const premier = (buf[4] << 8) | buf[5];
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 4;
    if (o + 4 > buf.length - 2) break;
    entries.push({ addr: premier + i, value: buf.readUInt32BE(o) });
  }
  return { count, entries, hex: buf.subarray(0, buf[1] + 1).toString("hex").replace(/(..)/g, "$1 ").trim() };
}

/**
 * Enregistre un relevé de réglages. Stocké dans `meta.reglages` — quelques entiers, une table
 * aurait coûté une version de schéma pour six lignes (même raisonnement que `meta.beanPresets`).
 * `source` dit par quel chemin la valeur est arrivée : la propriété Ayla ou la trame `0x95`. Les
 * deux existent pour la même donnée, et savoir laquelle a répondu est ce qu'on regarde quand
 * l'une des deux reste muette.
 */
function noteReglages(m, entries, source) {
  const actuel = m.store.getMeta("reglages") ?? {};
  const at = Date.now();
  for (const e of entries) actuel[e.addr] = { value: e.value, at, source };
  m.store.setMeta("reglages", actuel);
  return actuel;
}

/**
 * Met en forme un relevé de réglages : valeur brute, et pour l'adresse 63 les cinq interrupteurs
 * qu'elle porte. `autoStart` est **inversé** (bit à 1 = désactivé), comme dans l'app.
 */
function vueReglages(m, brut) {
  const modele = m.catalog?.model ?? {};
  /**
   * **Non déclaré vaut « non supporté », jamais « supporté par défaut ».** Le drapeau vient du
   * catalogue extrait de l'APK ; s'il manque, c'est que ce modèle ne figure pas dans la table ou
   * que la source ne dit rien — dans les deux cas on n'a aucune raison d'écrire à cette adresse.
   * Le sens inverse (absent ⇒ autorisé) proposerait un chauffe-tasses à une machine qui n'en a pas
   * et écrirait un bit dont on ignore l'effet.
   */
  const dispo = (drapeau) => (drapeau == null ? true : modele[drapeau] === true);
  const sortie = [];
  for (const r of REGLAGES) {
    const lu = brut?.[r.addr];
    const e = {
      addr: r.addr,
      cle: r.cle,
      value: lu?.value ?? null,
      at: lu?.at ?? null,
      source: lu?.source ?? null,
      min: r.min,
      max: r.max,
      supporte: dispo(r.supporte),
      prop: r.prop ? reglageProp(m, r) : null,
    };
    if (r.bits) {
      const v = e.value ?? 0;
      e.bits = r.bits.map((b) => ({
        cle: b.cle,
        bit: b.bit,
        value: e.value == null ? null : (b.inverse ? (v & (1 << b.bit)) === 0 : (v & (1 << b.bit)) !== 0),
        inverse: !!b.inverse,
        supporte: dispo(b.supporte),
      }));
    }
    sortie.push(e);
  }
  return sortie;
}

// Libellé d'une boisson, dans le catalogue de CETTE machine. Plus de table de module : deux
// machines de modèles différents n'ont pas la même liste, et un libellé pris dans la mauvaise
// nommerait une boisson que la machine ne sait pas faire.
const bevLabel = (m, id) => m.catalog.byId(id)?.label ?? id;
/**
 * De quoi laisser le client nommer une boisson lui-même dans un libellé de tâche.
 *
 * Renvoie soit un paramètre simple (`{ p }`) quand la machine porte un nom SAISI par l'utilisateur
 * — donnée personnelle, jamais traduite — soit une référence (`{ refs }`) vers l'espace `beverage`
 * du catalogue, que le client résout avec le même helper que ses pages. Le repli reste le `label`
 * français de la tâche : catalogue incomplet ⇒ texte serveur, jamais de clé brute à l'écran.
 */
/**
 * Le nom d'une boisson pour un libellé de tâche : soit un **paramètre** (`p`) quand la boisson
 * porte un nom SAISI sur la machine — qui ne se traduit pas — soit une **référence** (`refs`) vers
 * le slug du catalogue, que le client traduit lui-même.
 *
 * ⚠️ **Ne jamais étaler le résultat par-dessus un `p` existant.** Il rend l'une OU l'autre clé, et
 * `{ p: { profil }, ...bevRef(…) }` écrase silencieusement `p` tout entier dans le cas « nom
 * saisi » — le paramètre `profil` disparaît et next-intl lève `FORMATTING_ERROR` au rendu. Le
 * piège est vicieux parce qu'il ne se déclenche **que** sur les machines où l'utilisateur a
 * renommé une recette : partout ailleurs c'est la branche `refs`, et il n'y a pas de collision.
 * Fusionner explicitement : `p: { …, ...(r.p ?? {}) }, refs: r.refs`.
 */
function bevRef(m, id, nom = "boisson") {
  const perso = machineBeverageNames(m.store.machineView())[id]?.name;
  if (perso) return { p: { [nom]: perso } };
  const slug = m.catalog.byId(id)?.slug;
  return slug ? { refs: { [nom]: { ns: "beverage", cle: slug } } } : { p: { [nom]: String(bevLabel(m, id)) } };
}

// --- service des commandes : une visite, un pas ---
const prop = (m, name, value, id = false) => { const p = { base_type: "string", dsn: m.dsn ?? "", name, value, metadata: {} }; if (id) p.id = crypto.randomBytes(4).toString("hex"); return { property: p }; };
const nowSec = () => String(Math.floor(Date.now() / 1000));
const paquet = (props) => JSON.stringify({ properties: props });

/**
 * Ce qu'on sert à la machine lors de CETTE visite.
 *
 * Deux choses se superposent ici, et elles étaient auparavant mêlées dans `nextProgramData` :
 *
 * 1. **La chorégraphie de présence**, qui appartient au protocole — `device_connected` d'abord,
 *    puis rafraîchi une visite sur cinq. Elle ne dépend d'aucune priorité et reste donc ici.
 * 2. **Quel travail servir**, qui appartient à l'ordonnanceur et à lui seul (`aServir`).
 *
 * La machine ne prend qu'une commande par visite : c'est cette fonction qui matérialise
 * l'exclusion, et c'est pour ça qu'il ne peut jamais y avoir deux trames en vol.
 */
function prochainePaquet(m) {
  if (vide(m.file)) { m.visites = 0; return { data: "{}", label: "idle", trame: null }; }
  const c = m.visites++;
  // `device_connected` en tête de séquence puis périodiquement : la machine cesse de nous
  // considérer présents sans lui, et le pas suivant ne serait jamais récupéré.
  if (c === 0 || c % 5 === 0) return { data: paquet([prop(m, "device_connected", nowSec())]), label: "device_connected", trame: null };

  const a = aServir(m.file, Date.now());
  if (a.quoi === "pas") {
    const p = a.pas;
    if (p.type === "prop") return { data: readPropertyCmd(m, p.prop), label: `lecture ${p.prop}`, trame: null };
    return { data: paquet([prop(m, m.send, p.trame, true)]), label: `${a.tache.label} · ${p.nom}`, trame: p.trame };
  }
  if (a.quoi === "soutien") {
    // Présence tenue pendant qu'on attend la réponse du pas déjà servi.
    //
    // ⚠️ 0xA9 EST la commande de sélection de profil : s'en servir comme simple battement de cœur
    // imposait silencieusement le profil 1 (constaté : une demande de sommes de contrôle ramenait
    // la machine du profil 3 au profil 1). `profile` n'est donc utilisé que là où réaffirmer la
    // valeur est la recette validée — le réveil — ou idempotent : la sélection de profil elle-même.
    if (a.sustain === "profile") {
      const t = datapointValue(frameSendProfile(m.activeProfile));
      return { data: paquet([prop(m, m.send, t, true)]), label: `présence(profil ${m.activeProfile})`, trame: t };
    }
    const t = datapointValue(frameMonitorRequest());
    return { data: paquet([prop(m, m.send, t, true)]), label: "présence(monitor)", trame: t };
  }
  return { data: "{}", label: "idle", trame: null };
}

/**
 * **Les réglages machine, par adresse** — relevés dans le view-model de l'app
 * (`p018b7/d.java`), où chaque écran de configuration appelle `readParameter(addr, 1)` puis
 * `writeParameter(addr, valeur)`.
 *
 * `prop` est la propriété Ayla qui porte la même valeur : l'app la lit **de préférence** à la
 * trame quand la machine est jointe par le cloud (`d.X()` fait exactement ce choix pour la dureté
 * de l'eau). Deux familles de noms, comme partout ailleurs : `d28x_mchn_sett_*` en génération
 * classic, `d28x_mach_sett_*` en Striker.
 *
 * `bits` marque le seul réglage qui n'est pas un nombre : l'adresse 63 est un champ de bits, et
 * `autostart` y est **inversé** (bit à 1 = démarrage automatique désactivé). C'est l'app qui le
 * fait, pas nous : `d.f0()`, `zBooleanValue = bool5.booleanValue() ^ true`.
 *
 * `supporte` nomme le drapeau du catalogue de modèles qui dit si CE modèle expose le réglage —
 * l'ECAM 610.75 en supporte cinq sur neuf. Ne jamais proposer un réglage que le modèle ne déclare
 * pas : l'écrire quand même serait poser une valeur à une adresse dont on ignore l'usage.
 */
const REGLAGES = [
  { addr: 50, cle: "waterHardness", prop: true, supporte: "water_hardness_settings", min: 1, max: 4 },
  // `globalTemperature` : quand il est faux, la température est un paramètre de recette, pas un
  // réglage de la machine — l'adresse 61 n'a alors rien à régler.
  { addr: 61, cle: "temperature", prop: true, supporte: "globalTemperature", min: 0, max: 3 },
  { addr: 62, cle: "autoOff", prop: true, supporte: "auto_off_settings", min: 0, max: 255 },
  { addr: 63, cle: "userConf", prop: true, supporte: null, min: 0, max: 255, bits: [
    { bit: 0, cle: "autoStart", inverse: true, supporte: "auto_start_settings" },
    { bit: 2, cle: "buzzer", supporte: "buzzer_settings" },
    { bit: 3, cle: "cupLight", supporte: "cup_light_settings" },
    { bit: 4, cle: "energySaving", supporte: "energy_saving_settings" },
    { bit: 5, cle: "cupWarmer", supporte: "cup_warmer_settings" },
  ] },
  { addr: 64, cle: "autoStartHour", prop: null, supporte: "time_settings", min: 0, max: 23 },
  { addr: 65, cle: "autoStartMinute", prop: null, supporte: "time_settings", min: 0, max: 59 },
];
const REGLAGE_PAR_CLE = new Map(REGLAGES.map((r) => [r.cle, r]));
/**
 * Nom complet de la propriété Ayla d'un réglage, selon la génération.
 *
 * Les deux familles ne sont pas un simple préfixe : en Striker la dureté de l'eau s'appelle
 * `d283_mach_sett_water_hard` là où le classic dit `d283_mchn_sett_water`. Table explicite plutôt
 * que règle, pour la même raison que partout ailleurs ici — un nom inventé se lit « propriété
 * absente sur ce modèle » et non « bug ».
 */
const REGLAGE_PROPS = {
  50: { classic: "d283_mchn_sett_water", striker: "d283_mach_sett_water_hard" },
  61: { classic: "d281_mchn_sett_temp", striker: "d281_mach_sett_temperature" },
  62: { classic: "d282_mchn_sett_aoff", striker: "d282_mach_sett_auto_off" },
  63: { classic: "d284_mchn_sett_user_conf", striker: "d284_mach_sett_user_conf" },
};
function reglageProp(m, r) {
  const e = REGLAGE_PROPS[r.addr];
  if (!e) return null;
  return m.mon === "d302_monitor_machine" ? e.striker : e.classic;
}

/**
 * Les arguments d'une trame, en clair. Le décodage vit dans `src/lib/ecam-args.mjs`, **pur et
 * vérifié en CI** ; ici on ne fournit que ce qui n'est pas du protocole : le nom d'une boisson
 * pour CETTE machine — un nom tapé sur l'appareil prime sur le libellé du catalogue — et le nom
 * d'un réglage. Les deux dépendent de l'état, le décodeur ne doit pas les connaître.
 */
function argumentsTrame(m, ecamB64) {
  let t;
  try { t = opTrame(ecamB64).trame; } catch { return null; }
  return argsEcam(t, {
    boisson: (id) => machineBeverageNames(m.store.machineView())[id]?.name ?? m.catalog.byId(id)?.label ?? `boisson ${id}`,
    reglage: nomReglage,
    params: PARAMS,
  });
}
/** L'adresse d'un réglage machine, nommée quand `REGLAGES` la connaît. Sinon le nombre, nu. */
function nomReglage(addr) {
  const r = REGLAGES.find((x) => x.addr === addr);
  return r ? `réglage ${r.cle} (${addr})` : `réglage ${addr}`;
}

/**
 * La description complète d'une commande relayée : opération, **arguments**, puis octets.
 *
 * Cet ordre est le propos. `describeFrame` termine par la trame, ce qui convient à une ligne de
 * file où l'on cherche l'opération ; ici on lit d'abord la question qu'on se pose devant une
 * commande venue d'un tiers — *quelle boisson, quel profil, quels réglages* — et les octets
 * viennent après, pour vérifier ou pour rétro-concevoir. Ils ne disparaissent jamais : c'est la
 * seule trace exploitable d'une trame que nous ne saurions pas encore décoder.
 *
 * `octets: false` rend la forme courte — l'opération et ses arguments, sans les octets. C'est ce
 * qu'un libellé de tâche demande : le panneau « Activité » dit ce qui part vers la machine, il
 * n'est pas un dumper d'octets, et ceux-ci sont de toute façon dans les deux journaux.
 */
function decrireCommande(m, ecamB64, { octets = true } = {}) {
  const base = describeFrame(ecamB64, { octets });
  let args = null;
  try { args = argumentsTrame(m, ecamB64); } catch { /* décodage douteux : la trame suffit */ }
  if (!args) return base;
  // On réinsère avant « · trame … » plutôt que d'ajouter à la fin.
  const i = base.lastIndexOf(" · trame ");
  return i < 0 ? `${base} · ${args}` : `${base.slice(0, i)} · ${args}${base.slice(i)}`;
}

/**
 * La charge d'une écriture, **telle quelle** : hexadécimal complet et base64 d'origine.
 *
 * Sert au journal des applications, et pour une raison de méthode. `describeFrame()` est un outil
 * de lecture : il nomme l'opération et **retire les 4 octets d'horodatage** parce que ce ne sont
 * pas des octets de commande. C'est le bon choix quand on sait ce qu'on regarde. Ça devient le
 * mauvais dès qu'on ne sait pas : un outil qui a déjà décidé quoi jeter ne peut plus rien
 * apprendre, et ce projet s'est déjà fait prendre — voir `/regtoken.json`, où reconstruire la
 * réponse « évidente » revenait à parier sur une liste de champs qu'on ne connaissait pas.
 *
 * Donc ici : aucun retrait, aucune interprétation. Les deux formes parce qu'elles ne servent pas à
 * la même chose — l'hexadécimal se lit et se compare aux tables de `doc/commandes-cafe.md`, le
 * base64 se recolle tel quel dans un test ou un rejeu. Borné, parce qu'une ligne de journal reste
 * une ligne de journal ; la coupe est DITE plutôt que silencieuse.
 */
function chargeBrute(valeur, max = 120) {
  const v = String(valeur ?? "");
  if (!v) return "charge vide";
  const coupe = (s) => (s.length > max ? `${s.slice(0, max)}…` : s);
  // ⚠️ Tester AVANT de décoder, parce que `Buffer.from(x, "base64")` ne lève jamais : il ignore
  // silencieusement ce qui n'est pas du base64 et rend des octets qui ont l'air de quelque chose.
  // Relevé en direct sur la vraie application, qui écrit `device_connected = 1787407876` — un
  // horodatage unix en clair — et que cette fonction affichait « brut d7 bf 3b e3 4e fc ef ».
  // Sept octets inventés là où la valeur était lisible telle quelle : le contraire exact de ce
  // qu'un journal de rétro-ingénierie doit faire. Toutes les propriétés Ayla ne portent pas du
  // base64 ; celle qui porte les trames ECAM, oui, et c'est ce qui rendait le piège invisible.
  const semblebase64 = v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
  if (!semblebase64) return `valeur ${coupe(v)}`;
  const buf = Buffer.from(v, "base64");
  let hex = buf.subarray(0, max).toString("hex").replace(/(..)/g, "$1 ").trim();
  if (buf.length > max) hex += ` … (+${buf.length - max} octets)`;
  return `brut ${hex} · b64 ${coupe(v)}`;
}

/**
 * Met une COMMANDE ECAM en file. Signature conservée : quinze sites d'appel l'utilisent, et les
 * réécrire tous en même temps que l'ordonnanceur aurait mêlé deux changements dans un seul pas.
 *
 * `durationMs` n'a plus le même sens selon la trame, et c'est une correction, pas un détail :
 *
 * - une trame de **lecture** (`0x75`, `0xA2`, `0xA3`, `0xA6`, `0xB0`, `0xBA`) attend une réponse.
 *   Le pas s'achève quand elle arrive — plus quand un chronomètre le décide. Un balayage des grains
 *   avance donc à la vitesse de la machine au lieu d'un `setTimeout(11000)` deviné.
 * - une trame qui **agit** (`0x84`, `0x83`, `0xA9`, `0xBB`, `0xB9`) n'a rien à répondre :
 *   `durationMs` reste la durée de présence soutenue, et l'atteindre est un SUCCÈS.
 *
 * La nature se déduit de la table `ECAM_OPS` de `src/lib/ecam-args.mjs` : aucun site d'appel
 * n'a à trancher, et il n'y a pas de deuxième table à tenir à jour.
 */
/**
 * **Le pas d'une trame, avec sa nature.** C'est `natureTrame` qui décide si l'on attend une réponse
 * ou une fenêtre de présence, donc aucun appelant n'a à le savoir — et il n'existe pas de seconde
 * table à tenir à jour.
 *
 * Extrait de `startProgram` parce qu'un transfert de recette met DEUX trames dans une seule tâche
 * (`0x83` puis `0xAB`) : les construire à la main là-bas aurait recopié cette règle, et une copie
 * d'une règle d'ordonnancement diverge sans rien lever.
 */
function pasPourTrame(label, ecamB64, durationMs, sustain) {
  const lecture = natureTrame(ecamB64) === "lecture";
  // La commande ECAM voyage avec le pas : c'est elle qui permet d'apparier étroitement la réponse.
  // Voir `reponse()` dans `tasks.mjs` — une poussée de monitor ne doit valider qu'un pas qui a
  // justement demandé un monitor, jamais une lecture de statistiques en attente.
  const cmd = (() => { try { return opTrame(ecamB64).cmd ?? null; } catch { return null; } })();
  return lecture
    ? pasTrame(label, ecamB64, { attente: "reponse", ms: Math.max(DELAIS.reponse, Math.min(durationMs, 30000)), sustain, cmd })
    : pasTrame(label, ecamB64, { attente: "fenetre", ms: durationMs, sustain, cmd });
}

function startProgram(m, ecamB64, label, durationMs = 75000, sustain = "monitor", { rang = RANG.LECTURE, cle = null, meta = null, i18n = null } = {}) {
  const lecture = natureTrame(ecamB64) === "lecture";
  const pas = [pasPourTrame(label, ecamB64, durationMs, sustain)];
  return enfilerTache(m, tache({ label, rang, pas, cle, meta, i18n, genre: lecture ? "lecture" : "commande" }), `${label} — ${decrireCommande(m, ecamB64)} · présence ${sustain}`);
}

/** Met une LECTURE de propriétés Ayla en file : une tâche, un pas par propriété. */
function startImport(m, queue, durationMs = 120000, { label = null, rang = RANG.LECTURE, cle = null, meta = null, i18n = null } = {}) {
  const nom = label ?? (queue.length === 1 ? `Lecture ${queue[0]}` : `Lecture de ${queue.length} propriétés`);
  // Sans libellé explicite, la clé décrit la forme du repli, pas le contenu : une propriété nommée
  // ou un décompte. C'est exactement ce que dit le texte français juste au-dessus.
  const cleI18n = i18n ?? (label ? null : (queue.length === 1 ? { k: "readOne", p: { prop: queue[0] } } : { k: "readMany", p: { count: queue.length } }));
  const t = tache({ label: nom, rang, pas: queue.map((n) => pasLecture(n)), cle: cle ?? `lecture:${[...queue].sort().join(",")}`, meta, i18n: cleI18n });
  return enfilerTache(m, t, `${nom} — ${queue.length} propriété(s)`);
}

/**
 * Le seul endroit qui met en file, donc le seul qui journalise une mise en file, réveille le
 * keep-alive et arme le veilleur. Renvoie de quoi répondre au client : l'identifiant de la tâche et
 * sa place, pour que l'interface puisse la suivre au lieu de deviner.
 */
function enfilerTache(m, t, ligne) {
  const r = enfiler(m.file, t, Date.now());
  if (!r.ok) {
    L("sys", "file", `pleine (${MAX_FILE} tâches) : « ${t.label} » refusée`, m);
    return { ok: false, raison: r.raison };
  }
  if (r.fusion) {
    L("sys", "file", `« ${t.label} » déjà en attente (${r.tache.id}) : demande fusionnée`, m);
    return { ok: true, fusion: true, taskId: r.tache.id, position: m.file.liste.indexOf(r.tache) };
  }
  const position = m.file.liste.indexOf(r.tache);
  // Une seule ligne, et elle porte tout : ce que l'utilisateur a demandé, ce que ça vaut côté
  // protocole, et les octets. La trame vit ici — plus dans les messages de l'interface, où elle ne
  // renseignait personne sur le résultat de son geste. La position dit s'il va falloir attendre.
  L("out", "tâche", `${r.tache.id} · ${ligne}${position > 0 ? ` · ${position} tâche(s) devant` : ""}`, m);
  ensureKeepalive(m);
  sseWatch();
  return { ok: true, taskId: r.tache.id, position };
}

/**
 * Ce qu'un endpoint renvoie au client à propos de la tâche qu'il vient de mettre en file.
 *
 * Sans identifiant, l'interface ne pouvait que deviner : elle annonçait « envoyé » et regardait
 * ensuite un état global qui pouvait très bien décrire le travail de quelqu'un d'autre. Avec
 * `taskId` elle suit SA demande, et `position` lui dit franchement s'il va falloir patienter.
 */
function tacheRendue(r) {
  if (!r) return {};
  if (!r.ok) return { queueFull: true, error: `file pleine (${MAX_FILE} tâches en attente) : réessayez quand elle se sera écoulée, ou videz-la.` };
  return { taskId: r.taskId, position: r.position, merged: r.fusion ?? false };
}

// --- import des recettes : lecture de propriétés Ayla en LAN (100 % local) ---
// Port de AylaLanCommand.newGetPropertyCommand : on sert une commande GET dans
// commands.json ; la machine POSTe la valeur sur /local_lan/property/datapoint.json,
// endpoint qu'on déchiffre déjà. Aucun appel au cloud.
function readPropertyCmd(m, name) {
  return JSON.stringify({ cmds: [{ cmd: { cmd_id: ++m.cmdId, method: "GET", resource: `property.json?name=${name}`, data: "", uri: "/local_lan/property/datapoint.json" } }] });
}

// --- local_reg (node:http, Content-Length explicite) ---
async function postLocalReg(m) {
  const t = await machineTarget(m);
  if (!t) {
    L("out", "local_reg", "impossible : adresse de la machine non configurée (page « Machines »)", m);
    return { ok: false, error: "machineIp" };
  }
  if (!t.ip) {
    L("out", "local_reg", `impossible : ${t.error}`, m);
    return { ok: false, error: "dns" };
  }
  const probleme = serverIpProblem();
  if (probleme) {
    // On n'envoie pas : la machine accepterait (202) une adresse à laquelle elle ne peut pas
    // revenir, et le serveur croirait s'être annoncé.
    L("out", "local_reg", `impossible : ${probleme} — c'est l'adresse que la machine utilisera pour nous joindre`, m);
    return { ok: false, error: "serverIp" };
  }
  // `notify` dit à la machine qu'il y a du travail : c'est vrai dès qu'une tâche est en file.
  const notify = vide(m.file) ? 0 : 1;
  const b = Buffer.from(JSON.stringify({ local_reg: { ip: CFG.serverIp, port: CFG.port, uri: "/local_lan", notify } }), "utf8");
  return new Promise((resolve) => {
    const r = httpRequest(
      { host: t.ip, port: 80, path: "/local_reg.json", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": b.length, Host: t.ip, Connection: "close" } },
      (res) => { res.on("data", () => {}); res.on("end", () => { m.lastRegisterAt = Date.now(); resolve(res.statusCode < 300 ? { ok: true, status: res.statusCode } : { ok: false, error: "refused", status: res.statusCode }); }); },
    );
    // **Le code de cause voyage, le message technique reste au journal.** L'échec était rendu par un
    // `{ ok: false }` nu, que personne ne lisait : les pages annonçaient « commande envoyée » alors
    // que la machine n'avait jamais entendu l'annonce, donc n'irait jamais chercher la commande.
    // C'est le cas d'une cafetière hors tension au secteur ou sortie du réseau, et il doit se dire.
    r.on("error", (e) => { L("out", "local_reg", `erreur: ${e.message}`, m); resolve({ ok: false, error: "unreachable" }); });
    r.setTimeout(8000, () => r.destroy());
    r.write(b); r.end();
  });
}

/**
 * Présence soutenue pendant qu'une commande est en attente : `local_reg` toutes les 2,5 s, parce
 * que c'est la machine qui vient nous chercher et qu'elle doit connaître notre adresse.
 *
 * **Le critère d'arrêt est la file vide, et c'est enfin un critère honnête.** Il reposait avant sur
 * un drapeau qui ne retombait que quand la machine venait chercher la commande suivante — donc
 * jamais si elle était éteinte, injoignable ou sans clé : la boucle tournait **indéfiniment**, un
 * `local_reg` toutes les 2,5 s vers une adresse muette, une ligne d'erreur par tentative, et un
 * journal de 400 lignes identiques où l'historique utile avait disparu. Le coupe-circuit de
 * l'ordonnanceur vide désormais la file au bout de 25 s sans contact, ce qui borne cette boucle
 * par construction. Les quinze secondes de grâce restent : la machine peut se présenter juste
 * après le dernier pas.
 */
function ensureKeepalive(m) {
  if (m.keepalive) return;
  L("sys", "keep-alive", "démarré (2,5 s)", m);
  let videDepuis = 0;
  m.keepalive = setInterval(async () => {
    if (vide(m.file)) {
      if (!videDepuis) videDepuis = Date.now();
      if (Date.now() - videDepuis > 15000) { clearInterval(m.keepalive); m.keepalive = null; L("sys", "keep-alive", "arrêté", m); return; }
    } else videDepuis = 0;
    await postLocalReg(m);
  }, 2500);
}

// --- réponse brute (compatible ESP32) ---
function raw(res, bodyStr, status = 200, type = "application/json") {
  // PAS de "Connection: close" : l'ESP32 enchaîne key_exchange → commands.json sur la
  // même connexion keep-alive ; fermer casse la séquence. Content-Length explicite suffit.
  //
  // `type` n'existe que pour le multiplexeur : la vraie machine répond `text/json` sur
  // `/regtoken.json`, et se faire passer pour elle veut dire lui ressembler jusque-là.
  const buf = Buffer.from(bodyStr, "utf8");
  res.writeHead(status, { "Content-Type": type, "Content-Length": buf.length });
  res.end(buf);
}
/**
 * Le frère binaire de `raw()` — même discipline d'en-têtes, mais des octets qu'on ne réencode pas.
 *
 * `raw()` fait `Buffer.from(corps, "utf8")` : lui passer un JPEG le corromprait silencieusement.
 * D'où cette fonction plutôt qu'un paramètre de plus, qu'un appelant finirait par oublier.
 *
 * `entetes` sert au cache : une image ne change que quand on la remplace, et la servir avec son
 * `ETag` évite de la retélécharger à chaque rendu d'une grille de cartes.
 */
function rawBin(res, buf, type, entetes = {}) {
  res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, ...entetes });
  res.end(buf);
}

function readBody(req) { return new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c))); }); }

// --- handlers device-facing ---
/**
 * Les trois endpoints que la machine appelle. Chacun commence par répondre à « laquelle ? » —
 * voir `machineByPeer()` : le protocole ne transporte aucune identité en dehors du `key_id` de
 * l'échange de clés, donc c'est l'adresse source qui tranche.
 */
async function handleLan(req, res) {
  const url = req.url.split("?")[0];
  const body = await readBody(req);
  if (url === "/local_lan/key_exchange.json" && req.method === "POST") {
    const brut = body.toString("utf8").match(/"time_1"\s*:\s*"?(-?\d+)"?/);
    const kx = JSON.parse(body.toString("utf8")).key_exchange;
    kx.time_1 = brut ? brut[1] : String(kx.time_1);
    if (kx.proto !== 1 || kx.ver !== 1) return raw(res, JSON.stringify({ error: "ver" }), 426);
    // L'adresse d'abord, le `key_id` en second : c'est le seul endroit où le protocole nous donne
    // une deuxième chance de reconnaître l'appelant, et une machine derrière un NAT ou tout juste
    // renumérotée n'est identifiable que par sa clé.
    const m = machineByPeer(req) ?? machineByKeyId(kx.key_id);
    if (!m) {
      L("in", "session", `refusé : aucune machine connue à l'adresse ${peerAddress(req)} et key_id ${kx.key_id} non attribué`);
      return raw(res, JSON.stringify({ error: "unknown device" }), 412);
    }
    if (Number(kx.key_id) !== m.lanKeyId) return raw(res, JSON.stringify({ error: "keyid" }), 412);
    // Mémorisé pour les deux autres endpoints, qui ne portent pas de `key_id`.
    m.peerIp = peerAddress(req);
    const t2 = Date.now();
    const rouverte = !!m.session;
    m.session = makeSession(m, kx, String(t2));
    // ⚠️ **La seule chose que ce serveur faisait sans l'écrire — et c'était la plus visible.**
    //
    // Deux conséquences, la seconde bien pire que la première. Le journal ne portait aucune
    // trace de l'ouverture d'une session LAN : l'évènement le plus structurant de la liaison
    // était le seul intraçable. Et surtout, `sseTouch()` est branché sur `L()` — c'est tout le
    // principe : un changement d'état passe par le journal, donc les navigateurs l'apprennent.
    // Ne rien journaliser ici, c'est ne rien pousser : `/pilotage` restait sur « session LAN :
    // en attente » alors que `/api/status` répondait `active: true` depuis l'échange de clés.
    // Un rechargement de page corrigeait l'affichage, ce qui faisait passer un vrai trou pour
    // un caprice du navigateur.
    //
    // Aucun risque d'inonder le journal : une session s'ouvre une fois, pas toutes les deux
    // secondes — et si elle se rouvre en boucle, c'est précisément ce qu'il faut voir. Le repli
    // des lignes identiques de `L()` s'en charge, avec son compte.
    L("in", "session", `${rouverte ? "rouverte" : "établie"} (key_id ${m.lanKeyId})`, m);
    return raw(res, JSON.stringify({ random_2: m.session.random2, time_2: t2 }));
  }
  const m = machineByPeer(req);
  if (!m) {
    L("in", "session", `requête device-facing ignorée : ${url} vient de ${peerAddress(req)}, qui ne correspond à aucune machine connue`);
    return raw(res, JSON.stringify({ error: "unknown device" }), 412);
  }
  if (url === "/local_lan/commands.json" && req.method === "GET") {
    if (!m.session) return raw(res, "no session", 412);
    // Une visite, un pas — c'est ici que l'exclusion est matérialisée. Voir prochainePaquet().
    const { data, label, trame } = prochainePaquet(m);
    if (label !== "idle") L("out", "commande", label, m, trame);
    return raw(res, m.session.encapsulate(data));
  }
  if (url.includes("/property/datapoint") && req.method === "POST") {
    if (m.session) {
      try {
        const dec = m.session.decapsulate(JSON.parse(body.toString("utf8")));
        for (const { name, value } of collectProps(dec)) handleProperty(m, name, value);
      } catch (e) { L("in", "session", `decrypt datapoint échec: ${e.message}`, m); }
    }
    return raw(res, m.session ? m.session.encapsulate("{}") : "{}");
  }
  return raw(res, "{}");
}

// --- multiplexeur : lan-server joue la MACHINE auprès des applications ---
/**
 * La moitié « appareil » du serveur. Voir `doc/spec-proxy-multi-app.md`, et surtout le §7.1 :
 * mesuré le 2026-08-22, **le créneau `local_reg` de la machine est unique**. Une application
 * De'Longhi ouverte sur le réseau nous évince, sans erreur et sans le moindre signal — nos
 * annonces continuent d'être acceptées, la machine cesse simplement de venir. C'est de là que
 * vient cette fonctionnalité : puisque le créneau est unique, il faut que quelqu'un le tienne
 * pour tout le monde.
 *
 * Nous sommes déjà ce quelqu'un. Il ne reste qu'à servir les autres.
 *
 * ## Éteint par défaut, et ce n'est pas de la timidité
 *
 * `PROXY_APPS=1` l'allume. Sans ce réglage, `/regtoken.json` et `/local_reg.json` n'existent pas
 * sur ce serveur. Se faire passer pour un appareil auprès d'un logiciel tiers est une usurpation,
 * même consentie et même chez soi : elle doit être un geste explicite, pas un effet de bord d'une
 * mise à jour. C'est aussi ce qui garantit qu'une installation existante ne change pas de
 * comportement en passant sur cette version.
 *
 * ## Le port 80, contrainte non négociable
 *
 * Le SDK construit ses URL en `http://<ip>/…` — **sans port**. Une application cherchera donc
 * l'appareil sur le port 80 et nulle part ailleurs. Tant que lan-server écoute sur 3000, aucune
 * application ne le trouvera d'elle-même : il faut écouter sur 80, ou rediriger. On le dit au
 * démarrage plutôt que de laisser chercher.
 */
const PROXY = {
  actif: /^(1|true|oui|on)$/i.test(process.env.PROXY_APPS ?? ""),
  registre: nouveauRegistre(),
  /** Sondes de récupération des commandes, une par application établie. */
  sondes: new Map(),
};

/** L'intervalle auquel nous allons chercher les commandes d'une application. */
const PERIODE_SONDE_APP = 2000;

const appsEtablies = () => [...PROXY.registre.apps.values()].filter((a) => a.etat === "etablie");

/**
 * Quelle machine une application veut-elle piloter ?
 *
 * Le `POST local_reg.json` porte `?dsn=` — l'app l'ajoute au premier enregistrement
 * (`AylaLanModule.sendLocalRegistration`, branche `!_isActive`). C'est une aubaine : c'est la
 * seule fois où le protocole nous dit explicitement à qui l'application croit parler, donc la
 * seule occasion de refuser une demande qui ne nous concerne pas. Le `PUT` n'en porte pas, mais
 * il suit toujours un `POST`, donc l'application est déjà rattachée.
 */
function machinePourApp(dsn) {
  if (dsn) {
    const m = machineList().find((x) => x.dsn && x.dsn === dsn);
    return m ?? null;
  }
  // Sans DSN, une seule machine tranche sans ambiguïté ; plusieurs, non — et deviner reviendrait
  // à relayer des commandes vers la mauvaise cafetière.
  return MACHINES.size === 1 ? machineList()[0] : null;
}

/**
 * Ouvre la session chiffrée VERS une application, dans le rôle de l'appareil.
 *
 * C'est le miroir exact de ce que la machine nous fait subir, et cette symétrie n'est pas une
 * image : `makeLanSession` est le même code, avec `role: "device"` au lieu de `"client"`. Ce qui
 * change de main, ce sont les clés d'émission — voir `src/lib/lansession.mjs`.
 *
 * Nous présentons le `key_id` et la clé LAN de la **vraie** machine : c'est ce qui fait tenir la
 * supercherie, l'application ayant obtenu la même clé du cloud pour ce DSN.
 */
async function ouvrirSessionApp(m, app) {
  // ⚠️ **Un seul échange en vol par application**, même idiome que `app.sondeEnCours` et pour la
  // même raison : deux échanges concurrents produisent deux flux AES dont un seul survit à
  // `etablir`, tandis que l'application peut très bien retenir l'autre. Rien ne lève d'erreur —
  // elle obtiendrait des octets plausibles et illisibles, et sa session « cesserait de répondre ».
  // Le cas est atteignable : l'échange initial dure jusqu'à son délai (5 s mesurées sur un vrai
  // téléphone) et une annonce peut tomber pendant ce temps — la voie `nouvelle` ne posant pas
  // `relanceA`, le verrou de 15 s ne la couvrait pas.
  app.echangeEnCours = true;
  try {
    const random1 = token(16);
    const time1 = String(Math.floor(Date.now() / 1000));
    const { random2, time2 } = await echangeClesVersApp({
      ip: app.ip, port: app.port, uri: app.uri, keyId: m.lanKeyId, random1, time1,
    });
    const session = makeLanSession({ lanKey: m.lanKey, random1, random2, time1, time2, role: "device" });
    etablir(PROXY.registre, app, session, Date.now());
    LA("out", "session", `session établie, nous nous présentons comme ${m.dsn ?? "DSN inconnu"}`, app, m);
    armerSondeApp(m, app);
  } catch (e) {
    app.dernierMotif = "echecEchange";
    refuser(PROXY.registre, { from: `${app.ip}:${app.port}`, motif: "echecEchange", detail: e.message }, Date.now());
    LA("out", "session", `échange de clés échoué — ${e.message}`, app, m);
  } finally {
    app.echangeEnCours = false;
  }
}

/**
 * Va chercher, périodiquement, ce que l'application a à nous demander.
 *
 * L'appareil est le CLIENT de ce côté-ci : c'est lui qui visite `commands.json`. Nous rejouons
 * donc la cadence de la machine plutôt que d'inventer un mécanisme de notification — l'objectif
 * est que l'application ne puisse pas distinguer notre comportement du sien.
 */
function armerSondeApp(m, app) {
  desarmerSondeApp(app);
  const timer = setInterval(() => { sonderApp(m, app).catch(() => {}); }, PERIODE_SONDE_APP);
  timer.unref?.();
  PROXY.sondes.set(app.id, timer);
}

function desarmerSondeApp(app) {
  const t = PROXY.sondes.get(app.id);
  if (t) clearInterval(t);
  PROXY.sondes.delete(app.id);
}

/**
 * Une visite : on récupère au plus un bloc de commandes, on l'analyse, on l'exécute.
 *
 * ⚠️ **Une seule sonde à la fois par application.** Deux appels concurrents — la sonde périodique
 * et celle déclenchée par un `notify: 1` — déchiffreraient deux blocs sur le MÊME flux AES-CBC
 * persistant, dans un ordre non garanti. Constaté en direct avec la vraie application : une
 * « demande non reconnue » portant des octets à demi lisibles (`…"ta":{}}`), signature d'un flux
 * désynchronisé de quelques octets. Le symptôme est trompeur — il ressemble à une charge utile
 * inattendue alors que c'est notre propre concurrence qui a brouillé le déchiffrement.
 */
/** Combien de blocs on accepte d'enchaîner sur un même passage. Voir `sonderApp`. */
const MAX_BLOCS_ENCHAINES = 12;

/**
 * **En deçà, une lecture d'application est servie depuis le cache sans redemander à la machine.**
 *
 * C'est la promesse du multiplexeur mise en chiffre : deux applications qui interrogent le
 * monitor à trois secondes d'intervalle valent **une** lecture réelle, pas deux. La vraie
 * application sonde `d302_monitor` sans relâche — soixante-douze demandes en deux secondes ont
 * été relevées — et sans ce seuil chacune mettrait une tâche en file.
 *
 * La valeur est servie dans tous les cas : au-delà du seuil on répond quand même avec ce qu'on
 * a, et on demande un rafraîchissement en plus. Attendre la machine pour répondre reviendrait à
 * ne pas répondre, ses 5 secondes d'attente étant plus courtes que notre aller-retour.
 */
const FRAICHEUR_LECTURE_APP = 10000;

async function sonderApp(m, app) {
  if (app.etat !== "etablie" || !app.session) {
    // **La sonde est la seule horloge de ce côté ; elle sert donc aussi à réparer.** Elle
    // repartait à vide sur une entrée sans session, ce qui laissait un échange de clés raté sans
    // aucune seconde chance. Le verrou de 15 s de `reprendreSessionApp` fait le débit ; ici on
    // ne fait que lui donner le tempo, sans minuterie supplémentaire à armer ni à désarmer.
    reprendreSessionApp(m, app);
    return;
  }
  if (app.sondeEnCours) return;
  app.sondeEnCours = true;
  try {
    // On enchaîne tant que l'application répond 206 (« il en reste »), sans jamais lâcher le
    // verrou : deux sondes concurrentes déchiffreraient deux blocs du MÊME flux AES-CBC dans un
    // ordre non garanti, ce qui est le défaut que ce verrou existe pour empêcher.
    for (let i = 0; i < MAX_BLOCS_ENCHAINES; i++) {
      if (app.etat !== "etablie" || !app.session) break;
      if (!(await sonderAppSerialise(m, app))) break;
    }
  } finally {
    app.sondeEnCours = false;
  }
}

/**
 * **Ce que la sonde a rapporté, dit une fois par CHANGEMENT — jamais une fois par sonde.**
 *
 * L'angle mort était total : quatorze sondes en vingt-huit secondes, et pas une ligne. On ne
 * pouvait donc ni prouver que la boucle tournait, ni voir ce que l'application répondait, ni
 * situer le moment où un bloc s'est perdu. Or c'est exactement ce qu'on cherche quand une
 * commande envoyée par le téléphone n'arrive jamais jusqu'ici.
 *
 * Journaliser chaque sonde noierait tout : elle bat toutes les 2 s. On ne journalise donc que
 * la **transition** — statut HTTP, taille du corps, et la forme de ce qu'on en a tiré. Une file
 * vide se dit une fois et se tait ; la sonde où quelque chose change se voit immédiatement.
 */
function noterSondage(m, app, etat) {
  if (etat === app.dernierSondage) return;
  app.dernierSondage = etat;
  LA("out", "sonde", `commands.json — ${etat}`, app, m);
}

async function sonderAppSerialise(m, app) {
  let rep;
  try {
    rep = await httpJson({ ip: app.ip, port: app.port, path: `${app.uri}/commands.json`, method: "GET", timeout: 4000 });
  } catch (e) {
    // Une application qui ne répond plus n'est pas une erreur à journaliser toutes les deux
    // secondes : c'est un téléphone verrouillé — mais au bout de quelques REFUS d'affilée,
    // c'est un port fermé, et l'entrée doit partir sans attendre `DELAI_APP_MUETTE`.
    constaterEchecApp(m, app, e);
    // ⚠️ **Un délai dépassé n'est pas un silence : c'est un flux DOUTEUX.** La requête a pu
    // atteindre le téléphone, qui a alors produit ET CHIFFRÉ sa réponse — son flux sortant a
    // avancé, le nôtre non. Le dégât est BORNÉ — un message sauté n'abîme que les 16 premiers
    // octets du prochain message lu, après quoi le flux se recale seul (`verif-lansession.mjs`
    // le prouve) — mais ce qui ne revient pas, c'est la COMMANDE que ce message portait : le SDK
    // l'a retirée de sa file en la chiffrant. Rouvrir ne répare donc rien de perdu ; cela évite
    // seulement le bloc illisible qui suivrait, et cela ne coûte qu'un échange de clés, qui ne
    // touche pas la cafetière. Le verrou de 15 s empêche l'emballement si le téléphone est lent.
    if (e?.code === "ETIMEDOUT") relancerSessionApp(m, app, "sonde expirée, réponse peut-être perdue");
    return false;
  }
  // ⚠️⚠️ **`206` EST une réponse normale, et la jeter perdait la commande.** Relevé dans
  // `AylaLanModule.getResponseCode()` :
  //
  //     return this._pendingLanCommands.size() > 0 ? PARTIAL_CONTENT : OK;
  //
  // C'est-à-dire : **206 quand il RESTE des commandes après celle-ci**, 200 quand la file vient
  // de se vider. Le corps est identique dans les deux cas — un bloc chiffré parfaitement valide.
  // Notre test `!== 200` en faisait donc une erreur, et le silence coûtait double, parce que le
  // SDK a déjà retiré la commande de sa file au moment où il l'a CHIFFRÉE (voir
  // `handleLanCommandRequest`) : la commande est perdue **définitivement**, et notre flux a un
  // message de retard.
  //
  // C'est exactement ce qui empêchait l'allumage depuis l'application officielle. Elle empile le
  // `0x84` puis, une milliseconde plus tard, tout un lot d'alarmes : dès qu'il y a deux commandes
  // en file, la première revient en 206 — et partait à la poubelle sans une ligne de journal.
  // La règle vit dans `appproxy.mjs`, avec sa justification et sa preuve en CI. La redire ici
  // ferait deux copies d'une règle de protocole, qui divergeraient au premier ajout sans rien
  // lever — et celle-ci a coûté des jours.
  if (!porteUneCharge(rep.status, rep.corps)) {
    // Ce retour saute le déchiffrement, donc il peut encore perdre un message : le dire est le
    // minimum. C'était jusqu'ici une sortie muette, et c'est ce qui a rendu le défaut ci-dessus
    // invisible pendant des jours.
    noterSondage(m, app, `HTTP ${rep.status}, ${rep.corps.length} o — non déchiffré`);
    return false;
  }
  toucher(app, Date.now());
  let clair;
  try {
    clair = app.session.decapsulate(JSON.parse(rep.corps));
  } catch (e) {
    // Même cause que le cas `illisible` plus bas — un flux perdu — mais détectée un cran plus
    // tôt, quand c'est le déchiffrement lui-même qui refuse (remplissage invalide). On
    // journalisait et on repartait sonder sans jamais rouvrir la session.
    noterSondage(m, app, `HTTP ${rep.status}, ${rep.corps.length} o — indéchiffrable`);
    LA("in", "commandes", `bloc de commandes indéchiffrable (${e.message}) · ${chargeBrute(rep.corps, 96)}`, app, m);
    relancerSessionApp(m, app, "déchiffrement refusé");
    return false;
  }
  const intentions = analyserCommandes(clair);
  noterSondage(m, app, `HTTP ${rep.status}, ${rep.corps.length} o — ${intentions.map((i) => i.type).join(", ")}`);
  for (const intention of intentions) await executerPourApp(m, app, intention);
  // `206` dit « il en reste » : on repasse tout de suite au lieu d'attendre le prochain tour de
  // sonde. Sans cela un lot de dix commandes met vingt secondes à arriver, alors que
  // l'utilisateur, lui, vient d'appuyer sur un bouton. Borné pour ne pas transformer une
  // application bavarde en boucle serrée : au-delà, la sonde périodique reprend la main.
  return encoreDesCommandes(rep.status);
}

/**
 * Traduit ce qu'une application demande en travail pour la file de la machine.
 *
 * ⚠️ **Une écriture relayée atteint une vraie cafetière.** C'est le but — l'utilisateur commande
 * depuis son application officielle — mais cela vaut d'être écrit noir sur blanc : ce chemin peut
 * lancer une préparation, écrire une recette dans un profil, changer un réglage. D'où la
 * journalisation systématique, et d'où l'existence de la liste des applications sur `/pilotage` :
 * on doit pouvoir voir qui a commandé quoi.
 *
 * Les commandes passent par la **file**, comme tout le reste. Rang `COMMANDE` : une demande
 * d'application vaut une demande d'interface, ni plus ni moins, et l'ordonnanceur garantit
 * qu'elles ne se marchent pas dessus — ce que le créneau unique de la machine, lui, ne garantit
 * pas du tout.
 */
/**
 * **L'accusé est dû dès que la propriété porte un `id`, que nous la relayions ou non.**
 *
 * Il dit « reçu », pas « exécuté » : c'est un accusé de transport. Le confondre avec une
 * validation métier — et donc ne l'envoyer que pour les propriétés qu'on relaie — laisse
 * l'application attendre un message qui ne viendra jamais, puis conclure à un échec.
 *
 * Relevé en direct : la vraie application ouvre CHAQUE session en écrivant `device_connected`,
 * une propriété que nous n'avons aucune raison de relayer à la cafetière — et nous sortions
 * par le `return` de la branche « ignorée » sans jamais accuser. Du point de vue du téléphone,
 * la machine à qui il vient de se présenter ne répond pas ; il ne va donc pas plus loin, et
 * aucune commande ne part. Le registre le montrait sans qu'on sache le lire : session établie,
 * datapoints reçus, et `commandes = 0` pendant toute la vie de l'entrée.
 */
async function accuserSiDemande(m, app, intention) {
  if (!intention.ackId) return false;
  // Le retour est celui de l'ENVOI, pas de l'intention : dire « accusée » sur une poussée qui a
  // échoué journaliserait le contraire de ce qui s'est produit.
  return pousserVersApp(m, app, paquetAck(m.dsn ?? "", intention.ackId), CHEMIN_ACK);
}

async function executerPourApp(m, app, intention) {
  switch (intention.type) {
    case "vide":
      return;
    case "finSession":
      LA("in", "session", "fin de session demandée", app, m);
      retirerApp(app, m, "départ");
      return;
    case "lecture": {
      app.commandes++;
      // ⚠️ **Une lecture se dénoue par une POUSSÉE de notre part, pas par la réponse HTTP.** Le
      // SDK garde la commande dans `_commandsPendingResponses` et n'y rattache un datapoint que
      // par le `cmd_id` de l'URL. On retient donc l'identifiant tout de suite : qu'on réponde
      // depuis le cache maintenant ou que la machine pousse dans dix secondes, l'appariement
      // aura lieu. Sans cela, l'application redemandait sans fin — `lecture d302_monitor (×72)`
      // au journal n'était pas soixante-douze demandes, c'était une demande réessayée.
      app.lectures.set(intention.nom, intention.cmdId);
      const connue = m.dernieresValeurs.get(intention.nom) ?? null;
      const fraiche = !!connue && Date.now() - connue.at < FRAICHEUR_LECTURE_APP;
      const dit = connue ? (fraiche ? " · servie du cache" : " · servie du cache, rafraîchissement demandé")
                         : " · valeur inconnue, demandée à la machine";
      LA("in", "lecture", `${intention.nom}${dit}`, app, m);
      if (connue) {
        // Servie AVANT de mettre quoi que ce soit en file : les 5 secondes de l'application
        // courent déjà, et notre file, elle, peut être occupée par une préparation.
        app.lectures.delete(intention.nom);
        pousserVersApp(m, app, paquetDatapoint(m.dsn ?? "", intention.nom, connue.valeur),
                       "/property/datapoint.json", intention.cmdId).catch(() => {});
      }
      // Une valeur assez fraîche vaut pour tout le monde : c'est la promesse du multiplexeur, et
      // c'est ce qui évite qu'une application bavarde monopolise la cafetière.
      if (fraiche) return;
      /**
       * ⚠️ **Le monitor ne se lit pas comme une propriété : il se DEMANDE, avec `0x75`.** C'est
       * la seule trame qui interroge la machine sur son état, et sa réponse arrive en poussée de
       * `d302_monitor` — pas en `data_response`. Une lecture de propriété Ayla sur ce nom-là ne
       * déclenche rien.
       *
       * Et c'est exactement le même geste que « Lire l'état » de `/pilotage`, donc la même tâche,
       * donc la même clé de fusion. Cette propriété a trois lecteurs — le bouton, la page `/`, et
       * chaque téléphone branché — et ils regardent tous la même valeur : **une lecture réelle
       * vers la cafetière, N destinataires.** Passer par `startImport` aurait mis en file une
       * tâche distincte par téléphone, à côté de celle du bouton, pour aller chercher la valeur
       * que l'autre rapportait déjà.
       */
      if (intention.nom.startsWith(m.mon)) {
        startProgram(m, datapointValue(frameMonitorRequest()), "Présence", DELAI_PRESENCE, "monitor",
                     { cle: "presence", rang: RANG.LECTURE, i18n: { k: "presence" } });
        return;
      }
      startImport(m, [intention.nom], 30000, {
        label: `App ${app.id} · lecture ${intention.nom}`,
        rang: RANG.LECTURE,
        meta: { app: app.id },
        i18n: { k: "appRead", p: { app: app.id, prop: intention.nom } },
      });
      return;
    }
    case "ecriture": {
      // Seules les propriétés de transport de CETTE machine sont relayées. Une application qui
      // écrirait autre chose se verrait ignorée plutôt que devinée : `m.send` est la propriété
      // qui porte les trames ECAM, et c'est la seule dont nous sachions ce qu'elle déclenche.
      if (intention.nom !== m.send) {
        // Ignorée pour l'appareil, PAS pour le journal : la charge est relevée telle quelle. Une
        // propriété que nous ne relayons pas est, par définition, du protocole que nous ne
        // connaissons pas encore — c'est-à-dire exactement ce qu'on vient chercher ici. La jeter
        // sans la montrer, c'était perdre la seule occasion de la voir : l'application officielle
        // est le seul émetteur au monde à produire ces trames-là, et elle ne les rejoue pas.
        // L'accusé part quand même — voir `accuserSiDemande` : il porte le transport, pas
        // l'exécution. Il est DIT dans la ligne, sans quoi « ignorée » se lirait comme « sans
        // réponse » alors que c'est exactement le contraire qui se produit.
        const accuse = await accuserSiDemande(m, app, intention);
        LA("in", "écriture", `ignorée sur ${intention.nom} (seule ${m.send} est relayée)${accuse ? " · accusée" : ""} · ${chargeBrute(intention.valeur)}`, app, m);
        return;
      }
      app.commandes++;
      // Les arguments AVANT les octets : c'est la question qu'on se pose en lisant cette ligne —
      // quelle boisson, quel profil, quels réglages — et les octets ne servent qu'ensuite, pour
      // vérifier ou pour rétro-concevoir. Une commande sans argument connu garde sa seule trame.
      LA("in", "commande", decrireCommande(m, intention.valeur), app, m, intention.valeur);
      // Une commande relayée qui vise un profil DÉPLACE le profil actif de l'appareil, au même
      // titre que si nous l'avions envoyée nous-mêmes. On adopte donc la valeur ici — au moment de
      // la mise en file, comme le fait `/api/command` — sans quoi nos pages continueraient
      // d'afficher l'ancien profil pendant que la machine, elle, a changé. Journalisé parce qu'un
      // changement de profil décidé par un tiers est précisément ce qu'on doit pouvoir retracer.
      const profil = profilVise(intention.valeur);
      if (profil >= 1 && profil <= 5 && (profil !== m.activeProfile || !m.activeProfileConfirmed)) {
        const avant = m.activeProfile;
        m.activeProfile = profil;
        m.activeProfileConfirmed = true;
        rememberActiveProfile(m);
        // Des DEUX côtés, et c'est délibéré : le changement de profil actif est un état de
        // l'APPAREIL, donc il appartient à la chronologie machine ; et c'est un tiers qui l'a
        // décidé, donc il appartient aussi à celle des applications. Le retirer du journal
        // principal ferait disparaître un changement d'état réel du journal qui le décrit.
        L("sys", "profil", `app ${app.id} a imposé le profil ${profil}${avant && avant !== profil ? ` (était ${avant})` : ""}`, m);
        LA("sys", "profil", `profil ${profil} imposé${avant && avant !== profil ? ` (était ${avant})` : ""}`, app, m);
      }
      // Le libellé de la tâche porte la commande DÉCODÉE, arguments compris — sans octets, ils
      // sont déjà dans les deux journaux. « App a2 · commande » ne disait rien de ce qui partait
      // vers l'appareil, alors que c'est la seule ligne que le panneau « Activité » affiche : on
      // y voyait passer une tâche sans pouvoir distinguer un café lancé d'une recette écrasée.
      // La description voyage en PARAMÈTRE et reste en français, au même titre que les lignes de
      // journal : c'est le même texte, produit par la même table, et deux formulations pour une
      // même trame se contrediraient à la première évolution du protocole.
      const decrite = decrireCommande(m, intention.valeur, { octets: false });
      /**
       * ⚠️ **Sans clé de fusion, une application empile.** Constaté en usage réel : six
       * « sélection de profil (0xa9) · profil 1 » identiques en file, chacune partant redire à
       * la machine ce que la précédente venait de lui dire. L'application officielle impose son
       * profil courant à chaque ouverture de session, et elle en ouvre plusieurs.
       *
       * La clé vient de `cleFusion`, donc du protocole et non d'ici : ce qui se fusionne est ce
       * dont la répétition est démontrablement sans effet. Une préparation, elle, rend `null` et
       * garde sa ligne — demander deux cafés n'est pas demander un café.
       *
       * La fusion porte sur la TÂCHE, jamais sur l'accusé : `accuserSiDemande` part juste après,
       * une fois par demande. L'application dont la tâche a fusionné reçoit son accusé quand
       * même, ce qui est exact — il porte le transport, pas l'exécution.
       */
      startProgram(m, intention.valeur, `App ${app.id} · ${decrite}`, 75000, "monitor", {
        rang: RANG.COMMANDE,
        cle: cleFusion(intention.valeur),
        meta: { app: app.id },
        i18n: { k: "appWrite", p: { app: app.id, commande: decrite } },
      });
      // Même accusé que pour une écriture ignorée, et par le même chemin : sa présence EST la
      // demande, et l'application attend dessus.
      await accuserSiDemande(m, app, intention);
      return;
    }
    case "illisible":
      // Ce n'est PAS une charge inattendue, c'est notre flux qui est perdu — et `lansession.mjs`
      // le dit depuis toujours : « une désynchronisation force un nouvel échange de clés ». On ne
      // le faisait pas : on journalisait « demande non reconnue » et on repartait sonder.
      //
      // ⚠️ **Ce bloc-ci est un SYMPTÔME, pas la maladie, et la nuance a coûté des jours.** En CBC
      // un chaînage faux ne salit que le bloc de tête — la suite se recale seule sur le chiffré
      // qui la précède DANS le même message, d'où ces octets illisibles finissant proprement par
      // `…a":{}}`. Et le message suivant, lui, est parfaitement lisible : le flux se répare tout
      // seul (prouvé dans `verif-lansession.mjs`). Donc **un bloc illisible ne dit pas « le flux
      // est cassé », il dit « exactement un message a disparu juste avant »** — et ce message-là
      // portait peut-être une commande, définitivement perdue. C'est en amont qu'il faut
      // chercher, pas ici : voir `porteUneCharge` et le `206`.
      // La charge illisible est CONSERVÉE : c'est la seule preuve de ce qui s'est passé, et la
      // signature se lit à l'œil — en CBC un chaînage faux ne salit que le bloc de tête, d'où
      // des octets illisibles finissant proprement par `…a":{}}`. Sans elle, « désynchronisé »
      // est un verdict qu'on ne peut ni vérifier ni contredire.
      LA("in", "bloc", `illisible, conservé tel quel — ${String(intention.brut ?? "").slice(0, 200)}`, app, m);
      relancerSessionApp(m, app, "bloc illisible, flux désynchronisé");
      return;
    default:
      // 400 et non 160 : cette ligne est le seul endroit où une demande que nous ne savons pas
      // interpréter laisse une trace, et une demande tronquée à 160 caractères ne s'analyse pas.
      // C'est de la matière de rétro-ingénierie, pas un accusé de réception.
      LA("in", "demande", `non reconnue — ${JSON.stringify(intention).slice(0, 400)}`, app, m);
  }
}

/** Deux relances rapprochées ne répareraient rien : la seconde casserait le flux que la première vient d'ouvrir. */
const DELAI_RELANCE_APP = 15_000;

/**
 * Refait l'échange de clés avec une application dont le flux est irrécupérable.
 *
 * Une seule cause connue à ce jour, et elle est de notre côté : un message que l'application a
 * chiffré et que nous n'avons jamais déchiffré. Une sonde `commands.json` qui atteint le téléphone
 * puis expire côté serveur suffit — la réponse a été produite, donc le flux sortant de
 * l'application a avancé, et le nôtre non. C'est la même mécanique que le défaut de
 * `scripts/faux-app.mjs`, à ceci près qu'ici personne n'est fautif : le réseau a le droit de perdre
 * une réponse.
 *
 * Rouvrir est donc la seule issue, et c'est sans risque pour l'appareil : un échange de clés ne
 * touche pas la cafetière, il ne recrée que le chiffrement entre l'application et nous.
 */
/**
 * **Reprendre une session ABSENTE — le pendant manquant de `relancerSessionApp`.**
 *
 * Les deux fonctions se ressemblent et ne traitent pas la même situation, ce qui est exactement
 * pourquoi il en faut deux : `relancerSessionApp` jette un flux VIVANT devenu illisible,
 * celle-ci essaie d'en rouvrir un qui n'existe plus.
 *
 * ⚠️ **Sans elle, un échange de clés raté était DÉFINITIF.** Relevé en direct sur un vrai
 * téléphone :
 *
 * ```
 * 21:15:04  sonde expirée, réponse peut-être perdue — nouvel échange de clés
 * 21:15:09  échange de clés échoué — délai dépassé
 * 21:16:31  muette depuis 90 s, oubliée
 * ```
 *
 * Entre les deux dernières lignes, 82 secondes pendant lesquelles l'application était là — elle
 * continuait à s'annoncer — et où nous n'avons rien tenté. Deux impasses s'y ajoutaient :
 *
 *   1. `sonderApp` sort immédiatement quand la session manque, donc la sonde de 2 s, seule
 *      horloge de ce côté, tournait à vide sur une entrée morte au lieu de la réparer ;
 *   2. une nouvelle annonce ne déclenche l'échange que `if (nouvelle)` — or l'entrée existait
 *      déjà, donc le téléphone pouvait s'annoncer indéfiniment sans que rien ne reparte.
 *
 * Le symptôme visible était le pire des deux mondes : `/pilotage` affichait une application
 * branchée, avec son `User-Agent` et ses compteurs, qui ne pouvait plus rien recevoir.
 *
 * ⚠️ **Cela ne contredit pas « un PUT ne doit JAMAIS déclencher d'échange de clés ».** Cette
 * règle protège un flux AES sur lequel l'application est en train de lire : le remplacer sous
 * elle la ferait décrocher. Ici il n'y a **rien à casser** — `session` est nul, il n'existe
 * aucun flux. La garde en première ligne rend la distinction exécutable plutôt que verbale.
 *
 * Le même verrou de 15 s que `relancerSessionApp` : au pire une tentative toutes les 15 s, et
 * l'expiration à 90 s emporte de toute façon l'entrée si le téléphone est vraiment parti. Les
 * tentatives sont donc bornées à cinq environ, sans compteur à tenir.
 */
function reprendreSessionApp(m, app, motif = null) {
  // Jamais sur un flux vivant : c'est `relancerSessionApp` qui traite ce cas, et lui seul.
  if (app.etat === "etablie" && app.session) return false;
  if (app.echangeEnCours) return false;
  const maintenant = Date.now();
  if (app.relanceA && maintenant - app.relanceA < DELAI_RELANCE_APP) return false;
  app.relanceA = maintenant;
  if (motif) LA("sys", "session", motif, app, m);
  app.etat = "annoncee";
  ouvrirSessionApp(m, app).catch(() => {});
  return true;
}

function relancerSessionApp(m, app, motif = "flux illisible") {
  if (app.echangeEnCours) return;
  const maintenant = Date.now();
  if (app.relanceA && maintenant - app.relanceA < DELAI_RELANCE_APP) return;
  app.relanceA = maintenant;
  // Le MOTIF est journalisé, pas seulement le verdict. « Désynchronisé » se constatait trois
  // fois par session sans qu'aucune ligne ne dise ce qui l'avait provoqué, ce qui laissait la
  // cause au rang d'hypothèse pendant des jours.
  LA("sys", "session", `${motif} — nouvel échange de clés`, app, m);
  app.session = null;
  app.etat = "annoncee";
  ouvrirSessionApp(m, app).catch(() => {});
}

/**
 * Pousse un corps déjà sérialisé vers une application, chiffré dans SON flux.
 *
 * ⚠️ **Sérialisé par application, et ce n'est pas une précaution de confort.** Le flux AES-CBC est
 * persistant : le n-ième bloc chiffré ne se déchiffre que si les n-1 précédents l'ont été, dans
 * l'ordre. Deux `pousserVersApp` concurrents — un datapoint rediffusé pendant qu'un accusé part —
 * produiraient deux corps parfaitement chiffrés qui pourraient arriver dans le désordre, et
 * l'application désynchroniserait son déchiffreur **sans lever la moindre erreur** : elle
 * obtiendrait des octets plausibles et illisibles, et sa session « cesserait de répondre ».
 *
 * D'où la chaîne de promesses : le chiffrement ET l'envoi ont lieu dans le même maillon, donc
 * l'ordre de production est aussi l'ordre d'émission.
 */
/**
 * `chemin` par défaut : le datapoint. Un ACCUSÉ part sur `CHEMIN_ACK` — c'est l'URI, et elle
 * seule, qui décide si l'application le lit comme un accusé ou comme une écriture.
 *
 * `cmdId` non nul apparie la poussée à une commande de lecture que l'application attend. Voir
 * `cheminAvecCmd` : le SDK ne fait ce lien que par ce paramètre d'URL, et sans lui la commande
 * expire au bout de 5 secondes en `Timed out waiting for command response`.
 */
function pousserVersApp(m, app, corpsJson, chemin = "/property/datapoint.json", cmdId = null) {
  if (app.etat !== "etablie" || !app.session) return Promise.resolve(false);
  const suite = (app.chaine ?? Promise.resolve()).then(async () => {
    // Re-vérifié DANS le maillon : la session a pu tomber pendant l'attente de notre tour.
    if (app.etat !== "etablie" || !app.session) return false;
    try {
      await httpJson({
        ip: app.ip, port: app.port, path: `${app.uri}${cheminAvecCmd(chemin, cmdId)}`,
        method: "POST", body: app.session.encapsulate(corpsJson), timeout: 4000,
      });
      toucher(app, Date.now());
      return true;
    } catch (e) {
      constaterEchecApp(m, app, e);
      return false;
    }
  });
  // La chaîne ne doit jamais rester rejetée, sinon tous les envois suivants seraient court-circuités.
  app.chaine = suite.then(() => {}, () => {});
  return suite;
}

/**
 * Rediffuse à toutes les applications ce que la machine vient de nous pousser.
 *
 * C'est ce qui fait la différence entre un multiplexeur et un simple partage de créneau : chaque
 * application reçoit l'état comme si elle était seule branchée sur l'appareil. Une seule lecture
 * réelle, N destinataires — alors que sans nous, une seule application pouvait exister à la fois.
 *
 * ⚠️ Chaque flux AES est indépendant : `encapsulate` est appelé une fois par application, jamais
 * mutualisé. Réutiliser un chiffré d'une session dans une autre ne produirait pas une erreur mais
 * du bruit, et désynchroniserait le flux du destinataire pour de bon.
 */
/**
 * **Inverse des constructeurs de noms de propriétés** : `d263_3_rec_priority` → « ordre des
 * favoris · profil 3 ». Construit une fois par catalogue et mémorisé sur lui, parce qu'il faut
 * énumérer 28 boissons × 6 formes pour l'obtenir et qu'une rediffusion se produit à chaque
 * poussée de la machine.
 *
 * Les noms sont bâtis par `boundsProp` / `profileProp` du catalogue, jamais recopiés ici : une
 * deuxième table de noms de propriétés dériverait de la première sans que rien ne le signale.
 */
const INVERSE_BOISSONS = new WeakMap();
function inverseBoissons(m) {
  let idx = INVERSE_BOISSONS.get(m.catalog);
  if (idx) return idx;
  idx = new Map();
  for (const b of m.catalog.beverages) {
    const bornes = m.catalog.boundsProp(b.slug);
    if (bornes) idx.set(bornes, { id: b.id, kind: "bounds" });
    for (let p = 1; p <= 5; p++) {
      const prop = m.catalog.profileProp(b, p);
      if (prop && !idx.has(prop)) idx.set(prop, { id: b.id, kind: "values", profileId: p });
    }
  }
  INVERSE_BOISSONS.set(m.catalog, idx);
  return idx;
}

/**
 * Le nom d'une propriété Ayla, en clair — ou `null` quand nous ne la connaissons pas.
 *
 * ⚠️ `null` est une **information**, pas un échec : une propriété que ce serveur ne sait pas
 * nommer est du protocole que nous n'avons pas encore relevé, et l'application officielle est le
 * seul émetteur au monde à en produire. Les appelants la disent en capitales plutôt que de la
 * laisser passer pour une propriété ordinaire.
 */
function nomPropriete(m, name) {
  if (name === m.mon || name.startsWith("d302_monitor")) return "état machine";
  if (name === m.send) return "commande";
  // `data_response` ne porte aucun sens par son nom : tout est dans la trame, que l'appelant lit.
  if (name === "data_response" || name === "app_data_response") return "réponse ECAM";
  if (name === SERIAL_PROP) return "numéro de série et modèle";
  if (name === "device_connected") return "présence du serveur";
  const pi = profilePropInfo(name);
  if (pi) {
    if (pi.kind === "priority") return `ordre des favoris · profil ${pi.profileId}`;
    return `${pi.kind === "profileNames" ? "noms de profils" : "noms de recettes perso"} ${pi.first}+`;
  }
  const reg = Object.entries(REGLAGE_PROPS).find(([, e]) => e.classic === name || e.striker === name);
  if (reg) return nomReglage(Number(reg[0]));
  const bev = inverseBoissons(m).get(name);
  if (bev) return bev.kind === "bounds" ? `bornes · ${bevLabel(m, bev.id)}` : `recette · ${bevLabel(m, bev.id)} · profil ${bev.profileId}`;
  const grain = /^d2\d\d_beansystem_(\d)$/.exec(name);
  if (grain) return `profil de grains ${grain[1]}`;
  return null;
}

/**
 * **Ce qu'une application reçoit de nous, en une ligne lisible.**
 *
 * Le journal disait `état rediffusé · d263_3_rec_priority`, c'est-à-dire un nom de propriété et
 * rien d'autre : illisible pour qui ne connaît pas la table par cœur, et surtout muet sur ce que
 * la valeur contient. On nomme donc les deux — la propriété **et** la commande que porte sa
 * trame, via la même `ECAM_OPS` que le reste du serveur.
 *
 * Deux choix qui sont le propos de la fonction :
 *
 * - **le monitor ne dit que son état et le repos.** Y mettre le pourcentage romprait le pliage
 *   des lignes identiques de `LA()` pendant une préparation, où la machine pousse toutes les 1 à
 *   3 secondes et où chaque poussée part vers chaque application : le journal des applications
 *   se remplirait de la progression, qui est déjà dans celui de la machine, à sa place.
 * - **l'inconnu est CRIÉ et garde ses octets.** Une propriété que nous ne savons pas nommer, ou
 *   une trame dont l'octet de commande n'est pas dans la table, sont exactement ce que ce
 *   multiplexeur permet de découvrir — l'application officielle produit des trames que nous
 *   n'avons jamais vues et ne les rejoue pas. Une ligne discrète les perd ; une ligne en
 *   capitales avec son hexadécimal se retrouve et se recolle dans `doc/commandes-cafe.md`.
 */
function libelleEtat(m, name, value) {
  const nom = nomPropriete(m, name);
  if (nom === "état machine") {
    try {
      const mo = decodeMonitor(value);
      return `${name} · état machine 0x${mo.stateByte.toString(16).padStart(2, "0")} · ${mo.auRepos ? "au repos" : "préparation en cours"}`;
    } catch { /* monitor illisible : on retombe sur le traitement générique, octets compris */ }
  }
  const r = opReponse(value);
  const parts = [name];
  parts.push(nom ?? "PROPRIÉTÉ NON IDENTIFIÉE");
  /**
   * ⚠️ **Une valeur qui n'est pas une trame doit le DIRE, ici comme ailleurs.**
   *
   * Ce branchement ne connaissait qu'`opReponse`. Quand il rendait `null` — valeur non-ECAM —
   * la ligne s'arrêtait au nom de la propriété : `état rediffusé · data_request · commande`,
   * relevé en direct. Ni ce que c'est, ni ses octets, puisque `chargeBrute` n'était joint que
   * si `r` existait avec une opération inconnue. Le pire des deux, et sur la seule valeur qui
   * méritait qu'on la garde.
   *
   * Le cas n'est pas théorique : `s0()` est écrite dans `data_request`, donc relayée, donc
   * réémise par la machine et rediffusée ici. Elle était **nommée à l'aller** (`describeFrame`)
   * et **anonyme au retour** — une table lue dans un seul sens est une table qui ment dans
   * l'autre, c'est la leçon que ce fichier répète ailleurs à propos des copies de tables.
   */
  if (r) {
    parts.push(r.op ? `${r.op.nom} (${hexCmd(r.cmd)})` : `commande ${hexCmd(r.cmd)} NON IDENTIFIÉE`);
  } else {
    const brut = Buffer.from(String(value ?? "").replace(/\s+/g, ""), "base64");
    const connue = constanteConnue(brut);
    parts.push(connue ? `${connue.nom} · non-trame` : "valeur non-trame");
  }
  // Les octets ne sont joints que sur de l'inconnu : ailleurs ils feraient une ligne de deux cents
  // caractères qui répète ce que le journal machine décode déjà, mieux. Une valeur non-trame que
  // l'on ne sait pas nommer en fait partie — c'est même le cas type, la seule trace qu'on aura
  // d'un paquet que l'application officielle est seule au monde à produire.
  const inconnue = !r && !constanteConnue(Buffer.from(String(value ?? "").replace(/\s+/g, ""), "base64"));
  if (!nom || (r && !r.op) || inconnue) parts.push(chargeBrute(value, 64));
  return parts.join(" · ");
}
function diffuserAuxApps(m, name, value) {
  if (!PROXY.actif) return;
  const cibles = appsEtablies().filter((a) => a.machineId === m.id);
  if (!cibles.length) return;
  const corps = paquetDatapoint(m.dsn ?? "", name, value);
  for (const app of cibles) {
    app.datapoints++;
    // Cette propriété était-elle attendue par une commande de lecture de CETTE application ?
    // Si oui, la poussée doit porter son `cmd_id`, sinon la commande expire alors même que la
    // valeur, elle, est bien arrivée. L'entrée est consommée : un `cmd_id` ne sert qu'une fois.
    const attendue = app.lectures.get(name) ?? null;
    if (attendue !== null) app.lectures.delete(name);
    // Le cœur du multiplexeur — une lecture réelle, N destinataires — n'était visible nulle
    // part : ni au journal, ni ailleurs qu'en compteur cumulé. Il l'est ici, et le repli des
    // lignes identiques suffit à contenir une préparation, où la machine pousse toutes les 1 à
    // 3 secondes. C'est aussi la seule trace de ce qu'une application a REÇU de nous.
    LA("out", "état", `${attendue !== null ? "servi" : "rediffusé"} · ${libelleEtat(m, name, value)}`, app, m, value);
    pousserVersApp(m, app, corps, "/property/datapoint.json", attendue).catch(() => {});
  }
}

/**
 * Un contact vers l'application a échoué : on compte, et on retire au bout de `SEUIL_ECHECS`.
 *
 * Constaté en direct : l'application officielle relancée prend un **nouveau port d'écoute**
 * (`AylaHttpServer` n'en réserve aucun), et comme l'identité d'une application est son couple
 * adresse:port, l'ancienne entrée reste dans le registre. Elle y affichait « session établie »
 * pendant 90 s alors que son port refusait déjà toute connexion — deux applications sur la page
 * pour un seul téléphone, dont une morte.
 *
 * ⚠️ **Ne jamais évincer sur la seule adresse.** Deux applications sur un même téléphone, ou les
 * deux `faux-app.mjs` de la démonstration sur `127.0.0.1`, partagent une adresse et rien d'autre :
 * les distinguer est exactement ce que ce multiplexeur existe pour faire. C'est l'injoignabilité
 * qui retire une entrée, jamais l'arrivée d'une voisine.
 */
function constaterEchecApp(m, app, err = null) {
  if (!PROXY.registre.apps.has(cleApp(app.ip, app.port))) return;
  // ⚠️ **Seul un REFUS compte.** C'était la justification de tout ce mécanisme — « le silence et le
  // refus ne sont pas la même information » — et le code les confondait quand même, parce qu'un
  // délai dépassé et un `ECONNREFUSED` arrivaient ici sous la même forme. Résultat mesuré sur la
  // vraie application : évincée en 16 s après trois délais dépassés, revenue 9 s plus tard sur le
  // MÊME port d'écoute — elle n'était jamais partie, elle s'était tue. Un téléphone qui verrouille
  // son écran fait exactement cela. Le silence retombe donc sur `DELAI_APP_MUETTE`, sa règle.
  if (!estRefus(err)) return;
  if (!echouer(app)) return;
  retirerApp(app, m, `injoignable (${SEUIL_ECHECS} refus de connexion, ${err.code}), oubliée`);
}

/** Retire une application : sonde désarmée d'abord, sinon elle continuerait sur un objet oublié. */
function retirerApp(app, m = null, motif = "retirée") {
  desarmerSondeApp(app);
  oublier(PROXY.registre, app);
  LA("sys", "registre", motif, app, m);
}

/** Balayage des applications muettes. Le même raisonnement que le coupe-circuit de la file. */
setInterval(() => {
  if (!PROXY.actif) return;
  for (const app of expirer(PROXY.registre, Date.now())) {
    desarmerSondeApp(app);
    LA("sys", "app", `muette depuis ${Math.round(DELAI_APP_MUETTE / 1000)} s, oubliée`, app);
  }
}, 10000).unref?.();

/**
 * `GET /regtoken.json` — la seule chose que le module de la machine sert hors mode AP, et donc la
 * première que touche quiconque cherche à savoir qui répond ici. Nous rendons la même forme, avec
 * le vrai DSN : c'est ce qui nous fait passer pour l'appareil.
 */
async function handleAppRegtoken(req, res) {
  const m = defaultMachine();
  if (!m?.dsn) {
    refuser(PROXY.registre, { from: peerAddress(req), motif: "dsnInconnu" }, Date.now());
    return raw(res, JSON.stringify({ error: "no dsn" }), 404);
  }
  // On RESSERT la réponse de la vraie machine plutôt que d'en fabriquer une.
  //
  // Comparées côte à côte le 2026-08-22, les deux différaient sur quatre points : la machine
  // renvoie `text/json` et non `application/json`, et son corps porte `regtoken` et `registered`
  // en plus, avec `registration_type: "AP-Mode"` là où nous inventions `"Same-LAN"`. Chacun de ces
  // écarts est une occasion, pour une application, de constater qu'elle ne parle pas à l'appareil
  // — et nous n'avons aucun moyen de savoir lequel elle regarde. Copier est donc la seule
  // stratégie défendable ; deviner ne l'est pas.
  //
  // Le cache est court : `regtoken` est un jeton d'enregistrement, servir une valeur périmée
  // serait un écart de plus.
  // ⚠️ **On ne fait attendre l'application que si on n'a RIEN à lui servir.** La sonde vers la
  // machine dure jusqu'à 4 s ; mesuré avec la vraie application, son client HTTP (Volley) abandonne
  // avant cela et journalise `TimeoutError for http://<machine>/local_reg.json`. Une réponse d'une
  // minute d'âge est infiniment préférable à une réponse juste mais arrivée trop tard : le jeton
  // d'enregistrement ne change pas d'une seconde à l'autre, alors qu'un délai dépassé fait conclure
  // à l'application que l'appareil est absent.
  const frais = m.regtokenBrut && Date.now() - m.regtokenBrut.at < 60_000;
  if (!frais && m.ip) {
    if (m.regtokenBrut) probeRegtoken(m).catch(() => {});   // rafraîchissement en arrière-plan
    else await probeRegtoken(m).catch(() => {});            // premier appel : on n'a pas le choix
  }
  if (m.regtokenBrut) {
    LA("in", "regtoken", `demandé, nous resservons celui de la machine (${m.dsn})`, peerAddress(req), m);
    return raw(res, m.regtokenBrut.body, 200, "text/json");
  }
  // Repli : la machine est injoignable et nous n'avons jamais vu sa réponse. On sert le minimum,
  // et on le DIT — une application qui refuserait ici doit être diagnosticable.
  LA("in", "regtoken", "demandé, mais la réponse de la machine est inconnue — réponse minimale reconstruite", peerAddress(req), m);
  return raw(res, JSON.stringify({ registered: 1, registration_type: "AP-Mode", host_symname: m.dsn }), 200, "text/json");
}

/**
 * `POST` / `PUT` / `DELETE /local_reg.json` — le créneau, vu de l'autre côté.
 *
 * Et voilà la différence de fond avec la machine : **nous n'avons pas un créneau, nous avons un
 * registre.** C'est toute la fonctionnalité, en une structure de données.
 */
async function handleAppReg(req, res) {
  const from = peerAddress(req);
  const body = await readBody(req);

  if (req.method === "DELETE") {
    // Le corps porte `delete_session` (voir `DeleteSessionCommand`), mais la méthode suffit.
    const app = [...PROXY.registre.apps.values()].find((a) => a.ip === from);
    if (app) retirerApp(app, machineById(app.machineId), "session fermée par l'application");
    return raw(res, JSON.stringify({}), 200);
  }
  if (req.method !== "POST" && req.method !== "PUT") return raw(res, JSON.stringify({ error: "method" }), 405);

  let reg;
  try {
    reg = JSON.parse(body.toString("utf8")).local_reg;
  } catch {
    refuser(PROXY.registre, { from, motif: "corpsIllisible" }, Date.now());
    return raw(res, JSON.stringify({ error: "body" }), 400);
  }
  if (!reg?.port) {
    refuser(PROXY.registre, { from, motif: "corpsIllisible", detail: "port absent" }, Date.now());
    return raw(res, JSON.stringify({ error: "body" }), 400);
  }

  const dsn = new URL(req.url, "http://x").searchParams.get("dsn");
  const existante = PROXY.registre.apps.get(cleApp(reg.ip ?? from, reg.port));
  const m = existante ? machineById(existante.machineId) : machinePourApp(dsn);
  if (!m) {
    // Refus explicite plutôt que rattachement au hasard : relayer vers la mauvaise cafetière est
    // exactement le genre d'erreur qu'on ne rattrape pas après coup.
    refuser(PROXY.registre, { from, motif: "dsnInconnu", detail: dsn }, Date.now());
    LA("in", "enregistrement", `refusé — DSN ${dsn ?? "non fourni"} ne correspond à aucune machine connue`, from);
    return raw(res, JSON.stringify({ error: "unknown dsn" }), 412);
  }
  if (!m.lanKey.length) {
    refuser(PROXY.registre, { from, motif: "sansCle", detail: m.id }, Date.now());
    LA("in", "enregistrement", `refusé — la clé LAN de ${m.id} est inconnue, aucune session ne pourrait être chiffrée`, from, m);
    return raw(res, JSON.stringify({ error: "no key" }), 412);
  }

  const { app, nouvelle } = annoncer(
    PROXY.registre,
    { ip: reg.ip ?? from, port: reg.port, uri: reg.uri ?? "/local_lan", notify: reg.notify, keyId: m.lanKeyId },
    Date.now(),
  );
  app.machineId = m.id;
  /**
   * ⚠️ **Le protocole ne transporte AUCUNE identité d'application.** `LocalReg` du SDK a
   * exactement cinq champs — `ip`, `key`, `notify`, `port`, `uri` — et `key` n'est renseigné qu'en
   * appairage (clé publique d'un appareil en cours de configuration). Le `key_id` de l'échange de
   * clés est celui de la MACHINE, donc identique pour toutes les applications qui lui parlent. Ni
   * nom, ni identifiant d'instance, ni identifiant d'utilisateur.
   *
   * Le seul signal supplémentaire disponible est **hors protocole** : l'en-tête `User-Agent` que
   * le client HTTP de l'application met sur ses propres requêtes. Il ne distingue pas deux
   * instances l'une de l'autre — deux téléphones avec la même version portent le même — mais il
   * distingue une *nature* de client : l'application officielle, un script, notre `faux-app.mjs`.
   * C'est précisément ce que la moitié « surveillance des usurpations » de la page réclame, et
   * cela ne coûte rien : l'en-tête est déjà là, on le jetait.
   *
   * Borné, et traité comme la donnée non fiable qu'il est : n'importe qui peut écrire ce qu'il
   * veut dedans. Il documente, il n'authentifie pas.
   */
  const ua = String(req.headers["user-agent"] ?? "").slice(0, 120) || null;
  if (ua && ua !== app.ua) {
    const avant = app.ua;
    app.ua = ua;
    if (avant) LA("in", "client", `changé — ${avant} → ${ua}`, app, m);
  }
  // 202, comme la machine : c'est ce que l'app attend d'un `local_reg` accepté.
  raw(res, JSON.stringify({}), 202);

  if (nouvelle) {
    LA("in", "annonce", `${from} s'annonce pour ${m.dsn ?? m.id} (écoute ${app.ip}:${app.port}${app.uri})${ua ? ` · client ${ua}` : " · client anonyme"}`, app, m);
    // L'échange de clés part APRÈS la réponse : l'application n'a pas encore fini de traiter son
    // propre `local_reg` tant qu'elle attend notre 202, et son serveur HTTP pourrait ne pas être
    // prêt à recevoir. La machine fait exactement pareil avec nous.
    ouvrirSessionApp(m, app).catch(() => {});
  } else if (!app.session || app.etat !== "etablie") {
    // **Une annonce reçue sur une entrée SANS session est le signal de réparation le plus sûr
    // qui soit** : l'application vient de dire elle-même qu'elle est là et qu'elle écoute. Le
    // test `if (nouvelle)` au-dessus ne couvrait que la première annonce, si bien qu'après un
    // échange raté le téléphone pouvait s'annoncer cent fois sans que rien ne reparte.
    // Passe avant `notify` : sans session, aucune commande ne peut être servie de toute façon.
    reprendreSessionApp(m, app, "annonce reçue sans session — nouvelle tentative d'échange de clés");
  } else if (reg.notify) {
    // `notify: 1` veut dire « j'ai quelque chose pour toi ». Aller le chercher tout de suite,
    // plutôt que d'attendre le prochain tour de sonde, est ce qui rend l'app réactive.
    sonderApp(m, app).catch(() => {});
  }
}

// Une réponse de la machine peut porter {property:{...}}, {properties:[...]} ou un
// accusé de commande. On collecte donc tous les couples name/value à n'importe quelle
// profondeur, avec repli regex si le JSON est tronqué.
function collectProps(decoded) {
  const out = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v.name === "string" && typeof v.value === "string") out.push({ name: v.name, value: v.value });
    for (const k of Object.keys(v)) walk(v[k]);
  };
  try { walk(JSON.parse(decoded)); } catch {
    const m = decoded.match(/"name"\s*:\s*"([^"]+)".*?"value"\s*:\s*"([^"]*)"/s);
    if (m) out.push({ name: m[1], value: m[2] });
  }
  return out;
}

/**
 * Aiguillage des propriétés reçues de la machine — **sur l'octet de commande de la trame**,
 * pas sur le nom de la propriété.
 *
 * Une première version routait par motif de nom (`_beansystem` → décodeur de recettes) : la
 * machine a répondu à `0xBA` en poussant `d251_beansystem_1`, qui est allé au mauvais décodeur et
 * ressortait « désaligné ». Or chaque famille a son propre octet de commande, vérifié sur les
 * 50 propriétés réellement lues :
 *
 *   0xB0 bornes min/déf/max · 0xA6 valeurs d'un profil · 0xA4 noms de profils
 *   0xAA noms de recettes perso · 0xA8 ordre des favoris · 0xBA profil Bean System
 *   0xA3 sommes de contrôle · 0xA2 paramètres et statistiques
 *
 * `0xA1` (numéro de série) fait exception : voir le routage par nom, plus bas.
 */
function handleProperty(m, name, value) {
  // Tout datapaquet, même inattendu, prouve que la machine est là : c'est ce que le coupe-circuit
  // interroge. Le noter AVANT tout traitement, sinon un décodage raté ferait passer une machine
  // bavarde pour une machine muette.
  contactMachine(m.file, Date.now());
  // Retenue AVANT tout décodage, et **brute** : c'est ce qu'une application redemandera, et une
  // propriété qu'on ne sait pas décoder doit pouvoir être servie comme les autres.
  m.dernieresValeurs.set(name, { at: Date.now(), valeur: value });
  // Rediffusion aux applications branchées, AVANT tout décodage : ce que nous savons décoder
  // n'a rien à voir avec ce qu'elles savent lire, et filtrer ici les priverait de propriétés
  // parfaitement valides que nous ignorons. Sans proxy actif, c'est un retour immédiat.
  diffuserAuxApps(m, name, value);
  if (name.startsWith(m.mon)) {
    // Isolé : un monitor illisible ne doit pas interrompre le traitement des AUTRES propriétés
    // portées par le même datapoint.
    try {
      const mo = decodeMonitor(value);
      m.lastMonitor = { at: Date.now(), ...mo };
      // La progression n'est journalisée que pendant une préparation : au repos elle n'apprend
      // rien et ferait perdre le pliage des lignes identiques de `L()`.
      const prog = mo.auRepos ? "" : ` · ${mo.etapeCle ?? "en cours"} ${mo.pourcent ?? "?"} % (f=${mo.fonction} e=${mo.etape})`;
      L("in", "monitor", `état=0x${mo.stateByte.toString(16).padStart(2, "0")}${prog}${mo.switches.length ? " · " + mo.switches.map((x) => x.label).join(", ") : ""}${mo.alarms.length ? " · alarmes " + mo.alarms.map((a) => a.name ?? `bit ${a.bit}`).join(", ") : ""}`, m, value);
    } catch (e) {
      L("in", `${name}`, `monitor illisible (${e.message})`, m, value);
    }
    // ⚠️ **La poussée de monitor EST la réponse à `0x75`.** Ce retour se faisait sans jamais
    // apparier, si bien qu'un pas « Présence » ne pouvait être satisfait que par un
    // `data_response`… que la machine n'envoie pas pour cette commande. Mesuré trois fois de
    // suite : monitor reçu à 16:19:58 et 16:20:11, tâche déclarée « sans réponse » à 16:20:01 puis
    // « échouée : 1 sans réponse » à 16:20:15 — l'état était là, affiché à l'écran, et la tâche
    // mourait quand même. Toute lecture d'état échouait ainsi, ce qui donne à l'usage l'impression
    // d'une machine déconnectée alors que la liaison fonctionne.
    //
    // Apparié sur la commande, jamais largement : ces poussées sont aussi spontanées pendant une
    // préparation, et valider un pas qui attend autre chose déclarerait lues des données jamais
    // lues. Même quand le décodage échoue : la machine a répondu, c'est ce que le pas attendait.
    apparier(m.file, { reponse: true, cmd: 0x75 }, Date.now());
    return;
  }
  if (name === "data_response") {
    handleDataResponse(m, value);
    return;
  }
  if (!value) {
    // Une propriété qui répond vide n'existe pas sur ce modèle (typiquement les variantes
    // Striker) : on le note pour ne pas la confondre avec « pas encore lue ».
    if (isProfileProp(name)) m.store.putProp(name, { at: Date.now(), kind: profilePropInfo(name).kind, absent: true });
    /**
     * **Même note pour un compteur nommé, et ici elle porte plus loin qu'un libellé.**
     *
     * La table de `compteurs.mjs` contient quarante noms dont vingt-six viennent d'un relevé fait
     * sur une AUTRE machine (une Eletta Explore) : sur l'ECAM 610.75.MB, la majorité répondra vide.
     * Sans cette marque, « Tous les noms connus » renverrait quarante pas à chaque clic pour
     * ramener les mêmes quatorze réponses — et un pas coûte une visite de la machine, qui n'en
     * accorde qu'une commande à la fois. Notée une fois, l'absente est sautée ensuite
     * (`nomsARelire`), et la page peut dire « absente sur ce modèle » plutôt que « jamais lue ».
     */
    if (estCompteur(name)) m.store.putProp(name, { at: Date.now(), kind: "counter", absent: true });
    // Une propriété absente du modèle a bel et bien RÉPONDU : le pas est fait, pas manqué. La
    // confondre avec un échec relancerait une lecture qui n'a aucune chance d'aboutir.
    apparier(m.file, { prop: name }, Date.now());
    L("in", `${name}`, `absente sur ce modèle`, m);
    return;
  }

  // Routage par NOM, et c'est délibéré pour celle-ci. Sa trame porte la commande `0xA1`
  // (vérifié en direct : `d0 1b a1 0f …`), qui n'a pas de décodeur — sans cette branche elle
  // tomberait dans `default` et resterait « non décodée ». L'app elle-même ne regarde pas cet
  // octet : elle lit la valeur positionnellement. Nom EXACT, pas motif : c'est le routage par
  // MOTIF (`_beansystem` → décodeur de recettes) qui avait produit les désalignements.
  if (name === SERIAL_PROP) {
    applyIdentity(m, value);
    apparier(m.file, { prop: name }, Date.now());
    return;
  }

  // Routage par NOM lui aussi, et pour la même raison que le numéro de série : sa trame porte la
  // commande `0xA1`, qui n'a pas de décodeur d'aiguillage — sans cette branche elle se journalisait
  // « commande 0xa1 NON IDENTIFIÉE » et repartait brute, ce qu'elle a fait jusqu'au 2026-08-26.
  // Nom EXACT, jamais un motif : c'est le routage par motif (`_beansystem`) qui avait déjà produit
  // un désalignement silencieux ici même.
  if (name === BEAN_SYNC_PROP) {
    try {
      const sy = decodeBeanSync(value);
      m.store.putProp(name, { at: Date.now(), kind: "beanSync", selected: sy.selected, ecoulementMs: sy.ecoulementMs, espressos: sy.espressos, mots: sy.mots, hex: sy.hex });
      // Les trois mots nommés se lisent en clair, les sept autres restent des nombres nus : le
      // journal ne doit jamais donner à un mot anonyme l'air d'avoir un sens.
      const nommes = [
        `grain ${sy.selected}`,
        sy.ecoulementMs === null ? null : `écoulement ${sy.ecoulementMs} ms`,
        sy.espressos === null ? null : `${sy.espressos} espresso(s)`,
      ].filter(Boolean).join(" · ");
      L("in", `${name}`, `${nommes} · mots ${sy.mots.join(", ")}`, m, value);
    } catch (e) {
      // La machine a répondu : le pas est FAIT, pas manqué — le redemander rendrait les mêmes
      // octets. On garde la trame brute, seule chose qui permettra de comprendre l'échec.
      m.store.putProp(name, { at: Date.now(), kind: "unknown", cmd: 0xa1, hex: Buffer.from(value, "base64").toString("hex").replace(/(..)/g, "$1 ").trim() });
      L("in", `${name}`, `décodage impossible (${e.message})`, m, value);
    }
    apparier(m.file, { prop: name }, Date.now());
    return;
  }

  /**
   * **Les compteurs nommés — troisième routage par NOM, et le seul qui ne porte pas de trame.**
   *
   * `d553_water_tot_qty`, `d701_tot_bev_bw`, `d705_tot_id1_espr`… : ces propriétés ne transportent
   * pas d'ECAM du tout, mais un nombre, ou un objet JSON de sous-compteurs sur les Striker. Elles
   * arrivaient donc dans `default`, rangées en `kind: "unknown"` avec leur valeur mot pour mot —
   * conservées, jamais lues. Voir `src/lib/compteurs.mjs` pour ce que chaque nom compte et d'où
   * vient la table.
   *
   * ⚠️ **Avant l'aiguillage par octet de commande, et c'est nécessaire.** Une valeur numérique est
   * du texte : `octetsEcam` refuse déjà `"1787407876"`, mais rien ne garantit qu'aucun compteur ne
   * ressemblera jamais à du base64 de longueur multiple de quatre. Router par nom exact ferme la
   * question au lieu de la parier. Nom EXACT, jamais un motif — c'est le routage par motif
   * (`_beansystem`) qui avait produit un désalignement silencieux quelques lignes plus haut.
   *
   * La valeur BRUTE est conservée à côté de la valeur lue : c'est elle qu'on recompare à un relevé
   * ultérieur, et c'est elle qui prouve la conversion quand il y en a une (l'eau, en demi-ml).
   */
  if (estCompteur(name)) {
    const info = compteurInfo(name);
    const lu = lireCompteur(value);
    if (lu === null) {
      // La machine a RÉPONDU, avec quelque chose que nous ne savons pas lire. Le pas est fait ; la
      // valeur repart brute, seule chose qui permettra de comprendre l'échec.
      m.store.putProp(name, { at: Date.now(), kind: "counter", illisible: true, brut: String(value) });
      L("in", `${name}`, `compteur illisible : ${String(value).slice(0, 120)}`, m);
    } else {
      m.store.putProp(name, {
        at: Date.now(), kind: "counter", value: lu.value, breakdown: lu.breakdown, brut: String(value),
      });
      const converti = info.divisor ? ` (${valeurAffichee(name, lu.value)} ${info.unit})` : "";
      const detail = lu.breakdown ? ` · ${Object.entries(lu.breakdown).map(([k, v]) => `${k}=${v}`).join(", ")}` : "";
      L("in", `${name}`, `${lu.value}${converti}${detail}`, m);
    }
    apparier(m.file, { prop: name }, Date.now());
    return;
  }

  // ⚠️ **Tester que c'est une trame AVANT d'en lire l'octet de commande.**
  // `Buffer.from(x, "base64")` ne lève jamais : il ignore silencieusement ce qui n'en est pas et
  // rend des octets qui ont l'air de quelque chose. Deux conséquences, l'une visible et l'autre
  // pas. Visible : `device_connected = 1787407876` — un horodatage unix en clair, que la vraie
  // application nous écrit — se journalisait « commande 0x3b non décodée — d7 bf 3b e3 4e fc ef »,
  // sept octets inventés là où la valeur était lisible telle quelle. Invisible et pire : cet
  // octet fabriqué sert à AIGUILLER le décodage, donc une valeur quelconque dont le troisième
  // octet vaut par hasard 0xA2 partait chez `decodeParameters`, qui rangeait des compteurs
  // imaginaires dans la base. `opReponse` vérifie la forme base64 puis l'en-tête ECAM (0xD0 ou
  // 0x0D) et rend `null` sinon — ce qui envoie proprement la valeur au cas `default`.
  const reponse = opReponse(value);
  const cmd = reponse?.cmd;
  // Chaque branche écrit ce qu'elle a décodé, tout de suite : `done` ne fait plus que journaliser.
  const done = (msg) => {
    apparier(m.file, { prop: name }, Date.now());
    L("in", `${name}`, msg, m, value);
  };
  /**
   * Décodage impossible : la machine a répondu, donc le pas n'est PAS à retenter — le redemander
   * rendrait exactement les mêmes octets. On le solde comme fait, et c'est le journal qui porte
   * l'anomalie. Ne pas l'apparier laisserait le pas expirer, donc repartir pour rien.
   */
  const failed = (e) => {
    apparier(m.file, { prop: name }, Date.now());
    L("in", `${name}`, `décodage impossible (${e.message})`, m, value);
  };

  try {
    switch (cmd) {
      case 0xb0:
      case 0xa6: {
        const r = decodeRecipeProperty(value);
        m.store.putProp(name, { at: Date.now(), kind: r.kind, beverageId: r.beverageId, profileId: r.profileId ?? null, exact: r.exact, params: r.params, hex: r.hex });
        return done(`${r.kind === "bounds" ? "bornes" : "valeurs"} ${bevLabel(m, r.beverageId)}, ${r.params.length} paramètres${r.exact ? "" : " ⚠ désalignement"}`);
      }
      case 0xa4:
      case 0xaa: {
        const kind = cmd === 0xa4 ? "profileNames" : "customNames";
        const r = decodeNames(value, STRIDE_CLASSIC);
        m.store.putProp(name, { at: Date.now(), kind, first: r.first, last: r.last, stride: r.stride, offset: r.offset, exact: r.exact, entries: r.entries, hex: r.hex });
        const named = r.entries.filter((e) => e.name).map((e) => e.name);
        return done(`${r.entries.length} noms${named.length ? " (" + named.join(", ") + ")" : " (tous vides)"}`);
      }
      case 0xa8: {
        const r = decodePriorities(value);
        m.store.putProp(name, { at: Date.now(), kind: "priority", profileId: r.profileId, beverageIds: r.beverageIds, hex: r.hex });
        return done(`ordre profil ${r.profileId} → ${r.beverageIds.join(",")}`);
      }
      case 0xba: {
        const bs = decodeBeanSystem(value);
        m.store.putProp(name, { at: Date.now(), kind: "beanSystem", index: bs.index, hex: bs.hex });
        m.store.putBeanSystem(bs);
        /**
         * **La réponse à `0xBA` n'est pas un `data_response`.** Elle arrive ici, en poussée de la
         * propriété `d(250+n)_beansystem_n`. Or le pas qui l'attend est un pas de TRAME, donc de
         * type `reponse`, et `done()` n'apparie que sur un nom de PROPRIÉTÉ : ça ne colle jamais.
         *
         * Mesuré le 2026-08-26 : le balayage des grains recevait ses quatre trames, les rangeait
         * en base (`d250`…`d253`, noms et réglages corrects), et échouait quand même en « 6 sans
         * réponse » ; « Bean System 1 » de même, sa trame arrivée à 07:11:02 dans une fenêtre
         * ouverte de 07:10:41 à 07:11:15. Le pire des résultats : la donnée est là, la tâche est
         * déclarée morte, et rien ne dit laquelle des deux croire.
         *
         * C'est exactement le défaut du monitor `0x75`, et le même remède — apparier sur la
         * COMMANDE. Étroitement, pour la même raison que là-bas : la machine pousse aussi ces
         * propriétés d'elle-même après une écriture `0xBB`, et un appariement large validerait
         * alors le pas d'une tâche qui attendait tout autre chose.
         *
         * L'appariement par nom de `done()` est conservé et ne fait pas doublon : `reponse()`
         * n'avance qu'UN pas par appel, et seulement du type demandé. Si un jour une lecture
         * `startImport(['d251_beansystem_1'])` attend cette propriété, elle a bel et bien reçu sa
         * réponse elle aussi.
         */
        apparier(m.file, { reponse: true, cmd: 0xba }, Date.now());
        return done(`bean system ${bs.index} « ${bs.name ?? "sans nom"} » mouture=${bs.grinder} temp=${bs.temperature} arôme=${bs.aroma}${bs.active ? " · ACTIF" : ""}${bs.visible ? "" : " · masqué"}`);
      }
      case 0xa2: {
        const pr = decodeParameters(value);
        m.store.putProp(name, { at: Date.now(), kind: "parameters", entries: pr.entries, hex: pr.hex });
        m.store.putStats(pr.entries);
        return done(`${pr.entries.length} paramètre(s) : ${pr.entries.map((e) => `${e.id}=${e.value}`).join(", ")}`);
      }
      case 0xa3: {
        const cs = decodeChecksums(value);
        m.store.putChecksums(cs);
        return done(`sommes de contrôle : ${cs.size} profils, noms=0x${cs.names.toString(16)}`);
      }
      case 0x95: {
        const st = decodeSettings(value);
        m.store.putProp(name, { at: Date.now(), kind: "settings", entries: st.entries, hex: st.hex });
        noteReglages(m, st.entries, "propriété");
        return done(`réglages : ${st.entries.map((e) => `${e.addr}=${e.value}`).join(", ")}`);
      }
      // Tout ce que nous ne savons pas décoder — et c'est une DÉCOUVERTE, pas une erreur : la
      // valeur est conservée telle quelle, sans interprétation, parce qu'un outil qui a déjà
      // décidé quoi jeter ne peut plus rien apprendre. Même règle que `chargeBrute`.
      default: {
        if (!reponse) {
          // Pas une trame ECAM du tout : on garde la valeur, mot pour mot.
          m.store.putProp(name, { at: Date.now(), kind: "unknown", cmd: null, valeur: String(value) });
          return done(`valeur non-trame : ${String(value).slice(0, 120)}`);
        }
        const hex = reponse.trame.toString("hex").replace(/(..)/g, "$1 ").trim();
        m.store.putProp(name, { at: Date.now(), kind: "unknown", cmd, hex });
        return done(`commande ${hexCmd(cmd)} NON IDENTIFIÉE — ${hex}`);
      }
    }
  } catch (e) {
    return failed(e);
  }
}

/** Réponse ECAM à une de nos commandes. Les sommes de contrôle arrivent parfois par ici. */
function handleDataResponse(m, value) {
  const buf = Buffer.from(value, "base64");
  const hex = buf.toString("hex").replace(/(..)/g, "$1 ").trim();
  m.lastDataResponse = { at: Date.now(), hex };
  L("in", "data_response", describeFrame(value, { octets: false }), m, value);
  // C'est LA réponse qu'attend un pas de trame de lecture (0xBA, 0xA3, 0xA2, monitor). Apparier ici
  // est ce qui fait avancer un balayage à la vitesse de la machine : six grains ne sont plus six
  // programmes espacés d'un `setTimeout(11000)` deviné, mais six pas qui s'enchaînent à la réponse.
  apparier(m.file, { reponse: true }, Date.now());
  if (buf[2] === 0xa2) {
    try {
      const pr = decodeParameters(value);
      m.store.putStats(pr.entries);
      L("in", "paramètres", `${pr.entries.map((e) => `${e.id}=${e.value}`).join(", ")}`, m);
    } catch (e) {
      L("in", "paramètres", `décodage impossible (${e.message})`, m);
    }
    return;
  }
  if (buf[2] === 0x95) {
    try {
      const st = decodeSettings(value);
      noteReglages(m, st.entries, "trame 0x95");
      L("in", "réglages", `${st.entries.map((e) => `${e.addr}=${e.value}`).join(", ")}`, m);
    } catch (e) {
      L("in", "réglages", `décodage impossible (${e.message})`, m);
    }
    return;
  }
  if (buf[2] === 0xa3) {
    try {
      const cs = decodeChecksums(value);
      // `putChecksums` décale l'ancien relevé vers `checksumsPrev` et rend le couple : c'est lui
      // qui dit ce qui a bougé, il est écrit dans une seule transaction.
      const { prev, current } = m.store.putChecksums(cs);
      const changed = diffChecksums(prev, current);
      L("in", "sommes", `${cs.size} profils, noms=0x${cs.names.toString(16)}, perso=0x${cs.customRecipes.toString(16)}${changed.length ? " — changé : " + changed.join(", ") : prev ? " — rien de changé" : ""}`, m);
    } catch (e) {
      L("in", "sommes", `décodage impossible (${e.message})`, m);
    }
  }
}

/**
 * Noms lus sur la machine, aplatis en « index → entrée ».
 *
 * On scanne le cache par **famille décodée** (`kind`), pas par liste de propriétés attendues :
 * la machine peut répondre sur une propriété qu'on n'avait pas prévue (elle l'a fait pour les
 * Bean Systems), et un nom reçu doit compter quelle que soit la propriété qui l'a porté.
 * Chaque bloc annonce son index de départ ; la première variante qui donne un nom non vide gagne.
 *
 * Partagé par /api/profiles ET /api/beverages : c'est ce qui garantit qu'un emplacement renommé
 * sur la machine porte le même nom partout.
 */
function readNames(store, kind) {
  const out = {};
  for (const [prop, data] of Object.entries(store.props ?? {})) {
    if (data?.kind !== kind || data.absent || !Array.isArray(data.entries)) continue;
    data.entries.forEach((e, i) => {
      const idx = (data.first ?? 1) + i;
      if (out[idx]?.name) return;
      out[idx] = { ...e, prop, stride: data.stride ?? null };
    });
  }
  return out;
}

/**
 * id de boisson → nom donné sur la machine, pour les emplacements personnalisables.
 *
 * **Uniquement les recettes personnalisées** (emplacement n → boisson 229 + n, noms `0xAA`).
 *
 * ⚠️ Ne PAS y mettre les noms de Bean System. Ce sont deux natures différentes : un Bean System est
 * une **configuration de grains** (mouture/température/arôme, nommée d'après la marque du café —
 * « Grain A », « Grain B »), pas une boisson. Une version précédente mappait « bean system n →
 * boisson 199 + n » et écrasait ainsi le nom de la boisson 200 par celui du grain : la première
 * carte de la page s'appelait « Grain A » au lieu de l'espresso qu'elle prépare. Le grain associé
 * s'expose comme **attribut** de la boisson (voir `activeBeanSystem`), jamais comme son nom.
 */
function machineBeverageNames(store) {
  const out = {};
  for (const [slot, entry] of Object.entries(readNames(store, "customNames"))) {
    // L'EMPLACEMENT voyage avec l'entrée. C'est lui qu'attend `0xAB` (`V0(slot, slot, …)` dans
    // l'app, `d.f0` ensuite), et le 229 qui le relie à l'identifiant de boisson est une constante
    // de protocole : la recalculer côté client en ferait une seconde source de vérité, à
    // diverger au premier modèle qui décale la plage.
    if (entry?.name) out[229 + Number(slot)] = { slot: Number(slot), name: entry.name, icon: entry.icon, prop: entry.prop, source: "recette perso" };
  }
  return out;
}

/**
 * Configuration de grains actuellement sélectionnée sur la machine (octet 50 de la trame `0xBA`).
 * C'est elle qui détermine la tasse pour la boisson Bean System, donc on l'expose comme attribut.
 */
function activeBeanSystem(store) {
  // **Source rapide** : le mot 4 de `d260_beansystem_sync_par`, une seule lecture de propriété.
  const sync = store.props?.[BEAN_SYNC_PROP];
  const rapide = Number.isInteger(sync?.selected) && sync.selected >= 1 ? sync.selected : null;

  // **Source lente** : le drapeau de l'octet 50 de `0xBA`, qui n'existe qu'après avoir balayé tous
  // les index — six trames, une cinquantaine de secondes avec les reprises. Elle reste la SEULE
  // source du nom et des réglages du grain, donc on la lit dans tous les cas.
  let drapeau = null;
  for (const [index, bs] of Object.entries(store.beanSystems ?? {})) {
    if (bs?.active && Number(index) >= 1) { drapeau = Number(index); break; }
  }

  const index = rapide ?? drapeau;
  if (index === null) return null;
  const bs = store.beanSystems?.[index] ?? {};
  return {
    index,
    // `null` et non un libellé de repli : le nom vient du balayage `0xBA`, qui peut très bien ne pas
    // avoir encore eu lieu pour cet index. La carte de boisson ne s'affiche que si le nom existe.
    name: bs.name ?? null,
    grinder: bs.grinder ?? null,
    temperature: bs.temperature ?? null,
    aroma: bs.aroma ?? null,
    source: rapide !== null ? "sync" : "flag",
    /**
     * **Un désaccord entre les deux sources est SIGNALÉ, jamais corrigé.** Les deux se lisent
     * indépendamment et à des instants différents : le balayage est cher donc rare, la propriété de
     * synchronisation est bon marché donc fraîche. Trancher silencieusement afficherait le grain
     * d'avant comme si c'était celui d'après — une valeur plausible et fausse, exactement ce que ce
     * fichier passe son temps à éviter. Les deux horodatages voyagent avec, pour qu'on puisse voir
     * laquelle des deux lectures est en retard.
     */
    disagree: rapide !== null && drapeau !== null && rapide !== drapeau
      ? { sync: rapide, syncAt: sync?.at ?? null, flag: drapeau, flagAt: store.beanSystems?.[drapeau]?.at ?? null }
      : null,
  };
}

/** Familles dont la somme de contrôle a bougé entre deux relevés. */
function diffChecksums(prev, cur) {
  if (!prev || !cur) return [];
  const out = [];
  if (prev.names !== cur.names) out.push("noms");
  if (prev.customRecipes !== cur.customRecipes) out.push("recettes perso");
  for (const k of Object.keys(cur.profiles ?? {})) {
    if (prev.profiles?.[k] !== cur.profiles[k]) out.push(`profil ${k}`);
  }
  return out;
}

/**
 * Ce qui est périmé dans le cache : on compare la somme actuelle à celle relevée lors du dernier
 * import réussi. `null` = on ne sait pas (jamais relevé), ce qui n'est pas la même chose que
 * « à jour ».
 */
function staleFromChecksums(store) {
  const cur = store.checksums;
  const ref = store.checksumsAtImport;
  if (!cur) return null;
  const cmp = (a, b) => (a == null || b == null ? null : a !== b);
  return {
    names: cmp(ref?.names, cur.names),
    customRecipes: cmp(ref?.customRecipes, cur.customRecipes),
    profiles: Object.fromEntries(Object.keys(cur.profiles ?? {}).map((k) => [k, cmp(ref?.profiles?.[k], cur.profiles[k])])),
  };
}

/**
 * Compteurs dont la signification est **établie** — lue dans `p018b7/e.java`, qui associe chaque
 * identifiant de paramètre à une entrée de l'énumération `p258z7/w.java$a` :
 *
 *   105 → TOTAL_DESCALES     108 → TOTAL_FILTERS      115 → TOTAL_MILK_CLEANS
 *   106 → TOTAL_LITRES_WATER (unité = 0,5 ml, donc litres = valeur / 2000)
 *   3000 → TOTAL_BEVERAGE_BLACK          3001 + 3003 → TOTAL_BEVERAGE_WITH_HOT_MILK
 *   3017 → TOTAL_BEVERAGE_WITH_COLD_MILK (Maestosa seulement)
 *   3021 → TOTAL_CHOCO                   3025 → TOTAL_TEA
 *
 * ⚠️ **La machine ne compte pas boisson par boisson, mais par catégorie.** Le seul compteur propre
 * à une boisson est celui du thé (et l'app a une propriété `d719_id22_tea` qui le confirme : 22 est
 * bien l'id du thé). Ne jamais présenter l'un de ces nombres comme « le nombre d'espressos ».
 *
 * Les 62 identifiants existent sur la machine ; seuls ceux-ci ont un sens connu. Les autres restent
 * exposés bruts par `/api/stats`.
 */
const STAT_MEANINGS = {
  105: { key: "descales" },
  106: { key: "waterLitres", divisor: 2000 },
  108: { key: "filters" },
  115: { key: "milkCleans" },
  3000: { key: "beverageBlack" },
  3001: { key: "beverageHotMilk" },
  3003: { key: "beverageHotMilkExtra" },
  3017: { key: "beverageColdMilk" },
  3021: { key: "choco" },
  3025: { key: "tea" },
};

/**
 * **Le second espace de paramètres : celui de `0xA1`, que le balayage `0xA2` n'atteindra jamais.**
 *
 * Les 62 compteurs ci-dessus se lisent par `0xA2 0x0F`, qui ÉNUMÈRE — demander un id inexistant
 * renvoie les suivants qui existent. On pourrait donc croire qu'il suffit d'élargir `STAT_RANGES`
 * pour finir par ramener les paramètres 500 et suivants. **Non : les deux espaces sont disjoints.**
 * Le numéro de série est le paramètre 205, il se lit par `0xA1 0x0F`, et 205 n'apparaît dans
 * AUCUNE énumération `0xA2` — dont le bloc `1xx` s'arrête à 116 et saute directement à 3000.
 *
 * D'où ce second tableau. `d260_beansystem_sync_par` porte dix mots de 32 bits qui SONT les
 * paramètres 500 à 509 (voir `decodeBeanSync`), dont trois ont un sens établi — par le journal de
 * l'app, pas par corrélation. La page des statistiques les montre à côté des autres parce que
 * c'est la même question posée à la même machine, et surtout parce que **502 est un instrument** :
 * c'est la seule durée que l'appareil mesure et publie. Le relevé différentiel du 2026-08-20
 * laisse le paramètre 101 en « autre nature (durée ? mouture ?) » ; 502 est la seule référence
 * contre laquelle cette hypothèse-là peut être testée, et c'est ce que la lecture conjointe
 * (`sync` dans `scanStats`) rend possible.
 *
 * Les sept autres mots restent nus, ici comme ailleurs : trois relevés concordants leur avaient
 * donné une direction, un quatrième les a tous démentis (voir `decodeBeanSync`).
 */
const SYNC_MEANINGS = {
  502: { key: "flowMs", unit: "ms" },
  504: { key: "beanIndex" },
  505: { key: "espressosSinceWrite" },
};

/**
 * Les dix mots du paramètre 500, tels que `/statistiques` les affiche : **le rang EST le décalage**
 * (`500 + rang`), donc l'identifiant se calcule et ne se recopie pas.
 *
 * `null` quand la propriété n'a jamais été poussée, ou qu'elle l'a été sous une forme indécodable
 * (`kind: "unknown"`, où `mots` n'existe pas) : la page doit pouvoir dire « pas encore lu » plutôt
 * que d'afficher dix cases vides qui ressemblent à dix zéros.
 */
function vueParamsSync(m) {
  const sync = m.store.machineView().props?.[BEAN_SYNC_PROP];
  if (!Array.isArray(sync?.mots) || !sync.mots.length) return null;
  return {
    prop: BEAN_SYNC_PROP,
    param: BEAN_SYNC_PARAM,
    at: sync.at ?? null,
    words: sync.mots.map((value, rang) => {
      const id = BEAN_SYNC_PARAM + rang;
      const sens = SYNC_MEANINGS[id] ?? null;
      return { id, rang, value, key: sens?.key ?? null, unit: sens?.unit ?? null };
    }),
  };
}

/**
 * Compteur à rattacher à une boisson. C'est celui de sa **catégorie**, pas de la tasse : voir
 * l'avertissement ci-dessus. `null` quand aucune catégorie connue ne s'applique (eau chaude, mug de
 * voyage — dont le total vit dans `d731/d732`, sans identifiant de paramètre connu).
 */
function beverageCounter(store, bev) {
  const stats = store.stats ?? {};
  const pick = (id, category) => {
    const s = stats[id];
    return s === undefined ? null : { id, value: s.value, at: s.at, category, scope: "category" };
  };
  if (bev.id === 22) return pick(3025, "tea");
  if (bev.id === 16) return null; // eau chaude : aucune catégorie de boisson
  if (bev.id === 26) return null; // mug de voyage : total dans d731/d732, pas d'id connu
  if (bev.milk) return pick(3001, "beverageHotMilk");
  return pick(3000, "beverageBlack");
}

/**
 * **L'assemblage d'UNE boisson telle que l'interface la reçoit** — catalogue du modèle, bornes du
 * modèle, valeurs enregistrées du profil demandé, nom et icône saisis sur la machine, emplacement
 * perso, compteur de catégorie.
 *
 * Il vivait en ligne dans `/api/beverages`, donc hors de portée de tout autre endpoint. `/api/recipes`
 * en a désormais besoin — une recette locale s'affiche et s'édite avec le MÊME composant que les
 * boissons, donc elle doit arriver à la même forme — et l'y recopier aurait fait deux assemblages
 * pour un seul objet, qui auraient divergé au premier champ ajouté sans que rien ne le signale.
 * C'est le défaut contre lequel ce fichier met en garde à propos de `TWO` et d'`ECAM_OPS`.
 *
 * `machineNames` et `bean` sont passés plutôt que relus : les deux coûtent un parcours du cache, et
 * `vueBoissons` les calcule une fois pour les 28 boissons.
 */
function vueBoisson(m, store, b, profileId, machineNames, bean) {
  const boundsProp = b.bounds;
  const valuesProp = m.catalog.profileProp(b, profileId);
  const bounds = boundsProp ? store.props[boundsProp] ?? null : null;
  const values = valuesProp ? store.props[valuesProp] ?? null : null;
  const named = machineNames[b.id];
  return {
    ...b,
    // Compteur d'usage de la CATÉGORIE de cette boisson (la machine ne compte pas par tasse).
    counter: beverageCounter(store, b),
    // La boisson Bean System porte la configuration de grains active comme ATTRIBUT.
    beanSystem: b.id === 200 ? bean : null,
    label: named?.name ?? b.label,
    catalogLabel: b.label, // libellé générique conservé pour référence
    machineName: named?.name ?? null,
    machineNameProp: named?.prop ?? null,
    /**
     * **L'octet d'icône EST l'index 0-19 dans la liste du sélecteur de l'app** — vérifié de
     * bout en bout dans son code, sans rien écrire sur l'appareil :
     *
     * 1. `CreateBeverageViewModel.J()` construit 20 images ; la sélectionnée est celle dont
     *    la **position** vaut `gVar.n()`.
     * 2. `Q6.g.n()` rend `f6459b`, que le `toString` de la classe nomme `recipeImageIndex`.
     * 3. À la validation, `m0()` appelle `f0(idBoisson, nom, gVar2.n())`.
     * 4. `DeLonghiWifiConnectService.f0` le journalise `"saveRecipeName … iconIndex:"` et le
     *    passe à `p097j6.d.f0`, qui pose `bArr[2] = 0xAB` puis l'octet 20 de l'entrée.
     *
     * C'est exactement l'octet que `decodeNames` rend ici. Non nul pour les seules recettes
     * perso : `machineBeverageNames` ne couvre qu'elles.
     */
    icon: named?.icon ?? null,
    /** Emplacement perso 1-6, ou `null`. C'est l'index qu'attend `POST /api/profiles/name`. */
    customSlot: named?.slot ?? null,
    boundsProp,
    valuesProp,
    bounds,
    values,
  };
}

/** Le catalogue entier vu pour un profil. Une recette perso renommée sur la machine doit
 *  s'afficher sous son nom, pas sous le libellé générique du catalogue — d'où `machineNames`. */
function vueBoissons(m, store, profileId) {
  const machineNames = machineBeverageNames(store);
  const bean = activeBeanSystem(store);
  return m.catalog.beverages.map((b) => vueBoisson(m, store, b, profileId, machineNames, bean));
}

/**
 * **Une recette locale, remise en forme à la lecture** — jamais réécrite en base.
 *
 * Le format a gagné `icon` (l'index 0-19 que `0xAB` demande lors d'un transfert) et `apercu` (de
 * quoi dessiner la carte tant que le catalogue n'est pas là). Les recettes enregistrées avant ne
 * les portent pas : elles sont complétées ici, à la volée. Migrer la base aurait été réécrire des
 * lignes pour ajouter des champs qu'on sait déduire — du risque contre rien.
 *
 * ⚠️ **`apercu` ne construit JAMAIS une trame.** Il n'existe que pour l'affichage, et dès que le
 * catalogue est là c'est le catalogue qui gagne. Une seule source pour ce qui atteint l'appareil.
 */
function normaliseRecette(r, bev) {
  return {
    id: String(r.id),
    name: r.name ?? "",
    beverageId: Number(r.beverageId),
    profileId: Number(r.profileId) || 1,
    params: (r.params ?? []).map((p) => ({ id: Number(p.id), value: Number(p.value) })),
    icon: r.icon == null ? null : Number(r.icon),
    apercu: r.apercu ?? (bev ? { label: bev.label, slug: bev.slug, category: bev.category, milk: !!bev.milk } : null),
    updatedAt: r.updatedAt ?? null,
  };
}

/**
 * **La bibliothèque de recettes, à la forme que l'interface consomme.**
 *
 * Chaque entrée porte trois choses distinctes, et les garder distinctes est le point : la `recipe`
 * (ce que l'utilisateur a enregistré), la `beverage` (la boisson visée telle que le MÊME assemblage
 * que `/api/beverages` la rend, pour que la page monte le même composant de carte et le même
 * éditeur), et le `transfert` (ce que la machine accepterait).
 *
 * `beverage` vaut **`null`** quand le catalogue du modèle ne connaît pas cet identifiant — modèle
 * changé, machine remplacée. On ne fabrique pas une boisson de circonstance pour sauver les
 * apparences : la carte le dira, ce qui est une information vraie et utile.
 *
 * `values` reste **les valeurs du profil sur la machine**, pas celles de la recette : c'est ce qui
 * donne son sens au « ↺ réinitialiser » de l'éditeur. Les valeurs de la recette voyagent dans
 * `recipe.params` et l'éditeur les reçoit par son `initial`.
 */
function vueRecettes(m) {
  const store = m.store.machineView();
  const machineNames = machineBeverageNames(store);
  const bean = activeBeanSystem(store);
  const parId = new Map(m.catalog.beverages.map((b) => [b.id, b]));

  /**
   * Les emplacements perso du modèle, **nommés ou non**. `customSlotOf` les tire du catalogue,
   * pas de la trame des noms : on transfère volontiers dans un emplacement encore vierge, et
   * `machineBeverageNames` ne couvre que ceux qui portent déjà un nom.
   */
  const emplacements = m.catalog.beverages
    .map((b) => ({ b, slot: customSlotOf(b.slug) }))
    .filter((x) => x.slot !== null)
    .map(({ b, slot }) => ({
      id: b.id,
      slot,
      // `null` = jamais nommé sur la machine. La confirmation d'écrasement le dira ainsi plutôt
      // que d'afficher le libellé d'usine comme s'il s'agissait d'un nom choisi.
      name: machineNames[b.id]?.name ?? null,
      icon: machineNames[b.id]?.icon ?? null,
      ingredients: b.ingredients,
    }));

  const recipes = m.store.listRecipes().map((brut) => {
    const b = parId.get(Number(brut.beverageId)) ?? null;
    const recipe = normaliseRecette(brut, b);
    // Un plan par emplacement : rien n'oblige deux emplacements à déclarer les mêmes réglages, et
    // supposer le contraire ferait proposer une cible qui refuserait à l'écriture.
    const plans = emplacements.map((e) => ({ e, plan: planTransfert({ params: recipe.params, cibleParams: e.ingredients }) }));
    const ouverts = plans.filter((x) => x.plan.possible);
    return {
      recipe,
      beverage: b ? vueBoisson(m, store, b, recipe.profileId, machineNames, bean) : null,
      transfert: {
        possible: ouverts.length > 0,
        // Une CLÉ, jamais une phrase : rien de traduisible ne traverse l'API.
        raison: ouverts.length ? null : (plans[0]?.plan.raison ?? "noCustomSlot"),
        /**
         * **`retires` traverse l'API, et c'est nouveau parce que le cas est devenu atteignable.**
         *
         * `planTransfert` a toujours listé ce que la cible ne déclare pas, et `transfert.mjs` dit en
         * tête que ce n'est « jamais écarté sans le dire » — mais personne ne le disait : la vue ne
         * publiait pas le champ, donc l'interface ne pouvait pas le montrer. Tant qu'une recette ne
         * portait que du café et du lait, un emplacement déclarait tout et la liste était vide.
         *
         * Depuis que l'eau chaude est un ingrédient, une recette du mug de voyage peut porter les
         * trois — et un emplacement perso ne déclare pas l'eau chaude. Le transfert reste possible
         * (le café et le lait, eux, passent) et il **perdrait l'eau en annonçant une réussite**.
         *
         * Des IDENTIFIANTS, pas des libellés : c'est la page qui les nomme, comme partout ailleurs.
         */
        emplacements: ouverts.map((x) => ({
          id: x.e.id, slot: x.e.slot, name: x.e.name, icon: x.e.icon,
          retires: x.plan.retires.map((r) => r.id),
        })),
      },
    };
  });
  return { recipes, slots: emplacements.map((e) => ({ id: e.id, slot: e.slot, name: e.name, icon: e.icon })) };
}

/**
 * Identifiants de paramètres que l'app demande sur son écran de statistiques
 * (`p018b7/e.java`, `readSettingsParameter`). Aucune table de l'APK ne les nomme : le viewmodel les
 * lit par id et affiche le résultat via les propriétés `d7xx_tot_*`. La correspondance
 * id → signification reste donc à établir sur la machine.
 */
const APP_STAT_IDS = [105, 106, 108, 115, 3000, 3001, 3003, 3017, 3021, 3025, 3047, 3048, 3077, 3078, 3080];

/**
 * Plages de balayage des compteurs, `[premier id, quantité]`, une réponse par plage (10 entrées
 * maximum par réponse — voir §12 de `docs/commandes-cafe.md`).
 *
 * **Elles vivaient dans la page `/statistiques`**, donc hors de portée du serveur, qui en a
 * désormais besoin lui aussi pour « tout lire ». Les recopier ici aurait fait deux sources de
 * vérité pour une table de protocole — exactement ce que ce fichier interdit ailleurs. Le serveur
 * les publie donc dans `GET /api/stats` (comme il publie déjà `appIds`), et la page les consomme.
 *
 * `all` exploite le fait que la machine ÉNUMÈRE : un id inexistant renvoie les suivants qui
 * existent, en sautant les trous. C'est ainsi que les 62 paramètres ont été cartographiés.
 */
const STAT_RANGES = {
  known: [[100, 10], [3001, 10], [3017, 10]],
  all: [[100, 10], [3001, 10], [3011, 10], [3021, 10], [3039, 10], [23000, 10], [23009, 10], [43011, 10]],
};

/** Propriétés dont la lecture est couverte par la somme de contrôle « noms » (trame `0xA3`). */
const NAME_PROPS = new Set([...PROFILE_NAME_PROPS, ...CUSTOM_NAME_PROPS].map((x) => x.prop));

/**
 * Marque « cette famille est à jour », posée à la FIN d'un import et seulement s'il a tout lu.
 *
 * Une propriété absente sur ce modèle (variantes Striker) compte comme lue, pas comme un échec :
 * c'est `handleProperty` qui la range dans `ok` avec `absent: true`.
 */
function applyChecksumMark(m, t) {
  const mark = t.meta?.checksumMark;
  if (!mark) return;
  // Une propriété non lue, même une seule, invalide la marque : « à jour » doit vouloir dire que
  // TOUT ce que la somme couvre a bien été relu.
  if (t.nonLus.length) {
    L("sys", "sommes", `non mémorisées : ${t.nonLus.length} propriété(s) sans réponse — la relecture restera proposée`, m);
    return;
  }
  m.store.setMeta("checksumsAtImport", { ...(m.store.getMeta("checksumsAtImport") ?? {}), ...mark });
  L("sys", "sommes", `mémorisée (0x${Number(mark.names).toString(16)}) : inutile de les relire tant qu'elle ne bouge pas`, m);
}

/**
 * Résout l'adresse configurée en IPv4, et dit quel `Host` envoyer.
 *
 * ⚠️ **Le serveur HTTP du module refuse tout `Host` qui n'est pas sa propre adresse IP** : il
 * répond une page 404 à `GET /regtoken.json` si l'en-tête porte un nom d'hôte. Mesuré côte à
 * côte, même destination, seul l'en-tête changeant :
 *
 *     192.168.x.x + `Host: cafe`          → 404
 *     cafe        + `Host: 192.168.x.x`   → 200
 *
 * Un nom d'hôte est donc bien utilisable — c'est même préférable, il survit à un changement de
 * bail DHCP — mais **à condition de le résoudre nous-mêmes** et de mettre l'IP dans `Host`. Sans
 * ça, saisir un nom faisait échouer toutes les requêtes vers la machine avec un 404 qui ressemble
 * à « ce n'est pas la cafetière » : c'est exactement le diagnostic erroné que ça a produit.
 *
 * Le cache évite une résolution par `local_reg`, c'est-à-dire toutes les 2,5 s pendant un
 * programme ; 60 s laisse un changement de bail se propager rapidement.
 */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
async function machineTarget(m) {
  const configured = m.ip;
  if (!configured) return null;
  if (IPV4.test(configured)) return { configured, ip: configured };
  if (m.dns?.configured === configured && Date.now() - m.dns.at < 60000) return m.dns;
  try {
    const { address } = await dnsLookup(configured, { family: 4 });
    if (m.dns?.ip !== address) L("sys", "adresse", `« ${configured} » résolu en ${address}`, m);
    m.dns = { configured, ip: address, at: Date.now() };
  } catch (e) {
    m.dns = {
      configured,
      ip: null,
      // Le message nomme la cause la plus fréquente : en conteneur, un nom court ne bénéficie pas
      // du domaine de recherche DNS de l'hôte.
      error: `nom d'hôte « ${configured} » non résolu (${e.code ?? e.message}) — en conteneur, un nom court n'hérite pas du domaine de recherche DNS de l'hôte : utiliser le nom complet, l'adresse IP, ou dns_search / extra_hosts (voir DOCKER.md)`,
      at: Date.now(),
    };
  }
  return m.dns;
}

/**
 * `SERVER_IP` est l'adresse que nous **annonçons** à la machine dans `local_reg` — c'est elle qui
 * viendra nous chercher. Une adresse de boucle locale y est toujours fausse : la machine se
 * connecterait à elle-même. Et le symptôme est trompeur, parce que rien n'échoue visiblement :
 * `local_reg` répond 202, la file de commandes se remplit, l'interface dit « envoyé », et la
 * session reste « en attente » indéfiniment.
 *
 * Même faute que le `MACHINE_IP` écrit en dur qu'on a retiré : une valeur par défaut qui fait
 * passer un serveur non configuré pour configuré.
 */
const LOOPBACK = /^(127\.|0\.0\.0\.0$|::1$|localhost$)/i;
function serverIpProblem() {
  if (!CFG.serverIp) return "SERVER_IP n'est pas définie";
  if (LOOPBACK.test(CFG.serverIp)) return `SERVER_IP vaut ${CFG.serverIp}, une adresse de boucle locale`;
  return null;
}

/**
 * Adresses IPv4 non locales vues d'ici, pour que le message dise quoi mettre.
 *
 * ⚠️ Dans un conteneur en réseau bridge, ce sont les adresses du CONTENEUR (172.17.x.x) : la
 * machine ne les atteint pas. C'est l'adresse de l'HÔTE qu'il faut annoncer. Le message le dit,
 * plutôt que de laisser croire qu'il suffit de recopier la première ligne.
 */
function candidateServerIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`${a.address} (${name})`);
    }
  }
  return out;
}

/** GET http://<machine>/regtoken.json — le seul endpoint que le module expose hors mode AP. */
async function probeRegtoken(m) {
  // Sans adresse, il n'y a personne à interroger : on répond « injoignable » plutôt que de
  // laisser node:http composer un hôte nul.
  const t = await machineTarget(m);
  if (!t) return { reachable: false, error: "adresse de la machine non configurée", at: Date.now() };
  // `host` est renvoyé avec le résultat : l'adresse peut changer pendant que la requête est en
  // vol, et le résultat doit rester attribuable à l'adresse réellement interrogée.
  const host = t.configured;
  if (!t.ip) return { host, reachable: false, error: t.error, at: Date.now() };
  return new Promise((resolve) => {
    const r = httpRequest({ host: t.ip, port: 80, path: "/regtoken.json", method: "GET", headers: { Host: t.ip } }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => {
        const body = Buffer.concat(c).toString("utf8");
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        // Le corps BRUT est gardé, pas seulement l'objet : le multiplexeur le ressert tel quel aux
        // applications (voir `handleAppRegtoken`). Mesuré le 2026-08-22, la vraie machine répond
        // `{"regtoken":…,"registered":1,"registration_type":"AP-Mode","host_symname":…}` en
        // `text/json` — quatre champs et un type MIME que notre version inventée n'avait pas.
        // Reconstruire cette réponse, c'est se donner une chance de plus de se trahir.
        if (parsed) m.regtokenBrut = { body, at: Date.now() };
        resolve({ host, ip: t.ip, reachable: true, status: res.statusCode, regtoken: parsed, raw: body, at: Date.now() });
      });
    });
    r.on("error", (e) => resolve({ host, ip: t.ip, reachable: false, error: e.message, at: Date.now() }));
    r.setTimeout(4000, () => r.destroy(new Error("timeout")));
    r.end();
  });
}

// --- clé LAN : découverte à la demande via le compte De'Longhi ------------------------------
// Strictement OPTIONNEL et sur action explicite de l'utilisateur. Le pilotage, lui, reste
// 100 % local : une fois la clé obtenue, plus aucun appel au cloud.
/**
 * Reprise de la clé LAN mémorisée lors d'une découverte précédente (table `meta`, clé `lanKey`).
 * C'est du matériel secret : le fichier `data/lan-server.db` doit être traité comme tel.
 */
function restoreLanKey(m) {
  if (m.lanKey.length) return;
  try {
    const s = m.store.getLanKey();
    if (s?.lanip_key && s?.lanip_key_id) {
      m.lanKey = Buffer.from(String(s.lanip_key), "utf8");
      m.lanKeyId = Number(s.lanip_key_id);
      m.lanKeySource = `cache local (découverte du ${new Date(s.at).toISOString().slice(0, 10)})`;
      L("sys", "clé LAN", `reprise du cache (key_id ${m.lanKeyId})`, m);
    }
  } catch {}
}

/**
 * Appel REST Gigya. Le centre de données compte : la clé API De'Longhi est servie par **eu1**
 * (`us1` répond `301001 This API key is served by another data center`). Réglable par
 * `GIGYA_DATACENTER`.
 *
 * Gigya répond toujours HTTP 200 : c'est `errorCode` qui porte le verdict.
 */
async function gigyaCall(method, params) {
  const dc = APP.gigyaDatacenter;
  const r = await fetch(`https://accounts.${dc}.gigya.com/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, format: "json" }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`${method} : réponse illisible (HTTP ${r.status})`);
  // On ne réécrit pas les messages de Gigya : ils sont plus précis que ce qu'on inventerait.
  // Relevés en sonde : 403042 « invalid loginID or password », 301001 mauvais centre de données,
  // 403005 jeton de session refusé.
  if (j.errorCode) {
    const detail = j.errorDetails ? ` — ${j.errorDetails}` : "";
    throw new Error(`${method} (${dc}) : ${j.errorMessage} [${j.errorCode}]${detail}`);
  }
  return j;
}

/**
 * Obtient la clé LAN de la machine à partir des identifiants du compte De'Longhi.
 *
 * Quatre sauts, tous vérifiés contre les vrais serveurs (voir ETAT.md) :
 *   1. Gigya `accounts.login`      e-mail + mot de passe → `sessionInfo.cookieValue`
 *   2. Gigya `accounts.getJWT`     `login_token`         → `id_token` (JWT RS256)
 *   3. Ayla  `token_sign_in.json`  JWT + app_id/secret   → `access_token` (24 h)
 *   4. Ayla  `dsns/<DSN>/lan.json` access_token          → `lanip_key` + `lanip_key_id`
 *
 * Un `jwt` déjà en main (celui que `docs/secrets.md` documente, valable 90 jours) court-circuite
 * les deux premiers sauts — c'est aussi ce qui permet de tester la moitié Ayla sans mot de passe.
 *
 * ⚠️ **Le mot de passe ne sort pas de cette fonction** : il n'est ni journalisé, ni mémorisé, ni
 * renvoyé. Les jetons intermédiaires (session Gigya, JWT, token Ayla) ne sont pas conservés non
 * plus — seule la clé LAN l'est, dans `data/lan-server.db` (table `meta`, clé `lanKey`, gitignoré).
 *
 * Les valeurs statiques de l'APK (clé API Gigya, app_id/app_secret Ayla) ne sont plus à saisir :
 * elles ne sont pas secrètes et vivent dans `src/lib/cloud-app.json`. Voir `APP`.
 */
/**
 * Jeton d'accès Ayla à partir des identifiants du compte De'Longhi. Trois sauts, tous vérifiés
 * contre les vrais serveurs (voir ETAT.md) :
 *
 *   1. Gigya `accounts.login`      e-mail + mot de passe → `sessionInfo.cookieValue`
 *   2. Gigya `accounts.getJWT`     `login_token`         → `id_token` (JWT RS256)
 *   3. Ayla  `token_sign_in.json`  JWT + app_id/secret   → `access_token` (24 h)
 *
 * Extrait de la récupération de clé parce que **deux** usages en ont besoin : `dsns/<DSN>/lan.json`
 * pour la clé, et `dsns/<DSN>/ota.json` pour savoir si une mise à jour est proposée. Le jeton
 * n'est **jamais mémorisé** : il vit le temps de la requête, comme le mot de passe.
 *
 * ⚠️ **PAS de `targetEnv: "mobile"`.** Sondé sur les vrais serveurs, avec le même compte :
 *   targetEnv=mobile  → sessionInfo = { sessionToken, sessionSecret, expires_in }
 *   défaut (browser)  → sessionInfo = { cookieName, cookieValue }
 * Une session mobile est une session OAuth1 : son `sessionToken` sert à SIGNER les requêtes
 * suivantes, ce n'est pas un `login_token`. Le passer tel quel à `accounts.getJWT` répond
 * « Unauthorized user [403005] » — c'est exactement ce qui faisait échouer la découverte alors que
 * l'app Android fonctionnait (elle, elle signe, via le SDK Gigya mobile).
 */
/**
 * Session cloud mémorisée : le `refresh_token` rendu par `token_sign_in.json`.
 *
 * Rangée dans `settings`, pas dans le `meta` d'une machine : c'est un identifiant de **compte**, pas
 * d'appareil, et deux machines du même compte n'ont pas à en garder deux copies.
 *
 * ⚠️ **C'est le seul secret de niveau COMPTE que ce serveur puisse écrire sur le disque**, et il ne
 * l'écrit que sur demande explicite (`remember: true`). La clé LAN, elle, ne donne que le pilotage
 * local d'une cafetière, et encore faut-il être sur le réseau. Un `refresh_token` agit sur le compte
 * De'Longhi jusqu'à sa révocation. Aucun endpoint ne le renvoie — seulement sa présence et sa date.
 */
const cloudSession = () => getSetting("aylaRefresh");
function rememberCloudSession(refresh) {
  if (!refresh) return;
  setSetting("aylaRefresh", { token: String(refresh), at: Date.now() });
}
function forgetCloudSession() {
  const had = cloudSession() !== null;
  clearSetting("aylaRefresh");
  for (const m of MACHINES.values()) m.aylaToken = null;
  return had;
}

/**
 * Renouvelle un jeton d'accès à partir du `refresh_token`, sans Gigya ni mot de passe.
 *
 * Chemin et forme du corps **vérifiés** contre ce déploiement : avec un jeton bidon, Ayla répond
 * « HTTP 401 Your refresh token is not found » — une réponse applicative, là où un mauvais chemin
 * aurait donné un 404. Reste non éprouvé : le chemin heureux, qui demande un vrai `refresh_token`.
 *
 * En cas d'échec on **oublie** la session mémorisée. Garder un jeton dont on ne sait pas s'il vaut
 * quelque chose ne ferait que retarder la demande de mot de passe en la rendant incompréhensible —
 * et c'est vérifié aussi : après un renouvellement refusé, `/api/cloudsession` repasse à `set:
 * false` et l'appel se termine par un 400 qui réclame les identifiants.
 */
async function refreshAylaToken(m) {
  const s = cloudSession();
  if (!s?.token) return null;
  try {
    const r = await fetch(`${APP.aylaUserUrl}${APP.aylaRefreshPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: { refresh_token: s.token } }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    if (!j?.access_token) throw new Error(`HTTP ${r.status}${j?.error ? " " + j.error : ""}`);
    // Ayla fait tourner le refresh_token : garder l'ancien le rendrait inutilisable au coup suivant.
    rememberCloudSession(j.refresh_token ?? s.token);
    L("sys", "cloud", "jeton renouvelé depuis la session mémorisée (sans mot de passe)", m);
    return { token: j.access_token, expiresIn: Number(j.expires_in) || 0 };
  } catch (e) {
    L("sys", "cloud", `renouvellement impossible (${e.message}) — session mémorisée oubliée, le mot de passe sera redemandé`, m);
    forgetCloudSession();
    return null;
  }
}

/**
 * Jeton d'accès Ayla, par la voie la moins coûteuse disponible.
 *
 *   1. celui qu'on a déjà **en mémoire**, s'il n'est pas expiré — aucun appel réseau ;
 *   2. le `refresh_token` mémorisé, s'il y en a un — un appel à Ayla, ni Gigya ni mot de passe ;
 *   3. les identifiants du compte — les quatre sauts complets ;
 *   4. `AYLA_TOKEN` — pour qui en a déjà un sous la main.
 *
 * Le niveau 1 ne survit pas au processus, et c'est voulu. Le niveau 2 n'existe que si l'utilisateur
 * l'a demandé (`remember`). Les niveaux 3 et 4 ne conservent rien.
 */
async function aylaToken(m, { email, password, jwt, remember } = {}) {
  const marge = 60000; // on ne repart pas avec un jeton qui expire pendant la requête
  if (m.aylaToken && Date.now() + marge < m.aylaToken.expiresAt) return m.aylaToken.token;

  if (email || jwt) {
    const t = await aylaAccessToken(m, { email, password, jwt, remember });
    return t;
  }
  const renouvele = await refreshAylaToken(m);
  if (renouvele) {
    m.aylaToken = { token: renouvele.token, expiresAt: Date.now() + (renouvele.expiresIn || 3600) * 1000 };
    return renouvele.token;
  }
  return process.env.AYLA_TOKEN || null;
}

async function aylaAccessToken(m, { email, password, jwt: givenJwt, remember = false }) {
  const apiKey = APP.gigyaApiKey;
  const appId = APP.aylaAppId;
  const appSecret = APP.aylaAppSecret;
  // Le contrôle reste utile bien que les valeurs soient fournies par défaut : une variable mise à
  // la chaîne vide — ou un cloud-app.json amputé — doit dire pourquoi l'appel ne part pas, plutôt
  // que d'échouer trois requêtes plus loin sur un message de Gigya.
  // (Un JWT fourni court-circuite Gigya : seules les valeurs Ayla sont alors nécessaires.)
  const missing = [
    !givenJwt && !apiKey && "clé API Gigya",
    !appId && "app_id Ayla",
    !appSecret && "app_secret Ayla",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`configuration de découverte incomplète : ${missing.join(", ")} — valeurs statiques de l'APK, normalement fournies par src/lib/cloud-app.json`);
  }

  let jwt = givenJwt;
  if (jwt) {
    L("sys", "cloud", "JWT fourni, Gigya court-circuité", m);
  } else {
    L("sys", "cloud", "connexion au compte De'Longhi…", m);
    const login = await gigyaCall("accounts.login", { apiKey, loginID: email, password });
    // Uniquement `cookieValue` : l'ancien repli sur `sessionToken` ne rattrapait rien, il
    // transmettait un jeton du mauvais type au lieu d'échouer avec un message clair.
    const loginToken = login?.sessionInfo?.cookieValue;
    if (!loginToken) throw new Error("accounts.login : pas de sessionInfo.cookieValue dans la réponse (session non navigateur ?)");
    jwt = (await gigyaCall("accounts.getJWT", { apiKey, login_token: loginToken }))?.id_token;
    if (!jwt) throw new Error("accounts.getJWT : aucun id_token dans la réponse");
    L("sys", "cloud", "identité De'Longhi obtenue, échange vers Ayla…", m);
  }

  const tr = await fetch(`${APP.aylaUserUrl}/api/v1/token_sign_in.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: jwt, app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(20000),
  });
  const tj = await tr.json().catch(() => null);
  const accessToken = tj?.access_token;
  if (!accessToken) throw new Error(`token_sign_in : pas de access_token (HTTP ${tr.status}${tj?.error ? " " + tj.error : ""})`);
  // Gardé en mémoire pour la durée annoncée : deux appels d'affilée ne refont pas les quatre sauts.
  m.aylaToken = { token: accessToken, expiresAt: Date.now() + (Number(tj.expires_in) || 3600) * 1000 };
  // Le refresh_token n'est écrit que si on l'a demandé. Voir cloudSession() pour ce que ça implique.
  if (remember) {
    if (tj.refresh_token) rememberCloudSession(tj.refresh_token);
    else L("sys", "cloud", "aucun refresh_token dans la réponse — la session ne peut pas être mémorisée", m);
  }
  return accessToken;
}

/**
 * Interroge `dsns/<DSN>/ota.json` : Ayla y tient la mise à jour proposée pour cet appareil.
 *
 * C'est la **seule** façon de savoir si une image existe en amont : le module n'expose que
 * `regtoken.json` hors mode point d'accès, et les requêtes OTA qu'il nous adresse
 * (`S.otaRequests`) disent qu'il en veut une, pas qu'il en existe une.
 *
 * Le **résultat** est mémorisé (`meta.otaCheck`), pas le jeton : une page qui s'ouvre ne doit
 * déclencher aucun appel au cloud, et rien ne doit rester qui puisse en déclencher un plus tard.
 */
async function checkCloudOta(m, token) {
  if (!m.dsn) throw new Error("DSN inconnu : la fiche OTA est rangée chez Ayla sous le numéro de série de la machine.");
  const r = await fetch(`${APP.aylaDeviceUrl}/apiv1/dsns/${m.dsn}/ota.json`, {
    headers: { Authorization: `auth_token ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const texte = await r.text();
  let corps = null;
  try { corps = JSON.parse(texte); } catch {}
  // Ayla répond 404 quand il n'y a rien à proposer, 200 avec la fiche sinon. `ota` est la clé
  // observée dans la réponse ; on garde le corps entier, la forme exacte n'étant pas documentée.
  const ota = corps?.ota ?? corps ?? null;
  const disponible = r.status === 200 && !!ota && Object.keys(ota).length > 0;
  const releve = {
    at: Date.now(),
    status: r.status,
    updateAvailable: disponible,
    version: ota?.version ?? ota?.ota_version ?? null,
    type: ota?.type ?? null,
    body: corps,
  };
  m.store.setMeta("otaCheck", releve);
  L("sys", "OTA", `${disponible ? `image proposée${releve.version ? ` (${releve.version})` : ""}` : `aucune mise à jour (HTTP ${r.status})`}`, m);
  return releve;
}

/**
 * **Rapatrie les photos de grains que l'application officielle a laissées dans le cloud.**
 *
 * Troisième usage du jeton Ayla, après `lan.json` (clé LAN) et `ota.json` : même hôte, même en-tête
 * d'autorisation, un chemin de plus.
 *
 *     GET {aylaDeviceUrl}/apiv1/dsns/<DSN>/data/BS<index>IMG.json
 *       → { "datum": { "key": "BS3IMG", "value": "<base64 d'un JPEG>", … } }
 *
 * ## La clé, et pourquoi elle ne se devine pas
 *
 * `DeLonghiWifiConnectService.R(int)` formate `String.format("BS%sIMG", bArr[4])` où `bArr` est la
 * trame `0xBA` de l'emplacement demandé. Et l'octet 4 est **exactement** ce que nous appelons
 * `index` : `profiles.mjs` le lit sous `index: buf[4]`, et `p097j6/d.G0` construit son `BeanSystem`
 * avec `bArr[4]` comme identifiant. Les trois lectures concordent, donc l'emplacement 3 correspond
 * à `BS3IMG` — sans table de correspondance intermédiaire, qui aurait été la pièce à se tromper.
 *
 * ## Ce que ça écrase, et ce que ça n'est pas
 *
 * L'image atterrit sous `s<index>`, la même clé qu'une photo cadrée ici : un import **remplace**
 * donc la photo locale de cet emplacement. C'est voulu — deux photos pour un emplacement
 * demanderaient de choisir laquelle s'affiche, or il n'y a qu'une chose à montrer — mais c'est
 * destructif, d'où la confirmation côté interface.
 *
 * Ces octets ne sont pas au format commun du dépôt : voir `decoderBase64Nu`, qui le dit en détail.
 *
 * ## Ce que le cloud répond quand il n'y a rien
 *
 * Un datum absent donne un **404**, et c'est un cas NORMAL : un grain sans photo dans l'app n'a pas
 * de datum du tout (l'app affiche alors son illustration `ba_default_image`). Compté comme « rien à
 * importer », jamais comme une panne — sinon un import partiel se lirait comme un échec.
 *
 * Rend un relevé par emplacement demandé : `{ index, statut, mime?, octets?, erreur? }`.
 */
async function importerPhotosCloud(m, token, indices) {
  if (!m.dsn) throw new Error("DSN inconnu : les photos sont rangées chez Ayla sous le numéro de série de la machine.");
  const releves = [];
  for (const index of indices) {
    const cle = `BS${index}IMG`;
    let r;
    try {
      r = await fetch(`${APP.aylaDeviceUrl}/apiv1/dsns/${m.dsn}/data/${cle}.json`, {
        headers: { Authorization: `auth_token ${token}` },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      releves.push({ index, statut: "error", erreur: `réseau : ${e.message}` });
      continue;
    }
    if (r.status === 404) { releves.push({ index, statut: "absent" }); continue; }
    if (!r.ok) { releves.push({ index, statut: "error", erreur: `HTTP ${r.status}` }); continue; }
    let valeur = null;
    try {
      valeur = (await r.json())?.datum?.value ?? null;
    } catch {
      releves.push({ index, statut: "error", erreur: "réponse illisible (JSON attendu)" });
      continue;
    }
    // Un datum peut exister et être vide : l'app le crée puis le vide quand on retire la photo.
    if (!valeur || String(valeur).trim() === "") { releves.push({ index, statut: "absent" }); continue; }
    let img;
    try {
      img = decoderBase64Nu(String(valeur));
    } catch (e) {
      // On dit ce qui a été refusé et pourquoi, plutôt que de ranger des octets douteux dans la
      // base : le message vient de `decoderBase64Nu` et est destiné à être lu.
      releves.push({ index, statut: "refused", erreur: e.message });
      continue;
    }
    m.store.putBeanImage(ID_VISUEL_EMPLACEMENT(index), img.mime, img.bytes);
    releves.push({ index, statut: "imported", mime: img.mime, octets: img.bytes.length });
  }
  const importees = releves.filter((x) => x.statut === "imported");
  L(
    "sys",
    `import des photos de grains depuis le cloud : ${importees.length} importée(s)` +
      `, ${releves.filter((x) => x.statut === "absent").length} absente(s)` +
      `, ${releves.filter((x) => x.statut === "refused").length} refusée(s)` +
      `, ${releves.filter((x) => x.statut === "error").length} en erreur` +
      (importees.length ? ` — ${importees.map((x) => `#${x.index} ${x.mime} ${Math.round(x.octets / 1024)} kio`).join(", ")}` : ""),
    m,
  );
  return releves;
}

async function discoverLanKey(m, { email, password, jwt: givenJwt, remember = false }) {
  // **Un clic mérite une vraie tentative, et une seule.** `resolveDsn` s'étrangle à une sonde par
  // 30 s pour ne pas marteler la machine depuis les rafraîchissements de page — appliqué à une
  // action explicite, cet étranglement renvoyait un refus SANS avoir rien tenté, jusqu'à 30 s
  // après le clic précédent. `force` lève l'étranglement ; un DSN déjà en cache ne coûte toujours
  // aucune sonde.
  const dsn = await resolveDsn(m, { force: true });
  // Le DSN est la seule dépendance de la découverte envers la machine — et une fois mémorisé,
  // elle n'a plus besoin d'elle du tout. Le refus doit donc nommer la cause, pas réciter la liste
  // des causes possibles.
  if (!dsn) throw new Error(`DSN inconnu, et la clé est rangée chez Ayla sous ce numéro : ${raisonDsnManquant(m)}`);

  const accessToken = await aylaAccessToken(m, { email, password, jwt: givenJwt, remember });

  L("sys", "clé LAN", `lecture de lan.json pour ${dsn}…`, m);
  const lr = await fetch(`${APP.aylaDeviceUrl}/apiv1/dsns/${dsn}/lan.json`, {
    headers: { Authorization: `auth_token ${accessToken}` },
    signal: AbortSignal.timeout(20000),
  });
  const lj = await lr.json().catch(() => null);
  const lanip = lj?.lanip;
  if (!lanip?.lanip_key || lanip?.lanip_key_id === undefined) {
    throw new Error(`lan.json : réponse inattendue (HTTP ${lr.status})`);
  }
  // Le même jeton ouvre la fiche OTA : on la relève au passage, ce qui rend la vérification
  // gratuite au moment où l'on a de toute façon parlé au cloud. Au mieux disant : un échec ici ne
  // doit pas faire échouer la récupération de la clé, qui est le but de l'appel.
  let ota = null;
  try { ota = await checkCloudOta(m, accessToken); } catch (e) { L("sys", "OTA", `relevé impossible (${e.message})`, m); }
  return { key: String(lanip.lanip_key), keyId: Number(lanip.lanip_key_id), status: lanip.status, keepAlive: lanip.keep_alive, ota };
}

/**
 * Applique une clé LAN fraîchement obtenue. La session en cours a été dérivée de l'ANCIENNE clé :
 * elle devient inutilisable, on la jette pour forcer un nouveau key exchange.
 */
function applyLanKey(m, { key, keyId }, source) {
  const changed = key !== m.lanKey.toString("utf8") || keyId !== m.lanKeyId;
  m.lanKey = Buffer.from(key, "utf8");
  m.lanKeyId = keyId;
  m.lanKeySource = source;
  if (changed && m.session) {
    m.session = null;
    L("sys", "clé LAN", "changée : session LAN abandonnée, un nouveau key exchange est nécessaire", m);
  }
  m.store.setLanKey(key, keyId);
  L("sys", "clé LAN", `${changed ? "mise à jour" : "confirmée"} (key_id ${keyId}, source : ${source})`, m);
  return changed;
}

/**
 * Résout le DSN. Trois sources, par ordre de priorité :
 *
 *   1. `MACHINE_DSN` dans `.env.local` — un réglage explicite gagne toujours ;
 *   2. **la machine elle-même** : `GET /regtoken.json` (le seul endpoint que le module expose hors
 *      mode AP) renvoie `host_symname`, qui EST le DSN — vérifié sur cette machine. Sans
 *      authentification, sans cloud ;
 *   3. le cache local (`restoreDsn`), pour redémarrer quand la machine ne répond pas.
 *
 * `compare: true` interroge la machine même si le DSN est déjà connu, pour signaler une divergence
 * au lieu de la laisser passer.
 *
 * L'étranglement (`dsnLastTry`) et le dédoublonnage du verdict (`dsnLastMsg`) sont portés par la
 * MACHINE, pas par le module : sinon la sonde de l'une servirait de cache à l'autre, et le
 * verdict de l'une ferait taire celui de sa voisine.
 */
/**
 * **Pourquoi le DSN manque — trois causes, trois réparations.**
 *
 * Le refus disait « Renseigner l'adresse de la machine (page Machines), ou forcer MACHINE_DSN »
 * dans tous les cas, y compris quand l'adresse ÉTAIT enregistrée et que c'est la cafetière qui
 * n'avait pas répondu. Il envoyait alors refaire ce qui venait d'être fait, et la vraie cause —
 * appareil hors tension ou hors réseau — restait dans le journal. Relevé sur l'installation
 * réelle : adresse (IP_MACHINE) enregistrée, sonde en timeout, et l'utilisateur renvoyé vers son
 * .env.local.
 *
 * La sonde a déjà tranché ; on ne fait que lire son verdict.
 */
function raisonDsnManquant(m) {
  if (!m.ip) {
    return "aucune adresse de machine n'est enregistrée, donc le serveur ne sait pas qui interroger. Renseignez-la sur la page « Machines », ou forcez MACHINE_DSN dans .env.local.";
  }
  const r = m.dsnLastProbe;
  if (r?.reachable) {
    return `quelque chose répond à ${m.ip} (HTTP ${r.status ?? "?"} sur /regtoken.json) mais n'annonce aucun numéro de série : ce n'est probablement pas la cafetière. Vérifiez l'adresse sur la page « Machines ».`;
  }
  return `la machine n'a pas répondu à ${m.ip}${r?.error ? ` (${r.error})` : ""}. Son numéro de série ne se lit que sur elle : vérifiez qu'elle est alimentée au secteur et joignable depuis ce serveur, ou forcez MACHINE_DSN dans .env.local pour vous en passer.`;
}

async function resolveDsn(m, { compare = false, force = false } = {}) {
  if (m.dsn && !compare) return m.dsn;
  // Sans cela, la resolution paresseuse en tete de handleApi lance une sonde de 4 s a CHAQUE
  // appel d API tant que le DSN est inconnu — or les pages interrogent /api/status toutes les
  // 3 s. Resultat : le reseau martele et le journal noye sous des lignes identiques. Une
  // tentative toutes les 30 s suffit ; `compare` (action explicite) n est jamais bride.
  // `force` lève l'étranglement — et rien d'autre : contrairement à `compare`, il ne fait pas
  // resonder une machine dont le DSN est déjà connu (le garde ci-dessus a déjà rendu la main).
  // C'est ce qu'il faut pour une action explicite : au plus une sonde, jamais zéro.
  if (!compare) {
    if (!force && Date.now() - m.dsnLastTry < 30000) return m.dsn;
    m.dsnLastTry = Date.now();
  }
  const r = await probeRegtoken(m);
  m.dsnLastProbe = r;
  // L'adresse a pu changer pendant la requête (saisie d'une nouvelle machine, oubli). Attribuer
  // le DSN d'un ancien appareil à la nouvelle adresse serait faux — et c'est arrivé : une sonde
  // lancée au démarrage a repeuplé, 186 ms plus tard, un DSN qu'un changement d'adresse venait
  // d'effacer.
  if (r?.host && r.host !== m.ip) {
    L("sys", "sonde", `ignorée : la réponse venait de ${r.host}, l'adresse est maintenant ${m.ip ?? "inconnue"}`, m);
    return m.dsn;
  }
  const found = r?.regtoken?.host_symname;
  if (typeof found !== "string" || !/^[A-Za-z0-9-]{6,}$/.test(found)) {
    // « Joignable » ne veut pas dire « c'est la machine » : n'importe quel serveur HTTP à cette
    // adresse répond quelque chose. Distinguer les deux cas est ce qui rend le diagnostic possible.
    // Ne pas répéter le même verdict toutes les 30 s : sur un serveur mal configuré, ce message
    // remplissait le journal du conteneur indéfiniment. On le redit quand la RAISON change.
    if (!m.dsn && m.ip) {
      const msg = r?.reachable
        ? `DSN inconnu : ${r.host} a répondu HTTP ${r.status} à /regtoken.json, mais sans host_symname — ce n'est probablement pas la cafetière`
        : `DSN inconnu : aucune réponse de ${r?.host ?? "(adresse non configurée)"} (${r?.error ?? "pas de détail"}), et MACHINE_DSN n'est pas défini`;
      if (msg !== m.dsnLastMsg) {
        m.dsnLastMsg = msg;
        L("sys", "DSN", msg, m);
      }
    }
    return m.dsn;
  }
  if (m.dsn && m.dsn !== found) {
    L("sys", "DSN", `divergent : ${m.dsnSource} donne ${m.dsn}, la machine annonce ${found}. Le réglage explicite reste prioritaire — retirer MACHINE_DSN de .env.local pour suivre la machine.`, m);
  } else if (!m.dsn) {
    m.dsnLastMsg = null;
  m.dsn = found;
    m.dsnSource = "lu sur la machine";
    L("sys", "DSN", `découvert sur la machine : ${found}`, m);
  }
  // Mémorisé pour pouvoir redémarrer sans la machine.
  try { m.store.setMeta("dsn", { value: found, at: Date.now() }); } catch {}
  return m.dsn;
}

/**
 * Adresse de la machine : nom d'hôte ou IPv4. On accepte les deux, et un nom d'hôte protège d'un
 * changement de bail DHCP — mais il est **résolu par nous** avant chaque requête, parce que le
 * module refuse un en-tête `Host` qui ne soit pas son IP. Voir `machineTarget()`.
 */
const MACHINE_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
function validMachineHost(v) {
  return typeof v === "string" && MACHINE_HOST_RE.test(v.trim());
}

/** Reprise de l'adresse saisie précédemment. `MACHINE_IP` reste prioritaire. */
function restoreMachineIp(m) {
  if (m.ip) return;
  try {
    const saved = m.store.getMeta("machineIp");
    if (saved?.value) {
      m.ip = saved.value;
      m.ipSource = "saisie dans l'interface";
      L("sys", "adresse", `reprise du cache : ${saved.value}`, m);
    }
  } catch {}
}

/**
 * Applique une adresse saisie. Changer de machine invalide deux choses dérivées de l'ancienne :
 * la session LAN (dérivée d'un échange de clés avec elle) et le DSN mémorisé, qui est le numéro
 * de série de l'ANCIEN appareil. Un `MACHINE_DSN` explicite, lui, reste prioritaire.
 */
function applyMachineIp(m, ip) {
  const value = ip.trim();
  const changed = value !== m.ip;
  // On n'efface le DSN que si l'on REMPLACE une adresse connue par une autre : ce peut alors être
  // un autre appareil. Passer de « aucune adresse » à une adresse n'indique rien de tel — et
  // l'effacer là faisait perdre un DSN parfaitement valide juste après un oubli d'adresse, laissant
  // la récupération de clé sans rien à quoi se raccrocher.
  const remplace = changed && m.ip !== null;
  if (changed) m.dns = null; // sinon un nom réutilisé garderait l'IP de l'ancien appareil
  m.ip = value;
  m.ipSource = "saisie dans l'interface";
  m.store.setMeta("machineIp", { value, at: Date.now() });
  if (remplace) {
    m.session = null;
    if (!envForced(m, "dsn")) {
      m.dsn = null;
      m.dsnSource = "inconnu";
      m.store.clearMeta("dsn");
    }
    L("sys", "adresse", `changée : ${value} — session et DSN mémorisé abandonnés`, m);
  } else {
    L("sys", "adresse", `confirmée : ${value}`, m);
  }
  return changed;
}

/** Reprise du DSN mémorisé, avant toute interrogation de la machine. */
function restoreDsn(m) {
  if (m.dsn) return;
  try {
    const saved = m.store.getMeta("dsn");
    if (saved?.value) {
      m.dsn = saved.value;
      m.dsnSource = "cache local";
      L("sys", "DSN", `repris du cache : ${saved.value}`, m);
    }
  } catch {}
}

/**
 * Enregistre l'identification déduite de `d270_serialnumber`, **et applique le catalogue**.
 *
 * Le modèle détecté commande désormais la liste des boissons. Ce qui rend la bascule sûre, et qui
 * a demandé de relire l'app pour en être certain : la numérotation des propriétés Ayla ne dépend
 * PAS du modèle. C'est un espace de noms De'Longhi figé, par nom de boisson (voir `beverages.mjs`).
 * Un commentaire de cette fonction affirmait le contraire — que le pas de 21 était « le nombre de
 * recettes standard du modèle » — et refusait la bascule sur cette base. C'était une inférence
 * fausse : le 21 est une constante de l'app.
 *
 * Corollaire : basculer ne périme aucune lecture déjà faite, puisque les noms ne bougent pas.
 */
function applyIdentity(m, b64) {
  const r = identifyModel(b64);
  if (!r.ok) {
    m.identity = { at: Date.now(), ok: false, reason: r.reason, hex: r.hex };
    L("in", `${SERIAL_PROP}`, r.reason, m, b64);
    return;
  }
  m.identity = { at: Date.now(), ok: true, serial: r.serial, machineName: r.machineName, modelKey: r.modelKey, hex: r.hex };
  // La propriété est rangée comme les autres : `/api/system` expose déjà
  // `machineState.serialNumber` depuis `props.d270_serialnumber`, et la trame brute permet de
  // rejuger la découpe sans redemander à la machine.
  m.store.putProp(SERIAL_PROP, { at: Date.now(), kind: "serialNumber", serial: r.serial, machineName: r.machineName, modelKey: r.modelKey, hex: r.hex });
  m.store.setMeta("model", { key: r.modelKey, serial: r.serial, machineName: r.machineName, at: Date.now() });
  if (!envForced(m, "modelKey")) {
    m.modelKey = r.modelKey;
    m.modelSource = "lu sur la machine";
  }
  const lu = r.model
    ? `${r.model.type} — ${r.model.appModelId}, ${r.model.recipeCount} recettes, ${r.model.nProfiles} profils`
    : `modèle absent de la table v${MODELS_TABLE_VERSION} (${Object.keys(MODELS).length} modèles connectés connus)`;
  L("in", `${SERIAL_PROP}`, `${r.machineName} → clé ${r.modelKey} → ${lu}`, m, b64);
  applyCatalog(m);
}

/**
 * Première lecture d'une machine, dès qu'elle devient possible : son **modèle** et les **noms**
 * qu'elle porte (profils, recettes personnalisées).
 *
 * Les deux passent par une lecture de propriété Ayla, donc par une session chiffrée, donc par la
 * clé LAN. C'est pourquoi rien de tout cela ne peut être calculé au moment où l'on **ajoute** une
 * machine : à cet instant on n'a que son adresse et le DSN qu'elle vient de donner.
 *
 * Le premier moment possible est celui où le SECOND prérequis tombe, dans un sens ou dans l'autre :
 * clé obtenue alors que l'adresse était déjà là, ou adresse saisie alors que la clé venait de
 * l'environnement. D'où l'appel depuis ces deux endroits, et un garde qui rend l'ordre indifférent.
 *
 * La file est construite à partir de ce qui **manque**, propriété par propriété : la fonction est
 * donc idempotente sans avoir besoin d'un drapeau « déjà fait », et une machine dont le modèle est
 * connu mais les noms pas encore lus obtient quand même ses noms.
 *
 * Ce sont des LECTURES : rien n'est préparé, rien n'est écrit sur la machine. On ne passe pas
 * par-dessus un import ou un programme en cours — `startImport` écraserait la file.
 *
 * ⚠️ Volontairement, cet import ne pose **aucune** marque « sommes à jour » (`checksumMark`). Le
 * faire ici obligerait à répliquer la règle de `/api/profiles/import`, et une marque posée à tort
 * fait sauter la relecture des noms jusqu'à un `force: true` — le coût d'une lecture inutile est
 * sans commune mesure avec celui d'un nom jamais relu.
 */
async function maybeInitialRead(m) {
  if (!m.ip || !m.lanKey.length) return null;
  // Plus de refus quand quelque chose tourne : la file encaisse, et la clé de fusion empêche deux
  // lectures initiales identiques de coexister. C'est précisément ce que l'écrasement interdisait.
  const queue = [];
  if (!m.modelKey) queue.push(SERIAL_PROP);
  // Les noms de profils ET ceux des recettes personnalisées : même famille de trames, même somme
  // de contrôle, et ce sont eux qui font qu'un emplacement renommé sur la machine s'affiche sous
  // son nom partout (`readNames`).
  for (const x of [...PROFILE_NAME_PROPS, ...CUSTOM_NAME_PROPS]) {
    // Une propriété déjà lue compte comme lue, même si elle a répondu vide : `absent: true` est une
    // réponse, pas un échec.
    if (!m.store.getProp(x.prop)) queue.push(x.prop);
  }
  if (!queue.length) return null;
  L("sys", "lecture", `adresse et clé LAN réunies : première lecture (${queue.length} propriétés — modèle et noms)`, m);
  startImport(m, queue, 0, { label: "Première lecture (modèle et noms)", cle: "initiale", i18n: { k: "initialRead" } });
  await postLocalReg(m);
  return queue;
}

/** Le modèle survit à un redémarrage : sinon la page Système redeviendrait muette hors session. */
function restoreModel(m) {
  if (m.modelKey) return;
  try {
    const saved = m.store.getMeta("model");
    if (!saved?.key) return;
    m.modelKey = saved.key;
    m.modelSource = "cache local";
    const modele = findModel(saved.key);
    m.identity = { at: saved.at ?? null, ok: true, serial: saved.serial ?? null, machineName: saved.machineName ?? null, modelKey: saved.key, hex: null, restored: true };
    L("sys", "modele", `repris du cache : ${saved.key}${modele ? ` (${modele.type})` : " (inconnu de la table)"}`, m);
    applyCatalog(m);
  } catch {}
}

/** Ce que les pages affichent : le modèle lu, le catalogue actif, et l'écart entre les deux. */
function modelState(m) {
  const detected = m.modelKey ? findModel(m.modelKey) : null;
  const cat = m.catalog;
  const catalogKey = cat.key;
  return {
    key: m.modelKey,
    source: m.modelSource,
    serialProp: SERIAL_PROP,
    tableVersion: MODELS_TABLE_VERSION,
    knownModels: Object.keys(MODELS).length,
    detected,
    // Le catalogue réellement utilisé pour bâtir les trames et nommer les propriétés.
    catalog: {
      key: catalogKey,
      productCode: cat.model.productCode,
      type: cat.model.type,
      appModelId: cat.model.appModelId,
      nProfiles: cat.model.nProfiles,
      nStandardRecipes: cat.model.nStandardRecipes,
      nCustomRecipes: cat.model.nCustomRecipes,
      nBeverages: cat.beverages.length,
      support: cat.support,
      /** Vrai si le catalogue est un pis-aller : le modèle détecté n'était pas exploitable. */
      fallback: cat.fallback,
      /** Boissons listées par le modèle mais qu'aucune propriété connue n'adresse. */
      unaddressable: cat.unaddressable,
    },
    // null = pas encore lu. false = le modèle détecté n'a pas pu être appliqué.
    matchesCatalog: m.modelKey ? m.modelKey === catalogKey : null,
    serial: m.identity?.serial ?? null,
    machineName: m.identity?.machineName ?? null,
    at: m.identity?.at ?? null,
    restored: m.identity?.restored === true,
    lastError: m.identity && m.identity.ok === false ? { reason: m.identity.reason, hex: m.identity.hex } : null,
  };
}

/**
 * Ce qu'on sait de l'OTA côté cloud : le **dernier relevé mémorisé**, jamais une requête.
 *
 * Avant, ouvrir la page Système déclenchait un appel au cloud à chaque affichage — pour un projet
 * dont l'objet est le pilotage local, c'est le mauvais réglage par défaut. La vérification est
 * maintenant une action explicite (`POST /api/ota`), et cette fonction ne fait que rapporter.
 */
function cloudOtaState(m) {
  return {
    // Vrai si une vérification peut partir sans rien demander à l'utilisateur.
    tokenConfigured: !!process.env.AYLA_TOKEN,
    last: m.store.getMeta("otaCheck"),
  };
}

/**
 * Le profil actif est une **intention de notre part**, pas une observation : la machine ne
 * l'expose pas (aucune réponse à `d286_mach_sett_profile`), et l'app officielle ne le lit pas
 * davantage — `EcamMachine.B()` renvoie un état local initialisé à 1. On persiste donc le dernier
 * profil qu'on a imposé, pour ne pas repartir d'un « profil 1 » faux après un redémarrage du
 * serveur, tout en gardant `confirmed` qui dit s'il vient d'une commande réelle.
 */
function rememberActiveProfile(m) {
  try {
    m.store.setMeta("activeProfile", { id: m.activeProfile, confirmed: m.activeProfileConfirmed, at: Date.now() });
  } catch {}
}

function restoreActiveProfile(m) {
  try {
    const saved = m.store.getMeta("activeProfile");
    if (saved?.id) {
      m.activeProfile = saved.id;
      m.activeProfileConfirmed = saved.confirmed === true;
      L("sys", "profil", `restauré : ${saved.id}${saved.confirmed ? "" : " (non confirmé)"}`, m);
    }
  } catch {}
}

/**
 * Balayage des grains : **une tâche, un pas `0xBA` par index**.
 *
 * C'étaient six programmes indépendants, enchaînés par `setTimeout(11000)` — un intervalle deviné.
 * Trois défauts en découlaient : les 2 s de vide entre deux grains, où plus rien n'était « actif » ;
 * l'impossibilité de dire « 3 sur 6 » ailleurs que dans un état ad hoc ; et surtout, n'importe
 * quelle autre demande arrivant entre-temps écrasait le programme en cours et décapitait le
 * balayage. En une tâche, les pas s'enchaînent **à la réponse de la machine**, le rythme est le
 * sien, et une commande qui s'intercale suspend le balayage au lieu de le tuer.
 *
 * ⚠️ **La machine laisse tomber une partie des `0xBA`, et la reprise en fin de tâche est ce qui
 * rattrape le balayage — ne pas la retirer.** Mesuré le 2026-08-26 sur deux balayages consécutifs :
 * deux trames muettes sur six à chaque fois, mais jamais les mêmes (index 1 et 5, puis 0 et 4), et
 * toutes rendues à la reprise. Ce n'est donc ni un index en particulier — trois lectures isolées
 * ont répondu en 3,7 à 4 s — ni la valeur, une propriété inchangée étant bel et bien repoussée, ni
 * la cadence : le PREMIER pas du second balayage est resté muet, alors qu'aucune réponse ne le
 * précédait. Un silence intermittent, côté machine, dont la cause n'est pas établie.
 */
function scanBeans(m, from, to) {
  const pas = [];
  // `pasPourTrame` et non `pasTrame` : c'est lui qui attache la COMMANDE ECAM au pas, et sans elle
  // l'appariement étroit de la réponse 0xBA (voir `handleProperty`, cas 0xBA) n'a rien à quoi se
  // raccrocher. Les pas étaient bâtis ici à la main, avec la nature « reponse » recopiée et `cmd`
  // laissé à null : une deuxième écriture de la règle d'ordonnancement, donc une divergence — et
  // elle ne levait rien, elle faisait simplement échouer le balayage en « 6 sans réponse ».
  for (let i = from; i <= to; i++) pas.push(pasPourTrame(`Bean System ${i}`, datapointValue(frameBeanSystem(i)), DELAIS.reponse, "monitor"));
  return enfilerTache(m, tache({
    label: `Balayage des grains ${from}–${to}`,
    i18n: { k: "beanScan", p: { from, to } },
    rang: RANG.LECTURE,
    pas,
    cle: `beans:${from}-${to}`,
    meta: { scan: "beans", from, to },
  }), `balayage des grains ${from}→${to}, ${pas.length} lectures 0xBA`);
}

/** Lecture des statistiques : une tâche, un pas `0xA2` par requête. Même raison qu'au-dessus. */
function scanStats(m, requetes, { sync = false } = {}) {
  // Même remarque que pour `scanBeans` : `pasPourTrame` est le seul endroit qui sache déduire la
  // nature d'une trame ET y joindre sa commande. Ici le trou était latent — 0xA2 répond bien en
  // `data_response`, qui apparie sans qualifier la commande — mais un pas sans `cmd` reste un pas
  // qu'aucun appariement étroit ne pourra jamais satisfaire.
  const pas = requetes.map((r) => pasPourTrame(`Paramètres ${r.id}${r.qty > 1 ? `+${r.qty - 1}` : ""}`, datapointValue(frameParamRead(r.id, r.qty)), DELAIS.reponse, "monitor"));
  /**
   * **`sync` met le paramètre 500 dans la MÊME tâche que les compteurs, et c'est tout l'intérêt.**
   *
   * Les deux familles se lisent par deux commandes différentes (`0xA2` ici, `0xA1` pour la
   * propriété), donc rien n'oblige à les demander ensemble — sauf l'usage qu'on en fait. Un relevé
   * différentiel compare deux instants : si les compteurs viennent d'un passage et l'écoulement
   * mesuré d'un autre, quatre minutes plus loin et une tasse plus tard, la comparaison porte sur
   * deux états de la machine et non sur un. Une tâche, une file, des pas consécutifs : les deux
   * relevés se suivent dans le même passage, et leurs horodatages le disent.
   *
   * En queue plutôt qu'en tête : la propriété est bon marché et les compteurs sont la demande.
   */
  if (sync) pas.push(pasLecture(BEAN_SYNC_PROP));
  return enfilerTache(m, tache({
    label: requetes.length > 1 ? `Statistiques (${requetes.length} requêtes)` : `Statistiques ${requetes[0].id}`,
    // Fond de file : voir `RANG.LECTURE_BASSE`. Les compteurs ne périment pas, tout le reste est
    // ce qu'on attend devant l'écran — un balayage de huit requêtes ne doit pas le faire patienter.
    rang: RANG.LECTURE_BASSE,
    pas,
    // Le pas de synchronisation entre dans la clé : sans lui, une demande AVEC compagnon fusionnerait
    // avec une demande SANS, et la propriété ne serait jamais lue — silencieusement, la fusion étant
    // un succès du point de vue de l'appelant.
    cle: `stats:${requetes.map((r) => `${r.id}+${r.qty}`).join(",")}${sync ? "+sync" : ""}`,
    // `total` compte les PAS, pas les requêtes : `statScan.remaining` se mesure sur `pas.length`
    // (voir `machineActivity`), et un total plus petit que le restant afficherait « 9 requêtes
    // restantes sur 8 ».
    meta: { scan: "stats", total: pas.length },
  }), `statistiques, ${requetes.length} requête(s) 0xA2${sync ? ` + ${BEAN_SYNC_PROP}` : ""}`);
}

/**
 * **Lecture des compteurs NOMMÉS — l'autre canal de statistiques, celui des propriétés Ayla.**
 *
 * Rien de commun avec `scanStats` côté protocole : pas de trame, un pas de LECTURE de propriété
 * par nom (`pasLecture`), donc `startImport` et pas `pasPourTrame`. Ce qui est commun, c'est le
 * rang : `LECTURE_BASSE`, pour la même raison qu'au balayage `0xA2` — un compteur ne périme pas, et
 * quarante pas ne doivent pas faire patienter ce que quelqu'un attend devant l'écran.
 *
 * ⚠️ **Les noms déjà notés absents sont retirés ici, pas au moment de servir.** Sur cette machine
 * la portée large en perdra la majorité dès le premier passage : les garder ferait une tâche de
 * quarante pas qui en réussit quatorze, donc une tâche que le planificateur déclare échouée alors
 * qu'elle a ramené tout ce qui existe. Une portée entièrement épuisée ne met rien en file du tout
 * et le dit — c'est un résultat, pas une panne.
 */
function scanCompteurs(m, portee) {
  const noms = nomsARelire(portee, m.store.machineView().props ?? {});
  const total = (PORTEES_COMPTEURS[portee] ?? []).length;
  if (!noms.length) return { ok: false, raison: total ? "tous absents sur ce modèle" : "portée inconnue", vide: true, total };
  const r = startImport(m, noms, 120000, {
    label: `Compteurs nommés (${noms.length})`,
    rang: RANG.LECTURE_BASSE,
    cle: `compteurs:${portee}`,
    meta: { scan: "compteurs", portee, total: noms.length },
    i18n: { k: "namedCounters", p: { count: noms.length } },
  });
  return { ...r, sautes: total - noms.length, total };
}

/**
 * Les compteurs nommés tels que `/statistiques` les affiche.
 *
 * Construite depuis `props` : cet endpoint ne demande jamais rien à la machine, comme
 * `vueParamsSync`. Une propriété jamais lue **n'apparaît pas** — elle n'est ni absente ni à zéro,
 * elle n'a pas été demandée, et les trois états doivent rester distincts à l'écran.
 *
 * `slug` plutôt qu'un libellé pour un compteur de boisson : rien de traduisible ne traverse l'API,
 * la page l'étiquette avec le catalogue (`useBeverageLabel`). `label` est le secours d'usine, pour
 * une boisson que le catalogue du modèle en place ne connaît pas — le cas de la moitié des
 * compteurs Eletta sur cette machine.
 */
function vueCompteurs(m) {
  const props = m.store.machineView().props ?? {};
  return Object.entries(COMPTEURS)
    .filter(([nom]) => props[nom])
    .map(([nom, info]) => {
      const p = props[nom];
      const bev = Number.isInteger(info.beverageId) ? beverageMeta(info.beverageId) : null;
      return {
        prop: nom,
        key: info.key ?? null,
        beverageId: info.beverageId ?? null,
        slug: bev?.slug ?? null,
        label: bev?.label ?? null,
        source: info.source,
        famille: info.famille,
        absent: p.absent === true,
        illisible: p.illisible === true,
        raw: p.value ?? null,
        value: p.value === undefined ? null : valeurAffichee(nom, p.value),
        unit: info.unit ?? null,
        breakdown: p.breakdown ?? null,
        at: p.at ?? null,
      };
    });
}

// La persistance vit maintenant dans `src/lib/store.mjs` (SQLite). Les écritures sont ciblées
// (`putProp`, `putStats`, `putChecksums`, `setMeta`) ; `machineView()` reste la vue d'ensemble en
// lecture, pour les endpoints qui parcourent tout le cache.

/**
 * Endpoints qui ne peuvent RIEN faire sans les deux prérequis : l'adresse de la machine et la clé
 * LAN. Ils mettent en file une trame que seule une session chiffrée peut transporter. Sans clé, la
 * machine se présente, reçoit un 412 à l'échange de clés et repart ; sans adresse, on ne peut même
 * pas lui annoncer notre existence. Dans les deux cas la commande serait acceptée puis
 * silencieusement perdue, et l'interface annoncerait « envoyé » pour un ordre qui n'atteindra
 * jamais la machine.
 *
 * Seules les écritures (POST) sont bloquées : les lectures continuent de servir le cache déjà
 * constitué, qui reste parfaitement consultable.
 */
// `/api/lankey`, `/api/ota` et `/api/cloudsession` en sont volontairement absents : ils parlent au
// cloud, pas à la machine, et ce sont eux qui débloquent la situation. Les bloquer la rendrait
// irrécupérable.
const NEEDS_MACHINE = [
  "/api/command",
  "/api/presence",
  "/api/model",
  "/api/register",
  "/api/checksums",
  "/api/stats",
  "/api/beansystem",
  "/api/beanadapt",
  "/api/beverages/import",
  "/api/profiles/import",
  // Six lectures en file, toutes portées par une session chiffrée : sans clé ni adresse, elles
  // seraient acceptées puis silencieusement perdues — ce que ce garde-fou existe pour empêcher.
  "/api/readall",
  // Même raison pour les nouveautés : lecture ET écriture des réglages, écriture des noms, ordre
  // des favoris, sondes de mode monitor. Toutes passent par une trame, donc par une session.
  "/api/settings",
  "/api/profiles/name",
  "/api/profiles/favorites",
  "/api/monitormode",
];

/**
 * **Les POST qui vivent SOUS un préfixe de `NEEDS_MACHINE` sans jamais parler à la machine.**
 *
 * Le garde-fou ci-dessus raisonne par préfixe, ce qui est le bon défaut : une entrée ajoutée sous
 * `/api/beanadapt/` demain sera protégée sans que personne y pense. Mais il attrape au passage un
 * calcul PUR — `simulate` rejoue la règle Bean Adapt en mémoire, ne construit aucune trame, ne met
 * rien en file. Le refuser ne protège de rien, et son message ne serait même pas vrai : « la
 * commande n'atteindrait jamais la machine » décrit un envoi, or il n'y en a pas.
 *
 * Concrètement, cela rendait le questionnaire d'affinage inutilisable tant qu'une adresse et une
 * clé LAN n'étaient pas configurées — alors que c'est précisément le moment où l'on veut pouvoir
 * essayer la règle sans appareil. Trouvé par `verif-surfaces.mjs`, qui démarre sans machine.
 *
 * ⚠️ Liste d'exceptions EXACTES, jamais de préfixes : une exemption qui s'étendrait à ce qui vient
 * après elle finirait par dispenser une écriture, et le ferait en silence.
 */
const SANS_MACHINE = new Set(["/api/beanadapt/simulate"]);

/**
 * Autres entrées qui désignent visiblement le MÊME appareil.
 *
 * Le DSN tranche : c'est le numéro de série, deux entrées qui le partagent sont la même cafetière.
 * L'adresse — saisie, ou celle qu'on a résolue — est un second indice, qui rattrape le cas où le
 * DSN n'a pas encore été lu.
 *
 * Le cas n'est pas théorique : enregistrer la même machine deux fois, une fois par nom court et
 * une fois par nom complet, est l'erreur naturelle quand on découvre la page. Et il est
 * **silencieux** — c'est l'adresse source qui identifie l'appelant, donc une seule des deux
 * entrées recevra la session, l'autre restera muette sans jamais dire pourquoi. D'où
 * l'avertissement, plutôt qu'un doublon qui a l'air de marcher à moitié.
 */
function machineDuplicates(m) {
  const out = [];
  for (const x of MACHINES.values()) {
    if (x.id === m.id) continue;
    const raison =
      x.dsn && m.dsn && x.dsn === m.dsn
        ? "dsn"
        : (x.ip && m.ip && x.ip === m.ip) || (x.dns?.ip && m.dns?.ip && x.dns.ip === m.dns.ip)
          ? "address"
          : null;
    if (raison) out.push({ id: x.id, label: machineLabel(x), reason: raison });
  }
  return out;
}

/**
 * Résumé d'une machine, pour le sélecteur et la page de gestion.
 *
 * ⚠️ Ne contient **aucun secret** : la clé LAN n'apparaît que par `lanKeySet` et son `key_id`,
 * qui circule en clair dans l'échange de clés. Même règle que /api/lankey.
 */
function machineSummary(m) {
  return {
    id: m.id,
    label: machineLabel(m),
    custom: m.label,
    createdAt: m.createdAt,
    ip: m.ip,
    ipSource: m.ipSource,
    // Date de la saisie mémorisée, pour savoir s'il y a quelque chose à « oublier ».
    ipCachedAt: m.store.getMeta("machineIp")?.at ?? null,
    dsn: m.dsn,
    dsnSource: m.dsnSource,
    lanKeySet: m.lanKey.length > 0,
    lanKeyId: m.lanKeyId || null,
    lanKeySource: m.lanKeySource,
    // Uniquement la date de la découverte : la clé elle-même ne sort jamais d'ici.
    lanKeyCachedAt: m.store.getLanKey()?.at ?? null,
    model: {
      key: m.modelKey,
      source: m.modelSource,
      machineName: m.identity?.machineName ?? null,
      matchesCatalog: m.modelKey ? m.modelKey === m.catalog.key : null,
      // Le catalogue réellement en service, pour que l'interface puisse nommer le pis-aller.
      catalogKey: m.catalog.key,
      catalogType: m.catalog.model.type,
      catalogBeverages: m.catalog.beverages.length,
      catalogSupport: m.catalog.support,
    },
    sessionActive: !!m.session,
    lastRegisterAt: m.lastRegisterAt,
    /**
     * Lecture en cours, pour que l'interface puisse attendre le résultat au lieu de demander un
     * rafraîchissement. Déduit de la file — voir `vueLecture` / `vueProgramme`.
     */
    reading: vueLecture(m)?.active ? vueLecture(m) : null,
    running: vueProgramme(m)?.label ?? null,
    /** Combien de tâches attendent derrière : de quoi dire « ça va prendre un moment ». */
    queued: m.file.liste.length,
    // Juste de quoi dire « elle répond, et dans quel état » — la fiche complète est /api/status.
    // **La progression n'est délibérément PAS ici** : `/api/status` renvoie `m.lastMonitor` en
    // entier, donc les octets 9-11 y parviennent déjà, et c'est de là que `/` et `/pilotage` les
    // lisent. Les recopier dans ce résumé ferait deux sources pour le même fait, dont une que
    // personne ne consomme.
    lastMonitor: m.lastMonitor ? { at: m.lastMonitor.at, stateByte: m.lastMonitor.stateByte } : null,
    activeProfile: m.activeProfile,
    activeProfileConfirmed: m.activeProfileConfirmed,
    importedAt: m.store.importedAt(),
    // Signal pour la page des grains : `setMeta` ne touche pas `importedAt` (à dessein — c'est la
    // date des données LUES sur la machine), donc sans ce compteur un autre onglet ne saurait pas
    // qu'une configuration mémorisée a changé.
    beanPresets: beanPresets(m).length,
    counts: m.store.counts(),
    // Ce que l'interface ne pourra pas changer durablement : au redémarrage, la variable regagne.
    envForced: { ip: envForced(m, "ip"), lanKey: envForced(m, "lanKey"), dsn: envForced(m, "dsn"), modelKey: envForced(m, "modelKey") },
    // Les deux prérequis de tout pilotage, résumés en un booléen.
    ready: !!m.ip && m.lanKey.length > 0,
    // Autres entrées qui semblent désigner le même appareil. Voir machineDuplicates().
    duplicates: machineDuplicates(m),
  };
}

/**
 * Gestion des machines elles-mêmes — **hors** de la résolution `pickMachine`, délibérément :
 * c'est l'endpoint qui répare une situation où l'identifiant courant n'existe plus, le bloquer
 * la rendrait irrécupérable (même raison que /api/lankey dans NEEDS_MACHINE).
 *
 *   GET    /api/machines        la liste, avec l'état de chacune
 *   POST   /api/machines        ajoute une machine, éventuellement avec son adresse
 *   POST   /api/machines/<id>   renomme (`label`) et/ou la désigne par défaut (`makeDefault`)
 *   DELETE /api/machines/<id>   supprime la machine ET toutes ses données
 */
async function handleMachines(req, res) {
  const url = req.url.split("?")[0];
  const prefixe = "/api/machines/";
  const id = url.startsWith(prefixe) ? decodeURIComponent(url.slice(prefixe.length)) : null;

  if (url === "/api/machines" && req.method === "GET") {
    return raw(res, JSON.stringify({
      defaultId: defaultMachine().id,
      machines: machineList().map(machineSummary),
      // Valeurs globales que la page affiche à côté de chaque machine. Les livrer ici évite
      // d'interroger /api/machine et /api/lankey une fois par machine pour les mêmes réponses.
      server: { ip: CFG.serverIp, port: CFG.port, problem: serverIpProblem() },
      // Ce qui manquerait pour interroger le cloud. Normalement vide (src/lib/cloud-app.json).
      discovery: { missingConfig: [!APP.gigyaApiKey && "clé API Gigya", !APP.aylaAppId && "app_id Ayla", !APP.aylaAppSecret && "app_secret Ayla"].filter(Boolean) },
    }));
  }

  if (url === "/api/machines" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 60) : null;
    const ip = typeof b.ip === "string" ? b.ip.trim() : "";
    if (ip && !validMachineHost(ip)) {
      return raw(res, JSON.stringify({ error: "adresse invalide : attendu une IPv4 ou un nom d'hôte, sans schéma ni port ni chemin." }), 400);
    }
    // L'identifiant est frappé par le stockage, jamais fourni par la requête (voir createMachine).
    const m = makeMachine(createMachine({ label }));
    MACHINES.set(m.id, m);
    L("sys", "machines", `ajoutée : ${machineLabel(m)}`, m);
    // Même chose que sur /api/machine : une adresse enregistrée mais muette doit être signalée
    // tout de suite, pas découverte à la première commande.
    let probe = null;
    if (ip) {
      applyMachineIp(m, ip);
      probe = await probeRegtoken(m);
      if (probe.reachable) await resolveDsn(m, { compare: true });
      // Ne fera rien ici en pratique : une machine qu'on vient de créer n'a pas encore de clé LAN,
      // et ces lectures exigent une session chiffrée. L'appel est là pour que le comportement ne
      // dépende pas de l'ordre des saisies (voir maybeInitialRead).
      await maybeInitialRead(m);
    }
    return raw(res, JSON.stringify({
      ok: true,
      machine: machineSummary(m),
      probe: probe && { reachable: probe.reachable, isMachine: typeof probe.regtoken?.host_symname === "string", status: probe.status ?? null, error: probe.error ?? null },
    }));
  }

  if (id && req.method === "POST") {
    const m = machineById(id);
    if (!m) return raw(res, JSON.stringify({ error: `machine « ${id} » inconnue`, unknownMachine: true }), 404);
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    if (b.label !== undefined) {
      const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 60) : null;
      setMachineLabel(m.id, label);
      m.label = label;
      L("sys", "machines", `renommée : ${machineLabel(m)}`, m);
    }
    if (b.makeDefault === true) {
      setSetting("defaultMachine", m.id);
      L("sys", "machines", `par défaut : ${machineLabel(m)}`, m);
    }
    return raw(res, JSON.stringify({ ok: true, machine: machineSummary(m), defaultId: defaultMachine().id }));
  }

  if (id && req.method === "DELETE") {
    const m = machineById(id);
    if (!m) return raw(res, JSON.stringify({ error: `machine « ${id} » inconnue`, unknownMachine: true }), 404);
    // Le keep-alive est un intervalle vivant : sans ça il continuerait à annoncer un serveur à une
    // machine qui n'existe plus, ou qui vient d'être vidée.
    if (m.keepalive) { clearInterval(m.keepalive); m.keepalive = null; }
    const nom = machineLabel(m);

    /**
     * La **dernière** machine ne peut pas quitter le registre : l'application n'a aucun état
     * « aucune machine » à montrer, et une base vide s'en recréerait une au démarrage. Mais
     * refuser était le mauvais choix — ça renvoyait l'utilisateur faire à la main ce que le bouton
     * devait faire, et ça laissait de toute façon le cache de lectures en place.
     *
     * On fait donc ce que la suppression voulait dire : tout effacer, sur place. L'entrée survit,
     * vide, et l'état d'exécution est reconstruit — ce qui remet aussi en vigueur les valeurs
     * forcées par l'environnement, seule chose qu'un effacement local ne peut pas défaire.
     */
    if (MACHINES.size === 1) {
      // Tout ce qui était en vol part avec la machine effacée. Plus de `setTimeout` à désarmer :
      // les balayages sont des tâches, donc vider la file suffit — c'est un des bénéfices
      // silencieux de la file, il n'y a plus qu'un endroit où du travail peut être en attente.
      annuler(m.file, null, "machine réinitialisée", Date.now());
      m.session = null;
      m.aylaToken = null;
      const cleared = m.store.reset();
      // « Tout effacer » doit tout dire : la session cloud mémorisée est un identifiant de compte,
      // elle ne doit pas survivre à l'effacement de la seule machine qu'on pilotait.
      const cloudOublie = forgetCloudSession();
      setMachineLabel(m.id, null);
      const frais = makeMachine({ id: m.id, createdAt: m.createdAt, label: null });
      MACHINES.set(frais.id, frais);
      clearSetting("defaultMachine");
      L("sys", "machines", `remise à zéro : ${nom} — adresse, clé LAN, DSN, modèle, ${cleared.props} propriétés et ${cleared.stats} statistiques effacés`, frais);
      // Ce que l'environnement remet en place aussitôt : il faut le DIRE, sinon la remise à zéro
      // a l'air de n'avoir rien fait.
      const envRestored = ["ip", "lanKey", "dsn", "modelKey"].filter((k) => envForced(frais, k));
      if (envRestored.length) L("sys", "machines", `valeurs reprises de .env.local après la remise à zéro : ${envRestored.join(", ")}`, frais);
      return raw(res, JSON.stringify({
        removed: false,
        reset: true,
        cleared,
        cloudSessionForgotten: cloudOublie,
        envRestored,
        machine: machineSummary(frais),
        defaultId: defaultMachine().id,
        machines: machineList().map(machineSummary),
      }));
    }

    MACHINES.delete(m.id);
    const removed = deleteMachine(m.id);
    if (getSetting("defaultMachine") === m.id) clearSetting("defaultMachine");
    L("sys", "machines", `supprimée : ${nom} — propriétés lues, statistiques, recettes et clé LAN mémorisée effacées`, m);
    return raw(res, JSON.stringify({ removed, defaultId: defaultMachine().id, machines: machineList().map(machineSummary) }));
  }

  return raw(res, JSON.stringify({ error: "not found" }), 404);
}

/**
 * **Vues dérivées de la file**, pour les consommateurs écrits avant elle.
 *
 * `m.program` et `m.import` n'existent plus comme état : la file est la seule source. Mais
 * /machines, /api/beverages et /api/profiles lisent ces formes-là, et les casser n'apportait rien
 * à cette fiabilisation. Elles sont donc calculées ici, à un seul endroit — d'où l'impossibilité
 * qu'elles se contredisent, ce qui arrivait quand `m.program.active` et `fenetreOuverte()` ne
 * disaient pas la même chose selon la page.
 */
function vueProgramme(m) {
  const t = courante(m.file);
  if (!t || t.etat !== "encours") return null;
  return { active: true, id: t.id, label: t.label, counter: t.faits, genre: t.genre, dispense: t.meta?.dispense === true };
}

/**
 * L'état d'une LECTURE, en cours ou tout juste terminée.
 *
 * La tâche terminée est incluse à dessein : le résultat d'une lecture qui vient d'échouer est
 * exactement ce qu'on cherche à voir, et il disparaissait avec elle. `active` distingue les deux.
 */
function vueLecture(m) {
  const tete = courante(m.file);
  const t = tete?.genre === "lecture" ? tete : m.file.finies.find((x) => x.genre === "lecture");
  if (!t) return null;
  const encours = t.etat === "encours";
  return {
    active: encours,
    id: t.id,
    label: t.label,
    remaining: Math.max(0, t.pas.length - t.i),
    ok: t.faits,
    fail: t.nonLus.length,
    pending: encours ? (t.pas[t.i]?.nom ?? null) : null,
  };
}

/** Une tâche de balayage en cours, repérée par sa `meta`. Sert /api/beanadapt et /api/stats. */
function vueBalayage(m, quoi) {
  const t = courante(m.file);
  return t?.etat === "encours" && t.meta?.scan === quoi ? t : null;
}

/**
 * Tout ce que la machine est en train de faire pour nous, en un seul objet.
 *
 * `queue` est la vraie réponse depuis que la file existe ; `program`, `import`, `beanScan` et
 * `statScan` restent pour les pages qui les lisent déjà, et se déduisent tous de cette même file —
 * il n'y a plus qu'un seul état, donc plus de contradiction possible entre deux affichages.
 */
function machineActivity(m) {
  const bs = vueBalayage(m, "beans");
  const st = vueBalayage(m, "stats");
  return {
    queue: vueFile(m.file),
    program: vueProgramme(m),
    import: vueLecture(m),
    beanScan: bs ? { from: bs.meta.from, next: bs.meta.from + bs.faits, to: bs.meta.to } : null,
    statScan: st ? { remaining: st.pas.length - st.i, total: st.meta.total } : null,
  };
}

/**
 * Flux d'évènements vers les navigateurs (Server-Sent Events).
 *
 * Pourquoi pousser plutôt que laisser sonder : une lecture de propriété n'est pas synchrone — le
 * POST rend la main dès l'annonce, et c'est la machine qui pousse la valeur deux secondes plus
 * tard. Sonder, c'est re-télécharger la liste entière toutes les deux secondes pour voir un champ
 * changer, et se tromper de toute façon sur le moment.
 *
 * **Le déclencheur est le journal.** Chaque changement d'état significatif de ce serveur passe déjà
 * par `L()` — propriété reçue, import démarré ou terminé, programme servi, clé appliquée, adresse
 * changée. Se brancher là évite d'instrumenter vingt endroits et de rater celui qu'on aurait
 * oublié : il n'existe pas de changement d'état silencieux.
 *
 * Regroupé sur 250 ms : un import journalise une ligne par propriété, et on ne veut pas une trame
 * par ligne.
 */
const SSE = new Set();
let sseTimer = null;
/**
 * Le `n` le plus haut déjà poussé sur le fil, tous abonnés confondus.
 *
 * **Un seul curseur pour tout le monde, et c'est l'`id` de ligne qui rend ça sûr.** Un navigateur
 * qui s'abonne reçoit d'abord la fenêtre entière, puis suit le même flux que les autres : la
 * prochaine poussée peut donc lui redonner des lignes qu'il a déjà. Ça ne coûte rien, parce que
 * le client remplace par `id` — sur-livrer est gratuit, sous-livrer laisse un trou. Un curseur
 * par abonné aurait acheté quelques octets contre un état à tenir par connexion.
 */
let sseJournalCurseur = 0;

/** Les lignes des deux bacs dont `n` dépasse `depuis`, dans l'ordre où elles sont arrivées. */
function journalDepuis(depuis) {
  const l = [];
  for (const e of LOG) if (e.n > depuis) l.push(e);
  for (const e of LOG_APPS) if (e.n > depuis) l.push(e);
  return l.sort((a, b) => a.n - b.n);
}

/** La fenêtre entière, les deux bacs mêlés, du plus ancien au plus récent. */
const journalComplet = () => [...LOG, ...LOG_APPS].sort((a, b) => a.n - b.n);

function sseEcrire(res, cadre) {
  try { res.write(cadre); } catch { SSE.delete(res); }
}

/**
 * Le cadre SSE d'un lot de lignes.
 *
 * Deux choses le distinguent du cadre d'état, et les deux comptent. Il est **nommé**
 * (`event: journal`) : `EventSource.onmessage` ne reçoit que les évènements ANONYMES, donc les six
 * pages branchées sur `useMachineEvents` ne voient rien de nouveau — par construction, pas par
 * précaution. Et il porte un **`id:`**, que le navigateur renvoie tout seul en `Last-Event-ID` à
 * la reconnexion : la reprise après un décrochage est native, il n'y a pas de curseur à mémoriser
 * dans la page.
 */
function cadreJournal(lignes, complet) {
  const jusqu = lignes.length ? lignes[lignes.length - 1].n : journalSeq;
  return `id: ${jusqu}\nevent: journal\ndata: ${JSON.stringify({ lignes, complet, jusqu })}\n\n`;
}

function sseBroadcast() {
  if (!SSE.size) return;
  const charge = JSON.stringify({
    machines: machineList().map(machineSummary),
    defaultId: defaultMachine().id,
    at: Date.now(),
  });
  const lignes = journalDepuis(sseJournalCurseur);
  const journal = lignes.length ? cadreJournal(lignes, false) : null;
  if (lignes.length) sseJournalCurseur = lignes[lignes.length - 1].n;
  for (const res of [...SSE]) {
    sseEcrire(res, `data: ${charge}\n\n`);
    if (journal) sseEcrire(res, journal);
  }
}

/** Signale un changement d'état. Sans client connecté, ne coûte rien. */
function sseTouch() {
  if (!SSE.size || sseTimer) return;
  sseTimer = setTimeout(() => {
    sseTimer = null;
    sseBroadcast();
  }, 250);
}

/**
 * **Vider un journal — et le DIRE aux navigateurs déjà branchés.**
 *
 * Le journal est l'instrument de diagnostic de ce serveur, et sa fenêtre est bornée : quatre cents
 * lignes pour la machine, deux cents pour les applications. Quand on part sur une piste, ce qui
 * gêne n'est pas ce que le serveur garde, c'est ce qu'on a déjà lu — un coupe-circuit replié en une
 * ligne, un import de la veille. Repartir d'une page blanche AVANT le geste qu'on veut observer
 * vaut mieux que chercher à l'horodatage la frontière entre l'avant et l'après.
 *
 * Rien n'atteint l'appareil et rien n'est persistant : les deux bacs vivent en mémoire de
 * processus. C'est néanmoins irréversible, et cela vaut pour TOUS les onglets branchés — d'où la
 * confirmation côté page, même règle que « Vider la file ».
 *
 * ⚠️ **Un ajout ne peut pas décrire une suppression.** Le fil ne transporte que des lignes NEUVES
 * et le navigateur tient les anciennes par `id` : lui pousser la seule ligne « journal vidé » le
 * laisserait avec quatre cents lignes que le serveur ne possède plus, sous un message qui affirme
 * le contraire. On pousse donc la fenêtre entière marquée `complet` — la seule forme que
 * `fusionner()` traite en REMPLAÇANT au lieu d'ajouter.
 *
 * ⚠️ **`journalEvince` est recalé APRÈS la ligne de compte rendu, pas avant.** Ces lignes-là n'ont
 * pas été évincées par l'âge, elles ont été supprimées : un navigateur dont le curseur vaut le `n`
 * de la dernière d'entre elles l'a bien reçue, mais il l'AFFICHE toujours. La règle habituelle
 * (`depuis >= journalEvince` ⇒ delta) lui répondrait « rien de neuf » et laisserait la chronologie
 * effacée à l'écran. En calant la borne sur `journalSeq`, tout curseur antérieur à ce vidage reçoit
 * la fenêtre entière et remplace ; ceux qui viennent de recevoir le cadre `complet` ci-dessous sont
 * déjà à `journalSeq` et repassent en delta dès la ligne suivante, ce qui est exact.
 */
function viderJournal(source) {
  const bac = source === "apps" ? LOG_APPS : LOG;
  const efface = bac.length;
  if (!efface) return 0;
  bac.length = 0;
  // Le journal dit ce qui vient de lui arriver : un journal VIDÉ et un journal MUET sont deux
  // situations opposées, et seule la seconde doit inquiéter. La ligne part dans le bac qu'elle
  // décrit, jamais dans l'autre.
  const resume = `${efface} ligne${efface > 1 ? "s" : ""} effacée${efface > 1 ? "s" : ""} à la demande`;
  if (source === "apps") LA("sys", "Journal", resume);
  else L("sys", "Journal", resume);
  journalEvince = journalSeq;
  const cadre = cadreJournal(journalComplet(), true);
  for (const res of [...SSE]) sseEcrire(res, cadre);
  // La fenêtre entière vient de partir : le prochain lot d'ajouts repart d'ici, sans quoi il
  // relivrerait ce qu'on vient de livrer.
  sseJournalCurseur = journalSeq;
  return efface;
}

/**
 * Fait avancer les échéances de toutes les machines et journalise ce qui en sort.
 *
 * **Le temps ne passe pas tout seul dans l'ordonnanceur** : il est pur, l'instant lui est fourni.
 * C'est donc ici — dans le veilleur à 2 s — qu'une échéance manquée devient une reprise, une fin
 * ou un verdict de machine muette. Avant, ces constats n'avaient lieu que quand la machine venait
 * chercher la commande suivante : si elle ne venait jamais, aucune ligne n'était jamais écrite.
 */
function avancerFiles() {
  for (const m of machineList()) {
    for (const e of tic(m.file, Date.now())) {
      if (e.silencieux) continue;
      if (e.type === "muette") {
        L("sys", "tâche", `${e.tache.id} « ${e.tache.label} » abandonnée : aucun contact de la machine depuis ${Math.round(DELAIS.muet / 1000)} s${e.restantes ? ` — ${e.restantes} tâche(s) en attente annulée(s) pour la même raison` : ""}`, m);
      } else if (e.type === "repris") {
        L("sys", "tâche", `${e.tache.id} · « ${e.pas.nom} » sans réponse, remis en fin de tâche`, m);
      } else if (e.type === "perdu") {
        L("sys", "tâche", `${e.tache.id} · « ${e.pas.nom} » sans réponse après reprise : abandonné`, m);
      } else if (e.type === "faite") {
        L("sys", "tâche", `${e.tache.id} « ${e.tache.label} » terminée : ${e.tache.faits} pas`, m);
        finDeTache(m, e.tache);
      } else if (e.type === "echouee") {
        L("sys", "tâche", `${e.tache.id} « ${e.tache.label} » échouée : ${e.tache.motif}`, m);
        finDeTache(m, e.tache);
      }
    }
  }
}

/**
 * Ce qu'il reste à faire quand une tâche s'achève. Une seule chose aujourd'hui — la marque de
 * fraîcheur des sommes de contrôle — mais elle DOIT être posée à la fin et nulle part ailleurs :
 * posée à l'envoi, un import échoué prétendait que les noms étaient à jour, et la relecture était
 * alors définitivement sautée jusqu'à un `force: true`.
 */
function finDeTache(m, t) {
  if (t.meta?.checksumMark) applyChecksumMark(m, t);
}

/**
 * Veilleur, actif seulement pendant qu'un import ou un programme tourne.
 *
 * Le journal suffit pour tout ce qui **arrive**, mais pas pour ce qui **cesse** : quand une fenêtre
 * expire sans que la machine se soit connectée, aucune ligne n'est écrite. Sans ce veilleur, le
 * badge « lecture… » resterait affiché indéfiniment, à décrire un import qui n'existe plus — et
 * c'est aussi lui qui, désormais, écrit cette ligne manquante (`cloreFenetreExpiree`).
 *
 * Il s'arrête de lui-même au premier passage où plus rien n'est ouvert, après une dernière émission
 * — celle qui remet les champs à zéro.
 */
let sseWatcher = null;
function sseWatch() {
  if (sseWatcher) return;
  sseWatcher = setInterval(() => {
    // Faire avancer le temps d'abord : ça journalise, donc ça doit précéder l'émission finale.
    avancerFiles();
    const actif = machineList().some((m) => !vide(m.file));
    sseBroadcast();
    if (!actif) {
      clearInterval(sseWatcher);
      sseWatcher = null;
    }
  }, 2000);
}

/**
 * Abonnement d'un navigateur. Pas de `raw()` ici : un flux ne porte pas de `Content-Length` et ne
 * doit pas être fermé. Le premier envoi est immédiat, pour que la page ait un état sans attendre le
 * premier changement.
 */
function sseSubscribe(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Rien d'autre ne doit tamponner ce flux (un reverse-proxy devant nous, typiquement).
    "X-Accel-Buffering": "no",
  });
  SSE.add(res);
  res.write(`retry: 3000\n\n`);
  // Battement de cœur : un flux muet finit par être coupé par un intermédiaire, et le navigateur
  // ne le saurait qu'au premier évènement perdu. Un commentaire SSE ne déclenche pas `onmessage`.
  const battement = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* la fermeture est gérée ci-dessous */ }
  }, 25000);
  const fin = () => {
    clearInterval(battement);
    SSE.delete(res);
  };
  req.on("close", fin);
  req.on("error", fin);
  res.on("error", fin);
  /**
   * L'amorce du journal, et elle n'a lieu qu'ICI — ensuite, le fil ne porte plus que des ajouts.
   *
   * `Last-Event-ID` est renvoyé par le navigateur sans qu'on lui demande, parce que `cadreJournal`
   * pose un `id:`. Trois cas, et le troisième est celui qui empêche de mentir : curseur absent →
   * la fenêtre entière ; curseur récent → le rattrapage seul ; curseur plus vieux que la dernière
   * ligne évincée → il a raté des lignes qui n'existent plus, donc la fenêtre entière **et** on le
   * dit (`complet`), pour qu'il remplace au lieu d'ajouter à une chronologie trouée.
   */
  const repris = Number(req.headers["last-event-id"]);
  const reprise = Number.isFinite(repris) && repris > 0 && repris >= journalEvince;
  sseEcrire(res, reprise ? cadreJournal(journalDepuis(repris), false) : cadreJournal(journalComplet(), true));
  sseBroadcast();
}

/**
 * Configurations de grains **mémorisées par le serveur**, en regard des six emplacements de la
 * machine.
 *
 * Pourquoi les deux : la machine n'a que six emplacements, dont un qui n'est pas un café (l'entrée
 * marche/arrêt), et les écraser fait perdre le réglage précédent. Une bibliothèque locale permet de
 * garder un réglage par café acheté, d'en essayer un autre, et de revenir.
 *
 * Rangées dans `meta` de la machine, pas dans une table : ce sont quelques lignes, et `meta` est
 * fait pour ça (même famille que `checksums`). Une table aurait demandé une version de schéma pour
 * un tableau de cinq entrées. **Par machine** comme les recettes : un réglage vaut pour les bornes
 * d'un modèle, et supprimer une machine doit emporter ses configurations.
 *
 * L'identifiant est frappé ici, jamais fourni par la requête — même règle que pour les machines.
 */
function beanPresets(m) {
  const l = m.store.getMeta("beanPresets");
  return Array.isArray(l) ? l : [];
}

/**
 * Ce que les endpoints de LECTURE servent : les configurations mémorisées, plus la date de leur
 * image quand elles en ont une.
 *
 * Distinct de `beanPresets()` **à dessein**. Cette fonction-là est le stockage, et `putBeanPreset`
 * la relit pour réécrire le tableau : si elle rendait déjà `imageAt`, cette date se recopierait
 * dans `meta` à chaque enregistrement, et `meta` finirait par contredire la table le jour où une
 * image est supprimée. La table dit ce qu'elle contient, elle est seule à le dire.
 *
 * `imageAt` sert aussi de **version** à l'interface : c'est ce qu'elle met en paramètre de l'URL
 * de la vignette pour que le navigateur aille rechercher une image qui vient d'être remplacée.
 */
function vueBeanPresets(m) {
  const dates = m.store.beanImageDates();
  return beanPresets(m).map((p) => ({ ...p, imageAt: dates[p.id] ?? null }));
}

function putBeanPreset(m, { id, name, grinder, temperature, aroma, roast }) {
  const liste = beanPresets(m);
  const at = Date.now();
  const propre = {
    name: String(name ?? "").slice(0, 20),
    grinder: Number(grinder),
    temperature: Number(temperature),
    aroma: Number(aroma),
    /**
     * Le niveau de torréfaction déclaré, ou `null`.
     *
     * ⚠️ Rangé DANS la fiche, contrairement à la photo qui a sa table. C'est un entier : le ranger
     * à part demanderait une table pour une colonne, alors que le tableau des configurations est
     * de toute façon réécrit en entier à chaque enregistrement. C'est exactement l'inverse du
     * raisonnement qui a sorti l'image de `meta` — voir l'en-tête de `DDL_BEAN_IMAGES` — et pour
     * la même raison : ce qui pèse sort, ce qui ne pèse rien reste.
     *
     * `?? null` et non `?? liste[i].roast` : le formulaire envoie toujours le niveau, donc une
     * valeur absente veut dire « aucun », jamais « ne touche pas ». Le confondre rendrait le
     * retrait impossible.
     */
    roast: roast ?? null,
  };
  const i = id ? liste.findIndex((x) => x.id === id) : -1;
  let entree;
  if (i >= 0) {
    entree = { ...liste[i], ...propre, at };
    liste[i] = entree;
  } else {
    const used = liste.map((x) => Number(String(x.id).replace(/^b/, "")) || 0);
    entree = { id: `b${Math.max(0, ...used) + 1}`, ...propre, createdAt: at, at };
    liste.push(entree);
  }
  m.store.setMeta("beanPresets", liste);
  L("sys", "grains", `${i >= 0 ? "modifiée" : "mémorisée"} : « ${entree.name || "sans nom"} » mouture ${entree.grinder}, temp ${entree.temperature}, arôme ${entree.aroma}${entree.roast === null ? "" : `, torréfaction ${entree.roast}`}`, m);
  return entree;
}

/**
 * **Le visuel d'un emplacement de la machine** — torréfaction et photo, gardés par nous.
 *
 * La machine ne mémorise ni l'une ni l'autre : sa trame `0xBA` porte un nom et trois réglages, rien
 * de plus. Ces deux informations sont donc les nôtres, et elles se rangent comme les configurations
 * mémorisées : la torréfaction dans `meta` (un entier par emplacement), la photo dans la table
 * `bean_images`.
 *
 * ⚠️ **`bean_images` est indexée par une CHAÎNE, et on y ouvre un second espace de noms.** Les
 * configurations frappent `b1`, `b2`… ; les emplacements prennent `s1`…`s6`. Le préfixe est ce qui
 * garantit qu'un `b3` et un `s3` ne se marchent pas dessus, et il évite une version de schéma pour
 * une colonne. La table n'en sait rien et n'a pas à en savoir : elle range des octets sous une clé.
 *
 * ⚠️ **Le visuel suit l'INDEX, pas le grain.** Changer le grain de l'emplacement 3 sur la machine
 * laisse le visuel de l'ancien : rien ne nous prévient d'un renommage fait sur l'appareil, et
 * deviner qu'un nom différent veut dire « autre paquet » effacerait la photo de qui corrige une
 * faute de frappe. L'interface le dit plutôt que de le corriger.
 */
const ID_VISUEL_EMPLACEMENT = (index) => `s${Number(index)}`;

/**
 * Les emplacements de la machine **avec notre visuel** — ce que servent `/api/beanadapt` et
 * l'import cloud.
 *
 * Extrait de `/api/beanadapt` quand l'import a eu besoin de rendre la même liste : deux
 * constructions de la même vue auraient divergé sur le champ qui compte ici, `imageAt`, celui dont
 * dépend l'URL de la vignette. Une photo importée que la liste ne signale pas ne s'afficherait
 * jamais, et rien ne dirait pourquoi.
 */
/**
 * Ce que `d260_beansystem_sync_par` apporte à l'affinage : l'écoulement mesuré et le verrou.
 *
 * Le seuil voyage AVEC le compteur, et pas seulement le booléen : « encore 2 cafés » ne se dit pas
 * avec un `false`. Et `permis` reste distinct de `espressos >= seuil` calculé côté navigateur —
 * c'est la règle de l'app, elle appartient au serveur, qui est le seul à savoir si la machine est
 * une Striker.
 */
function vueBeanSync(m) {
  const sync = m.store.machineView().props?.[BEAN_SYNC_PROP];
  const espressos = Number.isInteger(sync?.espressos) ? sync.espressos : null;
  return {
    at: sync?.at ?? null,
    ecoulementMs: Number.isInteger(sync?.ecoulementMs) ? sync.ecoulementMs : null,
    // La troncature de l'app, refaite ici plutôt qu'au rendu : `L6/k.java` divise en entier.
    ecoulementS: Number.isInteger(sync?.ecoulementMs) ? Math.trunc(sync.ecoulementMs / 1000) : null,
    espressos,
    seuil: seuilAffinage(m.gen),
    permis: affinagePermis(espressos, m.gen),
  };
}

function vueBeansMachine(m) {
  const beanSystems = m.store.machineView().beanSystems ?? {};
  /* Deux lectures locales — une clé de `meta`, une requête de dates — faites une fois pour toute
     la liste plutôt qu'une par emplacement. */
  const roasts = beanRoasts(m);
  const dates = m.store.beanImageDates();
  return Object.entries(beanSystems).map(([index, bs]) => ({
    index: Number(index),
    name: bs.name,
    grinder: bs.grinder,
    temperature: bs.temperature,
    aroma: bs.aroma,
    at: bs.at,
    visible: bs.visible ?? null,
    active: bs.active ?? null,
    // L'index 0 est l'entrée « Bean Adapt (ON/OFF) », pas une configuration de café.
    isToggle: Number(index) === 0,
    // Nos deux informations à nous, que la machine ne connaît pas. Voir `ID_VISUEL_EMPLACEMENT`.
    roast: roasts[String(index)] ?? null,
    imageAt: dates[ID_VISUEL_EMPLACEMENT(index)] ?? null,
  }));
}

/** Les torréfactions par emplacement : `{ "1": 3, … }`, jamais `null` dans la table. */
function beanRoasts(m) {
  const o = m.store.getMeta("beanRoasts");
  return o && typeof o === "object" && !Array.isArray(o) ? o : {};
}

/**
 * Pose ou retire la torréfaction d'un emplacement. `null` **supprime la clé** au lieu de ranger un
 * `null` : une entrée qui vaut « rien » est indistinguable d'une absence à la lecture, et les
 * garder ferait grossir `meta` d'autant d'emplacements qu'on aura touchés puis annulés.
 */
function setBeanRoast(m, index, roast) {
  const o = beanRoasts(m);
  const cle = String(Number(index));
  if (roast === null) delete o[cle];
  else o[cle] = roast;
  m.store.setMeta("beanRoasts", o);
}

function deleteBeanPreset(m, id) {
  const liste = beanPresets(m);
  const reste = liste.filter((x) => x.id !== id);
  if (reste.length === liste.length) return false;
  m.store.setMeta("beanPresets", reste);
  // L'image part avec la configuration : la garder ne ferait qu'une ligne que plus rien ne
  // désigne, et que le prochain `b<n>` réutiliserait sous une autre identité.
  m.store.deleteBeanImage(id);
  L("sys", "grains", `oubliée (${id})`, m);
  return true;
}

// --- API de contrôle ---
async function handleApi(req, res) {
  const url = req.url.split("?")[0];
  // La gestion des machines elle-même n'est pas rattachée à une machine : elle en crée, en
  // renomme, en supprime. Traitée avant toute résolution, sinon un identifiant supprimé
  // empêcherait de réparer la situation.
  if (url === "/api/machines" || url.startsWith("/api/machines/")) return handleMachines(req, res);
  // Le flux d'évènements est global, et surtout : il ne doit pas déclencher la résolution du DSN
  // ci-dessous, qui sonde la machine pendant 4 s. Un abonnement n'a aucune raison de faire ça.
  if (url === "/api/events" && req.method === "GET") return sseSubscribe(req, res);
  /**
   * Le journal hors flux — l'amorce d'un navigateur sans `EventSource`, et le repli de `/pilotage`
   * quand le flux ne s'établit pas (elle repasse alors au minuteur de 3 s, et le dit).
   *
   * `depuis` rend la même chose que le fil : au-delà de la dernière ligne évincée, le rattrapage ;
   * en deçà, ou absent, la fenêtre entière marquée `complet`. Les deux bacs voyagent ensemble et
   * chaque ligne porte sa `source` : c'est le composant qui les sépare, pas deux requêtes.
   */
  if (url.split("?")[0] === "/api/journal" && req.method === "GET") {
    const depuis = Number(new URL(req.url, "http://x").searchParams.get("depuis"));
    const rattrape = Number.isFinite(depuis) && depuis > 0 && depuis >= journalEvince;
    const lignes = rattrape ? journalDepuis(depuis) : journalComplet();
    return raw(res, JSON.stringify({ lignes, complet: !rattrape, jusqu: lignes.length ? lignes[lignes.length - 1].n : journalSeq }));
  }
  /**
   * Le vidage, et il NOMME sa cible. `source` est obligatoire et sans valeur par défaut : les deux
   * bacs sont sur la même page, côte à côte, et retomber en silence sur `machine` parce qu'un
   * paramètre a été mal écrit effacerait l'instrument à la place du bavardage.
   */
  if (url.split("?")[0] === "/api/journal" && req.method === "DELETE") {
    const source = new URL(req.url, "http://x").searchParams.get("source");
    if (source !== "machine" && source !== "apps") {
      return raw(res, JSON.stringify({ error: `source de journal inconnue : ${source ?? "(absente)"}` }), 400);
    }
    return raw(res, JSON.stringify({ source, efface: viderJournal(source) }));
  }
  /**
   * Les applications branchées sur ce serveur. Global comme la liste des machines, et traité
   * ici pour la même raison : une application n'appartient pas à la machine qu'on regarde, et
   * surveiller des usurpations n'a de sens que si la vue est complète.
   *
   * **Aucune session n'en sort** — `vueApps()` ne rend que des métadonnées. Une session porte
   * des clés dérivées de la clé LAN ; la règle « aucun endpoint ne renvoie la clé » vaut aussi
   * pour ce qui en descend.
   */
  if (url === "/api/apps" && req.method === "GET") {
    const v = vueApps(PROXY.registre, Date.now());
    return raw(res, JSON.stringify({
      actif: PROXY.actif,
      // Le port dit pourquoi rien n'arrive quand rien n'arrive : une application ne cherche
      // l'appareil que sur le port 80.
      port: CFG.port,
      portAttendu: PORT_ATTENDU_PAR_APP,
      portOk: CFG.port === PORT_ATTENDU_PAR_APP,
      ...v,
      apps: v.apps.map((a) => ({ ...a, machine: a.machineId ?? null })),
      // Le journal des applications est parti sur le fil, avec celui de la machine et sous la
      // même numérotation : voir `cadreJournal`. Le laisser ici l'aurait fait retélécharger en
      // entier à chaque poussée, ce qui est précisément ce que ce lot supprime.
    }));
  }

  // À quelle machine cette requête s'adresse-t-elle ? Un identifiant inconnu est refusé, jamais
  // remplacé en silence par la machine par défaut.
  const { m, error: machineError } = pickMachine(req);
  if (!m) return raw(res, JSON.stringify({ error: machineError, unknownMachine: true }), 404);
  // Le DSN part dans CHAQUE écriture de propriété servie à la machine : on s'assure de le
  // connaître avant d'agir. Ne coûte une requête que tant qu'il est inconnu.
  if (!m.dsn) await resolveDsn(m);
  // Refus franc plutôt qu'un succès trompeur (voir NEEDS_MACHINE). Les drapeaux permettent à une
  // interface de réagir sans analyser le texte du message.
  if (req.method === "POST" && !SANS_MACHINE.has(url.split("?")[0]) && NEEDS_MACHINE.some((p) => url === p || url.startsWith(`${p}/`))) {
    if (!m.ip) {
      return raw(res, JSON.stringify({
        error: "adresse de la machine non configurée : la renseigner sur la page « Machines », ou par MACHINE_IP dans .env.local.",
        needsMachineIp: true,
      }), 409);
    }
    if (!m.lanKey.length) {
      return raw(res, JSON.stringify({
        error: "clé LAN absente : aucune session chiffrée n'est possible, la commande n'atteindrait jamais la machine. Renseigner LANIP_KEY dans .env.local, ou récupérer la clé depuis la page « Machines ».",
        needsLanKey: true,
      }), 409);
    }
    // Troisième prérequis, aussi décisif que les deux autres et bien plus discret : l'adresse que
    // nous annonçons. En boucle locale, la machine ne peut pas revenir vers nous — la commande
    // serait acceptée puis perdue, ce que ce refus existe précisément pour empêcher.
    const problemeIp = serverIpProblem();
    if (problemeIp) {
      return raw(res, JSON.stringify({
        error: `${problemeIp} : c'est l'adresse que nous annonçons à la machine pour qu'elle nous rappelle. En mode LAN, c'est ELLE qui se connecte à nous — avec cette valeur, la commande serait acceptée puis perdue. Renseigner SERVER_IP avec une adresse joignable depuis le réseau de la machine (voir DOCKER.md § 1).`,
        needsServerIp: true,
      }), 409);
    }
  }
  if (url === "/api/status") {
    return raw(res, JSON.stringify({
      // De quelle machine parle cette réponse, et quelles autres existent. Toutes les pages
      // interrogent /api/status : c'est donc ici que le sélecteur de machine trouve sa liste,
      // sans requête supplémentaire.
      machine: { id: m.id, label: machineLabel(m), custom: m.label },
      machines: machineList().map((x) => ({ id: x.id, label: machineLabel(x), current: x.id === m.id })),
      config: { dsn: m.dsn, dsnSource: m.dsnSource, machineIp: m.ip, machineIpSource: m.ipSource, serverIp: CFG.serverIp, serverIpSource: CFG.serverIpSource, serverIpProblem: serverIpProblem(), serverPort: CFG.port, generation: m.gen, lanKeyId: m.lanKeyId, lanKeySet: m.lanKey.length > 0, lanKeySource: m.lanKeySource },
      // Volontairement léger : /api/status est interrogé toutes les 3 s. La fiche complète du
      // modèle est sur /api/model.
      model: { key: m.modelKey, source: m.modelSource, catalogKey: m.catalog.key, catalogType: m.catalog.model.type, matchesCatalog: m.modelKey ? m.modelKey === m.catalog.key : null },
      /**
       * **`lastContactAt` : la seule mesure honnête de la liaison.** `active` est un VERROU — il
       * passe à vrai au premier échange de clés et n'est remis à zéro que par un changement de
       * configuration (clé, adresse, réinitialisation), jamais par une inactivité ni un délai. Il
       * affiche donc « établie » des heures après que la machine a cessé de répondre, ce qui est
       * exactement la situation qu'on vient diagnostiquer sur `/pilotage`. `file.dernierContact`
       * est daté par CHAQUE datapaquet reçu (`contactMachine` dans `handleProperty`), donc il dit
       * « elle nous parle encore » et non « elle nous a parlé un jour ». 0 = jamais.
       */
      session: { active: !!m.session, lastContactAt: m.file.dernierContact || null }, lastRegisterAt: m.lastRegisterAt, activeProfile: m.activeProfile, activeProfileConfirmed: m.activeProfileConfirmed,
      /**
       * `queue` — la file de tâches, et les vues dérivées que les autres pages lisent encore.
       * Voir `machineActivity()`. Il n'y a plus qu'un seul état pour « ce que fait la machine »,
       * donc plus de page qui en affirme une chose pendant qu'une autre affirme le contraire.
       */
      ...machineActivity(m),
      lastMonitor: m.lastMonitor, lastDataResponse: m.lastDataResponse,
      /**
       * ⚠️ **Le journal n'est plus ici, et c'est le point du lot.** Mesuré sur la machine d'essai :
       * cette réponse pesait 8 185 octets dont 5 685 (69 %) de journal — 50 lignes retéléchargées
       * en entier à chaque poussée SSE, soit toutes les 250 ms pendant une préparation, pour
       * ~114 octets d'information neuve. Il voyage désormais en ajouts sur le fil
       * (`cadreJournal`), et s'amorce par `GET /api/journal`.
       */
    }));
  }
  if (url === "/api/command" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    /**
     * `clear` vide la file — toutes les tâches, ou une seule si `taskId` est fourni. Les tâches
     * annulées rejoignent les terminées avec leur motif : elles ne s'évaporent pas, ce qui était
     * précisément le défaut que la file corrige.
     */
    if (b.action === "clear") {
      const annulees = annuler(m.file, b.taskId ?? null, "annulée depuis l'interface", Date.now());
      L("sys", "file", annulees.length ? `${annulees.length} tâche(s) annulée(s) : ${annulees.map((t) => t.label).join(", ")}` : "rien à annuler", m);
      return raw(res, JSON.stringify({ cleared: annulees.length, tasks: annulees.map((t) => t.id) }));
    }
    // `cleLibelle` suit `label` pas à pas : le libellé français reste (journal du terminal, repli
    // du client), la clé le double pour l'affichage. Les deux se posent dans la même branche, ce
    // qui est la seule façon qu'ils ne divergent pas.
    let frame, label, dur = 75000, refreshOrderFor = null, sustain = "monitor", checksumBefore, cleLibelle = null;
    // `MODE`, `ACT` et `inverted` sont importés de `trame-boisson.mjs` : ils décrivent la TRAME,
    // pas ce gestionnaire, et la page qui affiche cette trame a besoin des mêmes constantes.

    /**
     * **Transférer une recette locale dans un emplacement perso — DEUX écritures persistantes,
     * UNE seule tâche.**
     *
     * `0x83`/`SAVE_BEVERAGE` pose les réglages dans l'emplacement, `0xAB` y pose le nom de la
     * recette et son dessin. Une tâche de deux pas et non deux tâches, parce que c'est **un** geste
     * et qu'un transfert à moitié fait — réglages posés, nom pas posé — est exactement ce qu'il ne
     * faut pas laisser passer inaperçu : la file le mènerait alors comme deux demandes sans rapport,
     * dont l'une peut échouer pendant que l'autre réussit.
     *
     * Ce qui part est décidé par `planTransfert` (`src/lib/transfert.mjs`, pur, prouvé par
     * `verif-transfert.mjs`) et **jamais ici** : un ingrédient que la recette n'a pas doit être
     * écrit ABSENT et non omis, sans quoi celui de la recette précédente resterait en place.
     *
     * Cette branche sort avant le constructeur à trame unique plus bas — elle est la seule commande
     * qui en met deux en file.
     */
    if (b.action === "transferToSlot") {
      const brut = m.store.listRecipes().find((x) => String(x.id) === String(b.recipeId));
      if (!brut) return raw(res, JSON.stringify({ error: "recette inconnue" }), 404);
      const slot = Number(b.slot);
      const cible = m.catalog.beverages.find((x) => customSlotOf(x.slug) === slot) ?? null;
      if (!cible) return raw(res, JSON.stringify({ error: `emplacement perso ${b.slot} inconnu sur ${m.catalog.model.type}` }), 400);
      // ⚠️ Même refus que l'écriture de noms : le pas de 22 octets d'un Striker n'est pas porté, et
      // écrire au mauvais pas décalerait tous les noms suivants.
      if (m.gen === "striker") return raw(res, JSON.stringify({ error: "transfert non porté pour la génération Striker (pas de 22 octets)" }), 400);
      const rec = normaliseRecette(brut, m.catalog.byId(Number(brut.beverageId)) ?? null);
      const prof = Number(b.profileId ?? rec.profileId) || 1;
      if (!(prof >= 1 && prof <= m.catalog.model.nProfiles)) {
        return raw(res, JSON.stringify({ error: `profil ${prof} invalide (ce modèle en a ${m.catalog.model.nProfiles})` }), 400);
      }
      const nom = String(rec.name ?? "").trim();
      if (!nom) return raw(res, JSON.stringify({ error: "recette sans nom : c'est lui qui nommerait l'emplacement" }), 400);
      // Tronquer serait pire que refuser : l'emplacement porterait un nom que l'utilisateur n'a pas
      // choisi, et la trame en compte exactement 20.
      if (nom.length > 20) return raw(res, JSON.stringify({ error: "nom limité à 20 caractères" }), 400);
      const plan = planTransfert({ params: rec.params, cibleParams: cible.ingredients });
      if (!plan.possible) {
        return raw(res, JSON.stringify({
          error: plan.raison === "hotWaterNotInCustomSlot"
            ? "un emplacement perso ne déclare ni eau chaude ni thé : cette recette ne peut pas y être transférée"
            : "cette recette n'a aucun ingrédient que l'emplacement puisse recevoir",
          raison: plan.raison,
        }), 409);
      }
      /**
       * L'icône est obligatoire dans la trame (21e octet), et **nom et icône voyagent dans la même
       * entrée** : écrire l'un réécrit l'autre. Celle de la recette d'abord ; à défaut celle que
       * l'emplacement porte déjà, ce qui la préserve au lieu de l'inventer ; à défaut on refuse.
       * Envoyer 0 poserait silencieusement un dessin que personne n'a choisi.
       */
      const nomsLus = readNames(m.store.machineView(), "customNames");
      const icone = rec.icon != null ? rec.icon : nomsLus[slot]?.icon;
      if (!Number.isInteger(icone)) {
        return raw(res, JSON.stringify({
          error: "aucune image pour cette recette, et l'emplacement n'en a pas de lue : en choisir une, ou lire les noms d'abord",
          needsIcon: true,
        }), 409);
      }

      const fSave = frameDispense(cible.id, prof, MODE.DONTCARE, ACT.SAVE, plan.params);
      const fNom = frameSetNames(0xab, slot, slot, [{ name: nom, icon: icone }]);
      const libelle = `Transférer « ${nom} » dans l'emplacement perso ${slot} (profil ${prof})`;
      const t = enfilerTache(m, tache({
        label: libelle,
        rang: RANG.COMMANDE,
        pas: [
          pasPourTrame(`Réglages de « ${nom} » → emplacement ${slot}`, datapointValue(fSave), 20000, "monitor"),
          pasPourTrame(`Nom et image de l'emplacement ${slot}`, datapointValue(fNom), 20000, "monitor"),
        ],
        // Deux transferts de la MÊME recette vers le MÊME emplacement n'en font qu'un ; vers deux
        // emplacements différents, ce sont deux gestes distincts et ils gardent deux lignes.
        cle: `transfert:${rec.id}:${slot}`,
        i18n: { k: "transferToSlot", p: { nom, slot, profil: prof } },
        genre: "commande",
      }), `${libelle} — ${plan.params.length} réglage(s), ${plan.retires.length} retiré(s)`);

      /**
       * **La machine ne repousse rien après un `0xAB`**, donc sans relecture notre cache garderait
       * l'ancien nom de l'emplacement indéfiniment — l'écriture réussirait et la page continuerait
       * d'affirmer le contraire. Même raisonnement et même bloc unique que `/api/profiles/name`.
       *
       * Le `0x83`, lui, n'en a pas besoin : l'appareil pousse spontanément les cinq profils après
       * une écriture de recette (voir `beverages.mjs`, § recettes perso par profil).
       */
      const bloc = CUSTOM_NAME_PROPS
        .filter((x) => x.stride === STRIDE_CLASSIC && x.first <= slot)
        .sort((a, b2) => b2.first - a.first)[0] ?? null;
      const relecture = bloc ? startImport(m, [bloc.prop], 0, { i18n: { k: "readOne", p: { prop: bloc.prop } } }) : null;

      const reg = await postLocalReg(m);
      return raw(res, JSON.stringify({
        sent: true, slot, target: cible.id, name: nom, icon: icone, profileId: prof,
        // Ce que le report a changé, dit et non subi : l'interface le montre dans sa confirmation.
        plan: { params: plan.params, retires: plan.retires, absents: plan.absents },
        reread: bloc?.prop ?? null, rereadTaskId: relecture?.taskId ?? null,
        register: reg, ...tacheRendue(t),
      }));
    }

    try {
      if (b.action === "on") { frame = frameTurnOn(); label = "Allumer"; cleLibelle = { k: "on" }; sustain = "profile"; }
      else if (b.action === "off") { frame = frameTurnOff(); label = "Éteindre"; cleLibelle = { k: "off" }; dur = 20000; }
      else if (b.action === "saveToProfile") {
        // Écriture PERSISTANTE dans la machine : remplace la recette enregistrée de ce profil.
        // Port de DeLonghiWifiConnectService:2959 — mode DONTCARE, action SAVE_BEVERAGE, et le
        // profil visé est encodé dans le dernier octet ((profileId << 2) | action).
        const bev = Number(b.beverageId);
        const prof = Number(b.profileId ?? 1);
        const params = b.params ?? [];
        if (!m.catalog.byId(bev)) return raw(res, JSON.stringify({ error: `boisson ${bev} inconnue sur ${m.catalog.model.type}` }), 400);
        if (!(prof >= 1 && prof <= m.catalog.model.nProfiles)) return raw(res, JSON.stringify({ error: `profil ${prof} invalide (ce modèle en a ${m.catalog.model.nProfiles})` }), 400);
        if (!params.length) return raw(res, JSON.stringify({ error: "aucun paramètre à enregistrer" }), 400);
        frame = frameDispense(bev, prof, MODE.DONTCARE, ACT.SAVE, params);
        label = `Enregistrer ${bevLabel(m, bev)} dans le profil ${prof}`;
        // ⚠️ Fusionner `p`, ne PAS étaler `bevRef` par-dessus : voir le commentaire de `bevRef`.
        const rSave = bevRef(m, bev);
        cleLibelle = { k: "saveToProfile", p: { profil: prof, ...(rSave.p ?? {}) }, refs: rSave.refs };
        dur = 20000;
        // On renvoie la somme de contrôle du profil AVANT écriture : la redemander ensuite
        // (POST /api/checksums) permet de vérifier que la machine a bien enregistré, au lieu de
        // supposer que l'envoi a suffi.
        checksumBefore = m.store.getMeta("checksums")?.profiles?.[prof] ?? null;
      }
      else if (b.action === "selectProfile") {
        m.activeProfile = Number(b.profileId ?? 1);
        m.activeProfileConfirmed = true;
        rememberActiveProfile(m);
        sustain = "profile";
        frame = frameSendProfile(m.activeProfile);
        label = `Profil ${m.activeProfile}`;
        cleLibelle = { k: "selectProfile", p: { profil: m.activeProfile } };
        // Fenêtre courte : juste après, on relit l'ordre d'affichage de ce profil pour que
        // l'UI ne montre pas un ordre périmé (une seule propriété, c'est rapide).
        dur = 10000;
        refreshOrderFor = m.activeProfile;
      }
      else if (b.action === "selectBean") { frame = frameSelectBean(Number(b.beanId ?? 1)); label = `Bean ${b.beanId}`; cleLibelle = { k: "selectBean", p: { index: Number(b.beanId ?? 1) } }; dur = 20000; }
      else if (b.action === "stop") { frame = frameDispense(Number(b.beverageId ?? 1), Number(b.profileId ?? 1), MODE.STOPV2, ACT.PREPARE, []); label = "Arrêt"; cleLibelle = { k: "stop" }; dur = 15000; }
      else if (b.action === "dispense") {
        let bev, prof, params;
        if (b.recipeId) { const r = m.store.listRecipes().find((x) => x.id === b.recipeId); if (!r) return raw(res, JSON.stringify({ error: "recette inconnue" }), 404); ({ beverageId: bev, profileId: prof, params } = r); }
        else { bev = Number(b.beverageId ?? 1); prof = Number(b.profileId ?? 1); params = b.params ?? []; }
        m.activeProfile = Number(prof) || 1;
        m.activeProfileConfirmed = true;
        rememberActiveProfile(m);
        const act = actionPreparer(params);
        frame = frameDispense(bev, prof, MODE.START, act, params);
        label = `Préparer ${bevLabel(m, bev)}${act === ACT.PREPARE_INVERSION ? " (lait d'abord)" : ""}`;
        const r = bevRef(m, bev);
        cleLibelle = { k: "dispense", p: { inversion: act === ACT.PREPARE_INVERSION ? 1 : 0, ...(r.p ?? {}) }, refs: r.refs };
      } else return raw(res, JSON.stringify({ error: "action inconnue" }), 400);
    } catch (e) { return raw(res, JSON.stringify({ error: e.message }), 400); }
    const ecamB64 = datapointValue(frame);
    /**
     * **Le rang, et c'est ici que la politique de priorité entre dans le monde réel.** L'arrêt est
     * le seul geste qui ne peut pas attendre : il agit sur une machine qui coule. Tout le reste des
     * commandes passe devant les lectures sans jamais couper une autre commande.
     */
    const rang = b.action === "stop" ? RANG.URGENT : RANG.COMMANDE;
    /**
     * **Marquer la préparation, parce que c'est la seule chose qu'« Arrêter » puisse arrêter.**
     * `program.active` dit qu'une tâche tourne — depuis la file, une lecture en est une. Allumer
     * ce bouton là-dessus proposerait d'interrompre un balayage de compteurs avec une trame d'arrêt
     * de boisson. Le drapeau ne connaît que ce que CE serveur a mis en file : une boisson lancée au
     * panneau de la machine reste invisible, comme avant la file.
     */
    // Même règle que pour une commande relayée par une application, et c'est le point : deux
    // sélections du même profil n'en font qu'une, qu'elles viennent d'un téléphone, de deux
    // onglets, ou d'un téléphone et d'un onglet. Une règle par émetteur aurait fusionné ici et
    // pas là, pour la même trame.
    const t = startProgram(m, ecamB64, label, dur, sustain, { rang, cle: cleFusion(ecamB64), i18n: cleLibelle, meta: b.action === "dispense" ? { dispense: true } : null });
    // La file de lecture est écoulée quand aucun programme n'est actif : elle s'enchaîne donc
    // naturellement après la fenêtre du programme ci-dessus.
    if (refreshOrderFor) {
      const p = refreshOrderFor;
      startImport(m, [`d${String(260 + p).padStart(3, "0")}_${p}_rec_priority`], 0, { label: `Ordre d'affichage du profil ${p}`, i18n: { k: "displayOrder", p: { profil: p } } });
    }

    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ program: label, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg, ...tacheRendue(t), ...(checksumBefore !== undefined ? { checksumBefore } : {}) }));
  }
  // Catalogue des boissons de la machine + ce qui a été lu dessus.
  if (url === "/api/beverages" && req.method === "GET") {
    const store = m.store.machineView();
    const profileId = Number(new URL(req.url, "http://x").searchParams.get("profile") ?? 1);
    const beverages = vueBoissons(m, store, profileId);
    // Ordre d'affichage de la machine pour ce profil (propriété de priorité), s'il est connu.
    const prioProp = `d${String(260 + profileId).padStart(3, "0")}_${profileId}_rec_priority`;
    const order = store.props[prioProp]?.beverageIds ?? null;
    return raw(res, JSON.stringify({
      model: { key: m.catalog.key, type: m.catalog.model.type, appModelId: m.catalog.model.appModelId, productCode: m.catalog.model.productCode, nProfiles: m.catalog.model.nProfiles, protocolVersion: m.catalog.model.protocolVersion, fallback: m.catalog.fallback },
      categories: CATEGORIES, profileId, beverages, order, orderProp: prioProp,
      importedAt: store.importedAt,
      // Déduit de la file : la lecture en cours, ou la dernière terminée si plus rien ne tourne —
      // c'est `active` qui les distingue. Auparavant un import expiré dans le vide restait « en
      // cours » pour toujours et maintenait la page en relecture.
      import: vueLecture(m),
    }));
  }

  // Import : lit sur la machine les bornes et/ou les recettes du profil, en LAN pur.
  /**
   * **Tout lire, en une fois.** Six familles de données, six tâches, dans l'ordre où elles se
   * rendent service : la présence d'abord (l'état de la machine s'affiche tout de suite), le
   * modèle ensuite (c'est lui qui choisit le catalogue), puis les sommes, les profils, les
   * boissons du profil actif, les grains, et enfin le balayage complet des compteurs.
   *
   * **Cet endpoint n'était pas réalisable avant la file.** Chacune de ces lectures écrivait dans
   * l'emplacement unique `m.import` ou `m.program` : les enchaîner, c'était les écraser l'une après
   * l'autre, et seule la dernière survivait. C'est le premier usage qui ne demandait rien d'autre
   * que de pouvoir mettre plusieurs choses en file.
   *
   * Rien n'est préparé ni écrit : ce ne sont que des lectures, toutes de rang LECTURE — une
   * commande utilisateur passera donc devant sans avoir à attendre les quatre minutes du balayage.
   */
  if (url === "/api/readall" && req.method === "POST") {
    const p = m.activeProfile || 1;
    const taches = [];
    const ajouter = (r) => { if (r?.ok) taches.push({ id: r.taskId, position: r.position }); };

    ajouter(startProgram(m, datapointValue(frameMonitorRequest()), "Présence", DELAI_PRESENCE, "monitor", { cle: "presence", i18n: { k: "presence" } }));
    ajouter(startImport(m, [SERIAL_PROP], 0, { label: "Modèle (numéro de série)", i18n: { k: "model" } }));
    ajouter(startProgram(m, datapointValue(frameChecksums()), "Sommes de contrôle", 15000, "monitor", { cle: "checksums", i18n: { k: "checksums" } }));

    // Profils : les deux familles de noms plus l'ordre des favoris. `force` implicite — on relit
    // tout, c'est la demande ; les sommes de contrôle ne court-circuitent rien ici.
    const profs = [...PROFILE_NAME_PROPS, ...CUSTOM_NAME_PROPS, ...PRIORITY_PROPS].map((x) => x.prop);
    ajouter(startImport(m, profs, 0, { label: "Profils · noms et ordre", i18n: { k: "profilesNamesOrder" } }));

    // Boissons : bornes (caractéristiques du modèle) ET valeurs du profil actif.
    const bev = [];
    for (const x of m.catalog.beverages) {
      if (x.bounds) bev.push(x.bounds);
      const vp = m.catalog.profileProp(x, p);
      if (vp) bev.push(vp);
    }
    // Même raison qu'à `/api/beverages/import` : attribut de la boisson 200, lu avec les boissons.
    bev.push(BEAN_SYNC_PROP);
    if (bev.length) ajouter(startImport(m, bev, 0, { label: `Boissons · profil ${p}`, i18n: { k: "beverages", p: { profil: p } } }));

    ajouter(scanBeans(m, 0, 5));
    ajouter(scanStats(m, STAT_RANGES.all.map(([id, qty]) => ({ id, qty }))));

    const pas = m.file.liste.reduce((n, t) => n + t.pas.length, 0);
    L("sys", "lecture", `complète demandée : ${taches.length} tâches, ${pas} pas en file`, m);
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ tasks: taches, count: taches.length, steps: pas, profileId: p, register: reg }));
  }

  if (url === "/api/beverages/import" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const profileId = Number(b.profileId ?? 1);
    const what = b.what ?? "all"; // "bounds" | "values" | "all"
    const ids = Array.isArray(b.beverageIds) && b.beverageIds.length ? b.beverageIds.map(Number) : m.catalog.beverages.map((x) => x.id);
    const queue = [];
    for (const id of ids) {
      const bev = m.catalog.byId(id);
      if (!bev) continue;
      if (what !== "values" && bev.bounds) queue.push(bev.bounds);
      if (what !== "bounds") { const vp = m.catalog.profileProp(bev, profileId); if (vp) queue.push(vp); }
    }
    if (!queue.length) return raw(res, JSON.stringify({ error: "rien à lire" }), 400);

    // Le nom d'un Bean Adapt ne vient pas d'une propriété de recette mais de la commande ECAM
    // 0xBA. Si la lecture concerne la boisson 200, on l'enchaîne : programme court d'abord, puis
    // la file de lecture s'écoule.
    const beanIndex = ids.includes(200) ? 1 : null;
    // Le grain sélectionné est un ATTRIBUT de la boisson 200 (voir `activeBeanSystem`), donc il se
    // lit avec elle et sous son étiquette — pas dans une tâche à part, qui aurait exigé une clé de
    // traduction pour un seul mot et une deuxième ligne dans « Activité ».
    if (beanIndex !== null) queue.push(BEAN_SYNC_PROP);
    const t = startImport(m, queue, 0, { label: `Boissons · profil ${profileId}`, i18n: { k: "beverages", p: { profil: profileId } } });
    // Même `cle` que la lecture de Bean System de `/api/beanadapt` : c'est LA MÊME demande, la
    // même trame 0xBA sur le même index. Sans elle, ouvrir `/` pendant une lecture de grains en
    // relançait une seconde, et les deux verdicts s'empilaient dans « Activité » au lieu de se
    // replier. Deux chemins vers une demande doivent produire la même clé, sinon la fusion ne
    // protège que celui qui y a pensé.
    if (beanIndex !== null) {
      startProgram(m, datapointValue(frameBeanSystem(beanIndex)), `Bean System ${beanIndex}`, 12000, "monitor", { cle: `bean:${beanIndex}`, i18n: { k: "beanSystem", p: { index: beanIndex } } });
    }
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ queued: queue.length, profileId, what, beanSystem: beanIndex, register: reg, ...tacheRendue(t) }));
  }

  // Profils : noms, icônes, noms des recettes perso, ordre des favoris.
  if (url === "/api/profiles" && req.method === "GET") {
    const store = m.store.machineView();
    const names = readNames(store, "profileNames");
    const customNames = readNames(store, "customNames");
    // La machine nomme d'office les profils jamais personnalisés (« Profil 4 »). On distingue
    // ce nom par défaut d'un vrai nom choisi par l'utilisateur : la page / n'affiche que
    // les profils réellement renommés.
    const isDefaultName = (n) => n == null || /^profil(e)?\s*\d+$/i.test(n.trim());
    // Une seule fois pour les cinq profils : la table des noms SAISIS sur la machine, celle qui
    // doit primer sur le catalogue partout où une boisson est nommée.
    const persoNames = machineBeverageNames(store);
    const profiles = Array.from({ length: m.catalog.model.nProfiles }, (_, i) => {
      const id = i + 1;
      const prio = PRIORITY_PROPS.filter((x) => x.profileId === id)
        .map((x) => store.props[x.prop])
        .find((d) => d?.beverageIds?.length);
      const name = names[id]?.name ?? null;
      return {
        id,
        name,
        renamed: name != null && !isDefaultName(name),
        icon: names[id]?.icon ?? null,
        source: names[id]?.prop ?? null,
        /**
         * **L'ordre des favoris porte de quoi nommer la boisson SANS recopier notre français.**
         *
         * Il n'émettait qu'un `label` — le libellé français du catalogue — que `/profils` rendait
         * brut. Deux défauts pour le prix d'un : la chaîne n'était pas traduisible, et surtout
         * elle **contournait `machineBeverageNames`**, donc un emplacement perso renommé sur la
         * machine s'affichait ici sous son nom d'usine. C'est exactement la divergence que
         * `/api/beverages` avait déjà corrigée — « Recette perso 1 » d'un côté, « Lacteso » de
         * l'autre — reproduite sur l'autre page.
         *
         * On envoie donc le `slug` (identifiant, traduit côté client) et le `machineName` quand il
         * existe (saisi par l'utilisateur, jamais traduit). `label` reste, en repli.
         */
        order: prio
          ? prio.beverageIds.map((bid) => ({
              id: bid,
              slug: m.catalog.byId(bid)?.slug ?? null,
              label: m.catalog.byId(bid)?.label ?? null,
              machineName: persoNames[bid]?.name ?? null,
            }))
          : null,
      };
    });
    // Le nombre d'emplacements perso dépend du modèle : 6 sur un PD_SOUL, 3 sur un PD_SOUL_BETTER.
    const customs = Array.from({ length: m.catalog.model.nCustomRecipes }, (_, i) => i + 1).map((n) => ({
      slot: n,
      beverageId: 229 + n,
      name: customNames[n]?.name ?? null,
      icon: customNames[n]?.icon ?? null,
      source: customNames[n]?.prop ?? null,
    }));
    return raw(res, JSON.stringify({
      // `namesCustomizable` / `iconsCustomizable` : drapeaux du catalogue extrait de l'APK. Ils
      // décident si la page propose de renommer — sur un modèle qui dit non, la trame `0xA5`
      // partirait quand même, et on ignore ce qu'elle y ferait.
      model: { key: m.catalog.key, type: m.catalog.model.type, nProfiles: m.catalog.model.nProfiles, customizableProfiles: m.catalog.model.customizableProfiles, nCustomRecipes: m.catalog.model.nCustomRecipes, namesCustomizable: m.catalog.model.profileNamesCustomizable !== false, iconsCustomizable: m.catalog.model.profileIconsCustomizable !== false },
      profiles, customs,
      props: ALL_PROFILE_PROPS.map((x) => {
        const d = store.props[x.prop];
        return { prop: x.prop, kind: x.kind, stride: x.stride ?? null, state: !d ? "unread" : d.absent ? "absent" : "read" };
      }),
      importedAt: store.importedAt,
      // Déduit de la file : la lecture en cours, ou la dernière terminée si plus rien ne tourne —
      // c'est `active` qui les distingue. Auparavant un import expiré dans le vide restait « en
      // cours » pour toujours et maintenait la page en relecture.
      import: vueLecture(m),
    }));
  }

  if (url === "/api/profiles/import" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const what = b.what ?? "all"; // "names" | "customNames" | "order" | "all"
    const force = b.force === true;

    // Optimisation par sommes de contrôle (réponse 0xA3) : si la somme des noms n'a pas bougé
    // depuis le dernier import réussi, les relire ne peut rien apprendre. `force` court-circuite.
    const store = m.store.machineView();
    const stale = staleFromChecksums(store);
    const skipped = [];
    const namesFresh = !force && stale?.names === false;
    const customFresh = !force && stale?.customRecipes === false;

    const queue = [];
    if (what === "all" || what === "names") {
      if (namesFresh) skipped.push("noms (somme inchangée)");
      else queue.push(...PROFILE_NAME_PROPS.map((x) => x.prop));
    }
    if (what === "all" || what === "customNames") {
      // Les noms des recettes perso sont couverts par la même somme « noms ».
      if (namesFresh) skipped.push("noms des recettes perso (somme inchangée)");
      else queue.push(...CUSTOM_NAME_PROPS.map((x) => x.prop));
    }
    // Les sommes ne couvrent PAS l'ordre des favoris : rien ne permet de le court-circuiter.
    if (what === "all" || what === "order") queue.push(...PRIORITY_PROPS.map((x) => x.prop));

    if (!queue.length) {
      return raw(res, JSON.stringify({ queued: 0, what, skipped, upToDate: true, customFresh }));
    }
    // La marque « à jour » est posée à la FIN de l'import (`applyChecksumMark`), et seulement sur
    // les familles que cet import lit vraiment.
    //
    // ⚠️ Avant, tout `store.checksums` était recopié dans `checksumsAtImport` dès l'ENVOI. Deux
    // conséquences fausses : un import qui échouait (machine injoignable) marquait quand même les
    // noms comme frais, et un import `what:"order"` — qui ne lit aucun nom — les marquait aussi.
    // Dans les deux cas la relecture des noms était ensuite sautée (« somme inchangée »), et seul
    // `force:true` s'en sortait. Les sommes ne couvrant pas l'ordre des favoris, `what:"order"`
    // ne marque désormais rien du tout.
    const covered = queue.filter((p) => NAME_PROPS.has(p));
    const meta = store.checksums && covered.length ? { checksumMark: { names: store.checksums.names } } : null;
    const t = startImport(m, queue, 0, { label: `Profils · ${what}`, meta, i18n: { k: "profilesWhat", refs: { quoi: { ns: "profilesWhat", cle: String(what) } } } });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ queued: queue.length, what, skipped, register: reg, ...tacheRendue(t) }));
  }

  // Sommes de contrôle : demande la trame 0xA3 à la machine.
  if (url === "/api/checksums" && req.method === "POST") {
    const frame = frameChecksums();
    const t = startProgram(m, datapointValue(frame), "Sommes de contrôle", 15000, "monitor", { cle: "checksums", i18n: { k: "checksums" } });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ sent: true, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg, ...tacheRendue(t) }));
  }
  if (url === "/api/checksums" && req.method === "GET") {
    const store = m.store.machineView();
    return raw(res, JSON.stringify({
      checksums: store.checksums ?? null,
      previous: store.checksumsPrev ?? null,
      changed: diffChecksums(store.checksumsPrev, store.checksums),
      // Ce qu'on avait relevé au moment du dernier import réussi de chaque famille.
      atImport: store.checksumsAtImport ?? null,
      stale: staleFromChecksums(store),
    }));
  }

  // Fiche technique : ce qu'on peut lire en local + le relevé cloud figé + notre état protocole.
  if (url === "/api/system" && req.method === "GET") {
    const store = m.store.machineView();
    // Sondes indépendantes : en série, la page cumulait les délais d'attente (4 s + 8 s).
    const live = await probeRegtoken(m);
    const cloud = cloudOtaState(m);
    return raw(res, JSON.stringify({
      deviceSheet: DEVICE_SHEET,
      // Fiche du catalogue EN SERVICE, sans la liste des recettes : elle fait 28 entrées ici et 48
      // sur une Striker, personne ne les lit dans cette réponse, et /api/beverages les sert déjà.
      model: {
        ...modelSheet(m.catalog.key),
        nBeverages: m.catalog.beverages.length,
        /** Vrai si ce catalogue n'est pas celui du modèle détecté, mais un remplaçant. */
        fallback: m.catalog.fallback,
        detectedKey: m.modelKey,
      },
      identification: modelState(m),
      network: {
        machineIp: m.ip,
        serverIp: CFG.serverIp,
        serverPort: CFG.port,
        generation: m.gen,
        dsn: m.dsn,
        dsnSource: m.dsnSource,
        note: "La machine est sur un VLAN IoT isolé ; le LAN mode exige que machine → serveur soit permis.",
      },
      local: live,
      protocol: {
        lanKeyId: m.lanKeyId,
        lanKeySet: m.lanKey.length > 0,
        lanKeySource: m.lanKeySource,
        sessionActive: !!m.session,
        lastRegisterAt: m.lastRegisterAt,
        keepaliveMs: 2500,
        sendProperty: m.send,
        monitorProperty: m.mon,
        crypto: "AES-256-CBC en flux persistant, clés dérivées par double HMAC-SHA256",
        activeProfile: m.activeProfile,
        activeProfileConfirmed: m.activeProfileConfirmed,
      },
      ota: {
        lanRequests: m.otaRequests,
        lanNote: "En mode LAN, c'est la machine qui vient chercher l'image chez nous : aucune requête reçue signifie qu'aucun OTA n'est distribué par ce serveur.",
        cloud,
      },
      // Le stockage fait partie de la fiche technique : savoir quel moteur tourne, dans quelle
      // version de schéma et avec combien de lignes évite d'ouvrir le fichier pour le vérifier.
      storage: storageInfo(),
      machineState: {
        lastMonitor: m.lastMonitor,
        lastDataResponse: m.lastDataResponse,
        checksums: store.checksums ?? null,
        serialNumber: store.props?.d270_serialnumber ?? null,
        propsRead: Object.keys(store.props ?? {}).length,
        importedAt: store.importedAt ?? null,
      },
    }));
  }

  // Lecture d'un profil Bean System (nom + mouture/température/arôme) — commande ECAM 0xBA.
  if (url === "/api/beansystem" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const index = Number(b.index ?? 1);
    const frame = frameBeanSystem(index);
    const t = startProgram(m, datapointValue(frame), `Bean System ${index}`, 15000, "monitor", { cle: `bean:${index}`, i18n: { k: "beanSystem", p: { index } } });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ sent: true, index, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg, ...tacheRendue(t) }));
  }
  if (url === "/api/beansystem" && req.method === "GET") {
    return raw(res, JSON.stringify({ beanSystems: m.store.allBeanSystems() }));
  }

  /**
   * Identification du modèle. GET rapporte ce qu'on sait (y compris avant toute lecture) ; POST
   * demande `d270_serialnumber` à la machine — une LECTURE, aucune préparation, aucune écriture.
   */
  if (url === "/api/model" && req.method === "GET") {
    return raw(res, JSON.stringify(modelState(m)));
  }
  if (url === "/api/model" && req.method === "POST") {
    const t = startImport(m, [SERIAL_PROP], 0, { label: "Modèle (numéro de série)", i18n: { k: "model" } });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ queued: true, prop: SERIAL_PROP, register: reg, ...tacheRendue(t) }));
  }

  // Lecture de propriétés Ayla arbitraires — outil d'exploration, et brique de /api/presence.
  if (url === "/api/read" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const props = Array.isArray(b.props) ? b.props.filter((x) => typeof x === "string" && x) : [];
    if (!props.length) return raw(res, JSON.stringify({ error: "aucune propriété demandée" }), 400);
    const t = startImport(m, props, 0);
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ queued: props.length, props, register: reg, ...tacheRendue(t) }));
  }

  /**
   * Établit une session LAN pour rafraîchir l'état : on s'annonce, la machine se connecte, et on
   * lui sert une demande de monitor (lecture pure) pour qu'elle nous pousse son état marche/veille.
   * Appelé quand une page s'ouvre — sans ça le monitor peut dater de plusieurs heures.
   *
   * Volontairement **idempotent et étranglé** : plusieurs onglets qui s'ouvrent ne doivent pas
   * déclencher plusieurs programmes concurrents ni marteler la machine.
   */
  if (url === "/api/presence" && req.method === "POST") {
    const now = Date.now();
    /**
     * **`force` : le geste explicite ne se fait pas étrangler.** Les trois garde-fous ci-dessous
     * existent pour l'appel AUTOMATIQUE — ouvrir quatre onglets ne doit pas ouvrir quatre sessions.
     * Mais quand quelqu'un clique « Lire l'état », il clique précisément parce que l'état affiché
     * lui paraît absent ou périmé : lui répondre « monitor récent, ignoré » serait répondre le
     * contraire de ce qu'il demande. La fusion sur `cle: "presence"` reste, elle : deux clics
     * rapides ne font toujours qu'une tâche.
     */
    const force = (JSON.parse((await readBody(req)).toString("utf8") || "{}")).force === true;
    const fresh = !force && m.lastMonitor && now - m.lastMonitor.at < 30000;
    // Même règle : sur le drapeau brut, une machine qui a cessé de répondre restait « occupée »
    // pour toujours et cette relance — la seule qui puisse rétablir l'état — était refusée à
    // jamais avec « programme en cours ».
    // « Occupé » veut simplement dire qu'il y a déjà du travail en file : inutile d'y ajouter une
    // présence, la machine va de toute façon venir chercher ce qui s'y trouve.
    const busyAlready = !force && !vide(m.file);
    if (fresh || busyAlready) {
      return raw(res, JSON.stringify({ skipped: true, reason: fresh ? "monitor récent" : "programme en cours", lastMonitor: m.lastMonitor }));
    }
    // 8 s : assez pour ne pas marteler, assez court pour qu'une relance de la page passe. La
    // machine ne pousse pas toujours son monitor à la première session (comportement transitoire
    // déjà observé), donc une seconde tentative doit être possible.
    if (!force && now - (m.lastPresenceAt ?? 0) < 8000) {
      return raw(res, JSON.stringify({ skipped: true, reason: "présence déjà demandée récemment", lastMonitor: m.lastMonitor }));
    }
    m.lastPresenceAt = now;
    const t = startProgram(m, datapointValue(frameMonitorRequest()), "Présence", DELAI_PRESENCE, "monitor", { cle: "presence", i18n: { k: "presence" } });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ started: true, register: reg, ...tacheRendue(t) }));
  }

  // Bean Adapt : bornes + profils lus, et la règle d'ajustement rejouée LOCALEMENT.
  /**
   * Lit toute la liste des grains d'un coup. Chaque profil exige sa propre commande `0xBA` : la
   * propriété `d(250+n)_beansystem_n` reste vide tant qu'on ne l'a pas envoyée. On enchaîne donc
   * les programmes, un par index.
   */
  if (url === "/api/beanadapt/scan" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const from = Number(b.from ?? 0);
    const to = Number(b.to ?? 5);
    if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= 9 && to >= from)) {
      return raw(res, JSON.stringify({ error: "plage d'index invalide" }), 400);
    }
    // Plus de refus « un balayage est déjà en cours » : la file l'encaisse, et la clé de fusion
    // empêche deux balayages identiques de coexister. Refuser était l'aveu qu'un deuxième aurait
    // écrasé le premier.
    const t = scanBeans(m, from, to);
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ started: t.ok, from, to, register: reg, ...tacheRendue(t) }));
  }

  if (url === "/api/beanadapt" && req.method === "GET") {
    /* Le visuel de chaque emplacement voyage AVEC la liste : la date joue le rôle de version dans
       l'URL de la vignette, exactement comme pour les configurations mémorisées. */
    const beans = vueBeansMachine(m);
    return raw(res, JSON.stringify({
      beans,
      // La bibliothèque locale, servie avec les grains de la machine : la page les montre côte à
      // côte, une seule requête suffit.
      presets: vueBeanPresets(m),
      bounds: {
        grinder: { min: GRINDER_MIN, max: GRINDER_MAX, verified: true },
        aroma: { min: AROMA_MIN, max: AROMA_MAX, verified: true },
        temperature: { min: TEMPERATURE_MIN, max: TEMPERATURE_MAX, verified: false },
      },
      activeProfile: m.activeProfile,
      scan: machineActivity(m).beanScan,
      /**
       * **Ce que la MACHINE mesure pour l'affinage** — et c'est la seule source honnête des deux.
       *
       * L'assistant demandait le temps d'écoulement au clavier. Or l'appareil le chronomètre
       * lui-même et nous l'envoie déjà dans `d260_beansystem_sync_par` : le taper, c'est remplacer
       * une mesure par un souvenir. Le compteur d'espressos qui l'accompagne est le verrou de
       * l'app officielle (voir `affinagePermis`).
       *
       * `null` partout tant que la propriété n'est pas arrivée — l'interface dit « pas encore lu »,
       * elle n'invente pas un zéro.
       */
      sync: vueBeanSync(m),
    }));
  }

  /**
   * Bibliothèque locale de configurations de grains. **Rien n'est envoyé à la machine ici** : ces
   * entrées ne servent qu'à mémoriser des réglages, et c'est `/api/beanadapt/save` qui en écrit un
   * dans un emplacement.
   *
   * Les bornes sont vérifiées à l'enregistrement et pas seulement à l'écriture : mémoriser un
   * réglage inapplicable ne servirait qu'à faire échouer l'écriture plus tard, loin de la saisie.
   */
  if (url === "/api/beanpresets" && req.method === "GET") {
    return raw(res, JSON.stringify({ presets: vueBeanPresets(m) }));
  }

  /**
   * L'image d'une configuration mémorisée, servie par son **URL propre** et non dans le JSON de la
   * liste : le navigateur la met alors en cache, et ouvrir la page ne retransporte pas les images
   * de toutes les configurations à chaque fois.
   *
   * Revalidation à chaque affichage (`must-revalidate`) plutôt qu'une durée de vie : l'identifiant
   * ne change pas quand on remplace l'image, donc une image mise en cache pour une heure resterait
   * l'ancienne. L'`ETag` porte la date d'écriture, ce qui rend la réponse à cette revalidation
   * gratuite — un 304 sans corps.
   */
  if (url === "/api/beanpresets/image" && req.method === "GET") {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    const img = m.store.getBeanImage(String(id ?? ""));
    // 404 franc : une configuration sans image est un cas normal, et servir un substitut ferait
    // croire à l'interface qu'il y en a une.
    if (!img) return raw(res, JSON.stringify({ error: "aucune image pour cette configuration" }), 404);
    const etag = `"${id}-${img.at}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "private, max-age=0, must-revalidate" });
      return res.end();
    }
    return rawBin(res, Buffer.from(img.bytes), img.mime, {
      ETag: etag,
      "Cache-Control": "private, max-age=0, must-revalidate",
    });
  }
  if (url === "/api/beanpresets" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const grinder = Number(b.grinder);
    const temperature = Number(b.temperature);
    const aroma = Number(b.aroma);
    if (!(grinder >= GRINDER_MIN && grinder <= GRINDER_MAX)) return raw(res, JSON.stringify({ error: `mouture hors bornes (${GRINDER_MIN}–${GRINDER_MAX})` }), 400);
    if (!(aroma >= AROMA_MIN && aroma <= AROMA_MAX)) return raw(res, JSON.stringify({ error: `arôme hors bornes (${AROMA_MIN}–${AROMA_MAX})` }), 400);
    if (!(temperature >= TEMPERATURE_MIN && temperature <= TEMPERATURE_MAX)) return raw(res, JSON.stringify({ error: `température hors bornes (${TEMPERATURE_MIN}–${TEMPERATURE_MAX})` }), 400);
    /* La torréfaction est validée contre la MÊME liste que le rail de l'interface, celle de
       `image-grains.mjs`. Un niveau que la table d'images ne nomme pas s'enregistrerait sans
       erreur et n'afficherait aucun visuel — une fiche muette sans cause visible. */
    const roast = b.roast === undefined ? null : b.roast;
    if (!torrefactionValide(roast)) {
      return raw(res, JSON.stringify({ error: `torréfaction inconnue (attendu ${TORREFACTIONS.join(", ")} ou aucune)` }), 400);
    }
    /**
     * L'image, s'il y en a une, est décodée **avant** d'écrire quoi que ce soit.
     *
     * Trois valeurs, trois sens, et ils ne se confondent pas : absente, on ne touche pas à
     * l'image existante ; `null`, on la retire ; une data URL, on la remplace. Sans le cas
     * `null` explicite, retirer une image serait impossible autrement qu'en supprimant la
     * configuration entière.
     *
     * Valider d'abord, écrire ensuite : enregistrer les réglages puis refuser l'image laisserait
     * une configuration à moitié écrite, dont l'utilisateur ne saurait pas ce qu'elle contient.
     */
    let image = null;
    if (b.image !== undefined && b.image !== null) {
      try {
        image = decoderDataUrl(b.image);
      } catch (e) {
        return raw(res, JSON.stringify({ error: e.message, maxBytes: IMAGE_TAILLE_MAX }), 400);
      }
    }
    const entree = putBeanPreset(m, { id: typeof b.id === "string" ? b.id : null, name: b.name, grinder, temperature, aroma, roast });
    if (image) {
      m.store.putBeanImage(entree.id, image.mime, image.bytes);
      L("sys", "grains", `« ${entree.name || "sans nom"} » enregistrée (${image.mime}, ${Math.round(image.bytes.length / 1024)} kio)`, m);
    } else if (b.image === null && m.store.deleteBeanImage(entree.id)) {
      L("sys", "grains", `« ${entree.name || "sans nom"} » retirée`, m);
    }
    const presets = vueBeanPresets(m);
    return raw(res, JSON.stringify({ ok: true, preset: presets.find((x) => x.id === entree.id) ?? entree, presets }));
  }
  if (url === "/api/beanpresets" && req.method === "DELETE") {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    const removed = deleteBeanPreset(m, String(id ?? ""));
    return raw(res, JSON.stringify({ removed, presets: vueBeanPresets(m) }));
  }

  /**
   * **Le visuel d'un emplacement de la machine** — photo et torréfaction. Voir
   * `ID_VISUEL_EMPLACEMENT` pour le pourquoi et pour l'espace de noms.
   *
   * **Rien ne part vers la machine par ces deux routes**, et c'est la raison pour laquelle elles
   * existent au lieu d'un champ de plus dans `/api/beanadapt/save` : cette dernière écrit un profil
   * dans l'appareil, geste physique et persistant. Mêler une préférence d'affichage locale à une
   * écriture machine ferait d'un changement de photo une opération à confirmer, et d'une écriture
   * machine quelque chose qui a l'air anodin. Deux destinations, deux routes.
   */
  if (url === "/api/beans/visual/image" && req.method === "GET") {
    const index = Number(new URL(req.url, "http://x").searchParams.get("index"));
    const img = Number.isInteger(index) ? m.store.getBeanImage(ID_VISUEL_EMPLACEMENT(index)) : null;
    // 404 franc, comme pour une configuration : un emplacement sans photo est un cas normal.
    if (!img) return raw(res, JSON.stringify({ error: "aucune image pour cet emplacement" }), 404);
    /* `ETag` sur la date d'écriture et revalidation à chaque affichage : l'index ne change pas
       quand on remplace la photo, donc une durée de vie resservirait l'ancienne. Le 304 rend la
       revalidation gratuite. Identique à `/api/beanpresets/image`, à la clé près. */
    const etag = `"s${index}-${img.at}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "private, max-age=0, must-revalidate" });
      return res.end();
    }
    return rawBin(res, Buffer.from(img.bytes), img.mime, {
      ETag: etag,
      "Cache-Control": "private, max-age=0, must-revalidate",
    });
  }

  if (url === "/api/beans/visual" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const index = Number(b.index);
    /* Les six emplacements, et pas l'index 0 : ce n'est pas un café mais l'interrupteur
       « Bean Adapt (ON/OFF) », et lui donner une photo de paquet serait décrire un objet qui
       n'existe pas. Borne haute à 6, ce que la machine expose. */
    if (!Number.isInteger(index) || index < 1 || index > 6) {
      return raw(res, JSON.stringify({ error: "emplacement hors bornes (1–6)" }), 400);
    }
    const roast = b.roast === undefined ? null : b.roast;
    if (!torrefactionValide(roast)) {
      return raw(res, JSON.stringify({ error: `torréfaction inconnue (attendu ${TORREFACTIONS.join(", ")} ou aucune)` }), 400);
    }
    /* Décoder avant d'écrire, même règle que pour une configuration : poser la torréfaction puis
       refuser l'image laisserait un visuel à moitié changé, dont personne ne saurait l'état. */
    let image = null;
    if (b.image !== undefined && b.image !== null) {
      try {
        image = decoderDataUrl(b.image);
      } catch (e) {
        return raw(res, JSON.stringify({ error: e.message, maxBytes: IMAGE_TAILLE_MAX }), 400);
      }
    }
    const cle = ID_VISUEL_EMPLACEMENT(index);
    setBeanRoast(m, index, roast);
    let photo = "inchangée";
    if (image) {
      m.store.putBeanImage(cle, image.mime, image.bytes);
      photo = `remplacée (${image.mime}, ${Math.round(image.bytes.length / 1024)} kio)`;
    } else if (b.image === null && m.store.deleteBeanImage(cle)) {
      photo = "retirée";
    }
    L("sys", "grains", `${index} : torréfaction ${roast ?? "aucune"}, photo ${photo}`, m);
    return raw(res, JSON.stringify({
      ok: true,
      index,
      roast,
      imageAt: m.store.beanImageDates()[cle] ?? null,
    }));
  }

  /**
   * **Import des photos que l'app officielle a laissées dans le cloud.** Voir
   * `importerPhotosCloud` pour la clé du datum et ce que l'import écrase.
   *
   * ⚠️ **Le seul endroit de cette page qui sorte du réseau local.** Ce serveur ne parle au cloud
   * que par trois chemins, tous demandés explicitement : la clé LAN, l'OTA, la session. Celui-ci
   * est le quatrième, et il obéit à la même règle — c'est un `POST`, donc un geste, jamais un effet
   * de bord d'un affichage de page.
   *
   * `index` restreint l'import à un emplacement ; sans lui, les six y passent. Même cascade de
   * jeton que `/api/ota` : jeton en mémoire, session mémorisée, identifiants de la requête,
   * `AYLA_TOKEN`.
   */
  if (url === "/api/beans/visual/import" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    let indices;
    if (b.index === undefined || b.index === null) {
      // Les six emplacements de café. L'index 0 est l'interrupteur « Bean Adapt (ON/OFF) » : il n'a
      // pas de paquet, et l'app ne lui associe pas de photo non plus (`id == 0` la renvoie sur son
      // illustration par défaut sans jamais lire de datum).
      indices = [1, 2, 3, 4, 5, 6];
    } else {
      const index = Number(b.index);
      if (!Number.isInteger(index) || index < 1 || index > 6) {
        return raw(res, JSON.stringify({ error: "emplacement hors bornes (1–6)" }), 400);
      }
      indices = [index];
    }
    if (!(await resolveDsn(m, { force: true }))) {
      return raw(res, JSON.stringify({ error: `DSN inconnu, et les photos sont rangées chez Ayla sous ce numéro : ${raisonDsnManquant(m)}`, needsDsn: true }), 409);
    }
    const email = typeof b.email === "string" ? b.email.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const jwt = typeof b.jwt === "string" && b.jwt.trim() ? b.jwt.trim() : null;
    try {
      const token = await aylaToken(m, { email, password, jwt, remember: b.remember === true });
      if (!token) {
        return raw(res, JSON.stringify({ error: "identifiants du compte De'Longhi requis : ces photos ne vivent que côté cloud, et aucune session n'est mémorisée.", needsCredentials: true }), 400);
      }
      const releves = await importerPhotosCloud(m, token, indices);
      return raw(res, JSON.stringify({ ok: true, releves, beans: vueBeansMachine(m) }));
    } catch (e) {
      // Le message vient de Gigya/Ayla ou du DSN manquant, et ne contient aucun identifiant.
      L("sys", "grains", `impossible (${e.message})`, m);
      return raw(res, JSON.stringify({ error: e.message }), 502);
    }
  }

  // Simulation : ce que la règle donnerait, sans rien envoyer à la machine.
  if (url === "/api/beanadapt/simulate" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const current = { grinder: Number(b.grinder), temperature: Number(b.temperature), aroma: Number(b.aroma) };
    if (![current.grinder, current.temperature, current.aroma].every(Number.isFinite)) {
      return raw(res, JSON.stringify({ error: "réglages actuels incomplets" }), 400);
    }
    const flowTime = Number(b.flowTime);
    if (!Number.isFinite(flowTime) || flowTime < 0 || flowTime > 120) {
      return raw(res, JSON.stringify({ error: "temps d'écoulement invalide" }), 400);
    }
    return raw(res, JSON.stringify(computeBeanAdapt(current, { flowTime, crema: Number(b.crema), taste: Number(b.taste) })));
  }

  // Écriture d'un profil Bean System dans la machine (0xBB). Persistant.
  /**
   * **Renommer un profil ou une recette perso — `0xA5` / `0xAB`, persistant.**
   *
   * Pendant exact des lectures `0xA4` / `0xAA` que `profiles.mjs` décode déjà. On n'écrit **qu'une
   * entrée** (`premier = dernier = index`), comme le fait l'app elle-même : réécrire le bloc entier
   * imposerait de connaître les autres noms, donc de faire dépendre un renommage de la fraîcheur du
   * cache — un nom non relu serait écrasé par une valeur périmée.
   *
   * L'icône est obligatoire dans la trame (21e octet). Faute de valeur fournie, on reprend celle
   * qui a été lue ; faute de lecture, on refuse. Envoyer 0 mettrait silencieusement l'icône par
   * défaut sur un profil que l'utilisateur venait seulement de renommer.
   *
   * ⚠️ Pas de 21 octets : c'est la variante « classic ». Un modèle Striker demande 22
   * (`d.k0()`) et n'est pas porté ici — écrire au mauvais pas décalerait tous les noms suivants.
   */
  if (url === "/api/profiles/name" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const perso = b.kind === "custom";
    const index = Number(b.index);
    const maxi = perso ? 6 : (m.catalog?.model?.nProfiles ?? 5);
    if (!Number.isInteger(index) || index < 1 || index > maxi) {
      return raw(res, JSON.stringify({ error: `index ${b.index} invalide (1–${maxi})` }), 400);
    }
    if (m.gen === "striker") {
      return raw(res, JSON.stringify({ error: "écriture de noms non portée pour la génération Striker (pas de 22 octets)" }), 400);
    }
    const nom = String(b.name ?? "");
    if (nom.length > 20) return raw(res, JSON.stringify({ error: "nom limité à 20 caractères" }), 400);
    const lus = readNames(m.store.machineView(), perso ? "customNames" : "profileNames");
    const icone = b.icon != null ? Number(b.icon) : lus[index]?.icon;
    if (!Number.isInteger(icone)) {
      return raw(res, JSON.stringify({ error: "icône inconnue : lire d'abord les noms, ou fournir `icon`", needsRead: true }), 409);
    }
    const frame = frameSetNames(perso ? 0xab : 0xa5, index, index, [{ name: nom, icon: icone }]);
    const label = perso ? `Renommer la recette perso ${index} en « ${nom} »` : `Renommer le profil ${index} en « ${nom} »`;
    const t = startProgram(m, datapointValue(frame), label, 20000, "monitor", {
      rang: RANG.COMMANDE,
      i18n: { k: perso ? "renameCustom" : "renameProfile", p: { index, nom } },
    });
    /**
     * **La machine ne repousse RIEN après un `0xAB` / `0xA5`, et il faut donc relire.**
     *
     * Constaté en direct : la tâche d'écriture finit « faite », l'appareil affiche bel et bien la
     * nouvelle icône — et notre cache garde l'ancienne, indéfiniment. Rapporté tel quel : « l'image
     * est changée sur la machine mais pas dans l'application ».
     *
     * ⚠️ C'est l'INVERSE de `0x83`, qui pousse spontanément les cinq profils après une écriture de
     * recette (voir `beverages.mjs`, § recettes perso par profil). Rien ne laissait deviner cette
     * asymétrie, et son coût est le pire qui soit pour une écriture : elle réussit, et la page
     * continue d'affirmer le contraire — sans le moindre signe que la valeur affichée est périmée.
     *
     * On ne relit QUE le bloc qui contient l'index écrit, pas les quatre propriétés de la famille :
     * c'est le même raisonnement que pour l'écriture, qui ne touche qu'une entrée. Rang `LECTURE`,
     * donc une commande passe devant — et la relecture reste derrière l'écriture qu'elle suit,
     * puisque `enfiler` insère avant la première tâche de rang STRICTEMENT inférieur.
     *
     * Aucun `checksumMark` n'est posé au passage, volontairement : `startImport` n'en pose pas, et
     * marquer les noms « à jour » ici risquerait de supprimer une relecture ultérieure. Une lecture
     * redondante ne coûte qu'un aller-retour ; une lecture supprimée à tort n'est récupérable
     * qu'avec `force: true`.
     */
    const famille = perso ? CUSTOM_NAME_PROPS : PROFILE_NAME_PROPS;
    const bloc = famille
      .filter((x) => x.stride === STRIDE_CLASSIC && x.first <= index)
      .sort((a, b) => b.first - a.first)[0] ?? null;
    const relecture = bloc
      ? startImport(m, [bloc.prop], 0, { i18n: { k: "readOne", p: { prop: bloc.prop } } })
      : null;

    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({
      sent: true, kind: perso ? "custom" : "profile", index, name: nom, icon: icone,
      frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(),
      // Le client sait ainsi qu'une relecture suit, et laquelle : sans elle il afficherait
      // l'ancienne valeur en croyant l'écriture sans effet.
      reread: bloc?.prop ?? null,
      rereadTaskId: relecture?.taskId ?? null,
      register: reg, ...tacheRendue(t),
    }));
  }
  /**
   * **Ordre des favoris d'un profil — `0xAD`, persistant.**
   *
   * Pendant de la lecture `0xA8` (`d{260+p}_{p}_rec_priority`), dont `/` se sert pour ordonner ses
   * cartes. La trame a une longueur FIXE de 19 octets, donc exactement 12 emplacements : une liste
   * plus courte est complétée de zéros, une plus longue est refusée plutôt que tronquée en silence.
   * Chaque identifiant est vérifié dans le catalogue du modèle — envoyer une boisson que l'appareil
   * ne sait pas faire est le genre d'écriture dont on ne connaît pas l'effet.
   */
  if (url === "/api/profiles/favorites" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const profil = Number(b.profileId ?? m.activeProfile ?? 1);
    const nMax = m.catalog?.model?.nProfiles ?? 5;
    if (!Number.isInteger(profil) || profil < 1 || profil > nMax) {
      return raw(res, JSON.stringify({ error: `profil ${b.profileId} invalide (1–${nMax})` }), 400);
    }
    const ordre = Array.isArray(b.beverageIds) ? b.beverageIds.map(Number) : null;
    if (!ordre) return raw(res, JSON.stringify({ error: "`beverageIds` manquant" }), 400);
    if (ordre.length > 12) return raw(res, JSON.stringify({ error: `12 emplacements au maximum (${ordre.length} fournis)` }), 400);
    const inconnue = ordre.find((id) => id !== 0 && !m.catalog.byId(id));
    if (inconnue !== undefined) {
      return raw(res, JSON.stringify({ error: `boisson ${inconnue} inconnue sur ${m.catalog.model.type}` }), 400);
    }
    const frame = frameSetFavorites(profil, ordre);
    const t = startProgram(m, datapointValue(frame), `Ordre des favoris du profil ${profil}`, 20000, "monitor", { rang: RANG.COMMANDE, i18n: { k: "favouritesOrder", p: { profil } } });
    // Puis on relit : c'est la seule confirmation disponible, la machine n'accuse pas l'écriture.
    const prop = `d${String(260 + profil).padStart(3, "0")}_${profil}_rec_priority`;
    startImport(m, [prop], 0, { label: `Ordre d'affichage du profil ${profil}`, i18n: { k: "displayOrder", p: { profil } } });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({
      sent: true, profileId: profil, beverageIds: ordre,
      frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(),
      register: reg, ...tacheRendue(t),
    }));
  }
  /**
   * **Les deux modes de monitor restés hors Wi-Fi — `0x60` et `0x70`.**
   *
   * Diagnostic pur, et volontairement sans décodeur : on envoie la trame et on regarde ce qui
   * revient dans `lastDataResponse` / le journal. Ces deux modes n'apparaissent que dans le
   * constructeur de trames de l'app, jamais dans son service Wi-Fi ; rien ne dit que le module y
   * réponde en LAN, et inventer un décodage pour des octets qu'on n'a jamais vus serait pire que
   * de les afficher bruts. Rang `LECTURE`, aucun effet de bord connu.
   */
  if (url === "/api/monitormode" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const mode = Number(b.mode);
    if (![0, 1, 2].includes(mode)) return raw(res, JSON.stringify({ error: "mode attendu : 0, 1 ou 2" }), 400);
    const frame = frameMonitorMode(mode);
    const t = startProgram(m, datapointValue(frame), `Monitor mode ${mode} (0x${MONITOR_MODES[mode].toString(16)})`, 15000, "monitor", { cle: `monitormode:${mode}`, i18n: { k: "monitorMode", p: { mode, hex: MONITOR_MODES[mode].toString(16) } } });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({
      sent: true, mode, cmd: MONITOR_MODES[mode],
      frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(),
      lastDataResponse: m.lastDataResponse, register: reg, ...tacheRendue(t),
    }));
  }

  /**
   * **Réglages machine — la symétrie lecture / écriture qui manquait.**
   *
   * Deux chemins pour la même donnée, et c'est l'app qui les a tous les deux : la **propriété
   * Ayla** (`d281`…`d284`, une par réglage) et la **trame `0x95`** (une requête, plusieurs
   * adresses consécutives). On demande les deux — la propriété pour ce qui en a une, la trame pour
   * le reste (l'heure de démarrage, adresses 64/65) — parce qu'aucune des deux n'est garantie sur
   * un modèle donné et que la seconde ne coûte qu'un pas. `source` dira laquelle a répondu.
   */
  if (url === "/api/settings" && req.method === "GET") {
    return raw(res, JSON.stringify({
      reglages: vueReglages(m, m.store.getMeta("reglages") ?? {}),
      model: m.modelKey ?? null,
      modelName: m.catalog?.model?.name ?? null,
      lecture: vueLecture(m),
    }));
  }
  if (url === "/api/settings" && req.method === "POST") {
    const props = [];
    for (const r of REGLAGES) {
      const nom = r.prop ? reglageProp(m, r) : null;
      if (nom) props.push(nom);
    }
    const taches = [];
    if (props.length) {
      const t = startImport(m, props, 0, { label: "Réglages machine", cle: "reglages", i18n: { k: "settings" } });
      if (t?.ok) taches.push({ id: t.taskId, position: t.position });
    }
    // Les adresses sans propriété connue : une seule trame les couvre toutes, la machine rendant
    // `qty` adresses consécutives à partir de la première.
    const sansProp = REGLAGES.filter((r) => !r.prop).map((r) => r.addr);
    if (sansProp.length) {
      const premier = Math.min(...sansProp);
      const qty = Math.max(...sansProp) - premier + 1;
      const t = startProgram(m, datapointValue(frameParamRead95(premier, qty)), `Réglages ${premier}+${qty - 1}`, 15000, "monitor", { cle: `reglages95:${premier}+${qty}`, i18n: { k: "settings95", p: { premier, suite: qty - 1 } } });
      if (t?.ok) taches.push({ id: t.taskId, position: t.position });
    }
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ tasks: taches, count: taches.length, register: reg }));
  }
  /**
   * **Écriture d'un réglage — `0x90`, rang COMMANDE, persistant.**
   *
   * Deux formes acceptées : `{cle, value}` pour un réglage numérique, `{cle, on}` pour un des cinq
   * interrupteurs de l'adresse 63. Le second RELIT la valeur courante du champ de bits et n'y
   * change qu'un bit : écrire l'octet entier depuis un état supposé éteindrait au passage les
   * quatre autres réglages. Sans lecture préalable on refuse, plutôt que de deviner un octet.
   *
   * Le garde-fou qui compte : on n'écrit **que** les adresses de `REGLAGES`, et seulement si le
   * modèle déclare le réglage. `0x90` écrit 4 octets à une adresse arbitraire dans la
   * configuration d'un appareil réel ; la table d'adresses connue en couvre six, tout le reste est
   * inconnu et le rester est le comportement sûr.
   */
  if (url === "/api/settings/write" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const brut = m.store.getMeta("reglages") ?? {};
    const modele = m.catalog?.model ?? {};
    const dispo = (d) => (d == null ? true : modele[d] === true);  // voir `vueReglages`
    let r = REGLAGE_PAR_CLE.get(String(b.cle));
    let valeur;
    let libelle;
    let cleLibelle = null;
    if (r) {
      if (!dispo(r.supporte)) return raw(res, JSON.stringify({ error: `réglage « ${r.cle} » non supporté par ce modèle` }), 400);
      valeur = Number(b.value);
      if (!Number.isInteger(valeur) || valeur < r.min || valeur > r.max) {
        return raw(res, JSON.stringify({ error: `valeur hors bornes (${r.min}–${r.max})` }), 400);
      }
      libelle = `Réglage ${r.cle} = ${valeur}`;
      cleLibelle = { k: "settingWrite", p: { valeur }, refs: { reglage: { ns: "setting", cle: r.cle } } };
    } else {
      // Un interrupteur du champ de bits.
      const porteur = REGLAGES.find((x) => x.bits?.some((y) => y.cle === String(b.cle)));
      const bit = porteur?.bits.find((y) => y.cle === String(b.cle));
      if (!bit) return raw(res, JSON.stringify({ error: `réglage « ${b.cle} » inconnu` }), 400);
      if (!dispo(bit.supporte)) return raw(res, JSON.stringify({ error: `réglage « ${bit.cle} » non supporté par ce modèle` }), 400);
      const courant = brut[porteur.addr]?.value;
      if (courant == null) {
        return raw(res, JSON.stringify({ error: `réglage « ${bit.cle} » : lire d'abord les réglages — sans la valeur courante du champ de bits, l'écrire éteindrait les autres`, needsRead: true }), 409);
      }
      const on = b.on === true;
      // `inverse` : le bit à 1 DÉSACTIVE. C'est l'app qui en décide ainsi, pas nous.
      const poser = bit.inverse ? !on : on;
      valeur = poser ? (courant | (1 << bit.bit)) & 0xff : courant & ~(1 << bit.bit) & 0xff;
      r = porteur;
      libelle = `Réglage ${bit.cle} ${on ? "activé" : "désactivé"}`;
      cleLibelle = { k: "settingToggle", p: { actif: on ? 1 : 0 }, refs: { reglage: { ns: "setting", cle: bit.cle } } };
    }
    const frame = frameParamWrite(r.addr, valeur);
    const t = startProgram(m, datapointValue(frame), libelle, 20000, "monitor", { rang: RANG.COMMANDE, i18n: cleLibelle });
    // On note tout de suite la valeur envoyée, marquée comme telle : la machine ne confirme pas une
    // écriture de réglage, donc « lu » et « envoyé » ne doivent pas se ressembler dans l'interface.
    noteReglages(m, [{ addr: r.addr, value: valeur }], "écrit (non relu)");
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({
      sent: true, addr: r.addr, value: valeur,
      frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(),
      register: reg, ...tacheRendue(t),
    }));
  }

  if (url === "/api/beanadapt/save" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const index = Number(b.index);
    const grinder = Number(b.grinder);
    const temperature = Number(b.temperature);
    const aroma = Number(b.aroma);
    if (!Number.isInteger(index) || index < 0 || index > 5) return raw(res, JSON.stringify({ error: `index ${b.index} invalide` }), 400);
    if (!(grinder >= GRINDER_MIN && grinder <= GRINDER_MAX)) return raw(res, JSON.stringify({ error: `mouture hors bornes (${GRINDER_MIN}–${GRINDER_MAX})` }), 400);
    if (!(aroma >= AROMA_MIN && aroma <= AROMA_MAX)) return raw(res, JSON.stringify({ error: `arôme hors bornes (${AROMA_MIN}–${AROMA_MAX})` }), 400);
    if (!(temperature >= TEMPERATURE_MIN && temperature <= TEMPERATURE_MAX)) return raw(res, JSON.stringify({ error: `température hors bornes (${TEMPERATURE_MIN}–${TEMPERATURE_MAX})` }), 400);
    const name = typeof b.name === "string" ? b.name : "";
    const visible = b.visible !== false;
    const frame = frameBeanSystemSave(index, name, grinder, temperature, aroma, visible);
    const t = startProgram(m, datapointValue(frame), `Bean System ${index} → mouture ${grinder}, temp ${temperature}, arôme ${aroma}`, 20000, "monitor", { rang: RANG.COMMANDE, i18n: { k: "beanWrite", p: { index, mouture: grinder, temperature, arome: aroma } } });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({
      sent: true,
      frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(),
      wrote: { index, name: name.slice(0, 20), grinder, temperature, aroma, visible },
      register: reg,
      // `tacheRendue` manquait ici, et ici SEULEMENT : tous les autres points de mise en file
      // renvoient `taskId`/`position`, comme le contrat l'annonce. Sans eux l'interface ne pouvait
      // pas suivre l'écriture d'un profil de grains — ni l'annuler. Trouvé par ESLint, qui a
      // signalé que la valeur de `startProgram` n'était jamais lue.
      ...tacheRendue(t),
    }));
  }

  /**
   * Session cloud mémorisée. `GET` dit si elle existe et depuis quand, `DELETE` l'oublie.
   *
   * Ne renvoie **jamais** le jeton — même règle que la clé LAN. C'est le seul secret de niveau
   * compte que ce serveur puisse écrire, et il ne l'écrit que sur demande explicite.
   */
  if (url === "/api/cloudsession" && req.method === "GET") {
    const s = cloudSession();
    return raw(res, JSON.stringify({ set: s !== null, at: s?.at ?? null, tokenConfigured: !!process.env.AYLA_TOKEN }));
  }
  if (url === "/api/cloudsession" && req.method === "DELETE") {
    const removed = forgetCloudSession();
    L("sys", "cloud", `${removed ? "oubliée" : "déjà absente"}`, m);
    return raw(res, JSON.stringify({ removed, set: false }));
  }

  /**
   * Mises à jour OTA côté cloud. `GET` rapporte le dernier relevé, `POST` en fait un nouveau.
   *
   * La vérification a besoin d'un jeton Ayla. Deux façons de l'obtenir, dans cet ordre : les
   * identifiants du compte De'Longhi passés à cette requête (même chemin que la clé LAN, et le mot
   * de passe ne survit pas à l'appel), sinon `AYLA_TOKEN` s'il est renseigné. Le jeton obtenu par
   * les identifiants n'est pas mémorisé — seul le résultat l'est.
   */
  if (url === "/api/ota" && req.method === "GET") {
    return raw(res, JSON.stringify({ ...cloudOtaState(m), dsn: m.dsn, lanRequests: m.otaRequests }));
  }
  if (url === "/api/ota" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const email = typeof b.email === "string" ? b.email.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const jwt = typeof b.jwt === "string" && b.jwt.trim() ? b.jwt.trim() : null;
    // Même règle que la clé LAN : on tente une fois avant de refuser, et le refus nomme la cause.
    if (!(await resolveDsn(m, { force: true }))) {
      return raw(res, JSON.stringify({ error: `DSN inconnu, et la fiche OTA est rangée chez Ayla sous ce numéro : ${raisonDsnManquant(m)}`, needsDsn: true }), 409);
    }
    try {
      // La cascade choisit la voie la moins coûteuse : jeton en mémoire, session mémorisée,
      // identifiants, AYLA_TOKEN. Voir aylaToken().
      const token = await aylaToken(m, { email, password, jwt, remember: b.remember === true });
      if (!token) {
        return raw(res, JSON.stringify({ error: "identifiants du compte De'Longhi requis : la fiche OTA n'est lisible que côté cloud, et aucune session n'est mémorisée.", needsCredentials: true }), 400);
      }
      return raw(res, JSON.stringify({ ok: true, ...(await checkCloudOta(m, token)) }));
    } catch (e) {
      // Le message vient de Gigya/Ayla et ne contient aucun identifiant.
      L("sys", "OTA", `vérification impossible (${e.message})`, m);
      return raw(res, JSON.stringify({ error: e.message }), 502);
    }
  }

  /**
   * État de la clé LAN. Ne renvoie JAMAIS la clé — seulement de quoi savoir si elle est là et
   * d'où elle vient. Le key_id, lui, n'est pas un secret : il circule en clair dans le
   * key exchange.
   */
  if (url === "/api/lankey" && req.method === "GET") {
    // Uniquement la date de découverte : la clé elle-même ne sort jamais d'ici.
    const cachedAt = m.store.getLanKey()?.at ?? null;
    return raw(res, JSON.stringify({
      set: m.lanKey.length > 0,
      keyId: m.lanKeyId || null,
      source: m.lanKeySource,
      cachedAt,
      // Ce qu'il manque pour pouvoir interroger le cloud.
      // Normalement vide : les valeurs viennent de src/lib/cloud-app.json. Ne se remplit que si
      // ce fichier a été amputé, ou une variable mise à la chaîne vide.
      missingConfig: [!APP.gigyaApiKey && "clé API Gigya", !APP.aylaAppId && "app_id Ayla", !APP.aylaAppSecret && "app_secret Ayla"].filter(Boolean),
      dsn: m.dsn,
    }));
  }

  /**
   * Découverte de la clé LAN par le compte De'Longhi. Le mot de passe sert le temps de la
   * requête et n'est ni journalisé, ni stocké, ni renvoyé.
   */
  if (url === "/api/lankey" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const email = typeof b.email === "string" ? b.email.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const jwt = typeof b.jwt === "string" && b.jwt.trim() ? b.jwt.trim() : null;
    if (!jwt && (!email || !password)) return raw(res, JSON.stringify({ error: "e-mail et mot de passe requis (ou un jwt)" }), 400);
    try {
      const found = await discoverLanKey(m, { email, password, jwt, remember: b.remember === true });
      const changed = applyLanKey(m, found, jwt ? "JWT fourni (cloud Ayla)" : "compte De'Longhi (cloud)");
      // La clé était le prérequis manquant : modèle et noms deviennent lisibles, on les demande
      // tout de suite plutôt que d'attendre que l'utilisateur pense à le faire.
      const initialRead = await maybeInitialRead(m);
      return raw(res, JSON.stringify({
        ok: true,
        keyId: found.keyId,
        keyLength: found.key.length,
        lanStatus: found.status,
        keepAlive: found.keepAlive,
        changed,
        source: m.lanKeySource,
        initialRead,
        // Pour que l'interface dise si la session cloud a bien été mémorisée : Ayla ne renvoie pas
        // toujours un refresh_token, et une case cochée sans effet serait un mensonge.
        cloudSession: cloudSession() !== null,
      }));
    } catch (e) {
      // Le message d'erreur vient de Gigya/Ayla et ne contient pas d'identifiant.
      L("sys", "clé LAN", `échec de la découverte (${e.message})`, m);
      return raw(res, JSON.stringify({ error: e.message }), 502);
    }
  }

  /** Oubli de la clé mémorisée. La clé d'environnement, elle, reprend la main au redémarrage. */
  if (url === "/api/lankey" && req.method === "DELETE") {
    const removed = m.store.clearLanKey();
    if (!envForced(m, "lanKey")) {
      m.lanKey = Buffer.alloc(0);
      m.lanKeyId = 0;
      m.lanKeySource = "inconnue";
      m.session = null;
    }
    L("sys", "clé LAN", `cache ${removed ? "supprimé" : "déjà absent"}`, m);
    return raw(res, JSON.stringify({ removed, set: m.lanKey.length > 0, source: m.lanKeySource }));
  }

  /**
   * Statistiques d'utilisation. Ce sont des PARAMÈTRES machine lus par la commande `0xA2`, pas des
   * propriétés Ayla : les `d7xx_tot_*` que l'app connaît ne renvoient rien tant qu'on n'a pas
   * envoyé la commande (même piège que les Bean Systems).
   *
   * `ids` : liste d'identifiants. `from`+`qty` : une plage consécutive en une seule trame.
   * `sync: true` : joindre à la MÊME tâche la lecture de `d260_beansystem_sync_par`, dont les dix
   * mots sont les paramètres 500 à 509 — le seul moyen d'obtenir les deux familles dans un même
   * passage de la machine (voir `scanStats`).
   */
  if (url === "/api/stats" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    /**
     * **Les compteurs nommés passent par le même endpoint, et c'est délibéré.**
     *
     * C'est la même page qui demande, la même question posée à la même machine — seul le canal
     * change (des propriétés Ayla au lieu de trames `0xA2`). Un second endpoint aurait dédoublé la
     * mise en file, la réponse et le suivi de tâche pour une différence qui tient au corps de la
     * requête.
     */
    if (typeof b.named === "string") {
      const portee = b.named;
      if (!PORTEES_COMPTEURS[portee]) return raw(res, JSON.stringify({ error: `portée inconnue : ${portee}` }), 400);
      const r = scanCompteurs(m, portee);
      // Portée épuisée : tous les noms ont déjà répondu « absent ». Ce n'est pas un échec, et le
      // dire comme tel évite de relancer indéfiniment une lecture qui n'a rien à ramener.
      if (r.vide) return raw(res, JSON.stringify({ started: false, empty: true, portee, total: r.total, reason: r.raison }));
      return raw(res, JSON.stringify({ started: r.ok, portee, requests: r.total - r.sautes, skipped: r.sautes, register: await postLocalReg(m), ...tacheRendue(r) }));
    }
    // Même raison qu'au balayage des grains : la file encaisse au lieu d'écraser, donc plus de refus.
    let queue = [];
    if (Array.isArray(b.ids) && b.ids.length) {
      queue = b.ids.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff).map((id) => ({ id, qty: 1 }));
    } else if (Number.isInteger(Number(b.from))) {
      const qty = Math.min(Math.max(Number(b.qty ?? 1), 1), 40);
      queue = [{ id: Number(b.from), qty }];
    }
    if (!queue.length) return raw(res, JSON.stringify({ error: "fournir ids[] ou from(+qty)" }), 400);
    const requests = queue.length;
    const sync = b.sync === true;
    const t = scanStats(m, queue, { sync });
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ started: t.ok, requests, sync, register: reg, ...tacheRendue(t) }));
  }

  if (url === "/api/stats" && req.method === "GET") {
    const store = m.store.machineView();
    const stats = store.stats ?? {};
    return raw(res, JSON.stringify({
      // Identifiant brut → valeur. La signification de chaque id n'est PAS établie : l'app les
      // demande sans les nommer, il n'existe aucune table de correspondance dans l'APK.
      stats: Object.fromEntries(Object.entries(stats).map(([id, v]) => [id, v.value])),
      readAt: Object.fromEntries(Object.entries(stats).map(([id, v]) => [id, v.at])),
      count: Object.keys(stats).length,
      scan: machineActivity(m).statScan,
      // Ce que l'app demande (p258z7/w.java et le viewmodel des statistiques).
      appIds: APP_STAT_IDS,
      // Publiées plutôt que recopiées dans la page : voir STAT_RANGES.
      ranges: STAT_RANGES,
      /**
       * Le second canal : des compteurs NOMMÉS, portés par des propriétés Ayla (`compteurs.mjs`).
       * `named` ne liste que ce qui a été lu au moins une fois ; `namedScopes` dit ce qu'il y a à
       * demander, pour que les deux boutons sachent leur étendue sans recopier la table côté page —
       * même raison que `ranges` juste au-dessus.
       */
      named: vueCompteurs(m),
      namedScopes: Object.fromEntries(Object.entries(PORTEES_COMPTEURS).map(([k, v]) => [k, v.length])),
      // Le second espace de paramètres (`0xA1`, mots du paramètre 500) — voir SYNC_MEANINGS. Il
      // vient de la propriété déjà en cache : cet endpoint ne demande jamais rien à la machine.
      sync: vueParamsSync(m),
      // Les seuls dont la signification est établie. `raw` reste la valeur brute ; `value` est
      // convertie quand il y a une unité (eau : 0,5 ml → litres).
      known: Object.entries(STAT_MEANINGS)
        .filter(([id]) => stats[id] !== undefined)
        .map(([id, sens]) => ({
          id: Number(id),
          key: sens.key,
          raw: stats[id].value,
          value: sens.divisor ? Math.round(stats[id].value / sens.divisor) : stats[id].value,
          unit: sens.divisor ? "L" : null,
          at: stats[id].at,
        })),
    }));
  }

  /**
   * Adresse de la machine. `GET` renvoie l'état, `POST {ip}` l'enregistre puis la teste tout de
   * suite (`regtoken.json` est le seul endpoint que le module expose hors mode AP, et il répond
   * sans authentification), `DELETE` oublie la valeur mémorisée.
   */
  if (url === "/api/machine" && req.method === "GET") {
    const saved = m.store.getMeta("machineIp");
    return raw(res, JSON.stringify({
      ip: m.ip,
      source: m.ipSource,
      envForced: envForced(m, "ip"),
      cachedAt: saved?.at ?? null,
      dsn: m.dsn,
      dsnSource: m.dsnSource,
      serverIp: CFG.serverIp,
      serverPort: CFG.port,
    }));
  }
  if (url === "/api/machine" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const ip = typeof b.ip === "string" ? b.ip.trim() : "";
    if (!validMachineHost(ip)) {
      return raw(res, JSON.stringify({ error: "adresse invalide : attendu une IPv4 ou un nom d'hôte, sans schéma ni port ni chemin." }), 400);
    }
    if (envForced(m, "ip") && ip !== ENV_MACHINE.ip) {
      L("sys", "adresse", `saisie (${ip}) différente de MACHINE_IP (${ENV_MACHINE.ip}) — le réglage explicite reste prioritaire au redémarrage`, m);
    }
    const changed = applyMachineIp(m, ip);
    // On vérifie immédiatement : une adresse enregistrée mais muette doit être signalée comme
    // telle, pas laissée à découvrir au premier échec de commande.
    const probe = await probeRegtoken(m);
    const dsn = probe.reachable ? await resolveDsn(m, { compare: true }) : m.dsn;
    // Trois verdicts, pas deux : injoignable / quelque chose répond mais ce n'est pas la cafetière /
    // c'est bien elle. Le cas du milieu reste possible (un autre serveur à cette adresse), mais il
    // ne faut PLUS l'imputer à un nom d'hôte : depuis `machineTarget()`, un nom qui désigne bien la
    // machine fonctionne. C'est le 404 provoqué par un `Host` non-IP qui faisait croire le contraire.
    const isMachine = probe.reachable && typeof probe.regtoken?.host_symname === "string";
    // Ordre inverse du cas courant : la clé était déjà là (variable d'environnement, ou reprise du
    // cache) et c'est l'adresse qui manquait. Même déclencheur, d'où le garde dans la fonction.
    const initialRead = await maybeInitialRead(m);
    return raw(res, JSON.stringify({
      ok: true,
      ip: m.ip,
      source: m.ipSource,
      changed,
      probe: { reachable: probe.reachable, isMachine, status: probe.status ?? null, error: probe.error ?? null },
      dsn,
      dsnSource: m.dsnSource,
      initialRead,
    }));
  }
  if (url === "/api/machine" && req.method === "DELETE") {
    const had = m.store.getMeta("machineIp") !== null;
    m.store.clearMeta("machineIp");
    if (!envForced(m, "ip")) {
      m.ip = null;
      m.ipSource = "inconnue";
      m.session = null;
    }
    L("sys", "adresse", `cache ${had ? "supprimé" : "déjà absent"}`, m);
    return raw(res, JSON.stringify({ removed: had, ip: m.ip, source: m.ipSource }));
  }

  if (url === "/api/register" && req.method === "POST") { const r = await postLocalReg(m); return raw(res, JSON.stringify(r)); }
  if (url === "/api/recipes") {
    if (req.method === "GET") return raw(res, JSON.stringify(vueRecettes(m)));
    if (req.method === "POST") {
      const r = JSON.parse((await readBody(req)).toString("utf8"));
      // L'id est la clé primaire : sans lui, l'ancien code écrivait une recette anonyme que la
      // suivante écrasait en silence.
      if (!r?.id) return raw(res, JSON.stringify({ error: "id de recette manquant" }), 400);
      const bev = m.catalog.byId(Number(r.beverageId));
      // Refuser plutôt qu'enregistrer une recette qui ne désigne rien sur cette machine : elle
      // s'afficherait sans boisson et ne pourrait ni se préparer ni se transférer.
      if (!bev) return raw(res, JSON.stringify({ error: `boisson ${r.beverageId} inconnue sur ${m.catalog.model.type}` }), 400);
      const prof = Number(r.profileId) || 1;
      if (!(prof >= 1 && prof <= m.catalog.model.nProfiles)) {
        return raw(res, JSON.stringify({ error: `profil ${prof} invalide (ce modèle en a ${m.catalog.model.nProfiles})` }), 400);
      }
      /**
       * `apercu` est (re)posé à CHAQUE enregistrement : c'est le seul moment où l'on sait qu'il est
       * à jour, et un aperçu périmé afficherait l'ancien nom d'une recette renommée sur la machine.
       *
       * Le libellé est celui que l'utilisateur VOIT — le nom saisi sur la machine s'il y en a un,
       * le libellé du catalogue sinon. `m.catalog.byId` ne connaît que le second : un aperçu qui
       * dirait « Recette perso 1 » là où l'écran affiche « Lacteso » ne servirait pas à ce pour
       * quoi il existe, se retrouver quand le catalogue ne répond plus.
       */
      const nomMachine = machineBeverageNames(m.store.machineView())[bev.id]?.name ?? null;
      m.store.putRecipe({ ...normaliseRecette(r, bev), apercu: { label: nomMachine ?? bev.label, slug: bev.slug, category: bev.category, milk: !!bev.milk } });
      return raw(res, JSON.stringify(vueRecettes(m)));
    }
    if (req.method === "DELETE") { const id = new URL(req.url, "http://x").searchParams.get("id"); m.store.deleteRecipe(id); return raw(res, JSON.stringify(vueRecettes(m))); }
  }
  return raw(res, JSON.stringify({ error: "not found" }), 404);
}
// Aucune recette d'usine : le catalogue réel des 28 boissons vit sur la page /, lu sur la
// machine. La table `recipes` ne contient que les recettes créées par l'utilisateur, et démarre
// donc vide — plus besoin d'amorcer un fichier au premier lancement.

// --- bootstrap Next + serveur ---
// `--dev` active le mode dev de Next (HMR sur les pages) TOUT EN gardant nos endpoints
// device-facing en HTTP brut : `next dev` seul ne passerait pas par server.mjs et l'ESP32
// rejetterait le framing de l'App Router.
const DEV = process.argv.includes("--dev");
const app = next({ dev: DEV, hostname: "0.0.0.0", port: CFG.port });
const handle = app.getRequestHandler();
await app.prepare();

// Le registre est bâti AVANT d'écouter : une requête ne doit jamais arriver alors que l'état
// persistant n'est pas encore repris — sinon une commande partirait avec une clé LAN « absente »
// qui n'attendait que d'être relue.
for (const msg of storeBootMessages) L("sys", "base", msg);
for (const m of loadMachines()) {
  restoreActiveProfile(m);
  restoreMachineIp(m);
  restoreDsn(m);
  restoreModel(m);
  restoreLanKey(m);
  // Après les reprises : le modèle est connu (variable, cache) ou non, et dans les deux cas c'est
  // ici que le catalogue et la génération sont arrêtés — et que leurs limites sont annoncées.
  applyCatalog(m);
  if (!m.ip) L("sys", "adresse", "inconnue : la renseigner sur la page « Machines », ou par MACHINE_IP dans .env.local", m);
  if (!m.lanKey.length) L("sys", "clé LAN", "absente : la renseigner dans .env.local, ou la faire découvrir depuis la page « Machines » (compte De'Longhi)", m);
}

createServer((req, res) => {
  const u = req.url || "";
  // La machine réclame une image OTA à notre serveur (voir m.otaRequests). On ne lui en sert
  // aucune — on enregistre l'événement, qui est le seul indicateur local d'un OTA en attente.
  if (u.startsWith("/ota_status.json") || u.startsWith("/local_lan/lan_ota")) {
    // Attribuée à la machine qui l'a émise ; une requête d'un appareil non reconnu est journalisée
    // sans être rangée nulle part, plutôt que mise au compte de la première machine.
    const m = machineByPeer(req);
    if (m) {
      m.otaRequests.unshift({ at: Date.now(), url: u, method: req.method, from: peerAddress(req) });
      if (m.otaRequests.length > 20) m.otaRequests.pop();
    }
    L("in", "OTA", `${m ? "" : ` d'un appareil non reconnu (${peerAddress(req)})`} : ${req.method} ${u}`, m);
    return raw(res, JSON.stringify({ ota: "none" }), 404);
  }
  // Les deux endpoints que sert une VRAIE machine à un client local. Ils n'existent que si le
  // multiplexeur est allumé : voir PROXY, et la raison pour laquelle il est éteint par défaut.
  if (PROXY.actif && u.split("?")[0] === "/regtoken.json") return handleAppRegtoken(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
  if (PROXY.actif && u.split("?")[0] === "/local_reg.json") return handleAppReg(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
  if (u.startsWith("/local_lan/")) return handleLan(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
  if (u.startsWith("/api/")) return handleApi(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
  return handle(req, res);
}).listen(CFG.port, "0.0.0.0", () => {
  const liste = machineList();
  console.log(`De'Longhi LAN server (custom${DEV ? ", dev/HMR" : ""}) sur http://0.0.0.0:${CFG.port}  — ${liste.length} machine${liste.length > 1 ? "s" : ""}`);
  for (const m of liste) {
    console.log(`  ${m.id}${m.label ? ` « ${m.label} »` : ""} : adresse ${m.ip ?? "à configurer"}, DSN ${m.dsn ?? "à découvrir"}, clé LAN ${m.lanKey.length ? `key_id ${m.lanKeyId}` : "absente"}`);
  }
  if (PROXY.actif) {
    L("sys", "multiplexeur", `ACTIF : ce serveur répond à /regtoken.json et /local_reg.json comme le ferait la machine`);
    if (CFG.port !== PORT_ATTENDU_PAR_APP) {
      // Dit une fois, fort : sans cela on cherche longtemps pourquoi aucune application ne vient.
      L("sys", "multiplexeur", `nous écoutons sur ${CFG.port}, or une application construit ses URL en http://<ip>/ — donc port ${PORT_ATTENDU_PAR_APP}, et nulle part ailleurs. Écouter sur ${PORT_ATTENDU_PAR_APP} (SERVER_PORT) ou rediriger, sinon aucune app ne nous trouvera.`);
    }
  }
  const problemeServerIp = serverIpProblem();
  if (problemeServerIp) {
    const vues = candidateServerIps();
    L("sys", "réseau", `${problemeServerIp} — or c'est l'adresse que nous ANNONÇONS à la machine : en mode LAN, c'est elle qui se connecte à nous. Aucune session ne pourra s'établir. Adresses non locales vues d'ici : ${vues.length ? vues.join(", ") : "aucune"}. En conteneur bridge, annoncer l'adresse de l'HÔTE, pas celle du conteneur.`);
  }
  // `compare` : on interroge la machine même quand le DSN est déjà connu, pour signaler une
  // divergence au démarrage plutôt que de la découvrir au premier échec de commande.
  for (const m of liste) if (m.ip) resolveDsn(m, { compare: true }).catch(() => {});
});
