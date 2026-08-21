"use client";
import { useTranslations } from "next-intl";
import { Theme, useTheme } from "./theme";

/**
 * Sélecteur de thème : trois positions dans la barre.
 *
 * **Des radios natives, pas trois boutons.** Le choix est exclusif, et `role="radiogroup"` à la
 * main aurait demandé de recoder la navigation aux flèches, le groupement et le nom accessible —
 * trois choses que `<input type="radio">` fait déjà correctement. Les entrées sont masquées
 * visuellement (jamais `display: none`, qui les retirerait de l'ordre de tabulation) et c'est le
 * `<label>` qui porte l'icône.
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
  const commun = {
    width: TAILLE,
    height: TAILLE,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
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

  return (
    <span className="themes" role="group" aria-label={t("groupLabel")}>
      {POSITIONS.map((v) => (
        <label key={v} className={"theme" + (theme === v ? " actif" : "")} title={t(v)}>
          <input
            type="radio"
            name="theme"
            value={v}
            checked={theme === v}
            onChange={() => setTheme(v)}
          />
          <Icone pour={v} />
          {/* Le nom accessible du choix : l'icône est décorative, ce texte est ce qui est annoncé. */}
          <span className="horsEcran">{t(v)}</span>
        </label>
      ))}
    </span>
  );
}
