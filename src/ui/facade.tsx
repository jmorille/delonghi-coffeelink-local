"use client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PIÈCE DE LA FAÇADE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ce fichier contient ce que shadcn **ne peut pas** fournir : la pièce dont la forme est la thèse
 * du produit. Tout le reste — dialogue, sélecteur, onglets, infobulle, curseur — vient de la CLI et
 * hérite du monde par le pont de tokens de `globals.css`.
 *
 * La règle de partage est simple : si un composant existe dans toutes les interfaces, il est
 * importé et rebranché ; s'il n'existe que parce que ce produit pilote une machine à café par un
 * protocole qui pousse son état, il est écrit ici.
 *
 * ── Il y en avait cinq, il en reste une, et c'est le résultat de la revue ────────────────────
 *
 * `Plaque`, `Etat`, `Commande` et `Mesure` ont été écrites ici et **montées par aucune
 * surface**. Ce n'est pas le fait qu'elles soient inemployées qui les condamne : c'est que chacune
 * était une SECONDE implémentation d'un mécanisme déjà livré, et qu'une seconde implémentation est
 * la garantie qu'une prochaine modification n'en corrigera qu'une.
 *
 * - `Plaque` doublait `.card` + le `h2` gravé de la couche `facade` ;
 * - `Etat` doublait la lampe de `.pill.on / .off / .info::before` — laquelle a un avantage
 *   décisif : elle est posée sur la plaquette qui porte déjà le NOM de l'état, alors que `Etat`
 *   reconstruisait ce couple à côté ;
 * - `Commande` doublait l'échelle imprimée que `--crans` pose sur la piste du curseur dans
 *   `surfaces.css` — et c'est bien là qu'elle doit vivre, sur la commande, armée par les bornes
 *   que la machine a publiées et absente quand elle ne les a pas publiées ;
 * - `Mesure` doublait `.rappel` + `.valeur`, désormais portées par les surfaces elles-mêmes
 *   (`/machines` pour la provenance d'une adresse, `/statistiques` pour les totaux).
 *
 * Ce qu'il reste est donc exactement ce qui n'existe nulle part ailleurs : la touche.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   LA TOUCHE
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Les fonctions d'une touche, et rien d'autre. Ce ne sont pas des niveaux d'importance
 * (`primary` / `secondary`), ce sont les trois rôles du produit plus le neutre :
 *
 * - `neutre` — la touche ordinaire : lire, ouvrir, enregistrer localement ;
 * - `marche` — VERTE. Elle démarre quelque chose sur l'appareil. Il ne doit y en avoir **qu'une**
 *   visible à la fois sur un panneau ; c'est la contrainte qui rend le vert lisible d'un coup d'œil ;
 * - `arret` — ROUGE. Elle arrête, ou elle détruit. Elle vit sous une `.garde` ;
 * - `choisi` — AMBRE. Elle n'agit pas : elle indique que cette touche-ci est celle qui est
 *   actuellement sélectionnée (profil actif, page courante).
 */
type FonctionTouche = "neutre" | "marche" | "arret" | "choisi";

interface ProprietesTouche extends ButtonHTMLAttributes<HTMLButtonElement> {
  fonction?: FonctionTouche;
  /** `lg` est la taille de la console de boissons : on l'utilise debout, parfois d'une main. */
  taille?: "sm" | "md" | "lg";
  /** L'icône est le canal principal de l'affordance (PRODUCT.md) ; le texte l'accompagne. */
  icone?: ReactNode;
  /**
   * Replie le libellé visible et ne garde que l'icône. **`aria-label` devient alors obligatoire**
   * — TypeScript ne peut pas l'imposer, mais un bouton muet sans nom accessible est le défaut
   * qu'une interface à icônes produit par défaut, et il rend le produit inutilisable au lecteur
   * d'écran. `title` seul ne suffit pas : il ne se voit ni sur téléphone ni sur tablette, deux des
   * trois appareils prioritaires.
   */
  compacte?: boolean;
}

/** Les fonds et encres par fonction. Le verre éteint sert de fond : la touche EST la lampe. */
const HABILLAGE: Record<FonctionTouche, string> = {
  neutre: "bg-releve text-encre",
  marche: "bg-vert-verre text-vert",
  arret: "bg-rouge-verre text-rouge-encre",
  choisi: "bg-ambre-verre text-ambre",
};

/**
 * **Les trois tailles sont celles du système, pas des paliers inventés.** `md` vaut `--h-ctl`,
 * la hauteur de commande du produit (44 px) : une touche de façade et un bouton de page ont la
 * même hauteur, sinon la coquille et les pages ne se posent pas sur la même grille.
 *
 * `sm` descend à 36 px — c'est le seul palier au-dessous, réservé à la coquille, où une commande
 * secondaire ne doit pas peser autant qu'un geste sur la machine. Il remonte à 44 au doigt, par
 * `tactile:`, et `min-w` avec, parce qu'une touche compacte est carrée : baisser un seul des
 * deux axes sous 44 px est exactement l'échange que ce dépôt a déjà refusé une fois.
 */
const TAILLES = {
  sm: "min-h-9 min-w-9 tactile:min-h-11 tactile:min-w-11 px-2 gap-1.5 text-petit",
  md: "min-h-11 min-w-11 px-3 gap-2 text-petit",
  lg: "min-h-12 min-w-12 px-4 gap-2 text-corps",
} as const;

/**
 * **La physique de la touche.** Au repos elle est en relief : arête haute claire, arête basse
 * sombre, plus une ombre courte et décalée — une vraie ombre portée, pas un halo centré. Enfoncée,
 * elle descend d'un pixel et son biseau s'inverse : c'est le cran mécanique, et c'est la seule
 * animation que ce produit s'autorise sur une commande.
 */
export function Touche({
  fonction = "neutre",
  taille = "md",
  icone,
  compacte = false,
  className,
  children,
  ...reste
}: ProprietesTouche) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex select-none items-center justify-center rounded-touche",
        "font-medium transition-[transform,box-shadow] duration-75",
        "shadow-[inset_0_1px_0_0_var(--color-arete-haute),inset_0_-1px_0_0_var(--color-arete-basse),0_1px_2px_-1px_var(--color-arete-basse)]",
        "active:translate-y-px",
        "active:shadow-[inset_0_1px_0_0_var(--color-arete-basse),inset_0_-1px_0_0_var(--color-arete-haute)]",
        "disabled:pointer-events-none disabled:opacity-45",
        HABILLAGE[fonction],
        TAILLES[taille],
        className,
      )}
      {...reste}
    >
      {icone}
      {!compacte && children ? <span className="truncate">{children}</span> : null}
    </button>
  );
}
