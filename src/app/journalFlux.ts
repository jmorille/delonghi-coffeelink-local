"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LigneJournal, LotJournal } from "./events";

/**
 * L'anneau de journal du navigateur — **un état qui s'ajoute, jamais une liste retéléchargée**.
 *
 * Mesuré avant ce lot, sur la machine d'essai : `/api/status` pesait 8 185 octets dont 5 685 (69 %)
 * de journal, et la page la relisait en entier à CHAQUE poussée SSE — donc toutes les 250 ms
 * pendant une préparation — pour ~114 octets d'information neuve. Le journal a donc quitté cette
 * réponse : il s'amorce une fois par `GET /api/journal`, puis n'arrive plus que par ajouts sur le
 * flux déjà ouvert (voir `cadreJournal` dans `server.mjs`).
 *
 * ⚠️ **La fusion se fait par `id`, et c'est ce qui fait survivre le repli des répétitions.**
 * Le serveur ne réécrit pas une ligne identique consécutive : il incrémente `repetitions` sur la
 * ligne existante et lui donne un `n` neuf pour qu'elle reparte sur le fil. Fusionner par rang, ou
 * simplement concaténer, empilerait vingt-quatre copies de « socket hang up » là où le serveur
 * n'en tient qu'une — et le repli est précisément ce qui rend le journal lisible quand tout va
 * mal. Un `id` déjà connu REMPLACE ; sur-livrer devient alors gratuit, ce dont le serveur profite
 * en n'entretenant qu'un seul curseur pour tous les abonnés.
 */

/** Ce que chaque bac retient, côté navigateur. Doit suivre `JOURNAL_MAX` dans `server.mjs`. */
const GARDE: Record<LigneJournal["source"], number> = { machine: 400, apps: 200 };

function fusionner(prev: LigneJournal[], lot: LotJournal): LigneJournal[] {
  // `complet` dit « tu as raté des lignes qui n'existent plus » : on remplace, on n'ajoute pas à
  // une chronologie trouée.
  const par = new Map<number, LigneJournal>(lot.complet ? [] : prev.map((e) => [e.id, e]));
  for (const e of lot.lignes) par.set(e.id, e);
  const tout = [...par.values()].sort((a, b) => b.n - a.n);
  // Plafonner par SOURCE, comme le serveur : un bavardage d'applications ne doit pas évincer le
  // journal machine, qui est l'instrument.
  const reste = { machine: GARDE.machine, apps: GARDE.apps };
  return tout.filter((e) => reste[e.source]-- > 0);
}

export interface Journal {
  lignes: LigneJournal[];
  /** Branché sur l'évènement `journal` du flux. Voir `useMachineEvents`. */
  recevoir: (lot: LotJournal) => void;
  /** Le repli sans flux : redemande ce qui a paru depuis le curseur. */
  rattraper: () => void;
  /** Faux tant que l'amorce n'a pas répondu — un journal vide et un journal pas encore lu. */
  amorce: boolean;
}

export function useJournal(): Journal {
  const [lignes, setLignes] = useState<LigneJournal[]>([]);
  const [amorce, setAmorce] = useState(false);
  /**
   * Le plus haut `n` reçu. En **référence** et non en état : il change à chaque lot et n'est lu
   * que par `rattraper()` — le passer en état ferait re-rendre le bloc pour une valeur que
   * personne n'affiche.
   */
  const curseur = useRef(0);

  const recevoir = useCallback((lot: LotJournal) => {
    curseur.current = Math.max(curseur.current, lot.jusqu ?? 0);
    setLignes((prev) => fusionner(prev, lot));
    setAmorce(true);
  }, []);

  const rattraper = useCallback(() => {
    fetch(`/api/journal?depuis=${curseur.current}`)
      .then((r) => r.json())
      .then(recevoir)
      .catch(() => {
        /* le journal est un instrument de diagnostic : son absence ne doit rien casser */
      });
  }, [recevoir]);

  // L'amorce, et elle n'a lieu qu'une fois : ensuite, ce sont des ajouts. Sans machine dans
  // l'URL — le journal est unique, toutes machines confondues, et chaque ligne porte la sienne.
  useEffect(() => {
    rattraper();
  }, [rattraper]);

  return { lignes, recevoir, rattraper, amorce };
}
