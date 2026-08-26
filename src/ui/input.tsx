import * as React from "react"

import { cn } from "@/ui/cn"

/**
 * **Le champ est un creux du boîtier, pas une boîte posée dessus.**
 *
 * Les classes d'origine de shadcn — `bg-transparent`, `rounded-md`, un anneau de 3 px à la mise au
 * point — décrivent un formulaire web. Ici un champ de saisie appartient à la même famille que la
 * piste d'un curseur : une matière en retrait, cernée par l'arête de commande de la finition.
 *
 * Trois valeurs sont celles du système et non des choix de ce fichier :
 *
 * - `--h-ctl` (44 px) est la hauteur de commande du produit. Un champ et un bouton posés côte à
 *   côte doivent tenir sur la même ligne de grille ; le `h-9` de shadcn les aurait désalignés d'un
 *   demi-cran sur toutes les surfaces à la fois.
 * - `--r-touche` est le rayon du boîtier — 2 px, pas les 10 px de shadcn.
 * - `--lead-ctl` est l'interligne des commandes : sans lui, la hauteur du champ suit la prose
 *   voisine, ce qui la fait varier d'une page à l'autre pour le même champ.
 *
 * ⚠️ **`text-base` sur mobile n'est pas une coquette de taille.** En dessous de 16 px, Safari iOS
 * zoome automatiquement à la mise au point d'un champ — la page saute et ne revient pas. La règle
 * de shadcn (`text-base md:text-sm`) est conservée telle quelle pour cette raison.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-[var(--h-ctl)] w-full min-w-0 rounded-touche border border-[var(--arete-ctl)] bg-creux px-2.5 py-2 text-base text-encre",
        "leading-[var(--lead-ctl)] outline-none transition-[color,box-shadow] md:text-sm",
        "placeholder:text-encre-faible placeholder:opacity-100",
        "selection:bg-ambre-verre selection:text-encre",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-encre",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        /* La mise au point emprunte l'ambre, comme partout : c'est la teinte de « ce dont il est
           question en ce moment ». Un contour, pas un halo de 3 px — le boîtier n'en a nulle part. */
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ambre",
        "aria-invalid:border-rouge",
        className
      )}
      {...props}
    />
  )
}

export { Input }
