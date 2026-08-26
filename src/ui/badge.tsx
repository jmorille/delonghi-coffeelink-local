import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/ui/cn"

/** Le rythme d'une sérigraphie : petit corps, graisse haute, capitales, interlettrage large. */
const PLAQUETTE =
  "text-[length:var(--t-mini)] font-[650] leading-[var(--lead-dense)] tracking-[var(--suivi-legende)] uppercase " +
  "border-0 shadow-[inset_0_1px_0_0_var(--color-arete-basse),inset_0_-1px_0_0_var(--color-arete-haute)] " +
  "[a&]:no-underline [a&]:hover:underline [a&]:hover:underline-offset-2 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ambre focus-visible:ring-0"

/**
 * Le témoin lumineux : un point de la couleur du texte, avec son halo. `currentColor` et non une
 * teinte écrite — c'est ce qui fait qu'une variante ne peut pas allumer une lampe d'une autre
 * couleur que son propre mot.
 */
const LAMPE =
  "gap-1.5 px-2 py-[3px] before:block before:size-[7px] before:shrink-0 before:rounded-full " +
  "before:bg-current before:shadow-[0_0_6px_-1px_currentColor] before:content-['']"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",

        /**
         * ═══════════════════════════════════════════════════════════════════════════════════
         * LA PLAQUETTE — ET SA LAMPE
         * ═══════════════════════════════════════════════════════════════════════════════════
         *
         * Ce n'est pas une étiquette arrondie posée sur une page : c'est une **plaquette
         * sérigraphiée** encastrée dans le boîtier. Capitales, interlettrage large, rayon du
         * boîtier — jamais `rounded-full`, qui en referait une pilule de site web.
         *
         * ⚠️ **La lampe est posée sur la plaquette qui porte déjà le NOM de l'état, et c'est tout
         * l'intérêt.** Un témoin lumineux séparé du mot qu'il qualifie oblige à faire le lien ;
         * ici les deux sont le même objet. C'est ce qui a condamné le composant `Etat` de
         * l'ancienne façade, qui reconstruisait ce couple à côté.
         *
         * Les trois teintes répondent à trois questions différentes, et les mélanger est ce que
         * cette échelle existe pour empêcher :
         *
         * - `plaque` — une catégorie, un nom. Aucune lampe : il n'y a pas d'état à rapporter.
         * - `marche` / `arret` — ce que la MACHINE rapporte. Le vert et le rouge ne servent
         *   qu'à ça, dans tout le produit.
         * - `choisi` — ce que NOUS avons choisi ou lu : un profil de grain, la provenance d'une
         *   valeur. Distinct du vert parce que ce n'est pas un état de l'appareil — « Bean
         *   Adapt : Grain A » décrit une configuration, pas une machine prête.
         */
        plaque:
          "gap-1.5 rounded-plaque bg-creux px-2 py-[3px] text-encre-faible shadow-[inset_0_1px_0_0_var(--color-arete-basse),inset_0_-1px_0_0_var(--color-arete-haute)] " +
          PLAQUETTE,
        marche: `${LAMPE} rounded-plaque bg-vert-verre text-vert ${PLAQUETTE}`,
        arret: `${LAMPE} rounded-plaque bg-rouge-verre text-rouge-encre ${PLAQUETTE}`,
        choisi: `${LAMPE} rounded-plaque bg-ambre-verre text-ambre ${PLAQUETTE}`,
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
