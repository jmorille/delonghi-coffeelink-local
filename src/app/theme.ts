/**
 * Choix du thème, côté navigateur.
 *
 * PRODUCT.md pose le clair et le sombre au même rang : ce n'est pas une préférence secondaire, la
 * tablette qui pilote les boissons vit dans une cuisine, donc en plein soleil le matin et en
 * lumière basse le soir. Jusqu'ici l'interface **subissait** le réglage du système : aucun moyen de
 * demander le sombre sur un OS en clair, alors que c'est précisément ce qu'on veut le soir sur une
 * tablette posée au mur.
 *
 * Trois états et non deux. « Auto » n'est pas le vide : c'est un choix — suivre le système, qui
 * bascule tout seul selon l'heure sur la plupart des appareils — et il doit rester sélectionnable
 * une fois qu'on l'a quitté. Il est donc stocké comme les autres, par son absence de clé.
 *
 * Même mécanique que `machine.ts` (`localStorage` + événement) et pour la même raison : c'est une
 * préférence de CE navigateur. Un réglage global aurait fait basculer la tablette du mur pendant
 * que quelqu'un choisissait sur son téléphone.
 *
 * **Ce que ce module ne fait pas : appliquer le thème au premier rendu.** C'est le script en ligne
 * de `layout.tsx` qui s'en charge, avant la première peinture. Attendre un effet React aurait
 * produit un flash de thème clair sur chaque chargement en sombre — exactement le défaut que ce
 * réglage est censé supprimer.
 */
import { useCallback, useEffect, useState } from "react";

/** Doit rester identique à la clé lue par le script en ligne de `layout.tsx`. */
export const CLE_THEME = "delonghi.theme";

export type Theme = "auto" | "light" | "dark";

/** Émis quand le thème change, pour que les autres composants montés suivent. */
export const THEME_EVENT = "theme-changed";

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(CLE_THEME);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    // Rendu serveur, ou stockage refusé : on suit le système, qui est le défaut.
    return "auto";
  }
}

export function setTheme(t: Theme) {
  try {
    if (t === "auto") localStorage.removeItem(CLE_THEME);
    else localStorage.setItem(CLE_THEME, t);
  } catch {
    /* sans mémoire locale le choix ne survit pas à la navigation, mais il agit sur cette page */
  }
  // L'attribut est la seule chose que le CSS regarde ; en « auto » il doit DISPARAÎTRE, sinon la
  // media query `:not([data-theme="dark"])` continuerait de voir un choix explicite.
  const el = document.documentElement;
  if (t === "auto") delete el.dataset.theme;
  else el.dataset.theme = t;
  window.dispatchEvent(new Event(THEME_EVENT));
}

/**
 * Lecture réactive du thème choisi.
 *
 * L'état de départ est **toujours** `"auto"`, jamais la valeur stockée : la lire pendant le rendu
 * donnerait un premier rendu client différent du rendu serveur et React refuserait l'hydratation.
 * Ce décalage ne se voit pas — les couleurs de la page sont déjà justes, posées par le script en
 * ligne ; seule la puce mise en évidence dans le sélecteur se corrige une image plus tard.
 */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setLocal] = useState<Theme>("auto");

  useEffect(() => {
    const lire = () => setLocal(readTheme());
    lire();
    window.addEventListener(THEME_EVENT, lire);
    // Un autre onglet a choisi : `storage` ne se déclenche que sur les AUTRES onglets. Il faut
    // alors réappliquer l'attribut ici aussi — l'événement local, lui, ne traverse pas les onglets.
    const autreOnglet = () => {
      const t = readTheme();
      const el = document.documentElement;
      if (t === "auto") delete el.dataset.theme;
      else el.dataset.theme = t;
      setLocal(t);
    };
    window.addEventListener("storage", autreOnglet);
    return () => {
      window.removeEventListener(THEME_EVENT, lire);
      window.removeEventListener("storage", autreOnglet);
    };
  }, []);

  const changer = useCallback((t: Theme) => setTheme(t), []);
  return [theme, changer];
}
