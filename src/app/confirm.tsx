"use client";
import { type ReactNode, useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { cn } from "@/ui/cn";
import { Checkbox } from "@/ui/checkbox";
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
 * ── Du `<dialog>` natif à Radix, et ce qu'il a fallu redemander explicitement ─────────────────
 *
 * Ce composant reposait sur `<dialog>` + `showModal()`, qui donnait **gratuitement** le piège de
 * focus, la fermeture par Échap et l'inertie du fond. Depuis la migration vers shadcn, ces trois
 * garanties viennent de `@radix-ui/react-dialog` — c'est-à-dire du code, plus de la plateforme. La
 * différence n'est pas théorique sur l'écran qui protège d'une action physique, donc :
 *
 * - `scripts/verif-surfaces.mjs` les vérifie une par une dans un vrai navigateur, et il a été
 *   écrit **avant** cette migration pour capturer ce que le natif faisait ;
 * - le focus initial est **imposé** sur « Annuler ». Radix pose le focus sur le premier élément
 *   focusable du contenu, ce qui n'est PAS la même promesse : la garantie qui compte ici est que la
 *   touche Entrée ne valide pas une action irréversible, et elle est donc écrite, pas héritée ;
 * - le bouton de fermeture en croix de `DialogContent` est **retiré**. Le dialogue a deux sorties
 *   nommées ; une troisième, muette, dans le coin d'une garde, est une sortie de trop.
 *
 * Le clic sur le fond ferme, comme avant — mais il n'y a plus de code pour ça : le `<dialog>`
 * natif n'émettait rien sur son `::backdrop` et il fallait comparer `e.target`, Radix le fournit.
 * C'est le seul endroit où la migration a retiré du code plutôt que d'en ajouter.
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

export function ConfirmDialog({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const tc = useTranslations("common");
  /**
   * La case est décochée à chaque ouverture. Elle porte une intention sur CE geste-ci — « fais-le,
   * et ne me demande plus » — pas un état à retrouver coché la fois suivante, où elle n'aurait plus
   * rien à décrire puisque le dialogue ne s'ouvrirait plus.
   *
   * Radix démonte le contenu à la fermeture, ce que le `<dialog>` toujours monté ne faisait pas :
   * la remise à zéro n'a donc plus besoin d'un effet, elle vient du montage. Un `key` sur le
   * contenu la garantit même si deux questions se succèdent sans fermeture intermédiaire.
   */
  const [neRedemandePas, setNeRedemandePas] = useState(false);

  return (
    <Dialog
      open={ask !== null}
      /* Échap, le clic sur le fond et la croix passent tous par ici. Le sens de la fermeture est
         le seul acceptable pour une garde : on annule, on n'envoie rien. C'est aussi pourquoi le
         raccourci est offert sans réserve — il ne peut que renoncer. */
      onOpenChange={(o) => { if (!o) onClose(); }}
    >
      {ask && (
        <DialogContent
          key={ask.question}
          showCloseButton={false}
          /* **La matière du panneau, en utilitaires — et c'est une contrainte, pas un style.**
             Les classes de base de `DialogContent` vivent dans la couche `utilities`, qui bat
             `surfaces` : une règle `.confirm { background: … }` écrite dans la feuille perdait en
             silence contre `bg-background`. Posées ici, elles passent par `tailwind-merge`, qui
             résout le conflit dans le bon sens.

             Un panneau de boîtier ne flotte pas dans un halo de 48 px : il est posé, avec une
             ombre courte et franchement décalée, et son relief vient de ses arêtes. */
          className={cn(
            "gap-0 overflow-hidden p-0",
            "max-w-[min(30rem,calc(100vw-2rem))] sm:max-w-[min(30rem,calc(100vw-2rem))]",
            "rounded-plaque border border-gravure bg-releve text-encre",
            "shadow-[inset_0_1px_0_0_var(--color-arete-haute),inset_0_-1px_0_0_var(--color-arete-basse),0_8px_20px_-10px_var(--color-arete-basse)]",
          )}
          /* **Le focus va sur « Annuler », et c'est écrit.** Radix le poserait sur le premier
             élément focusable, ce qui dépendrait de la présence de la case « ne plus demander » —
             donc du geste. Pour une action irréversible, la touche Entrée ne doit pas valider, et
             cette garantie ne peut pas dépendre de ce que le dialogue contient ce jour-là. */
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            // `currentTarget` d'un événement Radix n'est pas typé comme un élément : on interroge
            // le document, ce qui est de toute façon plus juste — le contenu vit dans un PORTAIL,
            // donc hors de l'arbre du composant.
            document.querySelector<HTMLButtonElement>("[data-annuler]")?.focus();
          }}
        >
          <div className="px-5 pt-[1.125rem] pb-4">
            <DialogTitle className="mb-2.5 text-[length:var(--t-section)] leading-[var(--lead-section)]">
              {ask.question}
            </DialogTitle>
            {ask.detail
              /* Ce sur quoi l'action porte, dans un creux : la liste des valeurs se lit comme une
                 pièce jointe à la question, pas comme sa suite. `anywhere` parce qu'un nom de
                 propriété Ayla ou un identifiant de machine n'a aucun point de coupure naturel. */
              ? <DialogDescription className="m-0 rounded-touche bg-creux px-3 py-2.5 text-petit text-encre-faible [overflow-wrap:anywhere]">
                  {ask.detail}
                </DialogDescription>
              /* Radix exige une description pour l'accessibilité du dialogue ; sans détail il n'y a
                 rien d'honnête à écrire, donc on le déclare absent au lieu d'inventer une phrase. */
              : <DialogDescription className="sr-only">{ask.question}</DialogDescription>}
            {/* La provenance des valeurs : une ligne, sous la liste, sans fond. Elle répond à
                « lesquelles ? » quand `detail` répond à « quoi ? », et elle ne doit pas peser
                autant que la mise en garde. */}
            {ask.source && (
              <p className="mt-2 text-petit leading-[var(--lead-corps)] text-encre-faible">{ask.source}</p>
            )}
            {/* Le pictogramme est le même que celui des bandeaux de page : c'est ici que vit la mise
                en garde la plus forte du produit — de l'eau chaude qui coule — et elle doit se
                reconnaître au même dessin qu'ailleurs. */}
            {ask.warn && <Alerte>{ask.warn}</Alerte>}
            {/* Offerte uniquement aux gestes qui la déclarent — donc jamais devant une suppression
                ni devant une écriture dans la machine. C'est ici qu'on rencontre la friction, donc
                c'est ici qu'on doit pouvoir y renoncer ; le chemin du retour est sur `/pilotage`,
                et la phrase le nomme plutôt que de laisser un réglage sans porte de sortie. */}
            {ask.geste && (
              /* Renoncer à la question, depuis la question elle-même. Séparée par un filet et non
                 par une simple marge : elle ne décrit pas l'action en cours — c'est un réglage
                 durable posé dans un dialogue qui, lui, ne concerne qu'un geste. Sans la coupure,
                 elle se lisait comme une quatrième ligne de détail.

                 La cible tient 44 px de haut au doigt : la case seule en fait 16, et c'est le
                 libellé entier qui est cliquable puisque le `<label>` enveloppe les deux. */
              <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 border-t border-gravure pt-3 text-petit leading-[var(--lead-corps)]">
                <Checkbox
                  className="mt-0.5 size-[18px] shrink-0"
                  checked={neRedemandePas}
                  onCheckedChange={(v) => setNeRedemandePas(v === true)}
                />
                <span className="grid min-w-0 gap-px">
                  {tc("dontAskAgain")}
                  <span className="text-petit text-encre-faible">{tc("dontAskAgainWhere")}</span>
                </span>
              </label>
            )}
          </div>
          {/* Les deux sorties, à droite, sur un fond en creux séparé par un filet : la question
              est au-dessus, ce qu'on en fait est en dessous. */}
          <DialogFooter className="flex-row justify-end gap-2.5 border-t border-gravure bg-creux px-5 py-3.5 sm:justify-end">
            <Button data-annuler variant="neutre" size="commande" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button
              variant="marche"
              size="commande"
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
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
