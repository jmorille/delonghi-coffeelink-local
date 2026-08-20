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
import { CATEGORIES, catalogFor, decodeRecipeProperty, modelSheet } from "./src/lib/beverages.mjs";
import { computeBeanAdapt, encodeBeanName, GRINDER_MIN, GRINDER_MAX, AROMA_MIN, AROMA_MAX, TEMPERATURE_MIN, TEMPERATURE_MAX } from "./src/lib/bean-adapt.mjs";
import { ALL_PROFILE_PROPS, PROFILE_NAME_PROPS, CUSTOM_NAME_PROPS, PRIORITY_PROPS, profilePropInfo, isProfileProp, decodeNames, decodePriorities, decodeChecksums, decodeBeanSystem, STRIDE_CLASSIC } from "./src/lib/profiles.mjs";
// Persistance : SQLite (`data/lan-server.db`). Le module migre tout seul les anciens JSON au
// premier démarrage. Chaque propriété reçue est UNE ligne réécrite, plus 80 ko de cache entier.
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
function L(dir, msg, m = null) {
  LOG.unshift({ t: Date.now(), dir, msg, m: m?.id ?? null });
  if (LOG.length > 400) LOG.pop();
  // Tout changement d'état significatif passe par ici : c'est donc d'ici qu'on prévient les
  // navigateurs abonnés. Voir sseTouch().
  sseTouch();
  // Le préfixe n'apparaît que s'il y a de quoi confondre : en mono-machine, la sortie du
  // terminal reste exactement celle qu'elle était.
  console.log(now(), dir.toUpperCase(), (m && MACHINES.size > 1 ? `[${m.id}] ` : "") + msg);
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
    program: null, // {active,ecamB64,label,startedAt,durationMs,counter}
    import: null, // {active,queue:[prop],pending,ok,fail,startedAt,durationMs,counter}
    cmdId: 0,
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
    // Balayage de la liste des grains : un programme 0xBA par index.
    beanScan: null,
    // Lecture des paramètres/statistiques : un programme 0xA2 par requête.
    statScan: null,
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
      L("sys", `génération déduite du modèle ${identite} : ${gen} (propriétés ${m.send} / ${m.mon})`, m);
    }
  }
  if (c.fallback && m.modelKey) {
    const fiche = modelSheet(m.modelKey);
    L("sys", fiche
      ? `⚠ modèle ${m.modelKey} (${fiche.type}) reconnu mais son catalogue n'est pas exploitable (${fiche.support === "norecipes" ? "aucune recette dans la table constructeur" : "boissons hors de l'espace de noms vérifié"}) — catalogue ${c.model.type} conservé`
      : `⚠ modèle ${m.modelKey} absent de la table des catalogues — catalogue ${c.model.type} conservé`, m);
  } else if (avant && avant !== c.key) {
    L("sys", `catalogue basculé sur ${c.model.type} (${c.key}) : ${c.beverages.length} boissons, ${c.model.nProfiles} profils, ${c.model.nCustomRecipes} recettes perso`, m);
  }
  if (c.unaddressable.length) {
    L("sys", `⚠ ${c.unaddressable.length} boissons de ce modèle n'ont aucune propriété Ayla connue (${c.unaddressable.slice(0, 6).join(", ")}…) : listées, mais ni lisibles ni réglables`, m);
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
function machineLabel(m) {
  return m.label || (m.modelKey ? findModel(m.modelKey)?.type : null) || m.identity?.machineName || m.dsn || m.id;
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

// --- crypto (port validé de debug-capture.mjs) ---
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const derive = (K, seed) => hmac(K, Buffer.concat([hmac(K, seed), seed])); // double HMAC
const CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const token = (n) => { const b = crypto.randomBytes(n); let s = ""; for (let i = 0; i < n; i++) s += CH[b[i] % 62]; return s; };
function makeSession(m, kx, time2) {
  const R1 = Buffer.from(kx.random_1, "utf8"), R2 = Buffer.from(token(16), "utf8");
  const T1 = Buffer.from(String(kx.time_1), "utf8"), T2 = Buffer.from(time2, "utf8");
  const tag = (t) => Buffer.from([t]);
  const a = (t) => Buffer.concat([R1, R2, T1, T2, tag(t)]);
  const d = (t) => Buffer.concat([R2, R1, T2, T1, tag(t)]);
  const aSign = derive(m.lanKey, a(0x30)), aCrypto = derive(m.lanKey, a(0x31)), aIv = derive(m.lanKey, a(0x32)).subarray(0, 16);
  const dSign = derive(m.lanKey, d(0x30)), dCrypto = derive(m.lanKey, d(0x31)), dIv = derive(m.lanKey, d(0x32)).subarray(0, 16);
  const e = crypto.createCipheriv("aes-256-cbc", aCrypto, aIv); e.setAutoPadding(false);
  const dc = crypto.createDecipheriv("aes-256-cbc", dCrypto, dIv); dc.setAutoPadding(false);
  let seq = 0;
  return {
    random2: R2.toString("utf8"),
    encapsulate(dataJson) {
      const inner = `{"seq_no":${seq++},"data":${dataJson}}`;
      const ib = Buffer.from(inner, "utf8");
      const sign = crypto.createHmac("sha256", aSign).update(ib).digest("base64");
      let len = ib.length + 1; const r = len % 16; if (r) len += 16 - r;
      const pad = Buffer.alloc(len); ib.copy(pad, 0);
      return JSON.stringify({ enc: e.update(pad).toString("base64"), sign });
    },
    decapsulate(body) {
      let p = dc.update(Buffer.from(body.enc, "base64"));
      let end = p.length; while (end > 0 && p[end - 1] === 0) end--;
      return p.subarray(0, end).toString("utf8");
    },
  };
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
const frameRecipeQty = (prof, bev) => seal([0x0d, 0x07, 0xa6, 0xf0, prof & 0xff, bev & 0xff, 0, 0]);
// J() « checksums » : sommes de contrôle des quantités par profil + perso + noms. Une seule
// petite trame permet de savoir si le cache est encore valable, au lieu de tout relire.
const frameChecksums = () => seal([0x0d, 0x05, 0xa3, 0xf0, 0, 0]);
// V(data2) : demande du monitor. Trame de LECTURE, sans aucun effet de bord — c'est ce qu'il
// faut pour tenir la présence, contrairement à 0xA9 qui sélectionne un profil.
const frameMonitorRequest = () => seal([0x0d, 0x05, 0x75, 0x0f, 0, 0]);
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
const TWO = new Set([1, 9, 15]);
function frameDispense(bev, prof, mode, action, params, check = false) {
  const body = [];
  for (const p of params) { body.push(p.id & 0xff); if (TWO.has(p.id)) body.push((p.value >> 8) & 0xff, p.value & 0xff); else body.push(p.value & 0xff); }
  const total = body.length + 9; const bytes = new Array(total).fill(0);
  bytes[0] = 0x0d; bytes[1] = total - 1; bytes[2] = 0x83; bytes[3] = 0xf0; bytes[4] = bev & 0xff;
  bytes[5] = check ? (mode | 0x80) & 0xff : mode & 0xff;
  for (let i = 0; i < body.length; i++) bytes[6 + i] = body[i];
  bytes[6 + body.length] = ((prof << 2) | action) & 0xff;
  return seal(bytes);
}
function datapointValue(frame) { const t = Buffer.alloc(4); t.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0); return Buffer.concat([frame, t]).toString("base64"); }
/**
 * Alarmes du monitor — index de bit → identifiant, port de `p127m6/l` (méthode `a(int)`).
 *
 * ⚠️ La table fait autorité sur les couples (groupe, bit) déclarés dans l'énum : plusieurs index
 * sont explicitement `IGNORE_ALARM` sur cette génération (7, 10, 13, 16, 20, 21, 23, 24, 26-31),
 * alors que l'énum y déclare des alarmes. On les marque « ignorée » au lieu de les nommer à tort.
 *
 * Le champ est un bitfield 32 bits construit par `MonitorDataV2.b()` :
 *   octet 7 | octet 8 << 8 | octet 12 << 16 | octet 13 << 24
 */
const MONITOR_ALARMS = {
  0: "EMPTY_WATER_TANK",
  1: "COFFEE_WASTE_CONTAINER_FULL",
  2: "DESCALE_ALARM",
  3: "REPLACE_WATER_FILTER",
  4: "COFFE_GROUND_TOO_FINE",
  5: "COFFEE_BEANS_EMPTY",
  6: "MACHINE_TO_SERVICE",
  8: "TOO_MUCH_COFFEE",
  9: "COFFEE_INFUSER_MOTOR_NOT_WORKING",
  11: "EMPTY_DRIP_TRAY",
  12: "HYDRAULIC_CIRCUIT_PROBLEM",
  14: "CLEAN_KNOB",
  15: "COFFEE_BEANS_EMPTY_TWO",
  17: "BEAN_HOPPER_ABSENT",
  18: "GRID_PRESENCE",
  19: "INFUSER_SENSE",
  22: "EXPANSION_SUBMODULES_PROB",
  25: "CONDENSE_FAN_PROBLEM",
};

/**
 * Capteurs rapportés par le monitor — port de l'énum `p127m6/p` (couple groupe/bit) et de
 * `MonitorDataV2.l()` : l'octet est `5 + groupe`, le bit est la position dans l'énum.
 */
const MONITOR_SWITCHES = [
  { group: 0, bit: 0, name: "WATER_SPOUT", label: "buse à eau" },
  { group: 0, bit: 1, name: "MOTOR_UP", label: "moteur haut" },
  { group: 0, bit: 2, name: "MOTOR_DOWN", label: "moteur bas" },
  { group: 0, bit: 3, name: "COFFEE_WASTE_CONTAINER", label: "bac à marc" },
  { group: 0, bit: 4, name: "WATER_TANK_ABSENT", label: "réservoir d'eau absent" },
  { group: 0, bit: 5, name: "KNOB", label: "molette" },
  { group: 0, bit: 6, name: "WATER_LEVEL_LOW", label: "niveau d'eau bas" },
  { group: 0, bit: 7, name: "COFFEE_JUG", label: "verseuse" },
  { group: 1, bit: 0, name: "IFD_CARAFFE", label: "carafe à lait" },
  { group: 1, bit: 1, name: "CIOCCO_TANK", label: "bac chocolat" },
  { group: 1, bit: 2, name: "CLEAN_KNOB", label: "molette nettoyage" },
  { group: 1, bit: 5, name: "DOOR_OPENED", label: "porte ouverte" },
  { group: 1, bit: 6, name: "PREGROUND_DOOR_OPENED", label: "trappe café moulu ouverte" },
];

/**
 * Décode `d302_monitor` — port de `it/delonghi/ecam/model/MonitorDataV2`, où le tableau indexé
 * est la trame complète décodée du base64.
 *
 * ```
 * 4        état machine        (0x04 = veille ; voir MACHINE_STATES)
 * 5, 6     capteurs           champ de bits 16 bits, octet = 5 + groupe
 * 7, 8, 12, 13  alarmes       champ de bits 32 bits (7 | 8<<8 | 12<<16 | 13<<24)
 * 9, 10, 11     compteurs/divers (accesseurs f(), e(), d() de l'app)
 * ```
 *
 * ⚠️ Les octets 5-6 étaient nommés « progress » dans une première version : c'était faux. La
 * valeur 256 relevée sur cette machine signifie « groupe 1, bit 0 » = carafe à lait connectée,
 * ce que l'écran confirmait.
 */
function decodeMonitor(b64) {
  const raw = Buffer.from(b64, "base64");
  // Une trame exploitable va au moins jusqu'à l'octet 8 (état, capteurs, 2 premiers octets
  // d'alarmes). Sans ce contrôle, une valeur vide donnait `stateByte: undefined` et le
  // `toString(16)` du journal levait une TypeError : les autres propriétés du MÊME datapoint
  // étaient perdues, et le journal accusait à tort le déchiffrement.
  if (raw.length < 9) throw new Error(`trame monitor trop courte (${raw.length} octets)`);
  const n = raw[1] + 1;
  const e = raw.subarray(0, n);
  if (e.length < 9) throw new Error(`trame monitor tronquée (len annoncé ${n}, ${e.length} reçus)`);
  const bits = e[5] + (e[6] << 8);
  const switches = MONITOR_SWITCHES.filter((sw) => (e[5 + sw.group] >> sw.bit) & 1);
  // Octet 13 multiplié, pas décalé : `0x80 << 24` vaut −2147483648 en JS, et l'API publiait alors
  // un champ de bits négatif. La boucle sur les bits utilise déjà `>>>`, seule la valeur exposée
  // était fausse.
  const alarmBits = e[7] + (e[8] << 8) + ((e[12] ?? 0) << 16) + (e[13] ?? 0) * 0x1000000;
  const alarms = [];
  for (let i = 0; i < 32; i++) {
    if (!((alarmBits >>> i) & 1)) continue;
    // `ignored` : l'app écarte explicitement ces index sur cette génération. On les remonte
    // quand même, marqués, plutôt que de les cacher ou de leur coller un nom faux.
    alarms.push({ bit: i, name: MONITOR_ALARMS[i] ?? null, ignored: !MONITOR_ALARMS[i] });
  }
  return {
    stateByte: e[4],
    switchBits: bits,
    switches: switches.map((sw) => ({ name: sw.name, label: sw.label })),
    alarmBits,
    alarms,
    raw: e.toString("hex").replace(/(..)/g, "$1 ").trim(),
  };
}

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

// Libellé d'une boisson, dans le catalogue de CETTE machine. Plus de table de module : deux
// machines de modèles différents n'ont pas la même liste, et un libellé pris dans la mauvaise
// nommerait une boisson que la machine ne sait pas faire.
const bevLabel = (m, id) => m.catalog.byId(id)?.label ?? id;

// --- programme (séquence app validée : device_connected → cmd → présence soutenue) ---
const prop = (m, name, value, id = false) => { const p = { base_type: "string", dsn: m.dsn ?? "", name, value, metadata: {} }; if (id) p.id = crypto.randomBytes(4).toString("hex"); return { property: p }; };
const nowSec = () => String(Math.floor(Date.now() / 1000));
function nextProgramData(m) {
  const pg = m.program;
  if (!pg || !pg.active) return { data: "{}", label: "idle" };
  if (Date.now() > pg.startedAt + pg.durationMs) { pg.active = false; L("sys", `programme « ${pg.label} » terminé`, m); return { data: "{}", label: "done" }; }
  const c = pg.counter++;
  if (c === 0) return { data: JSON.stringify({ properties: [prop(m, "device_connected", nowSec())] }), label: "device_connected" };
  if (c === 1) return { data: JSON.stringify({ properties: [prop(m, m.send, pg.ecamB64, true)] }), label: pg.label };
  if (c % 5 === 0) return { data: JSON.stringify({ properties: [prop(m, "device_connected", nowSec())] }), label: "device_connected(refresh)" };
  // Trame de présence : dépend du programme. `profile` (0xA9) n'est utilisé que là où il est
  // nécessaire — le réveil, dont c'est la recette validée, et la sélection de profil, où
  // réaffirmer la même valeur est idempotent. Partout ailleurs on tient la présence avec une
  // demande de monitor, qui ne change rien sur la machine.
  //
  // ⚠️ 0xA9 EST la commande de sélection de profil : l'utiliser comme simple battement de cœur
  // avec un profil non confirmé imposait silencieusement le profil 1 à chaque commande (constaté :
  // une simple demande de sommes de contrôle ramenait la machine du profil 3 au profil 1).
  if (pg.sustain === "profile") {
    return { data: JSON.stringify({ properties: [prop(m, m.send, datapointValue(frameSendProfile(m.activeProfile)), true)] }), label: `sustain(profil ${m.activeProfile})` };
  }
  return { data: JSON.stringify({ properties: [prop(m, m.send, datapointValue(frameMonitorRequest()), true)] }), label: "sustain(monitor)" };
}
/**
 * Opérations ECAM, par octet de commande. Sert à **nommer** ce qu'un programme fait dans le
 * journal : « 0x83 » ne dit rien à la relecture, « préparation ou enregistrement de recette » si.
 *
 * La nature — lecture ou action — est ce qui compte le plus au moment où l'on cherche pourquoi une
 * machine a fait quelque chose : une lecture n'a aucun effet physique, une action en a un.
 */
const ECAM_OPS = {
  // `nature` est le VERBE, `nom` l'objet : les deux se lisent à la suite (« lecture · monitor »).
  // Les mettre tous les deux au complet donnait « lecture lecture d'un profil de grains ».
  0x75: { nature: "lecture", nom: "monitor" },
  // 0x83 est affiné par son octet de mode : voir `describeFrame`. La distinction compte — le même
  // octet de commande sert à préparer une boisson, à arrêter, et à ÉCRIRE une recette dans un profil.
  0x83: { nature: "action", nom: "recette" },
  0x84: { nature: "action", nom: "marche / arrêt" },
  0xa2: { nature: "lecture", nom: "paramètres et compteurs" },
  0xa3: { nature: "lecture", nom: "sommes de contrôle" },
  0xa6: { nature: "lecture", nom: "recette d'un profil" },
  0xa9: { nature: "action", nom: "sélection de profil" },
  0xb0: { nature: "lecture", nom: "bornes d'une recette" },
  0xb9: { nature: "action", nom: "sélection du grain actif" },
  0xba: { nature: "lecture", nom: "profil de grains" },
  // La seule écriture persistante de cette table, et c'est ce qu'il faut voir d'un coup d'œil.
  0xbb: { nature: "écriture", nom: "profil de grains" },
};

/**
 * Décrit la trame qu'on est en train d'envoyer : opération, nature, et octets.
 *
 * `ecamB64` porte la trame **suivie de 4 octets d'horodatage** (voir `datapointValue`) : on les
 * retire, sinon le journal afficherait quatre octets qui n'appartiennent pas à la commande.
 */
function describeFrame(ecamB64) {
  try {
    const buf = Buffer.from(ecamB64, "base64");
    const trame = buf.subarray(0, Math.max(0, buf.length - 4));
    const cmd = trame[2];
    let op = ECAM_OPS[cmd];
    // `0x83` : l'octet 5 porte le mode, et c'est lui qui dit ce que la commande fait vraiment.
    // Le bit 0x80 est le drapeau « vérification » (`check`), il ne change pas la nature.
    if (cmd === 0x83) {
      const mode = trame[5] & 0x7f;
      op =
        mode === 0x00
          ? { nature: "écriture", nom: "recette enregistrée dans un profil" }
          : mode === 0x02
            ? { nature: "action", nom: "arrêt de la préparation" }
            : { nature: "action", nom: "préparation d'une boisson" };
    }
    const hex = trame.toString("hex").replace(/(..)/g, "$1 ").trim();
    return `${op ? `${op.nature} · ${op.nom}` : "opération inconnue"} (0x${(cmd ?? 0).toString(16).padStart(2, "0")}) · trame ${hex}`;
  } catch {
    return "trame illisible";
  }
}

function startProgram(m, ecamB64, label, durationMs = 75000, sustain = "monitor") {
  m.program = { active: true, ecamB64, label, startedAt: Date.now(), durationMs, counter: 0, sustain };
  // Une seule ligne, et elle porte tout : ce que l'utilisateur a demandé, ce que ça vaut côté
  // protocole, et les octets. C'est ici que la trame vit — plus dans les messages de l'interface,
  // où elle ne renseignait personne sur le résultat de son geste.
  L("out", `${label} — ${describeFrame(ecamB64)} · présence ${sustain}`, m);
  ensureKeepalive(m);
  sseWatch();
}

// --- import des recettes : lecture de propriétés Ayla en LAN (100 % local) ---
// Port de AylaLanCommand.newGetPropertyCommand : on sert une commande GET dans
// commands.json ; la machine POSTe la valeur sur /local_lan/property/datapoint.json,
// endpoint qu'on déchiffre déjà. Aucun appel au cloud.
function readPropertyCmd(m, name) {
  return JSON.stringify({ cmds: [{ cmd: { cmd_id: ++m.cmdId, method: "GET", resource: `property.json?name=${name}`, data: "", uri: "/local_lan/property/datapoint.json" } }] });
}
function startImport(m, queue, durationMs = 120000) {
  m.import = { active: true, queue: [...queue], pending: null, ok: [], fail: [], startedAt: Date.now(), durationMs, counter: 0 };
  L("sys", `import démarré : ${queue.length} propriétés à lire`, m);
  ensureKeepalive(m);
  // La fin d'une fenêtre expirée n'écrit aucune ligne de journal : voir sseWatch().
  sseWatch();
}
function nextImportData(m) {
  const im = m.import;
  if (!im?.active) return null;
  if (Date.now() > im.startedAt + im.durationMs) {
    im.active = false;
    im.fail = [...im.fail, ...im.queue];
    L("sys", `import expiré : ${im.ok.length} lues, ${im.fail.length} non lues`, m);
    return null;
  }
  // Présence de l'app d'abord (même prérequis que pour les commandes ECAM).
  if (im.counter++ === 0) return { data: JSON.stringify({ properties: [prop(m, "device_connected", nowSec())] }), label: "device_connected" };
  const name = im.queue.shift();
  if (!name) {
    im.active = false;
    applyChecksumMark(m, im);
    L("sys", `import terminé : ${im.ok.length} propriétés lues`, m);
    return null;
  }
  im.pending = name;
  return { data: readPropertyCmd(m, name), label: `lecture ${name}` };
}

// --- local_reg (node:http, Content-Length explicite) ---
async function postLocalReg(m) {
  const t = await machineTarget(m);
  if (!t) {
    L("out", "local_reg impossible : adresse de la machine non configurée (page « Machines »)", m);
    return { ok: false, error: "machineIp" };
  }
  if (!t.ip) {
    L("out", `local_reg impossible : ${t.error}`, m);
    return { ok: false, error: "dns" };
  }
  const probleme = serverIpProblem();
  if (probleme) {
    // On n'envoie pas : la machine accepterait (202) une adresse à laquelle elle ne peut pas
    // revenir, et le serveur croirait s'être annoncé.
    L("out", `local_reg impossible : ${probleme} — c'est l'adresse que la machine utilisera pour nous joindre`, m);
    return { ok: false, error: "serverIp" };
  }
  const notify = m.program?.active || m.import?.active ? 1 : 0;
  const b = Buffer.from(JSON.stringify({ local_reg: { ip: CFG.serverIp, port: CFG.port, uri: "/local_lan", notify } }), "utf8");
  return new Promise((resolve) => {
    const r = httpRequest(
      { host: t.ip, port: 80, path: "/local_reg.json", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": b.length, Host: t.ip, Connection: "close" } },
      (res) => { res.on("data", () => {}); res.on("end", () => { m.lastRegisterAt = Date.now(); resolve({ ok: res.statusCode < 300, status: res.statusCode }); }); },
    );
    r.on("error", (e) => { L("out", `local_reg erreur: ${e.message}`, m); resolve({ ok: false }); });
    r.setTimeout(8000, () => r.destroy());
    r.write(b); r.end();
  });
}

function ensureKeepalive(m) {
  if (m.keepalive) return;
  L("sys", "keep-alive démarré (2,5 s)", m);
  m.keepalive = setInterval(async () => {
    const active = m.program?.active === true || m.import?.active === true;
    const past = Date.now() - (m.program?.startedAt ?? 0) - (m.program?.durationMs ?? 0);
    if (!active && past > 15000) { clearInterval(m.keepalive); m.keepalive = null; L("sys", "keep-alive arrêté", m); return; }
    await postLocalReg(m);
  }, 2500);
}

// --- réponse brute (compatible ESP32) ---
function raw(res, bodyStr, status = 200) {
  // PAS de "Connection: close" : l'ESP32 enchaîne key_exchange → commands.json sur la
  // même connexion keep-alive ; fermer casse la séquence. Content-Length explicite suffit.
  const buf = Buffer.from(bodyStr, "utf8");
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length });
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
      L("in", `échange de clés refusé : aucune machine connue à l'adresse ${peerAddress(req)} et key_id ${kx.key_id} non attribué`);
      return raw(res, JSON.stringify({ error: "unknown device" }), 412);
    }
    if (Number(kx.key_id) !== m.lanKeyId) return raw(res, JSON.stringify({ error: "keyid" }), 412);
    // Mémorisé pour les deux autres endpoints, qui ne portent pas de `key_id`.
    m.peerIp = peerAddress(req);
    const t2 = Date.now();
    m.session = makeSession(m, kx, String(t2));
    return raw(res, JSON.stringify({ random_2: m.session.random2, time_2: t2 }));
  }
  const m = machineByPeer(req);
  if (!m) {
    L("in", `requête device-facing ignorée : ${url} vient de ${peerAddress(req)}, qui ne correspond à aucune machine connue`);
    return raw(res, JSON.stringify({ error: "unknown device" }), 412);
  }
  if (url === "/local_lan/commands.json" && req.method === "GET") {
    if (!m.session) return raw(res, "no session", 412);
    // Une commande ECAM en cours a priorité ; sinon on écoule la file de lecture.
    const { data, label } = (m.program?.active ? null : nextImportData(m)) ?? nextProgramData(m);
    if (label !== "idle" && label !== "done") L("out", `commande servie: ${label}`, m);
    return raw(res, m.session.encapsulate(data));
  }
  if (url.includes("/property/datapoint") && req.method === "POST") {
    if (m.session) {
      try {
        const dec = m.session.decapsulate(JSON.parse(body.toString("utf8")));
        for (const { name, value } of collectProps(dec)) handleProperty(m, name, value);
      } catch (e) { L("in", `decrypt datapoint échec: ${e.message}`, m); }
    }
    return raw(res, m.session ? m.session.encapsulate("{}") : "{}");
  }
  return raw(res, "{}");
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
  if (name.startsWith(m.mon)) {
    // Isolé : un monitor illisible ne doit pas interrompre le traitement des AUTRES propriétés
    // portées par le même datapoint.
    try {
      const mo = decodeMonitor(value);
      m.lastMonitor = { at: Date.now(), ...mo };
      L("in", `monitor: état=0x${mo.stateByte.toString(16).padStart(2, "0")}${mo.switches.length ? " · " + mo.switches.map((x) => x.label).join(", ") : ""}${mo.alarms.length ? " · alarmes " + mo.alarms.map((a) => a.name ?? `bit ${a.bit}`).join(", ") : ""}`, m);
    } catch (e) {
      L("in", `${name}: monitor illisible (${e.message})`, m);
    }
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
    if (m.import) { m.import.ok.push(name); m.import.pending = null; }
    L("in", `${name}: absente sur ce modèle`, m);
    return;
  }

  // Routage par NOM, et c'est délibéré pour celle-ci. Sa trame porte la commande `0xA1`
  // (vérifié en direct : `d0 1b a1 0f …`), qui n'a pas de décodeur — sans cette branche elle
  // tomberait dans `default` et resterait « non décodée ». L'app elle-même ne regarde pas cet
  // octet : elle lit la valeur positionnellement. Nom EXACT, pas motif : c'est le routage par
  // MOTIF (`_beansystem` → décodeur de recettes) qui avait produit les désalignements.
  if (name === SERIAL_PROP) {
    applyIdentity(m, value);
    if (m.import) { m.import.ok.push(name); m.import.pending = null; }
    return;
  }

  let cmd;
  try { cmd = Buffer.from(value, "base64")[2]; } catch { cmd = undefined; }
  // Chaque branche écrit ce qu'elle a décodé, tout de suite : `done` ne fait plus que journaliser.
  const done = (msg) => {
    if (m.import) { m.import.ok.push(name); m.import.pending = null; }
    L("in", `${name}: ${msg}`, m);
  };
  const failed = (e) => {
    if (m.import) m.import.fail.push(name);
    L("in", `${name}: décodage impossible (${e.message})`, m);
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
      default: {
        const hex = Buffer.from(value, "base64").toString("hex").replace(/(..)/g, "$1 ").trim();
        m.store.putProp(name, { at: Date.now(), kind: "unknown", cmd: cmd ?? null, hex });
        return done(`commande 0x${(cmd ?? 0).toString(16)} non décodée — ${hex}`);
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
  L("in", `data_response: ${hex}`, m);
  if (buf[2] === 0xa2) {
    try {
      const pr = decodeParameters(value);
      m.store.putStats(pr.entries);
      L("in", `paramètres : ${pr.entries.map((e) => `${e.id}=${e.value}`).join(", ")}`, m);
    } catch (e) {
      L("in", `paramètres : décodage impossible (${e.message})`, m);
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
      L("in", `sommes de contrôle : ${cs.size} profils, noms=0x${cs.names.toString(16)}, perso=0x${cs.customRecipes.toString(16)}${changed.length ? " — changé : " + changed.join(", ") : prev ? " — rien de changé" : ""}`, m);
    } catch (e) {
      L("in", `sommes de contrôle : décodage impossible (${e.message})`, m);
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
    if (entry?.name) out[229 + Number(slot)] = { name: entry.name, icon: entry.icon, prop: entry.prop, source: "recette perso" };
  }
  return out;
}

/**
 * Configuration de grains actuellement sélectionnée sur la machine (octet 50 de la trame `0xBA`).
 * C'est elle qui détermine la tasse pour la boisson Bean System, donc on l'expose comme attribut.
 */
function activeBeanSystem(store) {
  for (const [index, bs] of Object.entries(store.beanSystems ?? {})) {
    if (bs?.active && Number(index) >= 1) {
      return { index: Number(index), name: bs.name, grinder: bs.grinder, temperature: bs.temperature, aroma: bs.aroma };
    }
  }
  return null;
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
 * Identifiants de paramètres que l'app demande sur son écran de statistiques
 * (`p018b7/e.java`, `readSettingsParameter`). Aucune table de l'APK ne les nomme : le viewmodel les
 * lit par id et affiche le résultat via les propriétés `d7xx_tot_*`. La correspondance
 * id → signification reste donc à établir sur la machine.
 */
const APP_STAT_IDS = [105, 106, 108, 115, 3000, 3001, 3003, 3017, 3021, 3025, 3047, 3048, 3077, 3078, 3080];

/** Propriétés dont la lecture est couverte par la somme de contrôle « noms » (trame `0xA3`). */
const NAME_PROPS = new Set([...PROFILE_NAME_PROPS, ...CUSTOM_NAME_PROPS].map((x) => x.prop));

/**
 * Marque « cette famille est à jour », posée à la FIN d'un import et seulement s'il a tout lu.
 *
 * Une propriété absente sur ce modèle (variantes Striker) compte comme lue, pas comme un échec :
 * c'est `handleProperty` qui la range dans `ok` avec `absent: true`.
 */
function applyChecksumMark(m, im) {
  const mark = im.checksumMark;
  if (!mark) return;
  const missing = (im.covered ?? []).filter((p) => !im.ok.includes(p));
  if (im.fail.length || missing.length) {
    L("sys", `sommes non mémorisées : ${im.fail.length} échec(s), ${missing.length} sans réponse — la relecture restera proposée`, m);
    return;
  }
  m.store.setMeta("checksumsAtImport", { ...(m.store.getMeta("checksumsAtImport") ?? {}), ...mark });
  L("sys", `somme des noms mémorisée (0x${Number(mark.names).toString(16)}) : inutile de les relire tant qu'elle ne bouge pas`, m);
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
    if (m.dns?.ip !== address) L("sys", `« ${configured} » résolu en ${address}`, m);
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
        resolve({ host, ip: t.ip, reachable: true, status: res.statusCode, regtoken: parsed, at: Date.now() });
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
      L("sys", `clé LAN reprise du cache (key_id ${m.lanKeyId})`, m);
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
    L("sys", "cloud : jeton renouvelé depuis la session mémorisée (sans mot de passe)", m);
    return { token: j.access_token, expiresIn: Number(j.expires_in) || 0 };
  } catch (e) {
    L("sys", `cloud : renouvellement impossible (${e.message}) — session mémorisée oubliée, le mot de passe sera redemandé`, m);
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
    L("sys", "cloud : JWT fourni, Gigya court-circuité", m);
  } else {
    L("sys", "cloud : connexion au compte De'Longhi…", m);
    const login = await gigyaCall("accounts.login", { apiKey, loginID: email, password });
    // Uniquement `cookieValue` : l'ancien repli sur `sessionToken` ne rattrapait rien, il
    // transmettait un jeton du mauvais type au lieu d'échouer avec un message clair.
    const loginToken = login?.sessionInfo?.cookieValue;
    if (!loginToken) throw new Error("accounts.login : pas de sessionInfo.cookieValue dans la réponse (session non navigateur ?)");
    jwt = (await gigyaCall("accounts.getJWT", { apiKey, login_token: loginToken }))?.id_token;
    if (!jwt) throw new Error("accounts.getJWT : aucun id_token dans la réponse");
    L("sys", "cloud : identité De'Longhi obtenue, échange vers Ayla…", m);
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
    else L("sys", "cloud : aucun refresh_token dans la réponse — la session ne peut pas être mémorisée", m);
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
  L("sys", `OTA : ${disponible ? `image proposée${releve.version ? ` (${releve.version})` : ""}` : `aucune mise à jour (HTTP ${r.status})`}`, m);
  return releve;
}

async function discoverLanKey(m, { email, password, jwt: givenJwt, remember = false }) {
  const dsn = await resolveDsn(m);
  // Le DSN est la seule dépendance de la découverte envers la machine — et une fois mémorisé,
  // elle n'a plus besoin d'elle du tout. Le message doit donc désigner l'action qui débloque.
  if (!dsn) throw new Error("DSN inconnu : la clé est rangée sous le numéro de série de la machine, que le serveur obtient en l'interrogeant. Renseigner l'adresse de la machine (page « Machines »), ou forcer MACHINE_DSN dans .env.local.");

  const accessToken = await aylaAccessToken(m, { email, password, jwt: givenJwt, remember });

  L("sys", `clé LAN : lecture de lan.json pour ${dsn}…`, m);
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
  try { ota = await checkCloudOta(m, accessToken); } catch (e) { L("sys", `OTA : relevé impossible (${e.message})`, m); }
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
    L("sys", "clé LAN changée : session LAN abandonnée, un nouveau key exchange est nécessaire", m);
  }
  m.store.setLanKey(key, keyId);
  L("sys", `clé LAN ${changed ? "mise à jour" : "confirmée"} (key_id ${keyId}, source : ${source})`, m);
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
async function resolveDsn(m, { compare = false } = {}) {
  if (m.dsn && !compare) return m.dsn;
  // Sans cela, la resolution paresseuse en tete de handleApi lance une sonde de 4 s a CHAQUE
  // appel d API tant que le DSN est inconnu — or les pages interrogent /api/status toutes les
  // 3 s. Resultat : le reseau martele et le journal noye sous des lignes identiques. Une
  // tentative toutes les 30 s suffit ; `compare` (action explicite) n est jamais bride.
  if (!compare) {
    if (Date.now() - m.dsnLastTry < 30000) return m.dsn;
    m.dsnLastTry = Date.now();
  }
  const r = await probeRegtoken(m);
  // L'adresse a pu changer pendant la requête (saisie d'une nouvelle machine, oubli). Attribuer
  // le DSN d'un ancien appareil à la nouvelle adresse serait faux — et c'est arrivé : une sonde
  // lancée au démarrage a repeuplé, 186 ms plus tard, un DSN qu'un changement d'adresse venait
  // d'effacer.
  if (r?.host && r.host !== m.ip) {
    L("sys", `sonde ignorée : la réponse venait de ${r.host}, l'adresse est maintenant ${m.ip ?? "inconnue"}`, m);
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
        L("sys", msg, m);
      }
    }
    return m.dsn;
  }
  if (m.dsn && m.dsn !== found) {
    L("sys", `⚠ DSN divergent : ${m.dsnSource} donne ${m.dsn}, la machine annonce ${found}. Le réglage explicite reste prioritaire — retirer MACHINE_DSN de .env.local pour suivre la machine.`, m);
  } else if (!m.dsn) {
    m.dsnLastMsg = null;
  m.dsn = found;
    m.dsnSource = "machine (regtoken.json)";
    L("sys", `DSN découvert sur la machine : ${found}`, m);
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
      L("sys", `adresse de la machine reprise du cache : ${saved.value}`, m);
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
    L("sys", `adresse de la machine changée : ${value} — session et DSN mémorisé abandonnés`, m);
  } else {
    L("sys", `adresse de la machine confirmée : ${value}`, m);
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
      L("sys", `DSN repris du cache : ${saved.value}`, m);
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
    L("in", `${SERIAL_PROP} : ${r.reason} — trame ${r.hex || "(vide)"}`, m);
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
  L("in", `${SERIAL_PROP} : ${r.machineName} → clé ${r.modelKey} → ${lu}`, m);
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
  if (m.import?.active || m.program?.active) return null;
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
  L("sys", `adresse et clé LAN réunies : première lecture (${queue.length} propriétés — modèle et noms)`, m);
  startImport(m, queue, Math.max(45000, queue.length * 4000));
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
    L("sys", `modèle repris du cache : ${saved.key}${modele ? ` (${modele.type})` : " (inconnu de la table)"}`, m);
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
      L("sys", `profil actif restauré : ${saved.id}${saved.confirmed ? "" : " (non confirmé)"}`, m);
    }
  } catch {}
}

/**
 * Enchaîne un `0xBA` par index. Un intervalle fixe suffit : la machine répond en 2-3 s, et le
 * programme précédent doit être clos avant le suivant, sinon `startProgram` l'écraserait.
 */
function scanNextBean(m) {
  const sc = m.beanScan;
  if (!sc?.active) return;
  if (sc.next > sc.to) {
    sc.active = false;
    L("sys", "balayage des grains terminé", m);
    return;
  }
  const index = sc.next++;
  startProgram(m, datapointValue(frameBeanSystem(index)), `Bean System ${index}`, 9000, "monitor");
  postLocalReg(m);
  setTimeout(() => scanNextBean(m), 11000);
}

/**
 * Enchaîne les lectures de paramètres, une trame `0xA2` à la fois. Même cadence que le balayage
 * des grains, qui est validée : la machine répond en 2-3 s et le programme précédent doit être clos
 * avant le suivant.
 */
function scanNextStat(m) {
  const sc = m.statScan;
  if (!sc?.active) return;
  const next = sc.queue.shift();
  if (next === undefined) {
    sc.active = false;
    L("sys", `lecture des statistiques terminée (${m.store.countStats()} paramètres connus)`, m);
    return;
  }
  startProgram(m, datapointValue(frameParamRead(next.id, next.qty)), `Paramètres ${next.id}${next.qty > 1 ? `+${next.qty - 1}` : ""}`, 9000, "monitor");
  postLocalReg(m);
  setTimeout(() => scanNextStat(m), 11000);
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
];

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
     * rafraîchissement. Voir `fenetreOuverte` pour la raison du contrôle de durée.
     */
    reading: fenetreOuverte(m.import)
      ? { remaining: m.import.queue.length, ok: m.import.ok.length, fail: m.import.fail.length, pending: m.import.pending }
      : null,
    running: fenetreOuverte(m.program) ? m.program.label : null,
    // Juste de quoi dire « elle répond, et dans quel état » — la fiche complète est /api/status.
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
    L("sys", `machine ajoutée : ${machineLabel(m)}`, m);
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
      L("sys", `machine renommée : ${machineLabel(m)}`, m);
    }
    if (b.makeDefault === true) {
      setSetting("defaultMachine", m.id);
      L("sys", `machine par défaut : ${machineLabel(m)}`, m);
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
      // L'ancien enregistrement va être remplacé, mais des `setTimeout` en vol le référencent
      // encore (balayage des grains, lecture des statistiques). Les désarmer avant : sinon un
      // balayage en cours continuerait à s'annoncer à l'ancienne adresse, sur un objet qui n'est
      // plus dans le registre — invisible depuis l'interface.
      m.beanScan = null;
      m.statScan = null;
      m.import = null;
      m.program = null;
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
      L("sys", `machine remise à zéro : ${nom} — adresse, clé LAN, DSN, modèle, ${cleared.props} propriétés et ${cleared.stats} statistiques effacés`, frais);
      // Ce que l'environnement remet en place aussitôt : il faut le DIRE, sinon la remise à zéro
      // a l'air de n'avoir rien fait.
      const envRestored = ["ip", "lanKey", "dsn", "modelKey"].filter((k) => envForced(frais, k));
      if (envRestored.length) L("sys", `valeurs reprises de .env.local après la remise à zéro : ${envRestored.join(", ")}`, frais);
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
    L("sys", `machine supprimée : ${nom} — propriétés lues, statistiques, recettes et clé LAN mémorisée effacées`, m);
    return raw(res, JSON.stringify({ removed, defaultId: defaultMachine().id, machines: machineList().map(machineSummary) }));
  }

  return raw(res, JSON.stringify({ error: "not found" }), 404);
}

/**
 * Une fenêtre est-elle encore ouverte ? On vérifie la **durée**, pas seulement le drapeau `active` :
 * celui-ci ne retombe que quand la machine vient chercher la commande suivante
 * (`nextImportData` / `nextProgramData`). Si elle ne se connecte jamais, il resterait vrai
 * indéfiniment — et tout ce qui s'y fie resterait bloqué avec lui.
 */
const fenetreOuverte = (x) => !!x?.active && Date.now() <= x.startedAt + x.durationMs;

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

function sseBroadcast() {
  if (!SSE.size) return;
  const charge = JSON.stringify({
    machines: machineList().map(machineSummary),
    defaultId: defaultMachine().id,
    at: Date.now(),
  });
  for (const res of [...SSE]) {
    try {
      res.write(`data: ${charge}\n\n`);
    } catch {
      SSE.delete(res);
    }
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
 * Veilleur, actif seulement pendant qu'un import ou un programme tourne.
 *
 * Le journal suffit pour tout ce qui **arrive**, mais pas pour ce qui **cesse** : quand une fenêtre
 * expire sans que la machine se soit connectée, aucune ligne n'est écrite. Sans ce veilleur, le
 * badge « lecture… » resterait affiché indéfiniment, à décrire un import qui n'existe plus.
 *
 * Il s'arrête de lui-même au premier passage où plus rien n'est ouvert, après une dernière émission
 * — celle qui remet les champs à zéro.
 */
let sseWatcher = null;
function sseWatch() {
  if (sseWatcher) return;
  sseWatcher = setInterval(() => {
    const actif = machineList().some((m) => fenetreOuverte(m.import) || fenetreOuverte(m.program));
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

function putBeanPreset(m, { id, name, grinder, temperature, aroma }) {
  const liste = beanPresets(m);
  const at = Date.now();
  const propre = {
    name: String(name ?? "").slice(0, 20),
    grinder: Number(grinder),
    temperature: Number(temperature),
    aroma: Number(aroma),
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
  L("sys", `configuration de grains ${i >= 0 ? "modifiée" : "mémorisée"} : « ${entree.name || "sans nom"} » mouture ${entree.grinder}, temp ${entree.temperature}, arôme ${entree.aroma}`, m);
  return entree;
}

function deleteBeanPreset(m, id) {
  const liste = beanPresets(m);
  const reste = liste.filter((x) => x.id !== id);
  if (reste.length === liste.length) return false;
  m.store.setMeta("beanPresets", reste);
  L("sys", `configuration de grains oubliée (${id})`, m);
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

  // À quelle machine cette requête s'adresse-t-elle ? Un identifiant inconnu est refusé, jamais
  // remplacé en silence par la machine par défaut.
  const { m, error: machineError } = pickMachine(req);
  if (!m) return raw(res, JSON.stringify({ error: machineError, unknownMachine: true }), 404);
  // Le DSN part dans CHAQUE écriture de propriété servie à la machine : on s'assure de le
  // connaître avant d'agir. Ne coûte une requête que tant qu'il est inconnu.
  if (!m.dsn) await resolveDsn(m);
  // Refus franc plutôt qu'un succès trompeur (voir NEEDS_MACHINE). Les drapeaux permettent à une
  // interface de réagir sans analyser le texte du message.
  if (req.method === "POST" && NEEDS_MACHINE.some((p) => url === p || url.startsWith(`${p}/`))) {
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
      session: { active: !!m.session }, lastRegisterAt: m.lastRegisterAt, activeProfile: m.activeProfile, activeProfileConfirmed: m.activeProfileConfirmed,
      program: m.program ? { active: m.program.active, label: m.program.label, counter: m.program.counter } : null,
      lastMonitor: m.lastMonitor, lastDataResponse: m.lastDataResponse, log: LOG.slice(0, 50),
    }));
  }
  if (url === "/api/command" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    if (b.action === "clear") { m.program = null; L("sys", "programme annulé", m); return raw(res, JSON.stringify({ cleared: true })); }
    let frame, label, dur = 75000, refreshOrderFor = null, sustain = "monitor", checksumBefore;
    // DONTCARE (0) est le mode utilisé pour enregistrer/supprimer une recette (voir
    // DeLonghiWifiConnectService:2959) ; START pour préparer.
    const MODE = { DONTCARE: 0, START: 1, STOPV2: 2 };
    const ACT = { SAVE: 1, PREPARE: 2, PREPARE_INVERSION: 6 };
    // `RecipeData.T()` : l'app choisit l'action « inversion » quand le paramètre INVERSION (12)
    // vaut 1 — c'est le cas du flat white, du cappuccino inversé, du cortado, du long black.
    const inverted = (params) => (params ?? []).some((x) => Number(x.id) === 12 && Number(x.value) === 1);
    try {
      if (b.action === "on") { frame = frameTurnOn(); label = "Allumer"; sustain = "profile"; }
      else if (b.action === "off") { frame = frameTurnOff(); label = "Éteindre"; dur = 20000; }
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
        // Fenêtre courte : juste après, on relit l'ordre d'affichage de ce profil pour que
        // l'UI ne montre pas un ordre périmé (une seule propriété, c'est rapide).
        dur = 10000;
        refreshOrderFor = m.activeProfile;
      }
      else if (b.action === "selectBean") { frame = frameSelectBean(Number(b.beanId ?? 1)); label = `Bean ${b.beanId}`; dur = 20000; }
      else if (b.action === "stop") { frame = frameDispense(Number(b.beverageId ?? 1), Number(b.profileId ?? 1), MODE.STOPV2, ACT.PREPARE, []); label = "Arrêt"; dur = 15000; }
      else if (b.action === "dispense") {
        let bev, prof, params;
        if (b.recipeId) { const r = m.store.listRecipes().find((x) => x.id === b.recipeId); if (!r) return raw(res, JSON.stringify({ error: "recette inconnue" }), 404); ({ beverageId: bev, profileId: prof, params } = r); }
        else { bev = Number(b.beverageId ?? 1); prof = Number(b.profileId ?? 1); params = b.params ?? []; }
        m.activeProfile = Number(prof) || 1;
        m.activeProfileConfirmed = true;
        rememberActiveProfile(m);
        const act = inverted(params) ? ACT.PREPARE_INVERSION : ACT.PREPARE;
        frame = frameDispense(bev, prof, MODE.START, act, params);
        label = `Préparer ${bevLabel(m, bev)}${act === ACT.PREPARE_INVERSION ? " (lait d'abord)" : ""}`;
      } else return raw(res, JSON.stringify({ error: "action inconnue" }), 400);
    } catch (e) { return raw(res, JSON.stringify({ error: e.message }), 400); }
    const ecamB64 = datapointValue(frame);
    startProgram(m, ecamB64, label, dur, sustain);
    // La file de lecture est écoulée quand aucun programme n'est actif : elle s'enchaîne donc
    // naturellement après la fenêtre du programme ci-dessus.
    if (refreshOrderFor) {
      const p = refreshOrderFor;
      startImport(m, [`d${String(260 + p).padStart(3, "0")}_${p}_rec_priority`], 45000);
    }

    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ program: label, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg, ...(checksumBefore !== undefined ? { checksumBefore } : {}) }));
  }
  // Catalogue des boissons de la machine + ce qui a été lu dessus.
  if (url === "/api/beverages" && req.method === "GET") {
    const store = m.store.machineView();
    const profileId = Number(new URL(req.url, "http://x").searchParams.get("profile") ?? 1);
    // Une recette perso renommée sur la machine doit s'afficher sous son nom, pas sous le
    // libellé générique du catalogue.
    const machineNames = machineBeverageNames(store);
    const bean = activeBeanSystem(store);
    const beverages = m.catalog.beverages.map((b) => {
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
        icon: named?.icon ?? null,
        boundsProp,
        valuesProp,
        bounds,
        values,
      };
    });
    // Ordre d'affichage de la machine pour ce profil (propriété de priorité), s'il est connu.
    const prioProp = `d${String(260 + profileId).padStart(3, "0")}_${profileId}_rec_priority`;
    const order = store.props[prioProp]?.beverageIds ?? null;
    return raw(res, JSON.stringify({
      model: { key: m.catalog.key, type: m.catalog.model.type, appModelId: m.catalog.model.appModelId, productCode: m.catalog.model.productCode, nProfiles: m.catalog.model.nProfiles, protocolVersion: m.catalog.model.protocolVersion, fallback: m.catalog.fallback },
      categories: CATEGORIES, profileId, beverages, order, orderProp: prioProp,
      importedAt: store.importedAt,
      import: m.import ? { active: m.import.active, remaining: m.import.queue.length, ok: m.import.ok.length, fail: m.import.fail.length, pending: m.import.pending } : null,
    }));
  }

  // Import : lit sur la machine les bornes et/ou les recettes du profil, en LAN pur.
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
    startImport(m, queue, Math.max(60000, queue.length * 3000));
    if (beanIndex !== null) startProgram(m, datapointValue(frameBeanSystem(beanIndex)), `Bean System ${beanIndex}`, 12000, "monitor");
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ queued: queue.length, profileId, what, beanSystem: beanIndex, register: reg }));
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
        order: prio
          ? prio.beverageIds.map((bid) => ({ id: bid, label: m.catalog.byId(bid)?.label ?? null }))
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
      model: { key: m.catalog.key, type: m.catalog.model.type, nProfiles: m.catalog.model.nProfiles, customizableProfiles: m.catalog.model.customizableProfiles, nCustomRecipes: m.catalog.model.nCustomRecipes },
      profiles, customs,
      props: ALL_PROFILE_PROPS.map((x) => {
        const d = store.props[x.prop];
        return { prop: x.prop, kind: x.kind, stride: x.stride ?? null, state: !d ? "unread" : d.absent ? "absent" : "read" };
      }),
      importedAt: store.importedAt,
      import: m.import ? { active: m.import.active, remaining: m.import.queue.length, ok: m.import.ok.length, fail: m.import.fail.length, pending: m.import.pending } : null,
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
    startImport(m, queue, Math.max(60000, queue.length * 3000));
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
    if (m.import && store.checksums && covered.length) {
      m.import.covered = covered;
      m.import.checksumMark = { names: store.checksums.names };
    }
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ queued: queue.length, what, skipped, register: reg }));
  }

  // Sommes de contrôle : demande la trame 0xA3 à la machine.
  if (url === "/api/checksums" && req.method === "POST") {
    const frame = frameChecksums();
    startProgram(m, datapointValue(frame), "Sommes de contrôle", 15000, "monitor");
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ sent: true, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg }));
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
    startProgram(m, datapointValue(frame), `Bean System ${index}`, 15000, "monitor");
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ sent: true, index, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg }));
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
    startImport(m, [SERIAL_PROP], 30000);
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ queued: true, prop: SERIAL_PROP, register: reg }));
  }

  // Lecture de propriétés Ayla arbitraires — outil d'exploration, et brique de /api/presence.
  if (url === "/api/read" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const props = Array.isArray(b.props) ? b.props.filter((x) => typeof x === "string" && x) : [];
    if (!props.length) return raw(res, JSON.stringify({ error: "aucune propriété demandée" }), 400);
    startImport(m, props, Math.max(30000, props.length * 3000));
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ queued: props.length, props, register: reg }));
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
    const fresh = m.lastMonitor && now - m.lastMonitor.at < 30000;
    const busyAlready = m.program?.active === true || m.import?.active === true;
    if (fresh || busyAlready) {
      return raw(res, JSON.stringify({ skipped: true, reason: fresh ? "monitor récent" : "programme en cours", lastMonitor: m.lastMonitor }));
    }
    // 8 s : assez pour ne pas marteler, assez court pour qu'une relance de la page passe. La
    // machine ne pousse pas toujours son monitor à la première session (comportement transitoire
    // déjà observé), donc une seconde tentative doit être possible.
    if (now - (m.lastPresenceAt ?? 0) < 8000) {
      return raw(res, JSON.stringify({ skipped: true, reason: "présence déjà demandée récemment", lastMonitor: m.lastMonitor }));
    }
    m.lastPresenceAt = now;
    startProgram(m, datapointValue(frameMonitorRequest()), "Présence", 12000, "monitor");
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({ started: true, register: reg }));
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
    if (m.beanScan?.active) return raw(res, JSON.stringify({ error: "un balayage est déjà en cours" }), 409);
    m.beanScan = { active: true, next: from, to, startedAt: Date.now() };
    scanNextBean(m);
    return raw(res, JSON.stringify({ started: true, from, to }));
  }

  if (url === "/api/beanadapt" && req.method === "GET") {
    const store = m.store.machineView();
    const beans = Object.entries(store.beanSystems ?? {}).map(([index, bs]) => ({
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
    }));
    return raw(res, JSON.stringify({
      beans,
      // La bibliothèque locale, servie avec les grains de la machine : la page les montre côte à
      // côte, une seule requête suffit.
      presets: beanPresets(m),
      bounds: {
        grinder: { min: GRINDER_MIN, max: GRINDER_MAX, verified: true },
        aroma: { min: AROMA_MIN, max: AROMA_MAX, verified: true },
        temperature: { min: TEMPERATURE_MIN, max: TEMPERATURE_MAX, verified: false },
      },
      activeProfile: m.activeProfile,
      scan: m.beanScan?.active ? { next: m.beanScan.next, to: m.beanScan.to } : null,
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
    return raw(res, JSON.stringify({ presets: beanPresets(m) }));
  }
  if (url === "/api/beanpresets" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const grinder = Number(b.grinder);
    const temperature = Number(b.temperature);
    const aroma = Number(b.aroma);
    if (!(grinder >= GRINDER_MIN && grinder <= GRINDER_MAX)) return raw(res, JSON.stringify({ error: `mouture hors bornes (${GRINDER_MIN}–${GRINDER_MAX})` }), 400);
    if (!(aroma >= AROMA_MIN && aroma <= AROMA_MAX)) return raw(res, JSON.stringify({ error: `arôme hors bornes (${AROMA_MIN}–${AROMA_MAX})` }), 400);
    if (!(temperature >= TEMPERATURE_MIN && temperature <= TEMPERATURE_MAX)) return raw(res, JSON.stringify({ error: `température hors bornes (${TEMPERATURE_MIN}–${TEMPERATURE_MAX})` }), 400);
    const entree = putBeanPreset(m, { id: typeof b.id === "string" ? b.id : null, name: b.name, grinder, temperature, aroma });
    return raw(res, JSON.stringify({ ok: true, preset: entree, presets: beanPresets(m) }));
  }
  if (url === "/api/beanpresets" && req.method === "DELETE") {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    const removed = deleteBeanPreset(m, String(id ?? ""));
    return raw(res, JSON.stringify({ removed, presets: beanPresets(m) }));
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
    startProgram(m, datapointValue(frame), `Bean System ${index} → mouture ${grinder}, temp ${temperature}, arôme ${aroma}`, 20000, "monitor");
    const reg = await postLocalReg(m);
    return raw(res, JSON.stringify({
      sent: true,
      frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(),
      wrote: { index, name: name.slice(0, 20), grinder, temperature, aroma, visible },
      register: reg,
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
    L("sys", `session cloud : ${removed ? "oubliée" : "déjà absente"}`, m);
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
    if (!m.dsn) {
      return raw(res, JSON.stringify({ error: "DSN inconnu : la fiche OTA est rangée chez Ayla sous le numéro de série de la machine. Renseigner son adresse pour que le serveur le lise.", needsDsn: true }), 409);
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
      L("sys", `OTA : vérification impossible (${e.message})`, m);
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
      L("sys", `clé LAN : échec de la découverte (${e.message})`, m);
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
    L("sys", `clé LAN : cache ${removed ? "supprimé" : "déjà absent"}`, m);
    return raw(res, JSON.stringify({ removed, set: m.lanKey.length > 0, source: m.lanKeySource }));
  }

  /**
   * Statistiques d'utilisation. Ce sont des PARAMÈTRES machine lus par la commande `0xA2`, pas des
   * propriétés Ayla : les `d7xx_tot_*` que l'app connaît ne renvoient rien tant qu'on n'a pas
   * envoyé la commande (même piège que les Bean Systems).
   *
   * `ids` : liste d'identifiants. `from`+`qty` : une plage consécutive en une seule trame.
   */
  if (url === "/api/stats" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    if (m.statScan?.active) return raw(res, JSON.stringify({ error: "une lecture est déjà en cours" }), 409);
    let queue = [];
    if (Array.isArray(b.ids) && b.ids.length) {
      queue = b.ids.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff).map((id) => ({ id, qty: 1 }));
    } else if (Number.isInteger(Number(b.from))) {
      const qty = Math.min(Math.max(Number(b.qty ?? 1), 1), 40);
      queue = [{ id: Number(b.from), qty }];
    }
    if (!queue.length) return raw(res, JSON.stringify({ error: "fournir ids[] ou from(+qty)" }), 400);
    const requests = queue.length;
    m.statScan = { active: true, queue, total: requests, startedAt: Date.now() };
    // scanNextStat() consomme la file : on compte AVANT de la lancer.
    scanNextStat(m);
    return raw(res, JSON.stringify({ started: true, requests }));
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
      scan: m.statScan?.active ? { remaining: m.statScan.queue.length, total: m.statScan.total } : null,
      // Ce que l'app demande (p258z7/w.java et le viewmodel des statistiques).
      appIds: APP_STAT_IDS,
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
      L("sys", `⚠ adresse saisie (${ip}) différente de MACHINE_IP (${ENV_MACHINE.ip}) — le réglage explicite reste prioritaire au redémarrage`, m);
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
    L("sys", `adresse de la machine : cache ${had ? "supprimé" : "déjà absent"}`, m);
    return raw(res, JSON.stringify({ removed: had, ip: m.ip, source: m.ipSource }));
  }

  if (url === "/api/register" && req.method === "POST") { const r = await postLocalReg(m); return raw(res, JSON.stringify(r)); }
  if (url === "/api/recipes") {
    if (req.method === "GET") return raw(res, JSON.stringify({ recipes: m.store.listRecipes() }));
    if (req.method === "POST") {
      const r = JSON.parse((await readBody(req)).toString("utf8"));
      // L'id est la clé primaire : sans lui, l'ancien code écrivait une recette anonyme que la
      // suivante écrasait en silence.
      if (!r?.id) return raw(res, JSON.stringify({ error: "id de recette manquant" }), 400);
      m.store.putRecipe(r);
      return raw(res, JSON.stringify({ recipes: m.store.listRecipes() }));
    }
    if (req.method === "DELETE") { const id = new URL(req.url, "http://x").searchParams.get("id"); m.store.deleteRecipe(id); return raw(res, JSON.stringify({ recipes: m.store.listRecipes() })); }
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
for (const msg of storeBootMessages) L("sys", msg);
for (const m of loadMachines()) {
  restoreActiveProfile(m);
  restoreMachineIp(m);
  restoreDsn(m);
  restoreModel(m);
  restoreLanKey(m);
  // Après les reprises : le modèle est connu (variable, cache) ou non, et dans les deux cas c'est
  // ici que le catalogue et la génération sont arrêtés — et que leurs limites sont annoncées.
  applyCatalog(m);
  if (!m.ip) L("sys", "adresse de la machine inconnue : la renseigner sur la page « Machines », ou par MACHINE_IP dans .env.local", m);
  if (!m.lanKey.length) L("sys", "clé LAN absente : la renseigner dans .env.local, ou la faire découvrir depuis la page « Machines » (compte De'Longhi)", m);
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
    L("in", `requête OTA${m ? "" : ` d'un appareil non reconnu (${peerAddress(req)})`} : ${req.method} ${u}`, m);
    return raw(res, JSON.stringify({ ota: "none" }), 404);
  }
  if (u.startsWith("/local_lan/")) return handleLan(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
  if (u.startsWith("/api/")) return handleApi(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
  return handle(req, res);
}).listen(CFG.port, "0.0.0.0", () => {
  const liste = machineList();
  console.log(`De'Longhi LAN server (custom${DEV ? ", dev/HMR" : ""}) sur http://0.0.0.0:${CFG.port}  — ${liste.length} machine${liste.length > 1 ? "s" : ""}`);
  for (const m of liste) {
    console.log(`  ${m.id}${m.label ? ` « ${m.label} »` : ""} : adresse ${m.ip ?? "à configurer"}, DSN ${m.dsn ?? "à découvrir"}, clé LAN ${m.lanKey.length ? `key_id ${m.lanKeyId}` : "absente"}`);
  }
  const problemeServerIp = serverIpProblem();
  if (problemeServerIp) {
    const vues = candidateServerIps();
    L("sys", `⚠ ${problemeServerIp} — or c'est l'adresse que nous ANNONÇONS à la machine : en mode LAN, c'est elle qui se connecte à nous. Aucune session ne pourra s'établir. Adresses non locales vues d'ici : ${vues.length ? vues.join(", ") : "aucune"}. En conteneur bridge, annoncer l'adresse de l'HÔTE, pas celle du conteneur.`);
  }
  // `compare` : on interroge la machine même quand le DSN est déjà connu, pour signaler une
  // divergence au démarrage plutôt que de la découvrir au premier échec de commande.
  for (const m of liste) if (m.ip) resolveDsn(m, { compare: true }).catch(() => {});
});
