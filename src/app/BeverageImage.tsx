"use client";
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import IMAGES from "@/lib/beverage-images.json";

/**
 * **Le dessin d'une boisson, un seul pour tout le produit.**
 *
 * Les images sont extraites de l'APK (`scripts/extract-images.mjs`) et servies depuis `public/`,
 * qui est gitignoré ET que le Dockerfile ne copie pas : ni un clone frais ni l'image publiée n'en
 * ont aucune. C'est le `repli` ci-dessous — les initiales gravées — qui rend cette absence normale
 * plutôt que visible, et le `onError` le fait aussi pour un fichier qui manque à l'exécution.
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

/**
 * **Les initiales d'une boisson, gravées à la place du dessin qui n'existe pas.**
 *
 * ⚠️ **Ce paragraphe a dit le contraire, et il avait tort.** Il affirmait que les six emplacements
 * Bean System (200-205) n'avaient aucune image et que « l'application officielle ne dessine pas de
 * tasse pour cette boisson non plus ». Les deux moitiés étaient fausses, et pour une seule raison :
 * l'extracteur s'arrêtait au `switch` de `p258z7.z.B()` sans suivre son `default`, qui résout
 * l'image par NOM de ressource puis se replie sur `R.drawable.espresso`. L'application affiche donc
 * bel et bien une tasse pour la boisson 200 — celle de l'espresso. `extract-images.mjs` reproduit
 * maintenant les deux étapes, et la table porte `repliParDefaut` pour que « 200 → espresso » ne se
 * confonde plus avec un dessin dédié. Le détail est dans l'en-tête de ce script.
 *
 * Restent donc **les recettes personnalisées** (230-239), qui ne figurent pas dans `parId` : leur
 * dessin est choisi sur la machine, pas fixe, et elles s'en sortent par leur index d'icône — sauf
 * tant qu'elles n'ont pas été nommées, auquel cas il n'y a ni nom ni index, et les initiales
 * prennent le relais.
 *
 * Le cas majoritaire est pourtant l'autre : le Dockerfile ne copie pas `public/` (les images sont
 * versionnées depuis le 2026-09-01, mais l'image publiée ne les emporte pas), donc l'installation
 * par défaut n'a **aucun** dessin. Une affiche dont l'image
 * fait le tiers de la hauteur ne peut pas y laisser un trou : ce serait vingt-huit trous.
 *
 * D'où les initiales, dans le registre gravé — le seul endroit de ce produit où les capitales
 * espacées sont vraies, puisqu'il s'agit d'un texte marqué sur de la tôle. Elles sont dérivées du
 * nom AFFICHÉ, donc déjà traduit ou déjà tapé sur la machine : aucune chaîne à ajouter au catalogue,
 * et rien d'inventé. `aria-hidden` parce que le nom complet est juste en dessous — l'annoncer deux
 * fois ferait entendre « E M Espresso macchiato ».
 */
export function monogramme(nom: string): string {
  /* Lettres ET chiffres, et le « × » n'est ni l'un ni l'autre : « Espresso ×2 » donne donc E2, là
     où ne garder que les lettres l'aurait renvoyé sur le ES d'un espresso simple. Deux touches
     voisines qui portent la même marque ne marquent rien. */
  const mots = nom.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!mots.length) return "";
  /* Un seul mot n'a qu'une initiale, et une lettre seule ne distingue pas « Café » de
     « Cappuccino » : on prend ses deux premières. Trois au plus au-delà, sinon « Cappuccino
     doppio+ inversé » rendrait une suite qu'on ne lit plus comme une marque. */
  const marque = mots.length === 1 ? mots[0].slice(0, 2) : mots.slice(0, 3).map((m) => m[0]).join("");
  return marque.toLocaleUpperCase("fr");
}

export function Monogramme({ nom }: { nom: string }) {
  const marque = monogramme(nom);
  if (!marque) return null;
  return (
    <span className="monogramme" aria-hidden="true">
      {marque}
    </span>
  );
}

export function VignetteBoisson({
  id,
  icon,
  repli = null,
}: {
  id?: number;
  icon?: number | null;
  /**
   * Ce qui s'affiche quand il n'y a pas de dessin — table sans entrée, index absent, ou fichier
   * manquant à l'exécution. Le repli est passé PAR L'APPELANT plutôt que câblé ici : la vignette
   * d'une ligne de titre et l'affiche d'une carte fermée n'ont pas la même taille, et c'est la
   * seule différence entre les deux.
   */
  repli?: ReactNode;
}) {
  const [absente, setAbsente] = useState(false);
  // La table par identifiant d'abord ; l'index d'icône ensuite, qui est le seul recours des
  // recettes perso — elles ne figurent pas dans `parId`, leur dessin étant choisi, pas fixe.
  // `id` est facultatif : le sélecteur ne montre que des index, et lui passer un identifiant
  // sentinelle pour forcer cette branche aurait été une valeur inventée de plus à maintenir.
  const fichier =
    (id === undefined ? undefined : (IMAGES.parId as Record<string, string>)[String(id)]) ??
    (icon !== null && icon !== undefined ? IMAGES_PERSO[icon] : undefined);
  if (!fichier || absente) return <>{repli}</>;
  return (
    // `<img>` et non `next/image` : le fichier est statique, de taille connue, servi depuis
    // `public/` — l'optimiseur n'aurait rien à optimiser, et il refuse de servir ce qui manque,
    // ce qui remplacerait le repli silencieux ci-dessous par une erreur de rendu.
    //
    // **`?v=` n'est pas un ornement.** Ces vingt et une vignettes ne figurent pas dans le HTML
    // servi : la liste des boissons arrive par `/api/beverages`, donc les `<img>` sont créées
    // après hydratation, toutes ensemble. Sans empreinte, `public/` est servi en
    // `Cache-Control: max-age=0` et cette rafale repartait en vingt et une requêtes
    // conditionnelles À CHAQUE navigation — mesuré : quatre vagues d'aller-retour, le serveur
    // étant en HTTP/1.1 (six connexions par origine). Avec l'empreinte, l'URL ne change que
    // quand le dessin change, et `next.config.mjs` peut répondre `immutable` sans mentir.
    <img
      className="bevVignette"
      src={`${IMAGES.chemin}/${fichier}.webp?v=${IMAGES.version}`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onError={() => setAbsente(true)}
    />
  );
}
