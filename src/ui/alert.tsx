import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/ui/cn"

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current",

        /**
         * **La mise en garde de ce produit est un CREUX HACHURÉ, pas une couleur.**
         *
         * L'ambre avait été essayé et retiré : il sert déjà à dire « c'est celui-ci », et sur
         * `/reglages` la carte d'avertissement se retrouvait ambre au-dessus de plaquettes ambre
         * qui, elles, désignaient un choix. Plus rien ne se lit d'un coup d'œil quand la même
         * teinte répond à deux questions.
         *
         * Le rouge n'est pas la réponse non plus : il est l'ARRÊT et le DÉFAUT, et une note de
         * prudence n'est ni l'un ni l'autre — l'employer ici userait le seul signal qui doit encore
         * pouvoir faire sursauter.
         *
         * Un boîtier sait faire autrement, et c'est même sa manière : la texture et le retrait
         * attirent l'œil sans emprunter une couleur de fonction. Les hachures sont à −45°, un pixel
         * tous les sept, dans l'encre douce de la finition courante.
         */
        garde: [
          "rounded-[var(--r-creux)] border-0 bg-creux px-3.5 py-2.5 text-encre",
          "bg-[repeating-linear-gradient(-45deg,color-mix(in_srgb,var(--encre-douce)_18%,transparent)_0_1px,transparent_1px_7px)]",
          "shadow-[inset_0_var(--trait)_0_0_var(--color-arete-basse),inset_0_calc(-1*var(--trait))_0_0_var(--color-arete-haute)]",
          /* Le pictogramme se cale sur la PREMIÈRE ligne, en `em` : un bandeau de page et un titre
             de carte n'ont pas le même corps, et un décalage en pixels décentrerait l'un des deux. */
          "[&>svg]:mt-[0.18em] [&>svg]:size-[1.05em] [&>svg]:translate-y-0 [&>svg]:text-ambre",
        ].join(" "),
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
