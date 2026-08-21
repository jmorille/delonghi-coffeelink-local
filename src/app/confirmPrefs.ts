/**
 * Faut-il demander confirmation avant ce geste ? Réglage, côté navigateur.
 *
 * **Pourquoi ce réglage existe.** Deux gestes de ce produit se répètent plusieurs fois par jour et
 * se font debout devant la machine, la tasse déjà posée : allumer, et préparer une boisson.
 * Confirmer un espresso qu'on vient de demander à 30 cm de la buse n'apprend rien à celui qui
 * appuie — il voit l'appareil. La confirmation reste le défaut, mais elle devient renonçable pour
 * ces deux gestes-là, et pour eux seuls.
 *
 * **Ce que le réglage ne touche pas, et ne doit jamais toucher.** Écrire une recette dans un profil,
 * remplacer un réglage de grain, supprimer, réinitialiser une machine : ce sont des modifications
 * persistantes de l'appareil ou des pertes de données, faites une fois, jamais dans l'urgence.
 * Elles n'ont pas de `Geste` et ne peuvent donc pas être désactivées — voir `confirm.tsx`, où
 * l'absence de `geste` suffit à garder le dialogue.
 *
 * **Par navigateur, comme le thème et la machine sélectionnée.** Un réglage global aurait désarmé
 * le téléphone qu'on tend à quelqu'un parce que la tablette du mur, elle, n'a pas besoin d'être
 * questionnée. Ce sont deux situations différentes sur la même cafetière.
 *
 * **Le défaut est du côté sûr, et l'absence de valeur vaut « demander ».** Seule une valeur
 * explicitement stockée affaiblit la garde. Un stockage refusé, un nouveau navigateur, une clé
 * illisible : tous ces cas retombent sur la confirmation, jamais sur le contraire.
 */
import { useCallback, useEffect, useState } from "react";

/**
 * Les gestes dont la confirmation est renonçable. C'est une liste fermée, et c'est le point : un
 * geste absent d'ici ne peut pas perdre son dialogue, même par oubli d'un appel.
 */
export type Geste = "power" | "dispense";

export const GESTES: Geste[] = ["power", "dispense"];

/** Une clé par geste : pas de JSON à analyser, donc pas de cas « valeur illisible » à trancher. */
const cle = (g: Geste) => "delonghi.confirm." + g;

/** Émis quand un réglage change, pour que les autres composants montés suivent. */
export const CONFIRM_EVENT = "confirm-prefs-changed";

/**
 * Lu au moment du geste, pas au rendu : un onglet qui vient de changer le réglage agit dès le clic
 * suivant, sans que rien n'ait à s'abonner.
 */
export function confirmRequis(g: Geste): boolean {
  try {
    return localStorage.getItem(cle(g)) !== "off";
  } catch {
    return true;
  }
}

export function setConfirmRequis(g: Geste, requis: boolean) {
  try {
    if (requis) localStorage.removeItem(cle(g));
    else localStorage.setItem(cle(g), "off");
  } catch {
    /* sans mémoire locale le choix ne survit pas à la navigation ; il agit sur cette page */
  }
  window.dispatchEvent(new Event(CONFIRM_EVENT));
}

/**
 * Lecture réactive, pour l'écran de réglage.
 *
 * L'état de départ est **toujours** « on demande » — jamais la valeur stockée. La lire pendant le
 * rendu donnerait un premier rendu client différent du rendu serveur et React refuserait
 * l'hydratation ; même raisonnement que `useTheme`. Le décalage ne dure qu'une image et va du côté
 * sûr.
 */
export function useConfirmPrefs(): [Record<Geste, boolean>, (g: Geste, requis: boolean) => void] {
  const [prefs, setPrefs] = useState<Record<Geste, boolean>>({ power: true, dispense: true });

  useEffect(() => {
    const lire = () =>
      setPrefs({ power: confirmRequis("power"), dispense: confirmRequis("dispense") });
    lire();
    window.addEventListener(CONFIRM_EVENT, lire);
    // `storage` ne se déclenche que sur les AUTRES onglets ; l'événement local ne les traverse pas.
    // Il faut les deux pour que deux onglets ouverts sur la même tablette restent d'accord.
    window.addEventListener("storage", lire);
    return () => {
      window.removeEventListener(CONFIRM_EVENT, lire);
      window.removeEventListener("storage", lire);
    };
  }, []);

  const changer = useCallback((g: Geste, requis: boolean) => setConfirmRequis(g, requis), []);
  return [prefs, changer];
}
