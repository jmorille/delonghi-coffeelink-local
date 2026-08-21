"use client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Alerte from "./Alerte";

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
  return { demander: setAsk, dialogue: <ConfirmDialog ask={ask} onClose={() => setAsk(null)} /> };
}

/**
 * L'élément reste monté en permanence, sinon `showModal()` n'aurait rien à appeler. Le focus part
 * sur « Annuler », qui est le premier bouton du DOM : pour une action irréversible, la touche
 * Entrée ne doit pas valider.
 */
export function ConfirmDialog({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const tc = useTranslations("common");
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (ask && !d.open) d.showModal();
    else if (!ask && d.open) d.close();
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
          </div>
          <div className="actions">
            <button autoFocus onClick={onClose}>
              {tc("cancel")}
            </button>
            <button
              className="primary"
              onClick={() => {
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
