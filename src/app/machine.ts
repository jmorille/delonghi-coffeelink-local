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

/** Résumé d'une machine tel que le renvoie `/api/machines`. Ne contient aucun secret. */
export interface MachineSummary {
  id: string;
  label: string;
  /** Libellé choisi par l'utilisateur, `null` s'il n'en a pas donné (le `label` est alors dérivé). */
  custom: string | null;
  createdAt: number;
  ip: string | null;
  ipSource: string;
  dsn: string | null;
  dsnSource: string;
  lanKeySet: boolean;
  lanKeyId: number | null;
  lanKeySource: string;
  model: { key: string | null; source: string; machineName: string | null; matchesCatalog: boolean | null };
  sessionActive: boolean;
  lastRegisterAt: number;
  lastMonitor: { at: number; stateByte: number } | null;
  activeProfile: number;
  activeProfileConfirmed: boolean;
  importedAt: number | null;
  counts: { props: number; stats: number; beanSystems: number; recipes: number };
  /** Réglages imposés par l'environnement : la saisie marche, mais la variable regagne au redémarrage. */
  envForced: { ip: boolean; lanKey: boolean; dsn: boolean; modelKey: boolean };
  /** Les deux prérequis du pilotage réunis : adresse connue et clé LAN présente. */
  ready: boolean;
}
