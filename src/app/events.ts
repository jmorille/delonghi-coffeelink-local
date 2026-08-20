"use client";
import { useEffect, useRef, useState } from "react";
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
 * Extrait ici parce que **deux pages** en ont besoin, et qu'une deuxième copie de la logique
 * d'abonnement aurait divergé au premier correctif.
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
