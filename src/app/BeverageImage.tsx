"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import IMAGES from "@/lib/beverage-images.json";

/**
 * **Le dessin d'une boisson, un seul pour tout le produit.**
 *
 * Les images sont extraites de l'APK (`scripts/extract-images.mjs`) et servies depuis `public/`,
 * qui est gitignoré : un clone frais n'en a aucune. C'est le `onError` ci-dessous qui rend cette
 * absence normale plutôt que visible.
 *
 * Ce module existe parce que `/recipes` montre les mêmes dessins pour les mêmes boissons. Deux
 * tables d'images, c'est deux fois la même correspondance identifiant → fichier à tenir d'accord.
 */

export const IMAGES_PERSO: string[] = IMAGES.choixRecettePerso;

/**
 * Le nom d'une image, dans son espace de noms à elle.
 *
 * Les clés sont les noms de ressources de l'app, qui ne sont **pas** nos slugs de catalogue
 * (`due_x_espresso_coffee` d'un côté, `2x_espresso` de l'autre) : les servir depuis `beverage`
 * mêlerait deux référentiels d'identifiants dans un seul espace. Repli sur la clé brute, même
 * règle que `useCategoryLabel` — une image inconnue s'affiche, elle ne fait pas tomber la carte.
 */
export function useImageLabel() {
  const t = useTranslations("beverageImage");
  return (fichier: string) => (t.has(fichier) ? t(fichier) : fichier);
}

export function VignetteBoisson({ id, icon }: { id?: number; icon?: number | null }) {
  const [absente, setAbsente] = useState(false);
  // La table par identifiant d'abord ; l'index d'icône ensuite, qui est le seul recours des
  // recettes perso — elles ne figurent pas dans `parId`, leur dessin étant choisi, pas fixe.
  // `id` est facultatif : le sélecteur ne montre que des index, et lui passer un identifiant
  // sentinelle pour forcer cette branche aurait été une valeur inventée de plus à maintenir.
  const fichier =
    (id === undefined ? undefined : (IMAGES.parId as Record<string, string>)[String(id)]) ??
    (icon !== null && icon !== undefined ? IMAGES_PERSO[icon] : undefined);
  if (!fichier || absente) return null;
  return (
    // `<img>` et non `next/image` : le fichier est statique, de taille connue, servi depuis
    // `public/` — l'optimiseur n'aurait rien à optimiser, et il refuse de servir ce qui manque,
    // ce qui remplacerait le repli silencieux ci-dessous par une erreur de rendu.
    <img
      className="bevVignette"
      src={`${IMAGES.chemin}/${fichier}.webp`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onError={() => setAbsente(true)}
    />
  );
}
