import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/ui/cn"

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE — UNE PLAQUE VISSÉE SUR LE BOÎTIER, PAS UNE BOÎTE CERCLÉE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * **Une carte n'a pas de contour : elle a des arêtes.** Le `border` + `rounded-xl` + `shadow-sm`
 * de la CLI est la grammaire que cette façade refuse — une boîte remplie, cerclée d'un pixel, à
 * coins arrondis. Un boîtier d'appareil ne connaît pas ce trait : il connaît une plaque dont le
 * relief vient d'un biseau — arête haute claire en haut, arête basse sombre en bas — et d'une
 * ombre COURTE. La matière est donc remplacée, pas habillée par-dessus.
 *
 * ⚠️ **Et elle est remplacée ICI, pas dans la feuille.** Les utilitaires l'emportent sur
 * `surfaces.css` dans la cascade en couches de `globals.css` : laisser `bg-card` sur le composant
 * et peindre `.card` dans la feuille aurait rendu la carte au fond de shadcn, en silence. C'est le
 * défaut que ce dépôt a déjà payé sur le dialogue de confirmation.
 *
 * ── Ce que la carte sait d'elle-même ────────────────────────────────────────────────────────
 *
 * - **Elle s'interroge elle-même.** Une carte dans une grille fait ~320 px de large que la fenêtre
 *   en fasse 800 ou 1400 : c'est SA largeur qui décide si un libellé de bouton tient, pas celle de
 *   la fenêtre. D'où `container-name: carte`, et des `@container` plutôt que des `@media`.
 * - **Son premier et son dernier enfant ne débordent pas de son rembourrage.** Sans ces deux
 *   règles, chaque site devait le dire lui-même : `<h2 style={{ marginTop: 0 }}>` six fois. Une
 *   carte sait où elle commence.
 *
 * ── Trois matières, et pourquoi ce sont des VARIANTES et pas des classes ────────────────────
 *
 * `.card.machine` et `.cards.clavier > .card:not(.open)` réécrivaient le fond, le rayon, le
 * rembourrage et l'ombre depuis la feuille. Depuis que la carte porte sa matière en utilitaires,
 * **ces réécritures perdaient en silence** : la couche `utilities` l'emporte sur `surfaces`, quelle
 * que soit la spécificité du sélecteur. Une carte de machine serait redevenue une carte ordinaire
 * sans que rien ne le signale. Elles deviennent donc des variantes, sur le seul objet qui décide.
 *
 * - `plaque` — la carte ordinaire, décrite ci-dessus ;
 * - `touche` — **la carte fermée EST la touche.** Fraisage d'un pixel tout autour (l'ouverture dans
 *   la tôle) puis le biseau inversé, sombre en haut et clair en bas : une surface enfoncée. Ouverte,
 *   la carte reprend `plaque`, et c'est le contraste qu'on veut — fermée elle est un élément du
 *   clavier, ouverte elle est le sujet de la page ;
 * - `machine` — l'état de l'appareil n'est pas un élément de la liste des boissons. Il se distingue
 *   par sa SURFACE, pas par sa position : un simple trait à 1,26:1 le rendait indiscernable de la
 *   carte de boisson n°0.
 *
 * Ce qui reste dans `surfaces.css` est la disposition de la grille `.cards` et les modificateurs
 * qui ne touchent pas à la matière (`.warn`, `.open`, `.log`). Ils y visent `[data-slot="card"]`,
 * donc ils suivent le composant.
 */
const cardVariants = cva(
  [
    "text-encre border-0",
    "[container-type:inline-size] [container-name:carte]",
    "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  ].join(" "),
  {
    variants: {
      variant: {
        /* `court:` = l'écran bas — le téléphone tenu en paysage devant la machine. Le rembourrage
           y descend d'un cran ; il le faisait par `@media` dans la feuille, où il ne pouvait plus
           gagner. */
        plaque:
          "bg-releve rounded-plaque p-[var(--s-4)] court:p-[var(--s-3)] mb-[var(--s-3)] " +
          "shadow-[inset_0_var(--trait)_0_0_var(--color-arete-haute),inset_0_calc(-1*var(--trait))_0_0_var(--color-arete-basse),0_1px_2px_-1px_color-mix(in_srgb,var(--color-arete-basse)_70%,transparent)]",
        touche:
          "bg-[var(--panel-2)] rounded-touche p-[var(--s-3)] mb-0 " +
          "shadow-[0_0_0_var(--trait)_var(--rule),inset_0_var(--trait)_0_0_var(--color-arete-basse),inset_0_calc(-1*var(--trait))_0_0_var(--color-arete-haute)]",
        machine:
          "bg-[var(--raise)] rounded-plaque p-[var(--s-4)] court:p-[var(--s-3)] mb-[var(--s-3)] " +
          "shadow-[inset_0_1px_0_0_var(--color-arete-haute),inset_0_-1px_0_0_var(--color-arete-basse),0_2px_6px_-3px_var(--color-arete-basse)]",
      },
    },
    defaultVariants: { variant: "plaque" },
  }
)

function Card({
  className,
  variant = "plaque",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      data-variant={variant}
      className={cn(cardVariants({ variant, className }))}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  cardVariants,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
