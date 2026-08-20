/**
 * Stockage persistant du serveur LAN — **SQLite** via `node:sqlite`, un seul fichier
 * `data/lan-server.db`. Remplace les trois fichiers JSON (`machine-beverages.json`,
 * `recipes.json`, `lan-key.json`), migrés automatiquement au premier démarrage.
 *
 * Pourquoi : le cache machine était réécrit **en entier** à chaque propriété reçue — 80 ko de
 * JSON sérialisés puis `rename`, une soixantaine de fois pendant un import, pour ne modifier
 * qu'une ligne. Ici chaque propriété est un `UPSERT` d'une ligne, dans sa propre transaction.
 * Le coût d'une écriture ne dépend plus de la taille du cache, et une coupure au milieu d'un
 * import ne peut plus laisser qu'une transaction inachevée — jamais un cache vide.
 *
 * Choix de robustesse, délibérés :
 * - `journal_mode = WAL` : les lectures ne bloquent pas l'écriture, et une coupure brutale se
 *   rejoue au prochain démarrage au lieu de corrompre le fichier.
 * - `synchronous = FULL` : chaque transaction est réellement sur le disque avant de rendre la
 *   main. Le volume est minuscule (quelques dizaines d'écritures par import), le coût est donc
 *   invisible, et on ne perd rien sur une coupure de courant — la machine, elle, ne rejouera
 *   pas ses propriétés.
 * - tables `STRICT` : une valeur du mauvais type est refusée à l'écriture au lieu d'être
 *   découverte à la lecture, six mois plus tard, dans une page qui affiche « NaN ».
 *
 * ⚠️ **Ce fichier contient du matériel secret** : la clé LAN (table `meta`, clé `lanKey`), le
 * numéro de série et les noms de profils saisis sur la machine. `data/` est gitignoré et doit être
 * traité comme tel — ne jamais joindre `lan-server.db` à un rapport de bug sans l'avoir purgé.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Où vivent les données. Deux réglages, dans cet ordre :
 *
 * - `DATA_DIR` — répertoire de tout l'état persistant (défaut : `./data`). C'est aussi là que la
 *   migration va chercher les anciens fichiers JSON.
 * - `DATABASE_FILE` — chemin complet du fichier de base, si on veut le sortir de `DATA_DIR`
 *   (défaut : `<DATA_DIR>/lan-server.db`).
 *
 * Indispensable en conteneur : l'image est en lecture seule, les données dans un volume monté.
 * Voir DOCKER.md.
 */
const DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(process.cwd(), "data");
const DBFILE = process.env.DATABASE_FILE ? resolve(process.env.DATABASE_FILE) : join(DIR, "lan-server.db");
const SCHEMA_VERSION = 1;

/**
 * Schéma. Les colonnes `at` sont des millisecondes unix ; `data` porte le JSON de ce qui n'est pas
 * indexé. On ne duplique pas `at`/`kind` dans le JSON des propriétés : ils sont reconstitués à la
 * lecture, ce qui évite deux sources de vérité pour la même valeur.
 */
const DDL = `
CREATE TABLE props (
  name TEXT PRIMARY KEY,
  at   INTEGER NOT NULL,
  kind TEXT,
  data TEXT NOT NULL
) STRICT;

CREATE TABLE bean_systems (
  idx  INTEGER PRIMARY KEY,
  at   INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;

CREATE TABLE stats (
  id    INTEGER PRIMARY KEY,
  value INTEGER NOT NULL,
  at    INTEGER NOT NULL
) STRICT;

CREATE TABLE recipes (
  id        TEXT PRIMARY KEY,
  updatedAt INTEGER NOT NULL,
  data      TEXT NOT NULL
) STRICT;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    INTEGER NOT NULL
) STRICT;
`;

// Les deux répertoires : celui des données (migration, anciens JSON) et celui de la base, qui peut
// être ailleurs si `DATABASE_FILE` la déplace.
mkdirSync(DIR, { recursive: true });
mkdirSync(dirname(DBFILE), { recursive: true });
const db = new DatabaseSync(DBFILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = FULL");
db.exec("PRAGMA foreign_keys = ON");

/** Messages produits par la migration, pour que `server.mjs` les journalise à sa façon. */
export const bootMessages = [];

// L'ordre compte : les tables d'abord, sinon les `prepare` ci-dessous échouent ; la migration
// ensuite, puisqu'elle s'appuie sur ces mêmes requêtes préparées.
const fresh = db.prepare("PRAGMA user_version").get().user_version < SCHEMA_VERSION;
if (fresh) {
  db.exec("BEGIN");
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec("COMMIT");
}

/** Fermeture propre : le WAL est intégré au fichier principal, qui reste lisible tel quel. */
process.on("exit", () => { try { db.close(); } catch {} });

// ---------------------------------------------------------------- requêtes préparées
const q = {
  putProp: db.prepare("INSERT INTO props(name, at, kind, data) VALUES(:name, :at, :kind, :data) ON CONFLICT(name) DO UPDATE SET at = :at, kind = :kind, data = :data"),
  getProp: db.prepare("SELECT * FROM props WHERE name = ?"),
  allProps: db.prepare("SELECT * FROM props"),
  countProps: db.prepare("SELECT count(*) AS n FROM props"),

  putBean: db.prepare("INSERT INTO bean_systems(idx, at, data) VALUES(:idx, :at, :data) ON CONFLICT(idx) DO UPDATE SET at = :at, data = :data"),
  allBeans: db.prepare("SELECT * FROM bean_systems ORDER BY idx"),

  putStat: db.prepare("INSERT INTO stats(id, value, at) VALUES(:id, :value, :at) ON CONFLICT(id) DO UPDATE SET value = :value, at = :at"),
  allStats: db.prepare("SELECT * FROM stats ORDER BY id"),
  countStats: db.prepare("SELECT count(*) AS n FROM stats"),

  putRecipe: db.prepare("INSERT INTO recipes(id, updatedAt, data) VALUES(:id, :updatedAt, :data) ON CONFLICT(id) DO UPDATE SET updatedAt = :updatedAt, data = :data"),
  delRecipe: db.prepare("DELETE FROM recipes WHERE id = ?"),
  allRecipes: db.prepare("SELECT * FROM recipes ORDER BY updatedAt"),

  putMeta: db.prepare("INSERT INTO meta(key, value, at) VALUES(:key, :value, :at) ON CONFLICT(key) DO UPDATE SET value = :value, at = :at"),
  getMeta: db.prepare("SELECT value, at FROM meta WHERE key = ?"),
  delMeta: db.prepare("DELETE FROM meta WHERE key = ?"),
};

if (fresh) migrateFromJson();

/** Toute écriture de données lues sur la machine passe par ici, dans une seule transaction. */
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// ---------------------------------------------------------------- meta (valeurs JSON)
/** Lit une valeur de la table `meta`. `null` si absente — jamais `undefined`. */
export function getMeta(key) {
  const row = q.getMeta.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function setMeta(key, value) {
  q.putMeta.run({ key, value: JSON.stringify(value), at: Date.now() });
}

export function clearMeta(key) {
  q.delMeta.run(key);
}

/**
 * Horodatage de la dernière donnée **lue sur la machine**. Volontairement pas touché par
 * l'écriture du DSN ou du profil actif : c'est la date d'import que les pages affichent, et
 * l'ancien code la faisait bouger à chaque enregistrement du profil actif.
 */
function touchImport(at) {
  q.putMeta.run({ key: "importedAt", value: JSON.stringify(at), at });
}

export function importedAt() {
  return getMeta("importedAt");
}

// ---------------------------------------------------------------- propriétés Ayla
/**
 * Enregistre une propriété décodée. `at` et `kind` sont des colonnes, le reste part en JSON.
 * Une ligne écrite = une transaction : le coût ne dépend pas du nombre de propriétés connues.
 */
export function putProp(name, prop) {
  const { at = Date.now(), kind = null, ...rest } = prop;
  tx(() => {
    q.putProp.run({ name, at, kind, data: JSON.stringify(rest) });
    touchImport(at);
  });
}

function rowToProp(row) {
  return { at: row.at, kind: row.kind ?? undefined, ...JSON.parse(row.data) };
}

export function getProp(name) {
  const row = q.getProp.get(name);
  return row ? rowToProp(row) : null;
}

/** Vue `{ nom: propriété }`, telle que l'attendent les endpoints de lecture. */
export function allProps() {
  const out = {};
  for (const row of q.allProps.all()) out[row.name] = rowToProp(row);
  return out;
}

export function countProps() {
  return q.countProps.get().n;
}

// ---------------------------------------------------------------- Bean System
export function putBeanSystem(bs) {
  const at = Date.now();
  tx(() => {
    q.putBean.run({ idx: bs.index, at, data: JSON.stringify({ ...bs, at }) });
    touchImport(at);
  });
}

/** Vue `{ index: profil de grains }` (clés numériques en chaîne, comme l'ancien JSON). */
export function allBeanSystems() {
  const out = {};
  for (const row of q.allBeans.all()) out[row.idx] = JSON.parse(row.data);
  return out;
}

// ---------------------------------------------------------------- statistiques d'usage
/** Une réponse `0xA2` porte jusqu'à 10 entrées : elles entrent toutes ou aucune. */
export function putStats(entries) {
  const at = Date.now();
  tx(() => {
    for (const e of entries) q.putStat.run({ id: e.id, value: e.value, at });
    touchImport(at);
  });
}

/** Vue `{ id: { value, at } }`. */
export function allStats() {
  const out = {};
  for (const row of q.allStats.all()) out[row.id] = { value: row.value, at: row.at };
  return out;
}

export function countStats() {
  return q.countStats.get().n;
}

// ---------------------------------------------------------------- sommes de contrôle
/**
 * Enregistre un relevé `0xA3` en décalant le précédent vers `checksumsPrev`, dans une seule
 * transaction : c'est le couple (avant, après) qui sert à dire ce qui a changé, il ne doit
 * jamais pouvoir être à moitié écrit.
 */
export function putChecksums(cs) {
  const at = Date.now();
  return tx(() => {
    const prev = getMeta("checksums");
    const current = { at, ...cs };
    if (prev) q.putMeta.run({ key: "checksumsPrev", value: JSON.stringify(prev), at });
    q.putMeta.run({ key: "checksums", value: JSON.stringify(current), at });
    touchImport(at);
    return { prev, current };
  });
}

// ---------------------------------------------------------------- recettes locales
export function listRecipes() {
  return q.allRecipes.all().map((row) => JSON.parse(row.data));
}

export function putRecipe(r) {
  const updatedAt = Date.now();
  const recipe = { ...r, updatedAt };
  q.putRecipe.run({ id: String(r.id), updatedAt, data: JSON.stringify(recipe) });
  return recipe;
}

export function deleteRecipe(id) {
  q.delRecipe.run(String(id));
}

// ---------------------------------------------------------------- clé LAN
/** `null` si aucune clé n'a été découverte. La valeur retournée EST le secret : ne pas la logger. */
export function getLanKey() {
  return getMeta("lanKey");
}

export function setLanKey(key, keyId) {
  setMeta("lanKey", { lanip_key: key, lanip_key_id: keyId, at: Date.now() });
}

/** Retourne `true` si une clé était bien mémorisée (pour que l'API dise la vérité). */
export function clearLanKey() {
  const had = getMeta("lanKey") !== null;
  clearMeta("lanKey");
  return had;
}

// ---------------------------------------------------------------- migration des JSON
/**
 * Reprise des trois fichiers JSON de l'implémentation précédente. Ils ne sont **pas supprimés**
 * mais renommés en `.migrated` : si quelque chose s'est mal passé, l'état d'origine est encore là,
 * et un fichier renommé ne sera pas réimporté au prochain démarrage.
 */
function migrateFromJson() {
  const read = (file) => {
    const p = join(DIR, file);
    if (!existsSync(p)) return null;
    try { return { data: JSON.parse(readFileSync(p, "utf8")), path: p }; } catch (e) {
      bootMessages.push(`migration : ${file} illisible (${e.message}) — ignoré, l'ancien fichier est conservé`);
      return null;
    }
  };
  const retire = (path) => { try { renameSync(path, `${path}.migrated`); } catch {} };
  const counts = [];

  const machine = read("machine-beverages.json");
  if (machine) {
    const s = machine.data;
    tx(() => {
      for (const [name, p] of Object.entries(s.props ?? {})) {
        const { at = Date.now(), kind = null, ...rest } = p;
        q.putProp.run({ name, at, kind, data: JSON.stringify(rest) });
      }
      for (const bs of Object.values(s.beanSystems ?? {})) {
        q.putBean.run({ idx: bs.index, at: bs.at ?? Date.now(), data: JSON.stringify(bs) });
      }
      for (const [id, st] of Object.entries(s.stats ?? {})) {
        q.putStat.run({ id: Number(id), value: st.value, at: st.at ?? Date.now() });
      }
      for (const key of ["checksums", "checksumsPrev", "checksumsAtImport", "dsn", "activeProfile", "importedAt"]) {
        if (s[key] !== undefined && s[key] !== null) {
          q.putMeta.run({ key, value: JSON.stringify(s[key]), at: Date.now() });
        }
      }
    });
    counts.push(`${Object.keys(s.props ?? {}).length} propriétés`, `${Object.keys(s.stats ?? {}).length} statistiques`, `${Object.keys(s.beanSystems ?? {}).length} profils de grains`);
    retire(machine.path);
  }

  const recipes = read("recipes.json");
  if (recipes) {
    const list = Array.isArray(recipes.data.recipes) ? recipes.data.recipes : [];
    tx(() => {
      for (const r of list) {
        q.putRecipe.run({ id: String(r.id), updatedAt: r.updatedAt ?? Date.now(), data: JSON.stringify(r) });
      }
    });
    counts.push(`${list.length} recettes`);
    retire(recipes.path);
  }

  const lan = read("lan-key.json");
  if (lan?.data?.lanip_key) {
    // Pas de trace de la clé dans les messages de démarrage : seul son key_id est public.
    setMeta("lanKey", lan.data);
    counts.push(`clé LAN (key_id ${lan.data.lanip_key_id})`);
    retire(lan.path);
  }

  if (counts.length) {
    bootMessages.push(`migration JSON → SQLite : ${counts.join(", ")} ; anciens fichiers renommés en .migrated`);
  }
}

// ---------------------------------------------------------------- vue d'ensemble
/**
 * Vue en lecture équivalente à l'ancien objet `store` complet. Pratique pour les endpoints qui
 * parcourent tout (`/api/beverages`, `/api/profiles`), à **éviter** pour lire une seule valeur —
 * `getProp`, `getMeta`, `countStats` existent pour ça.
 */
export function machineView() {
  return {
    props: allProps(),
    beanSystems: allBeanSystems(),
    stats: allStats(),
    checksums: getMeta("checksums"),
    checksumsPrev: getMeta("checksumsPrev"),
    checksumsAtImport: getMeta("checksumsAtImport"),
    dsn: getMeta("dsn"),
    activeProfile: getMeta("activeProfile"),
    importedAt: getMeta("importedAt"),
  };
}

/** Diagnostic exposé par `/api/system` : de quoi vérifier l'état du stockage sans ouvrir le fichier. */
export function storageInfo() {
  const pageCount = db.prepare("PRAGMA page_count").get().page_count;
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  return {
    engine: "sqlite",
    file: DBFILE,
    schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
    journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
    synchronous: db.prepare("PRAGMA synchronous").get().synchronous,
    sqliteVersion: db.prepare("SELECT sqlite_version() AS v").get().v,
    sizeBytes: pageCount * pageSize,
    counts: {
      props: countProps(),
      stats: countStats(),
      beanSystems: q.allBeans.all().length,
      recipes: q.allRecipes.all().length,
    },
  };
}
