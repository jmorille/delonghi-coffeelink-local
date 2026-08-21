"use client";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Alerte from "./Alerte";
import { type Geste, confirmRequis, setConfirmRequis } from "./confirmPrefs";

/**
 * Demande de confirmation, pour toute action physique ou persistante.
 *
 * **Pourquoi ce fichier existe.** Ce dialogue vivait à l'intérieur de `page.tsx` et n'y servait
 * qu'à l'accueil. Partout ailleurs — `/pilotage`, `/beans`, `/machines`, `/profils`, `/recipes` —
 * la même question passait encore par `window.confirm()` : **dix appels**, dont un qui collait sa
 * mise en garde à la question avec `\n\n` et un autre qui fabriquait sa phrase en ajoutant « ? »
 * dans le code. Ce qui protège d'un rinçage à l'eau chaude ne peut pas dépendre de la page où le
 * bouton se trouve.
 *
 * Les trois raisons de ne pas employer `window.confirm()` n'ont pas changé :
 *
 * - il n'est pas stylable, donc l'avertissement s'affiche au même niveau que le reste ;
 * - il vide les valeurs en texte brut, sans hiérarchie ;
 * - il renvoie `false` dans une iframe en bac à sable — donc tous les boutons de la page
 *   deviennent silencieusement inertes dans une carte de tableau de bord.
 *
 * `<dialog>` + `showModal()` apporte gratuitement le piège de focus, la fermeture par Échap et un
 * contenu qu'on peut hiérarchiser.
 */
export interface Ask {
  /** La question, en langue d'intention. C'est le titre du dialogue et son nom accessible. */
  question: string;
  /** Ce sur quoi l'action porte : valeurs, emplacement écrasé, appareil visé. */
  detail?: string;
  /**
   * D'où viennent ces valeurs. Quatrième champ, et non une phrase collée au bout de `detail` :
   * la même boisson pour le même profil ne donne pas la même tasse selon qu'on envoie ce que le
   * profil a enregistré ou ce que le modèle propose d'usine, et c'est exactement ce que
   * l'utilisateur doit pouvoir vérifier avant de confirmer une action physique.
   */
  source?: string;
  /** La conséquence physique ou irréversible. Elle a sa propre place, jamais la fin d'une phrase. */
  warn?: string;
  /**
   * Le geste répétitif dont la confirmation est renonçable — allumer, préparer. Sa **présence**
   * fait deux choses : elle autorise le raccourci si l'utilisateur l'a demandé, et elle affiche la
   * case « ne plus demander » dans le dialogue.
   *
   * Son **absence** est ce qui protège tout le reste. Écrire une recette dans un profil, écraser un
   * réglage de grain, supprimer, réinitialiser : rien de tout ça ne déclare de geste, donc rien de
   * tout ça ne peut perdre son dialogue ni proposer de s'en passer. L'oubli va du côté sûr, ce qui
   * est la seule direction acceptable pour une garde.
   */
  geste?: Geste;
  onConfirm: () => void;
}

/**
 * Le dialogue et la façon de le demander, en un appel.
 *
 * La page pose `{dialogue}` une fois dans son rendu et appelle `demander(...)` depuis ses gestes.
 * Rendre le nœud depuis le crochet est ce qui fait tenir l'adoption en deux lignes par page : sans
 * ça, chacune devait déclarer son état, importer le composant et le monter — soit exactement le
 * genre de recopie qui a laissé cinq pages sur `window.confirm()`.
 */
export function useConfirm(): { demander: (a: Ask) => void; dialogue: ReactNode } {
  const [ask, setAsk] = useState<Ask | null>(null);

  /**
   * **Le raccourci est décidé ici, et nulle part ailleurs.** Chaque page aurait pu tester la
   * préférence avant d'appeler — et c'est exactement ainsi que dix appels à `window.confirm()`
   * avaient fini par diverger. Une page qui déclare son geste hérite du réglage sans y penser ;
   * une page qui n'en déclare pas garde son dialogue.
   *
   * La lecture se fait au moment du geste, pas à l'abonnement : le réglage change rarement, et le
   * relire ici évite qu'une préférence modifiée dans un autre onglet mette une image à agir.
   */
  const demander = useCallback((a: Ask) => {
    if (a.geste && !confirmRequis(a.geste)) {
      a.onConfirm();
      return;
    }
    setAsk(a);
  }, []);

  return { demander, dialogue: <ConfirmDialog ask={ask} onClose={() => setAsk(null)} /> };
}

/**
 * L'élément reste monté en permanence, sinon `showModal()` n'aurait rien à appeler. Le focus part
 * sur « Annuler », qui est le premier bouton du DOM : pour une action irréversible, la touche
 * Entrée ne doit pas valider.
 */
export function ConfirmDialog({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const tc = useTranslations("common");
  const ref = useRef<HTMLDialogElement>(null);
  /**
   * La case est décochée à chaque ouverture. Elle porte une intention sur CE geste-ci — « fais-le,
   * et ne me demande plus » — pas un état à retrouver coché la fois suivante, où elle n'aurait plus
   * rien à décrire puisque le dialogue ne s'ouvrirait plus.
   */
  const [neRedemandePas, setNeRedemandePas] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (ask && !d.open) {
      setNeRedemandePas(false);
      d.showModal();
    } else if (!ask && d.open) d.close();
  }, [ask]);

  return (
    <dialog
      className="confirm"
      ref={ref}
      aria-labelledby="confirm-question"
      // Échap et le clic sur le fond passent par `cancel` : on annule, on n'envoie rien.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {ask && (
        <>
          <div className="body">
            <h2 id="confirm-question">{ask.question}</h2>
            {ask.detail && <p className="detail">{ask.detail}</p>}
            {ask.source && <p className="source">{ask.source}</p>}
            {/* Le pictogramme est le même que celui des bandeaux de page : c'est ici que vit la mise
                en garde la plus forte du produit — de l'eau chaude qui coule — et elle doit se
                reconnaître au même dessin qu'ailleurs. */}
            {ask.warn && <Alerte>{ask.warn}</Alerte>}
            {/* Offerte uniquement aux gestes qui la déclarent — donc jamais devant une suppression
                ni devant une écriture dans la machine. C'est ici qu'on rencontre la friction, donc
                c'est ici qu'on doit pouvoir y renoncer ; le chemin du retour est sur `/pilotage`,
                et la phrase le nomme plutôt que de laisser un réglage sans porte de sortie. */}
            {ask.geste && (
              <label className="renoncer">
                <input
                  type="checkbox"
                  checked={neRedemandePas}
                  onChange={(e) => setNeRedemandePas(e.target.checked)}
                />
                <span>
                  {tc("dontAskAgain")}
                  <span className="sub">{tc("dontAskAgainWhere")}</span>
                </span>
              </label>
            )}
          </div>
          <div className="actions">
            <button autoFocus onClick={onClose}>
              {tc("cancel")}
            </button>
            <button
              className="primary"
              onClick={() => {
                /**
                 * **La préférence ne s'applique qu'en confirmant.** Cochée puis annulée, elle ne
                 * change rien : « Annuler » veut dire que rien n'a eu lieu, et une interaction
                 * abandonnée ne doit pas laisser une garde en moins derrière elle.
                 */
                if (ask.geste && neRedemandePas) setConfirmRequis(ask.geste, false);
                const go = ask.onConfirm;
                onClose();
                go();
              }}
            >
              {tc("confirm")}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
