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
 * ## Plusieurs machines (schéma v2)
 *
 * Toutes les tables de données portent une colonne `machine` et une clé primaire composite. Une
 * machine est identifiée par un **identifiant que nous frappons nous-mêmes** (`m1`, `m2`…), et
 * non par son DSN : le DSN est découvert *après* la saisie de l'adresse, il ne peut donc pas
 * servir de clé à la création. Il reste rangé comme une donnée de la machine (`meta.dsn`).
 *
 * Les réglages qui ne concernent aucune machine en particulier vivent dans `settings`, une table
 * à part — plutôt qu'une machine sentinelle dans `meta`, qui aurait fait mentir la clé étrangère.
 *
 * `ON DELETE CASCADE` sur chaque table : supprimer une machine emporte ses données en une seule
 * instruction, sans liste de tables à tenir à jour ailleurs. C'est aussi ce qui rend impossible
 * l'oubli d'une table lors d'un ajout futur.
 *
 * ⚠️ **Ce fichier contient du matériel secret** : les clés LAN (table `meta`, clé `lanKey`, une
 * par machine), les numéros de série et les noms de profils saisis sur les machines. `data/` est
 * gitignoré et doit être traité comme tel — ne jamais joindre `lan-server.db` à un rapport de bug
 * sans l'avoir purgé.
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
const SCHEMA_VERSION = 3;

/**
 * Identifiant de la première machine. Il est **figé** : c'est celui que la migration attribue à
 * toutes les données existantes, et celui auquel les variables d'environnement historiques
 * (`MACHINE_IP`, `LANIP_KEY`, `MACHINE_DSN`…) continuent de s'appliquer. Une installation
 * mono-machine ne voit donc aucune différence.
 */
export const DEFAULT_MACHINE = "m1";

/**
 * Schéma. Les colonnes `at` sont des millisecondes unix ; `data` porte le JSON de ce qui n'est pas
 * indexé. On ne duplique pas `at`/`kind` dans le JSON des propriétés : ils sont reconstitués à la
 * lecture, ce qui évite deux sources de vérité pour la même valeur.
 */
const DDL_V2 = `
CREATE TABLE machines (
  id        TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  data      TEXT NOT NULL
) STRICT;

CREATE TABLE props (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  kind    TEXT,
  data    TEXT NOT NULL,
  PRIMARY KEY (machine, name)
) STRICT;

CREATE TABLE bean_systems (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (machine, idx)
) STRICT;

CREATE TABLE stats (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  id      INTEGER NOT NULL,
  value   INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
) STRICT;

CREATE TABLE recipes (
  machine   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  data      TEXT NOT NULL,
  PRIMARY KEY (machine, id)
) STRICT;

CREATE TABLE meta (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (machine, key)
) STRICT;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    INTEGER NOT NULL
) STRICT;
`;

/**
 * Schéma v3 : l'image d'une configuration de grains mémorisée.
 *
 * **Une table, et pas un champ de plus dans `meta.beanPresets`.** Le tableau des configurations
 * est relu et **réécrit en entier** à chaque enregistrement (`putBeanPreset`) : y ranger des
 * images en base64 rejouerait, en plus petit, le défaut qui a fait naître ce fichier — réécrire
 * tout un cache pour ne modifier qu'une ligne. Ici l'image est une ligne, servie par sa propre
 * URL, donc cachée par le navigateur et jamais retransmise avec la liste.
 *
 * `bytes` est un vrai BLOB : `STRICT` accepte ce type, et garder les octets tels quels évite
 * les 33 % de la base64 et une conversion à chaque lecture. `id` est celui de la configuration
 * (`b1`, `b2`…), donc la même clé des deux côtés.
 *
 * Déclarée à part de `DDL_V2` pour que chaque migration ne joue QUE son propre pas : une base v1
 * passe en v2 avec les sept tables d'origine, puis en v3 avec celle-ci. Les concaténer en un seul
 * bloc ferait créer cette table par la migration v1 → v2, et le pas suivant échouerait sur une
 * table déjà présente.
 */
const DDL_BEAN_IMAGES = `
CREATE TABLE bean_images (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  id      TEXT NOT NULL,
  mime    TEXT NOT NULL,
  bytes   BLOB NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
) STRICT;
`;

/** Le schéma courant, en entier — ce que reçoit une base neuve. */
const DDL = DDL_V2 + DDL_BEAN_IMAGES;

// Les deux répertoires : celui des données (migration, anciens JSON) et celui de la base, qui peut
// être ailleurs si `DATABASE_FILE` la déplace.
mkdirSync(DIR, { recursive: true });
mkdirSync(dirname(DBFILE), { recursive: true });
const db = new DatabaseSync(DBFILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = FULL");
// Hors transaction, donc effectif : c'est ce pragma qui fait marcher les CASCADE ci-dessus.
db.exec("PRAGMA foreign_keys = ON");

/** Messages produits par la migration, pour que `server.mjs` les journalise à sa façon. */
export const bootMessages = [];

const version = () => db.prepare("PRAGMA user_version").get().user_version;

// L'ordre compte : les tables d'abord, sinon les `prepare` ci-dessous échouent ; les migrations
// ensuite, puisqu'elles s'appuient sur ces mêmes requêtes préparées.
const from = version();
const fresh = from === 0;
if (fresh) {
  db.exec("BEGIN");
  db.exec(DDL);
  db.exec(`INSERT INTO machines(id, createdAt, data) VALUES('${DEFAULT_MACHINE}', ${Date.now()}, '{"label":null}')`);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec("COMMIT");
} else if (from < SCHEMA_VERSION) {
  migrateSchema(from);
} else if (from > SCHEMA_VERSION) {
  // Une base écrite par une version plus récente du serveur. On refuse tout de suite : continuer
  // reviendrait à échouer plus loin sur une colonne inconnue, au milieu d'une écriture.
  throw new Error(`${DBFILE} est en schéma v${from}, ce serveur ne connaît que v${SCHEMA_VERSION} — utiliser une version plus récente, ou restaurer une sauvegarde`);
}

/** Fermeture propre : le WAL est intégré au fichier principal, qui reste lisible tel quel. */
process.on("exit", () => { try { db.close(); } catch {} });

// ---------------------------------------------------------------- requêtes préparées
const q = {
  listMachines: db.prepare("SELECT * FROM machines ORDER BY createdAt, id"),
  getMachine: db.prepare("SELECT * FROM machines WHERE id = ?"),
  putMachine: db.prepare("INSERT INTO machines(id, createdAt, data) VALUES(:id, :createdAt, :data) ON CONFLICT(id) DO UPDATE SET data = :data"),
  delMachine: db.prepare("DELETE FROM machines WHERE id = ?"),

  putProp: db.prepare("INSERT INTO props(machine, name, at, kind, data) VALUES(:machine, :name, :at, :kind, :data) ON CONFLICT(machine, name) DO UPDATE SET at = :at, kind = :kind, data = :data"),
  getProp: db.prepare("SELECT * FROM props WHERE machine = ? AND name = ?"),
  allProps: db.prepare("SELECT * FROM props WHERE machine = ?"),
  countProps: db.prepare("SELECT count(*) AS n FROM props WHERE machine = ?"),

  putBean: db.prepare("INSERT INTO bean_systems(machine, idx, at, data) VALUES(:machine, :idx, :at, :data) ON CONFLICT(machine, idx) DO UPDATE SET at = :at, data = :data"),
  allBeans: db.prepare("SELECT * FROM bean_systems WHERE machine = ? ORDER BY idx"),
  countBeans: db.prepare("SELECT count(*) AS n FROM bean_systems WHERE machine = ?"),

  putStat: db.prepare("INSERT INTO stats(machine, id, value, at) VALUES(:machine, :id, :value, :at) ON CONFLICT(machine, id) DO UPDATE SET value = :value, at = :at"),
  allStats: db.prepare("SELECT * FROM stats WHERE machine = ? ORDER BY id"),
  countStats: db.prepare("SELECT count(*) AS n FROM stats WHERE machine = ?"),

  putRecipe: db.prepare("INSERT INTO recipes(machine, id, updatedAt, data) VALUES(:machine, :id, :updatedAt, :data) ON CONFLICT(machine, id) DO UPDATE SET updatedAt = :updatedAt, data = :data"),
  delRecipe: db.prepare("DELETE FROM recipes WHERE machine = ? AND id = ?"),
  allRecipes: db.prepare("SELECT * FROM recipes WHERE machine = ? ORDER BY updatedAt"),
  countRecipes: db.prepare("SELECT count(*) AS n FROM recipes WHERE machine = ?"),

  putBeanImage: db.prepare("INSERT INTO bean_images(machine, id, mime, bytes, at) VALUES(:machine, :id, :mime, :bytes, :at) ON CONFLICT(machine, id) DO UPDATE SET mime = :mime, bytes = :bytes, at = :at"),
  getBeanImage: db.prepare("SELECT mime, bytes, at FROM bean_images WHERE machine = ? AND id = ?"),
  delBeanImage: db.prepare("DELETE FROM bean_images WHERE machine = ? AND id = ?"),
  countBeanImages: db.prepare("SELECT count(*) AS n FROM bean_images WHERE machine = ?"),
  datesBeanImages: db.prepare("SELECT id, at FROM bean_images WHERE machine = ?"),

  putMeta: db.prepare("INSERT INTO meta(machine, key, value, at) VALUES(:machine, :key, :value, :at) ON CONFLICT(machine, key) DO UPDATE SET value = :value, at = :at"),
  // Remise à zéro d'une machine : une instruction par table, jouées dans une seule transaction.
  wipeProps: db.prepare("DELETE FROM props WHERE machine = ?"),
  wipeBeans: db.prepare("DELETE FROM bean_systems WHERE machine = ?"),
  wipeStats: db.prepare("DELETE FROM stats WHERE machine = ?"),
  wipeRecipes: db.prepare("DELETE FROM recipes WHERE machine = ?"),
  wipeMeta: db.prepare("DELETE FROM meta WHERE machine = ?"),
  wipeBeanImages: db.prepare("DELETE FROM bean_images WHERE machine = ?"),
  getMeta: db.prepare("SELECT value, at FROM meta WHERE machine = ? AND key = ?"),
  delMeta: db.prepare("DELETE FROM meta WHERE machine = ? AND key = ?"),

  putSetting: db.prepare("INSERT INTO settings(key, value, at) VALUES(:key, :value, :at) ON CONFLICT(key) DO UPDATE SET value = :value, at = :at"),
  getSetting: db.prepare("SELECT value, at FROM settings WHERE key = ?"),
  delSetting: db.prepare("DELETE FROM settings WHERE key = ?"),
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

// ---------------------------------------------------------------- migration de schéma
/**
 * v1 → v2 : ajout de la dimension machine.
 *
 * SQLite ne sait pas changer une clé primaire : on recrée les tables et on recopie. Toutes les
 * lignes existantes appartiennent à la **première** machine (`m1`) — c'est la seule interprétation
 * possible, la base ne pouvait en décrire qu'une.
 *
 * Le tout dans une seule transaction : une coupure au milieu laisse la base en v1, réessayable au
 * prochain démarrage, jamais à moitié convertie. `foreign_keys` est temporairement désactivée le
 * temps de la bascule — les tables sont détruites et recréées, l'intégrité est rétablie à la fin.
 */
/**
 * Enchaîne les pas de migration jusqu'au schéma courant.
 *
 * Une **chaîne** et non un aiguillage : une base v1 doit pouvoir arriver en v3 sans qu'on ait
 * écrit un chemin direct v1 → v3, qui serait un troisième code à vérifier et le seul jamais
 * exercé. Chaque pas stampe SA version — jamais `SCHEMA_VERSION`, sinon un pas intermédiaire
 * marquerait la base à jour alors que le suivant n'a pas encore tourné, et un plantage entre les
 * deux laisserait une base qui ment sur sa forme.
 */
function migrateSchema(fromVersion) {
  let v = fromVersion;
  if (v === 1) { migrateV1toV2(); v = 2; }
  if (v === 2) { migrateV2toV3(); v = 3; }
  if (v !== SCHEMA_VERSION) {
    throw new Error(`schéma v${fromVersion} inconnu de cette version du serveur (attendu v1, v2 ou v${SCHEMA_VERSION}) — base plus récente que le code ?`);
  }
}

function migrateV1toV2() {
  db.exec("PRAGMA foreign_keys = OFF");
  const at = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const copied = {};
    for (const t of ["props", "bean_systems", "stats", "recipes", "meta"]) {
      db.exec(`ALTER TABLE ${t} RENAME TO ${t}_v1`);
      copied[t] = db.prepare(`SELECT count(*) AS n FROM ${t}_v1`).get().n;
    }
    db.exec(DDL_V2);
    db.exec(`INSERT INTO machines(id, createdAt, data) VALUES('${DEFAULT_MACHINE}', ${at}, '{"label":null}')`);
    db.exec(`INSERT INTO props(machine, name, at, kind, data) SELECT '${DEFAULT_MACHINE}', name, at, kind, data FROM props_v1`);
    db.exec(`INSERT INTO bean_systems(machine, idx, at, data) SELECT '${DEFAULT_MACHINE}', idx, at, data FROM bean_systems_v1`);
    db.exec(`INSERT INTO stats(machine, id, value, at) SELECT '${DEFAULT_MACHINE}', id, value, at FROM stats_v1`);
    db.exec(`INSERT INTO recipes(machine, id, updatedAt, data) SELECT '${DEFAULT_MACHINE}', id, updatedAt, data FROM recipes_v1`);
    db.exec(`INSERT INTO meta(machine, key, value, at) SELECT '${DEFAULT_MACHINE}', key, value, at FROM meta_v1`);
    for (const t of ["props", "bean_systems", "stats", "recipes", "meta"]) db.exec(`DROP TABLE ${t}_v1`);
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
    bootMessages.push(
      `schéma v1 → v2 (plusieurs machines) : ${copied.props} propriétés, ${copied.stats} statistiques, ` +
      `${copied.bean_systems} profils de grains, ${copied.recipes} recettes et ${copied.meta} valeurs ` +
      `rattachées à « ${DEFAULT_MACHINE} »`,
    );
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    // `cause` attachée : c'est la SEULE opération de ce projet qui puisse détruire les données
    // d'un utilisateur, et le message seul perdait la pile de l'erreur SQLite d'origine — donc
    // précisément ce qu'on voudrait lire si elle échouait un jour chez quelqu'un.
    throw new Error(`migration du schéma v1 → v2 impossible (${e.message}) — la base est restée en v1`, { cause: e });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * v2 → v3 : la table des images de configurations de grains.
 *
 * **Purement additive** — un `CREATE TABLE`, aucune table recréée, aucune ligne recopiée,
 * contrairement à v1 → v2 qui devait changer une clé primaire. Rien d'existant n'est lu ni
 * réécrit, donc rien d'existant ne peut être perdu ; une coupure laisse la base en v2, où elle
 * fonctionne exactement comme avant, et le pas se rejoue au démarrage suivant.
 *
 * Pas de message dans `bootMessages` quand il n'y a rien à raconter : aucune donnée n'a bougé.
 */
function migrateV2toV3() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(DDL_BEAN_IMAGES);
    db.exec("PRAGMA user_version = 3");
    db.exec("COMMIT");
    bootMessages.push("schéma v2 → v3 : table des images de configurations de grains ajoutée");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new Error(`migration du schéma v2 → v3 impossible (${e.message}) — la base est restée en v2`, { cause: e });
  }
}

// ---------------------------------------------------------------- machines
function rowToMachine(row) {
  // `label: null` avant l'étalement : la forme rendue ne dépend alors pas de ce que contient la
  // colonne `data`, y compris pour une ligne écrite par une version antérieure.
  return { id: row.id, createdAt: row.createdAt, label: null, ...JSON.parse(row.data) };
}

/** Les machines connues, dans l'ordre de leur création. La première est celle par défaut. */
export function listMachines() {
  return q.listMachines.all().map(rowToMachine);
}

export function getMachine(id) {
  const row = q.getMachine.get(String(id));
  return row ? rowToMachine(row) : null;
}

/** Vrai si cet identifiant désigne une machine connue. Le seul contrôle à faire avant d'écrire. */
export function machineExists(id) {
  return !!q.getMachine.get(String(id));
}

/**
 * Crée une machine et rend son identifiant.
 *
 * L'identifiant est **frappé ici**, jamais fourni par l'appelant : c'est ce qui garantit qu'il
 * reste dans la forme `m<n>`, qu'il ne collisionne pas, et qu'aucune requête ne peut se voir
 * imposer une valeur choisie ailleurs.
 */
export function createMachine({ label = null } = {}) {
  return tx(() => {
    const used = q.listMachines.all().map((r) => Number(String(r.id).replace(/^m/, "")) || 0);
    const id = `m${Math.max(0, ...used) + 1}`;
    const createdAt = Date.now();
    q.putMachine.run({ id, createdAt, data: JSON.stringify({ label }) });
    return { id, createdAt, label };
  });
}

/** Renomme (ou dénomme, avec `null`) une machine. Le libellé est purement décoratif. */
export function setMachineLabel(id, label) {
  const current = getMachine(id);
  if (!current) return null;
  const next = { ...current, label: label ?? null };
  delete next.id;
  delete next.createdAt;
  q.putMachine.run({ id: String(id), createdAt: current.createdAt, data: JSON.stringify(next) });
  return { id: String(id), createdAt: current.createdAt, ...next };
}

/**
 * Supprime une machine **et toutes ses données** (propriétés lues, statistiques, recettes, clé
 * LAN mémorisée). Les `ON DELETE CASCADE` s'en chargent : il n'y a pas de liste de tables à tenir
 * à jour ici, donc rien à oublier lors d'un ajout futur.
 */
export function deleteMachine(id) {
  return tx(() => {
    if (!q.getMachine.get(String(id))) return false;
    q.delMachine.run(String(id));
    return true;
  });
}

// ---------------------------------------------------------------- réglages globaux
/** Réglages qui ne concernent aucune machine en particulier (machine par défaut, par exemple). */
export function getSetting(key) {
  const row = q.getSetting.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function setSetting(key, value) {
  q.putSetting.run({ key, value: JSON.stringify(value), at: Date.now() });
}

export function clearSetting(key) {
  q.delSetting.run(key);
}

// ---------------------------------------------------------------- API par machine
const bound = new Map();

/**
 * Rend l'API de stockage **liée à une machine**. Toutes les lectures et écritures de données
 * passent par là — il n'existe volontairement aucune version « sans machine » de ces fonctions :
 * un appel qui aurait oublié de préciser laquelle écrirait dans la mauvaise, et rien ne le
 * signalerait avant des semaines.
 */
export function forMachine(machine) {
  const id = String(machine);
  const hit = bound.get(id);
  if (hit) return hit;

  /**
   * Horodatage de la dernière donnée **lue sur la machine**. Volontairement pas touché par
   * l'écriture du DSN ou du profil actif : c'est la date d'import que les pages affichent, et
   * l'ancien code la faisait bouger à chaque enregistrement du profil actif.
   */
  const touchImport = (at) => q.putMeta.run({ machine: id, key: "importedAt", value: JSON.stringify(at), at });

  const getMeta = (key) => {
    const row = q.getMeta.get(id, key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  };
  const setMeta = (key, value) => q.putMeta.run({ machine: id, key, value: JSON.stringify(value), at: Date.now() });
  const clearMeta = (key) => q.delMeta.run(id, key);

  const rowToProp = (row) => ({ at: row.at, kind: row.kind ?? undefined, ...JSON.parse(row.data) });
  const allProps = () => {
    const out = {};
    for (const row of q.allProps.all(id)) out[row.name] = rowToProp(row);
    return out;
  };
  const allBeanSystems = () => {
    const out = {};
    for (const row of q.allBeans.all(id)) out[row.idx] = JSON.parse(row.data);
    return out;
  };
  const allStats = () => {
    const out = {};
    for (const row of q.allStats.all(id)) out[row.id] = { value: row.value, at: row.at };
    return out;
  };

  const api = {
    id,
    getMeta,
    setMeta,
    clearMeta,
    importedAt: () => getMeta("importedAt"),

    /**
     * Enregistre une propriété décodée. `at` et `kind` sont des colonnes, le reste part en JSON.
     * Une ligne écrite = une transaction : le coût ne dépend pas du nombre de propriétés connues.
     */
    putProp(name, prop) {
      const { at = Date.now(), kind = null, ...rest } = prop;
      tx(() => {
        q.putProp.run({ machine: id, name, at, kind, data: JSON.stringify(rest) });
        touchImport(at);
      });
    },
    getProp(name) {
      const row = q.getProp.get(id, name);
      return row ? rowToProp(row) : null;
    },
    /** Vue `{ nom: propriété }`, telle que l'attendent les endpoints de lecture. */
    allProps,
    countProps: () => q.countProps.get(id).n,

    putBeanSystem(bs) {
      const at = Date.now();
      tx(() => {
        q.putBean.run({ machine: id, idx: bs.index, at, data: JSON.stringify({ ...bs, at }) });
        touchImport(at);
      });
    },
    /** Vue `{ index: profil de grains }` (clés numériques en chaîne, comme l'ancien JSON). */
    allBeanSystems,

    /** Une réponse `0xA2` porte jusqu'à 10 entrées : elles entrent toutes ou aucune. */
    putStats(entries) {
      const at = Date.now();
      tx(() => {
        for (const e of entries) q.putStat.run({ machine: id, id: e.id, value: e.value, at });
        touchImport(at);
      });
    },
    /** Vue `{ id: { value, at } }`. */
    allStats,
    countStats: () => q.countStats.get(id).n,

    /**
     * Enregistre un relevé `0xA3` en décalant le précédent vers `checksumsPrev`, dans une seule
     * transaction : c'est le couple (avant, après) qui sert à dire ce qui a changé, il ne doit
     * jamais pouvoir être à moitié écrit.
     */
    putChecksums(cs) {
      const at = Date.now();
      return tx(() => {
        const prev = getMeta("checksums");
        const current = { at, ...cs };
        if (prev) q.putMeta.run({ machine: id, key: "checksumsPrev", value: JSON.stringify(prev), at });
        q.putMeta.run({ machine: id, key: "checksums", value: JSON.stringify(current), at });
        touchImport(at);
        return { prev, current };
      });
    },

    listRecipes: () => q.allRecipes.all(id).map((row) => JSON.parse(row.data)),
    putRecipe(r) {
      const updatedAt = Date.now();
      const recipe = { ...r, updatedAt };
      q.putRecipe.run({ machine: id, id: String(r.id), updatedAt, data: JSON.stringify(recipe) });
      return recipe;
    },
    deleteRecipe: (recipeId) => q.delRecipe.run(id, String(recipeId)),

    /**
     * L'image d'une configuration de grains mémorisée, rangée sous l'identifiant de cette
     * configuration.
     *
     * `bytes` entre et sort en octets bruts (`Uint8Array`), jamais en base64 : c'est un BLOB des
     * deux côtés, et convertir à chaque lecture ne servirait qu'à gonfler d'un tiers ce qui part
     * ensuite sur le réseau.
     *
     * ⚠️ Ces trois fonctions ne touchent PAS `importedAt` — comme `setMeta`, et pour la même
     * raison : cette date dit quand la MACHINE a écrit quelque chose, pas quand l'utilisateur a
     * rangé une photo. C'est `machineSummary` qui publie de quoi détecter le changement.
     */
    putBeanImage(presetId, mime, bytes) {
      const at = Date.now();
      q.putBeanImage.run({ machine: id, id: String(presetId), mime: String(mime), bytes, at });
      return at;
    },
    /** `null` si cette configuration n'a pas d'image — l'absence est un cas normal, pas une erreur. */
    getBeanImage(presetId) {
      const row = q.getBeanImage.get(id, String(presetId));
      return row ? { mime: row.mime, bytes: row.bytes, at: row.at } : null;
    },
    /** Rend `true` si une image existait, pour que l'API puisse dire ce qu'elle a fait. */
    deleteBeanImage(presetId) {
      return q.delBeanImage.run(id, String(presetId)).changes > 0;
    },
    countBeanImages: () => q.countBeanImages.get(id).n,
    /**
     * Les dates des images, indexées par configuration — en UNE requête.
     *
     * C'est ce qui permet à `/api/beanpresets` de dire « celle-ci a une image » sans que
     * `meta.beanPresets` ait à le recopier. Une donnée recopiée dans les deux endroits finirait
     * par les faire se contredire : la table dit ce qu'elle contient, elle est seule à le dire.
     */
    beanImageDates() {
      const d = {};
      for (const row of q.datesBeanImages.all(id)) d[row.id] = row.at;
      return d;
    },

    /** `null` si aucune clé n'a été découverte. La valeur retournée EST le secret : ne pas la logger. */
    getLanKey: () => getMeta("lanKey"),
    setLanKey: (key, keyId) => setMeta("lanKey", { lanip_key: key, lanip_key_id: keyId, at: Date.now() }),
    /** Retourne `true` si une clé était bien mémorisée (pour que l'API dise la vérité). */
    clearLanKey() {
      const had = getMeta("lanKey") !== null;
      clearMeta("lanKey");
      return had;
    },

    /**
     * Vue en lecture équivalente à l'ancien objet `store` complet. Pratique pour les endpoints qui
     * parcourent tout (`/api/beverages`, `/api/profiles`), à **éviter** pour lire une seule valeur —
     * `getProp`, `getMeta`, `countStats` existent pour ça.
     */
    machineView: () => ({
      props: allProps(),
      beanSystems: allBeanSystems(),
      stats: allStats(),
      checksums: getMeta("checksums"),
      checksumsPrev: getMeta("checksumsPrev"),
      checksumsAtImport: getMeta("checksumsAtImport"),
      dsn: getMeta("dsn"),
      activeProfile: getMeta("activeProfile"),
      importedAt: getMeta("importedAt"),
    }),

    counts: () => ({
      props: q.countProps.get(id).n,
      stats: q.countStats.get(id).n,
      beanSystems: q.countBeans.get(id).n,
      recipes: q.countRecipes.get(id).n,
      beanImages: q.countBeanImages.get(id).n,
    }),

    /**
     * Efface **tout** ce qui appartient à cette machine, sans supprimer la machine elle-même :
     * propriétés lues, statistiques, profils de grains, recettes, images de configurations de
     * grains, et toutes les valeurs `meta` — donc aussi l'adresse mémorisée, le DSN, le modèle et
     * la clé LAN.
     *
     * C'est la remise à zéro de la **dernière** machine, qu'on ne peut pas retirer du registre sans
     * laisser l'application sans rien à piloter. Une seule transaction : une coupure au milieu ne
     * peut pas laisser la moitié d'une ancienne configuration, ce qui serait pire que les deux
     * états francs.
     *
     * Rend le décompte de ce qui a été effacé, pour que l'interface puisse le dire.
     */
    reset() {
      return tx(() => {
        const efface = {
          props: q.countProps.get(id).n,
          stats: q.countStats.get(id).n,
          beanSystems: q.countBeans.get(id).n,
          recipes: q.countRecipes.get(id).n,
          beanImages: q.countBeanImages.get(id).n,
        };
        q.wipeProps.run(id);
        q.wipeBeans.run(id);
        q.wipeStats.run(id);
        q.wipeRecipes.run(id);
        q.wipeBeanImages.run(id);
        q.wipeMeta.run(id);
        return efface;
      });
    },
  };
  bound.set(id, api);
  return api;
}

// ---------------------------------------------------------------- migration des JSON
/**
 * Reprise des trois fichiers JSON de l'implémentation précédente. Ils ne sont **pas supprimés**
 * mais renommés en `.migrated` : si quelque chose s'est mal passé, l'état d'origine est encore là,
 * et un fichier renommé ne sera pas réimporté au prochain démarrage.
 *
 * Ces fichiers datent d'avant la notion de plusieurs machines : tout va donc dans `m1`.
 */
function migrateFromJson() {
  const M = DEFAULT_MACHINE;
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
        q.putProp.run({ machine: M, name, at, kind, data: JSON.stringify(rest) });
      }
      for (const bs of Object.values(s.beanSystems ?? {})) {
        q.putBean.run({ machine: M, idx: bs.index, at: bs.at ?? Date.now(), data: JSON.stringify(bs) });
      }
      for (const [id, st] of Object.entries(s.stats ?? {})) {
        q.putStat.run({ machine: M, id: Number(id), value: st.value, at: st.at ?? Date.now() });
      }
      for (const key of ["checksums", "checksumsPrev", "checksumsAtImport", "dsn", "activeProfile", "importedAt"]) {
        if (s[key] !== undefined && s[key] !== null) {
          q.putMeta.run({ machine: M, key, value: JSON.stringify(s[key]), at: Date.now() });
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
        q.putRecipe.run({ machine: M, id: String(r.id), updatedAt: r.updatedAt ?? Date.now(), data: JSON.stringify(r) });
      }
    });
    counts.push(`${list.length} recettes`);
    retire(recipes.path);
  }

  const lan = read("lan-key.json");
  if (lan?.data?.lanip_key) {
    // Pas de trace de la clé dans les messages de démarrage : seul son key_id est public.
    forMachine(M).setMeta("lanKey", lan.data);
    counts.push(`clé LAN (key_id ${lan.data.lanip_key_id})`);
    retire(lan.path);
  }

  if (counts.length) {
    bootMessages.push(`migration JSON → SQLite : ${counts.join(", ")} ; anciens fichiers renommés en .migrated`);
  }
}

// ---------------------------------------------------------------- vue d'ensemble
/** Diagnostic exposé par `/api/system` : de quoi vérifier l'état du stockage sans ouvrir le fichier. */
export function storageInfo() {
  const pageCount = db.prepare("PRAGMA page_count").get().page_count;
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  const machines = listMachines();
  // Les clés du total viennent de `counts()`, **jamais d'une liste écrite ici**. Elles l'étaient,
  // et c'est précisément ce qui a fait qu'un compteur ajouté à `counts()` n'apparaissait nulle
  // part dans `/api/system` — sans erreur, la clé manquait simplement. Une deuxième énumération
  // des tables est une divergence qui attend son tour.
  const total = {};
  const perMachine = {};
  for (const m of machines) {
    const c = forMachine(m.id).counts();
    perMachine[m.id] = c;
    for (const [k, v] of Object.entries(c)) total[k] = (total[k] ?? 0) + v;
  }
  return {
    engine: "sqlite",
    file: DBFILE,
    schemaVersion: version(),
    journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
    synchronous: db.prepare("PRAGMA synchronous").get().synchronous,
    sqliteVersion: db.prepare("SELECT sqlite_version() AS v").get().v,
    sizeBytes: pageCount * pageSize,
    machines: machines.length,
    counts: total,
    perMachine,
  };
}
