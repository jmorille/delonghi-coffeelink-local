"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/ui/cn"

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTERRUPTEUR — ET SA TROISIÈME POSITION
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Radix ne connaît que deux états : coché, décoché. Ce produit en a **trois**, et le troisième est
 * le plus important des trois.
 *
 * ⚠️ **`inconnu` n'est PAS un état désactivé.** La machine peut très bien n'avoir rien poussé
 * depuis longtemps : on ne sait alors ni si elle est allumée, ni si elle est éteinte. Griser la
 * commande (`opacity: .45`) dirait « cette commande ne vous est pas offerte », alors que ce qu'il
 * faut dire est « nous ne savons pas ce qu'elle vaut ». La différence compte devant une cafetière :
 * l'un invite à attendre, l'autre à aller voir la machine.
 *
 * Il se dessine donc, il ne se cache pas : la poignée quitte ses deux extrémités et se **centre**,
 * et la piste prend la hachure d'attente — la matière que ce monde emploie partout pour « la
 * machine n'a rien dit ». C'est la même hachure que la mise en garde (`alert.tsx`), pour la même
 * raison : elle attire l'œil par la texture, sans emprunter une couleur de fonction.
 *
 * ── Rien n'est rond ─────────────────────────────────────────────────────────────────────────
 *
 * Piste et poignée sont au rayon du boîtier (`--r-touche`, 2 px) et non en `rounded-full` : une
 * bascule d'appareil est un patin qui coulisse dans un creux, pas une pilule. C'est ce qui la fait
 * appartenir à la même famille que le curseur, qui coulisse dans le même creux.
 */
function Switch({
  className,
  size = "default",
  inconnu = false,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  /** `sm` est la ligne de réglage ; `default` est la commande principale du tableau de bord. */
  size?: "sm" | "default"
  /**
   * La machine n'a rien poussé : ni allumée, ni éteinte. Voir l'en-tête — c'est un état à part
   * entière, et il l'emporte sur `checked` à l'affichage. Sans ce recouvrement, une machine dont
   * l'état devient inconnu PENDANT qu'elle est allumée garderait sa poignée à droite, donc
   * continuerait d'affirmer « allumée » alors que plus rien ne le dit.
   */
  inconnu?: boolean
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      data-inconnu={inconnu || undefined}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-touche border-0 transition-colors outline-none",
        "shadow-[inset_0_1px_0_0_var(--color-arete-basse),inset_0_-1px_0_0_var(--color-arete-haute)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ambre",
        "disabled:cursor-not-allowed disabled:opacity-45",
        "data-[size=sm]:h-7 data-[size=sm]:w-[52px] data-[size=default]:h-[42px] data-[size=default]:w-[76px]",
        "data-[state=unchecked]:bg-creux data-[state=checked]:bg-vert-verre",
        /* La position inconnue reprend la piste et la rend à sa hachure, quel que soit l'état
           coché — et rend son opacité pleine même désactivée, puisqu'elle n'est pas un refus. */
        "data-[inconnu]:bg-creux data-[inconnu]:opacity-100",
        "data-[inconnu]:bg-[repeating-linear-gradient(-45deg,color-mix(in_srgb,var(--encre-douce)_22%,transparent)_0_1px,transparent_1px_6px)]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        /**
         * **La position se choisit ici, en JavaScript, et pas par une variante qui doit en battre
         * une autre.** Écrites côte à côte, `data-[state=unchecked]:translate-x-0` et
         * `group-data-[inconnu]/switch:-translate-x-1/2` portent la même propriété sous deux
         * variantes DIFFÉRENTES : `tailwind-merge` les garde toutes les deux, et c'est alors
         * l'ordre de la feuille générée qui départage. Constaté au navigateur — la poignée restait
         * collée à gauche au lieu de se centrer, donc l'état « inconnu » se lisait « éteint ». Un
         * défaut invisible en relecture : les deux classes sont justes, c'est leur rencontre qui
         * ne l'est pas.
         *
         * `inconnu` est une prop, donc la branche est connue au rendu. Une seule règle s'applique.
         */
        className={cn(
          "pointer-events-none absolute block rounded-touche ring-0 transition-[transform,background-color,left] duration-[180ms]",
          "shadow-[inset_0_1px_0_0_var(--color-arete-haute),0_1px_2px_-1px_var(--color-arete-basse)]",
          "group-data-[size=sm]/switch:size-5 group-data-[size=default]/switch:size-[34px]",
          inconnu
            // Centrée, et en encre douce : la poignée ne prétend plus rien.
            ? "left-1/2 -translate-x-1/2 bg-encre-faible"
            : [
                "bg-aluminium data-[state=checked]:bg-vert",
                "group-data-[size=sm]/switch:left-[3px] group-data-[size=default]/switch:left-1",
                "data-[state=unchecked]:translate-x-0",
                "group-data-[size=sm]/switch:data-[state=checked]:translate-x-6",
                "group-data-[size=default]/switch:data-[state=checked]:translate-x-[34px]",
              ].join(" "),
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
