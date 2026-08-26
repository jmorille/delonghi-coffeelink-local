import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Fusion de classes utilitaires : `clsx` aplatit les conditions, `twMerge` fait gagner la
 * *dernière* classe d'un même axe. Sans elle, `className="px-4"` passé à un composant qui pose
 * déjà `px-2` produit `px-2 px-4` et c'est l'ordre de la feuille compilée qui tranche — donc un
 * résultat qui dépend du build et pas de l'appel.
 *
 * **Pourquoi ici et pas dans `src/lib/`.** `src/lib/` est le cœur pur du serveur, et plusieurs de
 * ses fichiers `.ts` sont des doublons morts à l'exécution que `server.mjs` court-circuite
 * (voir CLAUDE.md, § *Shadowed code*). Y déposer un utilitaire vivant côté client mélangerait deux
 * catégories de fichiers qu'on a justement séparées. `src/ui/` ne contient que des primitives de
 * rendu, toutes vivantes.
 */
export function cn(...entrees: ClassValue[]) {
  return twMerge(clsx(entrees));
}
