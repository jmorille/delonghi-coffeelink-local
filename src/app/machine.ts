/**
 * Machine courante, côté navigateur.
 *
 * Le choix vit dans `localStorage`, **pas** côté serveur, et c'est délibéré : c'est une préférence
 * d'affichage propre à ce navigateur. Un « courant » global aurait fait changer la page sous les
 * yeux de quelqu'un pendant qu'un autre onglet — ou une autre personne — choisissait ailleurs, et
 * sur des commandes qui agissent sur un appareil réel, ce n'est pas une bizarrerie d'affichage.
 *
 * Chaque appel d'API porte donc la machine en paramètre de requête. `mfetch` est le seul chemin
 * autorisé : un `fetch` direct viserait la machine **par défaut du serveur**, qui n'est pas
 * forcément celle qui est affichée.
 */
const CLE = "delonghi.machine";

/** Émis quand la machine courante change, pour que la barre de navigation se reconstruise. */
export const MACHINE_EVENT = "machine-changed";

/** `null` = aucun choix mémorisé ; le serveur appliquera alors sa machine par défaut. */
export function currentMachine(): string | null {
  try {
    return localStorage.getItem(CLE);
  } catch {
    // Rendu côté serveur, ou stockage refusé : on laisse le serveur décider.
    return null;
  }
}

export function setCurrentMachine(id: string | null) {
  try {
    if (id) localStorage.setItem(CLE, id);
    else localStorage.removeItem(CLE);
  } catch {
    /* rien à faire : sans mémoire locale, on retombe sur la machine par défaut */
  }
  window.dispatchEvent(new Event(MACHINE_EVENT));
}

/**
 * `fetch` vers notre API, en précisant la machine courante.
 *
 * Récupération incluse : si la machine mémorisée n'existe plus (supprimée depuis un autre onglet),
 * le serveur répond 404 avec `unknownMachine`. On oublie alors le choix et on recharge, ce qui
 * ramène sur la machine par défaut. Pas de boucle possible : au rechargement, plus aucun
 * identifiant n'est envoyé.
 */
export async function mfetch(path: string, init?: RequestInit): Promise<Response> {
  const id = currentMachine();
  let url = path;
  if (id) {
    const u = new URL(path, window.location.origin);
    u.searchParams.set("machine", id);
    url = u.pathname + u.search;
  }
  const r = await fetch(url, init);
  if (r.status === 404 && id) {
    // `clone()` : le corps doit rester intact pour l'appelant.
    const j = await r
      .clone()
      .json()
      .catch(() => null);
    if (j?.unknownMachine) {
      setCurrentMachine(null);
      window.location.reload();
    }
  }
  return r;
}

/**
 * Ajoute une machine **nommée** à un chemin d'API.
 *
 * À ne pas confondre avec `mfetch`, qui vise la machine *courante*. Sur la page de gestion on
 * agit sur la machine d'une carte, qui n'est pas forcément celle affichée ailleurs : c'est
 * exactement le cas où `mfetch` enverrait la requête à la mauvaise cafetière.
 */
export function forId(path: string, id: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}machine=${encodeURIComponent(id)}`;
}

/** Résumé d'une machine tel que le renvoie `/api/machines`. Ne contient aucun secret. */
export interface MachineSummary {
  id: string;
  label: string;
  /** Libellé choisi par l'utilisateur, `null` s'il n'en a pas donné (le `label` est alors dérivé). */
  custom: string | null;
  createdAt: number;
  ip: string | null;
  ipSource: string;
  /** Date de la saisie mémorisée : `null` = rien à oublier. */
  ipCachedAt: number | null;
  dsn: string | null;
  dsnSource: string;
  lanKeySet: boolean;
  lanKeyId: number | null;
  lanKeySource: string;
  /** Date de la découverte. La clé elle-même n'est jamais transmise. */
  lanKeyCachedAt: number | null;
  model: {
    key: string | null;
    source: string;
    machineName: string | null;
    /** `false` = le modèle détecté n'a pas pu être appliqué, un catalogue de remplacement sert. */
    matchesCatalog: boolean | null;
    catalogKey: string;
    catalogType: string;
    catalogBeverages: number;
    catalogSupport: string;
  };
  sessionActive: boolean;
  lastRegisterAt: number;
  /** Lecture de propriétés en cours, `null` sinon. C'est ce qui fait scruter la page. */
  reading: { remaining: number; ok: number; fail: number; pending: string | null } | null;
  /** Libellé du programme ECAM en cours, `null` sinon. */
  running: string | null;
  lastMonitor: { at: number; stateByte: number } | null;
  activeProfile: number;
  activeProfileConfirmed: boolean;
  importedAt: number | null;
  counts: { props: number; stats: number; beanSystems: number; recipes: number };
  /** Réglages imposés par l'environnement : la saisie marche, mais la variable regagne au redémarrage. */
  envForced: { ip: boolean; lanKey: boolean; dsn: boolean; modelKey: boolean };
  /** Les deux prérequis du pilotage réunis : adresse connue et clé LAN présente. */
  ready: boolean;
  /** Autres entrées qui semblent désigner le même appareil — une seule recevra la session. */
  duplicates: { id: string; label: string; reason: "dsn" | "address" }[];
}
