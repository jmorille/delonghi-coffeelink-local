"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MachineSummary, currentMachine } from "./machine";

/**
 * Abonnement au flux d'évènements du serveur (`GET /api/events`, Server-Sent Events).
 *
 * Pourquoi un flux et pas une scrutation : une lecture de propriété n'est pas synchrone. Le POST
 * rend la main dès que l'annonce (`local_reg`) est faite, et c'est la **machine** qui se connecte
 * ensuite pour pousser la valeur — deux à quatre secondes plus tard. Un minuteur ne peut donc que
 * se tromper : trop tôt il affiche l'état d'avant, trop tard il fait attendre pour rien.
 *
 * Le serveur émet quand quelque chose bouge — son déclencheur est le journal, qui voit tout
 * changement d'état. Voir `sseTouch()` / `sseWatch()` dans `server.mjs`.
 *
 * Extrait ici parce que **six pages** en dépendent — les six qui affichent quelque chose que la
 * machine peut changer — et qu'une deuxième copie de la logique d'abonnement aurait divergé au
 * premier correctif.
 */
export interface PushState {
  machines: MachineSummary[];
  defaultId: string;
  at: number;
}

/**
 * `onPush` est appelé à chaque état poussé. Rend `live`, faux quand le flux n'a pas pu s'établir —
 * une page peut alors retomber sur une scrutation, et le dire.
 *
 * Le rappel est gardé dans une **référence** : passé en dépendance de l'effet, une fonction
 * recréée à chaque rendu ferait fermer et rouvrir la connexion en boucle.
 */
export function useMachineEvents(onPush: (p: PushState) => void): { live: boolean } {
  const [live, setLive] = useState(true);
  const cb = useRef(onPush);
  cb.current = onPush;

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setLive(false);
      return;
    }
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        cb.current(JSON.parse(e.data) as PushState);
        setLive(true);
      } catch {
        /* une trame illisible ne doit pas casser l'abonnement */
      }
    };
    es.onerror = () => setLive(false);
    return () => es.close();
  }, []);

  return { live };
}

/**
 * Le résumé de la machine **couramment affichée** dans un état poussé.
 *
 * Le flux porte toutes les machines ; une page n'en regarde qu'une. Sans choix explicite, c'est
 * celle par défaut du serveur — la même que celle à laquelle `mfetch` s'adresse, sans quoi la page
 * suivrait l'activité d'une cafetière et afficherait les données d'une autre.
 */
export function pickPushed(p: PushState): MachineSummary | null {
  const id = currentMachine() ?? p.defaultId;
  return p.machines.find((m) => m.id === id) ?? null;
}

/**
 * Vrai quand la machine a quelque chose en cours : une lecture de propriétés ou un programme ECAM.
 * C'est ce qui justifie d'attendre une nouvelle donnée plutôt que de conclure.
 */
export const isBusy = (m: MachineSummary | null) => !!m && (!!m.reading || !!m.running);

/**
 * État poussé de la machine courante, prêt à l'emploi — **la règle « quand relire », en un endroit**.
 *
 * Quatre pages en ont besoin (`/`, `/beans`, `/profils`, `/statistiques`) et les trois premières à
 * l'écrire le faisaient chacune à sa façon, avec son propre minuteur. La règle est la même partout,
 * et elle tient en deux signaux :
 *
 * - `importedAt` a bougé → la machine a écrit une donnée. Toute écriture de donnée lue passe par
 *   `putProp` / `putStats` / `putBeanSystem`, qui l'horodatent : c'est le signal exact ;
 * - une lecture ou un programme vient de **se terminer** → le moment de relire, même si rien n'a
 *   été écrit (machine muette, fenêtre expirée).
 *
 * Rend aussi `busyRef` : une référence, pas un état, pour qu'un enchaînement `await` puisse attendre
 * que la machine soit libre **sans** relancer de requête. C'est ce qui remplace les boucles qui
 * interrogeaient `/api/…` toutes les 1,5 s pour savoir si elles pouvaient continuer.
 *
 * **Deux signaux, un seul flux.** `onChange` répond à « il y a une donnée neuve à relire » ;
 * `onAny`, facultatif, répond à « quelque chose a bougé », ce qui n'est pas la même question. Le
 * journal, le monitor, l'état de session ne sont pas des données *écrites* : rien ne les horodate,
 * et le seul signal qui les concerne est la poussée elle-même. Les deux pages qui les affichent
 * (`/` et `/pilotage`) en avaient besoin ; sans ce second rappel, elles auraient ouvert un
 * **deuxième** `EventSource` pour la même connexion, ce qui coûte plus cher que le minuteur qu'on
 * vient d'enlever.
 *
 * `onAny` reçoit aussi le **premier** état poussé, contrairement à `onChange` : au montage, une
 * page n'a encore rien affiché, donc le premier état est bien une nouvelle.
 */
export function useMachinePush(onChange: () => void, onAny?: () => void): {
  live: boolean;
  busy: boolean;
  busyRef: React.RefObject<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const marqueur = useRef<{ importedAt: number | null; busy: boolean } | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const cbAny = useRef(onAny);
  cbAny.current = onAny;

  const { live } = useMachineEvents(
    useCallback((p: PushState) => {
      const mine = pickPushed(p);
      const occupe = isBusy(mine);
      const importedAt = mine?.importedAt ?? null;
      const avant = marqueur.current;
      marqueur.current = { importedAt, busy: occupe };
      busyRef.current = occupe;
      setBusy(occupe);
      cbAny.current?.();
      // Le premier état poussé n'est pas un changement : la page vient de charger ses données.
      if (!avant) return;
      if (importedAt !== avant.importedAt || (avant.busy && !occupe)) cb.current();
    }, []),
  );

  return { live, busy, busyRef };
}

/**
 * Attend que la machine soit libre, d'après l'état poussé. Purement local : on scrute une
 * référence en mémoire, aucune requête ne part.
 *
 * Rend `false` si le délai expire — un enchaînement doit pouvoir renoncer plutôt que de tourner
 * indéfiniment sur une machine qui ne répond pas.
 */
export async function attendreLibre(busyRef: React.RefObject<boolean>, timeoutMs = 30000): Promise<boolean> {
  const fin = Date.now() + timeoutMs;
  while (Date.now() < fin) {
    if (!busyRef.current) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
