"use client"

import * as React from "react"
import { CircleIcon } from "lucide-react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { cn } from "@/ui/cn"

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  )
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "aspect-square size-4 shrink-0 rounded-full border border-input text-primary shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CRAN — UN CHOIX EXCLUSIF QUI SE DESSINE COMME UNE TOUCHE, PAS COMME UNE PASTILLE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `RadioGroupItem` au-dessus est la pastille de la CLI : un rond de 16 px avec un point au
 * milieu. C'est le bon dessin pour une liste de réglages, et le mauvais pour un sélecteur de
 * barre, où les trois positions sont **fraisées dans un rail** et où celle qui est engagée est
 * une touche en relief. On garde donc les deux : la pastille pour les formulaires à venir, le
 * cran pour les rails.
 *
 * Ce qui est repris de Radix et qu'on ne réécrit pas : le groupement, le nom accessible, le
 * `tabindex` roulant et la navigation aux flèches. C'est exactement ce que les `<input
 * type="radio">` natifs donnaient — la raison pour laquelle ce sélecteur les employait — et le
 * seul motif de la bascule est qu'une case masquée sous une étiquette n'était plus le geste du
 * reste du produit.
 *
 * ⚠️ **Pas de lampe ambre sur un cran.** L'ambre dit « choisi » à propos de la MACHINE — profil
 * actif, page courante. L'étendre à une préférence d'affichage du navigateur diluerait la seule
 * chose qui rend cette couleur lisible d'un coup d'œil.
 */
function RadioGroupCran({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-cran"
      className={cn(
        "relative grid place-items-center rounded-touche transition-colors outline-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ambre",
        "text-encre-faible hover:text-encre disabled:pointer-events-none disabled:opacity-45",
        /* Engagé : la plaque en relief, biseau haut clair et biseau bas sombre — la même
           physique que `Button`, sans l'enfoncement, puisqu'un cran ne s'appuie pas : il reste. */
        "data-[state=checked]:bg-releve data-[state=checked]:text-encre",
        "data-[state=checked]:shadow-[inset_0_1px_0_0_var(--color-arete-haute),inset_0_-1px_0_0_var(--color-arete-basse)]",
        className
      )}
      {...props}
    >
      {children}
    </RadioGroupPrimitive.Item>
  )
}

export { RadioGroup, RadioGroupItem, RadioGroupCran }
