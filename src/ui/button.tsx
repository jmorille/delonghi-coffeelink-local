import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/ui/cn"

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TOUCHE, ABSORBÉE DANS LE BOUTON SHADCN
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ce fichier vient de la CLI, et il porte en plus les quatre variantes du produit. `Touche`,
 * qui vivait dans `src/ui/facade.tsx` (supprimé), a été **fondue ici** plutôt que gardée à côté : deux composants de bouton
 * dans le même dépôt, c'est la garantie qu'une prochaine correction n'en atteindra qu'un — le
 * défaut que ce projet a déjà payé sur l'éditeur de recette et sur la carte de boisson.
 *
 * ── Les variantes du produit ne sont PAS des niveaux d'importance ────────────────────────────
 *
 * `default` / `secondary` / `destructive` disent « à quel point c'est important ». Ici la couleur
 * d'une commande dit sa **fonction**, et c'est une règle de produit, pas de goût :
 *
 * - `neutre` — la touche ordinaire : lire, ouvrir, enregistrer localement ;
 * - `marche` — elle démarre quelque chose sur l'APPAREIL ;
 * - `arret` — ROUGE. Elle arrête, ou elle détruit. Elle vit sous une garde ;
 * - `choisi` — AMBRE. Elle n'agit pas : elle dit que cette touche-ci est celle qui est
 *   actuellement sélectionnée (profil actif, page courante) ;
 * - `discret` — un contour, pas une plaque. Une action secondaire qui ne mérite pas le relief.
 *
 * ⚠️ **`marche` n'est PAS une touche verte, et c'est une correction payée une fois.** Elle l'a été,
 * et c'était un mensonge répété vingt-huit fois : un bouton « Préparer » au repos ne marche pas, il
 * attend qu'on appuie. Vingt-huit touches vertes sur l'écran d'accueil, c'est la couleur de la
 * MARCHE dépensée sur une intention — et le jour où la machine coule vraiment un café, plus rien ne
 * se distingue. Le vert garde sa seule place légitime : les plaquettes d'état que la machine pousse.
 *
 * La touche est donc neutre au repos, et sa fonction se lit à son icône et à son nom. Elle dit
 * quand même « je démarre quelque chose sur l'appareil », mais par un **liseré vert d'un pixel
 * sous la touche** — l'arête d'une touche de démarrage, pas son verre allumé. Contraste mesuré
 * contre la plaque : `--vert` #4fae66 sur `--releve` #37393b → 4,19:1 en graphite, #1f5c31 sur
 * #d2d2cd → 5,26:1 en aluminium ; le seuil d'un élément non textuel est 3:1 (WCAG 1.4.11).
 *
 * ⚠️ **L'ambre ne doit jamais habiller le bouton principal.** C'est la raison pour laquelle le pont
 * de tokens fait de `--primary` la touche neutre (`globals.css`) : peindre en ambre tout `variant`
 * par défaut allumerait la lampe du choix sur des actions qui ne choisissent rien, et ruinerait la
 * loi des trois couleurs dès le premier composant importé.
 *
 * Les variantes shadcn d'origine sont **conservées** : un composant ajouté demain par la CLI les
 * emploie (un `AlertDialog` pose un bouton `destructive`), et les retirer casserait l'import qui
 * est tout l'intérêt d'avoir shadcn.
 *
 * ── La physique, et pourquoi elle survit ─────────────────────────────────────────────────────
 *
 * Au repos la touche est en relief : arête haute claire, arête basse sombre, plus une ombre courte
 * et décalée — une vraie ombre portée, pas un halo centré. Enfoncée, elle descend d'un pixel et son
 * biseau s'inverse. C'est le cran mécanique, et c'est **la seule animation que ce produit s'autorise
 * sur une commande**. Elle est portée par les quatre variantes du produit, pas par la base : un
 * bouton `link` en relief n'aurait aucun sens.
 */

const RELIEF = [
  "shadow-[inset_0_1px_0_0_var(--color-arete-haute),inset_0_-1px_0_0_var(--color-arete-basse),0_1px_2px_-1px_var(--color-arete-basse)]",
  "active:translate-y-px",
  "active:shadow-[inset_0_1px_0_0_var(--color-arete-basse),inset_0_-1px_0_0_var(--color-arete-haute)]",
  "transition-[transform,box-shadow] duration-75",
  "select-none rounded-touche",
].join(" ")

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",

        neutre: `${RELIEF} bg-releve text-encre disabled:opacity-45`,
        /**
         * La plaque neutre, **plus une arête verte de deux pixels sous la touche**. L'appui inverse
         * le biseau du haut sans toucher à l'arête : c'est le liseré qui dit la fonction, et il ne
         * doit pas disparaître au moment précis où l'on appuie dessus.
         */
        marche: [
          "select-none rounded-touche transition-[transform,box-shadow] duration-75 active:translate-y-px",
          "bg-releve text-encre disabled:opacity-45",
          "shadow-[inset_0_var(--trait)_0_0_var(--color-arete-haute),inset_0_calc(-2*var(--trait))_0_0_var(--color-vert),0_1px_2px_-1px_var(--color-arete-basse)]",
          "active:shadow-[inset_0_var(--trait)_0_0_var(--color-arete-basse),inset_0_calc(-2*var(--trait))_0_0_var(--color-vert)]",
        ].join(" "),
        /* L'arrêt et la destruction, seules à porter le verre allumé : elles n'annoncent pas une
           intention, elles sont la conséquence. */
        arret: `${RELIEF} bg-rouge-verre text-rouge-encre disabled:opacity-45`,
        choisi: `${RELIEF} bg-ambre-verre text-ambre disabled:opacity-45`,
        /**
         * Un contour, pas une plaque : le fond reste celui de la carte. Enfoncée, une touche en
         * contour ne peut pas inverser un biseau qu'elle n'a pas — elle **épaissit son trait**.
         * C'est le même geste que le relief, dans la matière qui est la sienne.
         */
        discret: [
          "select-none rounded-touche bg-transparent text-encre transition-[box-shadow] duration-75",
          "shadow-[inset_0_0_0_var(--trait)_currentColor] active:shadow-[inset_0_0_0_var(--trait-fort)_currentColor]",
          "disabled:opacity-45",
        ].join(" "),
        /* La même, en rouge : supprimer, oublier une machine. Le contour porte la teinte du texte,
           qui doit passer 4,5:1 — c'est cette valeur-là qui décide, pas le seuil d'un contour. */
        "discret-arret": [
          "select-none rounded-touche bg-transparent text-rouge-encre transition-[box-shadow] duration-75",
          "shadow-[inset_0_0_0_var(--trait)_currentColor] active:shadow-[inset_0_0_0_var(--trait-fort)_currentColor]",
          "disabled:opacity-45",
        ].join(" "),
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",

        /**
         * **Les tailles du produit sont celles du système, pas des paliers inventés.**
         *
         * `commande` vaut `--h-ctl`, la hauteur de commande du produit (44 px) : une touche de la
         * coquille et un bouton de page ont la même hauteur, sinon les deux ne se posent pas sur la
         * même grille.
         *
         * `coquille` descend à 36 px — le seul palier au-dessous, réservé à la coquille, où une
         * commande secondaire ne doit pas peser autant qu'un geste sur la machine. Il **remonte à
         * 44 au doigt** par `tactile:`, et `min-w` avec : une touche compacte est carrée, et
         * baisser un seul des deux axes sous 44 px est l'échange que ce dépôt a déjà refusé une
         * fois. `console` est la taille de la page des boissons, qu'on utilise debout.
         */
        coquille: "min-h-9 min-w-9 tactile:min-h-11 tactile:min-w-11 px-2 gap-1.5 text-petit",
        commande: "min-h-11 min-w-11 px-3 gap-2 text-petit",
        console: "min-h-12 min-w-12 px-4 gap-2 text-corps",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
