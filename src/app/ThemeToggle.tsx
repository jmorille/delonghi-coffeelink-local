"use client";
import { useTranslations } from "next-intl";
import { RadioGroup, RadioGroupCran } from "@/ui/radio-group";
import { Theme, useTheme } from "./theme";

/**
 * Sélecteur de thème : trois positions dans la barre.
 *
 * **Un groupe de radios, pas trois boutons.** Le choix est exclusif, et `role="radiogroup"` écrit
 * à la main aurait demandé de recoder la navigation aux flèches, le groupement et le nom
 * accessible. Les `<input type="radio">` natifs les donnaient et c'est pour ça qu'ils étaient là ;
 * `RadioGroup` de Radix les donne aussi, sans la case masquée sous une étiquette — un montage qui
 * n'était plus le geste du reste du produit, et dont la cible tactile tenait à un `inset-0`.
 *
 * **Des icônes dessinées.** Pas ☀️/🌙 : un emoji change de dessin selon la plateforme, ne suit pas
 * la couleur du texte et n'a pas de graisse de trait commune avec le reste. Les trois glyphes
 * partagent le même cadre 24, le même trait de 1,6 et `currentColor`.
 *
 * L'icône seule ne nomme rien : chaque position porte son libellé dans le nom accessible et dans
 * l'infobulle, et le groupe entier est nommé par sa légende.
 */
const TAILLE = 17;

function Icone({ pour }: { pour: Theme }) {
  /* Le trait est celui de tout le jeu — voir `traitCommun` dans `icons.tsx`, dont ces trois
     glyphes reprennent la grammaire gravée : extrémités carrées, jointures à angle vif. Une
     rangée d'icônes dont une seule a des bouts arrondis se voit immédiatement. */
  const commun = {
    width: TAILLE,
    height: TAILLE,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "square" as const,
    strokeLinejoin: "miter" as const,
    "aria-hidden": true,
    focusable: false as const,
  };
  if (pour === "light") {
    return (
      <svg {...commun}>
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.8v2.2M12 19v2.2M4.5 12H2.3M21.7 12h-2.2M6.7 6.7 5.1 5.1M18.9 18.9l-1.6-1.6M17.3 6.7l1.6-1.6M5.1 18.9l1.6-1.6" />
      </svg>
    );
  }
  if (pour === "dark") {
    return (
      <svg {...commun}>
        {/* Croissant obtenu par un seul contour, pour garder le même trait que les deux autres
            plutôt qu'un aplat qui trancherait dans une rangée d'icônes filaires. */}
        <path d="M20.2 14.9A8.6 8.6 0 0 1 9.1 3.8a8.6 8.6 0 1 0 11.1 11.1Z" />
      </svg>
    );
  }
  // « Auto » : le disque mi-plein, glyphe usuel du contraste — il dit « les deux, selon le
  // système » sans avoir à superposer un soleil et une lune dans 17 pixels.
  return (
    <svg {...commun}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 3.4v17.2A8.6 8.6 0 0 0 12 3.4Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

const POSITIONS: Theme[] = ["auto", "light", "dark"];

export default function ThemeToggle() {
  const t = useTranslations("theme");
  const [theme, setTheme] = useTheme();

  /**
   * **Trois positions fraisées dans le rail.** Le groupe est un creux du boîtier, et la position
   * engagée est une touche en relief — le même geste mécanique que partout ailleurs. Pas de lampe
   * ambre ici : l'ambre dit « choisi » à propos de la MACHINE (profil actif, page courante), et
   * l'étendre à une préférence d'affichage du navigateur diluerait la seule chose qui rend cette
   * couleur lisible d'un coup d'œil.
   */
  return (
    <RadioGroup
      className="creuset flex flex-none flex-row items-center gap-0.5 p-0.5"
      aria-label={t("groupLabel")}
      value={theme}
      onValueChange={(v) => setTheme(v as Theme)}
    >
      {POSITIONS.map((v) => (
        <RadioGroupCran
          key={v}
          value={v}
          title={t(v)}
          /* 32 px à la souris — ce groupe est déjà le seul objet plein de la barre, et le
             grossir partout le ferait peser plus que la navigation. 44 px au doigt, où il
             n'existe qu'en dessous du seuil du rail, donc uniquement sur téléphone et
             tablette. C'est l'arbitrage que ce fichier avait déjà rendu une fois, et que la
             bascule vers les utilitaires avait défait sans le dire. */
          className="size-8 tactile:size-11"
        >
          <Icone pour={v} />
          {/* Le nom accessible du choix : l'icône est décorative, ce texte est ce qui est annoncé. */}
          <span className="sr-only">{t(v)}</span>
        </RadioGroupCran>
      ))}
    </RadioGroup>
  );
}
