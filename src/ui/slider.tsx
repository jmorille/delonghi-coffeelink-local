"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/ui/cn"

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CURSEUR — C'EST ICI QUE LA FAÇADE DEVIENT PROPRE À CE PRODUIT
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La piste n'est pas une gouttière : c'est un **creux fraisé** dans le boîtier, et la graduation y
 * est sérigraphiée. La poignée n'est pas ronde : c'est un **patin usiné**, rectangle à arête haute
 * claire, hauteur pleine.
 *
 * ── Les crans ne sont pas décoratifs ─────────────────────────────────────────────────────────
 *
 * Leur nombre vient de `--crans`, posé par l'appelant à partir des bornes que la **machine** a
 * publiées pour ce paramètre. **Sans `--crans`, aucune graduation n'est imprimée** : une piste nue
 * dit « je ne connais pas les bornes de ce réglage », une piste graduée au hasard dirait « voici ce
 * que la machine autorise », et ce serait faux. C'est la règle de tout ce produit — ne jamais
 * afficher comme lu ce qui ne l'a pas été.
 *
 * La graduation est donc la seule chose de ce composant qui reste dans `surfaces.css` : elle est
 * conditionnée par la PRÉSENCE d'une variable (`[style*="--crans"]`), ce qu'aucun utilitaire
 * n'exprime. Elle y a suivi le nœud — de `input[type="range"]` à `[data-slot="slider-track"]`.
 *
 * ── `aria-label` va sur la POIGNÉE, pas sur la racine ────────────────────────────────────────
 *
 * C'est la poignée qui porte `role="slider"` chez Radix, alors que l'`<input type="range">` natif
 * était lui-même la commande. Laisser le libellé sur la racine l'aurait rendu invisible au lecteur
 * d'écran : il aurait annoncé « curseur » sans dire de quoi — sur un écran où chaque curseur est un
 * ingrédient différent du même café.
 */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex h-7 w-full touch-none items-center select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "relative grow rounded-[var(--r-creux)] bg-creux",
          "shadow-[inset_0_1px_0_0_var(--color-arete-basse),inset_0_-1px_0_0_var(--color-arete-haute)]",
          "data-[orientation=horizontal]:h-3 data-[orientation=horizontal]:w-full",
          "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-3",
        )}
      >
        {/* **La portion parcourue reste invisible, et c'est délibéré.** Un creux fraisé ne se
            remplit pas de couleur : c'est le patin qui dit où l'on est. Peindre la course en ambre
            allumerait la teinte du CHOIX sur un réglage qu'on est en train de faire glisser, alors
            qu'elle est réservée à ce qui EST choisi. */}
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute bg-transparent data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          aria-label={ariaLabel}
          /* 14 × 24 : au-dessus du plancher de 24 px de cible une fois la piste comptée, sur
             l'appareil tactile qui sert à piloter. Le curseur natif en donnait 14 de haut. */
          className={cn(
            "block h-6 w-3.5 shrink-0 cursor-pointer rounded-touche border-0 bg-aluminium",
            "shadow-[inset_0_1px_0_0_var(--color-arete-haute),0_1px_2px_-1px_var(--color-arete-basse)]",
            "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ambre",
            "disabled:pointer-events-none",
          )}
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
