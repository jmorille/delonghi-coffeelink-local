import type { ReactNode } from "react";
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
 */
export default function Alerte({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={"warn alerte" + (className ? " " + className : "")}>
      <Icone nom="alerte" />
      <div>{children}</div>
    </div>
  );
}

/**
 * La même mise en garde, mais quand c'est la CARTE qui est teintée et que le titre porte l'alerte.
 *
 * Trois endroits sont dans ce cas (`/statistiques`, les constats de `/systeme`, le désaccord de
 * modèle) : la carte entière est en `.warn`, donc un second bandeau à l'intérieur teinterait du
 * teinté. Seul le titre prend le pictogramme, aligné sur sa première ligne.
 */
export function TitreAlerte({ children }: { children: ReactNode }) {
  return (
    <strong className="alerte">
      <Icone nom="alerte" />
      <span>{children}</span>
    </strong>
  );
}
