import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { cn } from "@/ui/cn";
import Icone from "./icons";

/**
 * Bandeau d'avertissement : la mise en garde du produit, en un seul objet.
 *
 * **Pourquoi ce composant existe.** Il y avait treize bandeaux `.warn` répartis sur six pages, et
 * chacun posait son propre pictogramme en tête de texte — neuf fois `⚠️` (émoji, colorié par le
 * système), quatre fois `⚠` (glyphe texte, monochrome). Deux dessins pour un seul sens, sans que
 * personne l'ait décidé, et aucun des deux ne suivait la couleur du texte ni la graisse des icônes
 * voisines. `icons.tsx` disait déjà pourquoi c'est faux — « un caractère n'est pas une icône » —
 * mais la règle ne valait que pour les boutons.
 *
 * Le pictogramme n'ajoute aucune information : le bandeau est déjà teinté et le texte dit tout.
 * Il sert à ce que l'œil trouve la mise en garde en balayant une page longue, et c'est pourquoi il
 * est `aria-hidden` — répéter « avertissement » à un lecteur d'écran devant un texte qui commence
 * par « Aucune clé LAN configurée » n'aiderait personne.
 *
 * `className` reçoit les modificateurs de rythme du site (`chapeau`, `note`) : c'est la page qui
 * sait si son bandeau introduit un bloc ou le commente.
 *
 * ── Depuis shadcn ────────────────────────────────────────────────────────────────────────────
 *
 * Le bandeau est un `Alert` en variante `garde` — le creux hachuré, décrit dans `alert.tsx`. Deux
 * choses viennent du composant et n'étaient pas là avant : `role="alert"`, qui fait annoncer la
 * mise en garde quand elle APPARAÎT (une clé LAN qui tombe, un modèle qui désaccorde), et la grille
 * à deux colonnes qui tient le pictogramme hors du flux du texte au lieu d'un `flex` maison.
 */
export default function Alerte({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Alert variant="garde" className={cn("warn", className)}>
      <Icone nom="alerte" />
      <AlertDescription className="text-encre">{children}</AlertDescription>
    </Alert>
  );
}

/**
 * La même mise en garde, mais quand c'est la CARTE qui est teintée et que le titre porte l'alerte.
 *
 * Trois endroits sont dans ce cas (`/statistiques`, les constats de `/systeme`, le désaccord de
 * modèle) : la carte entière est en `.warn`, donc un second bandeau à l'intérieur teinterait du
 * teinté. Seul le titre prend le pictogramme, aligné sur sa première ligne.
 *
 * Ce n'est PAS un `Alert` : ce n'est pas un bandeau, c'est un titre qui en porte le signe. Le
 * rendre avec le composant aurait mis un `role="alert"` sur un `<strong>`, donc fait annoncer une
 * alerte pour un mot.
 */
export function TitreAlerte({ children }: { children: ReactNode }) {
  return (
    <strong className="flex items-start gap-2 [&>svg]:mt-[0.18em] [&>svg]:flex-none [&>svg]:text-ambre">
      <Icone nom="alerte" />
      <span className="min-w-0">{children}</span>
    </strong>
  );
}
