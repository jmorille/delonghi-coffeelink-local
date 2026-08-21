/**
 * Jeu d'icônes de l'interface.
 *
 * **Pourquoi ce fichier existe.** PRODUCT.md demande des *boutons à icônes SVG plutôt que des
 * boutons à texte long* : l'action doit se lire à l'icône, parce que la surface de pilotage est une
 * tablette murale qu'on regarde de loin et un téléphone tenu à une main devant la machine. Jusqu'ici
 * les seules « icônes » du produit étaient des caractères Unicode empruntés au texte — `↺`, `⟲`,
 * `ⓘ`, `⚠️`. Un caractère n'est pas une icône : son dessin change avec la police et la plateforme
 * (l'émoji est même colorié par le système), sa graisse n'a aucun rapport avec celle des voisines,
 * et il ne suit pas `currentColor`. Les glyphes ci-dessous sont dessinés, tous dans le même cadre
 * de 24, au même trait de 1,6, et prennent la couleur du texte.
 *
 * **Toutes partagent `traitCommun`**, y compris celles du sélecteur de thème : c'est la seule façon
 * de garantir qu'une rangée d'icônes ait un trait homogène. Ajouter un glyphe ailleurs sans passer
 * par là se verra immédiatement.
 *
 * **Une icône ne nomme rien.** Chaque bouton garde donc un nom accessible (`aria-label`, depuis le
 * catalogue) et, quand la place le permet, son libellé visible — voir `.iconBtn` dans
 * `globals.css`, où c'est une *container query* sur la carte, pas la largeur de la fenêtre, qui
 * décide de replier le texte. `aria-hidden` sur le SVG : sans lui, le lecteur d'écran annoncerait
 * le graphique en plus du libellé.
 */
import type { SVGProps } from "react";

/** Le contrat visuel commun : cadre, trait, jointures. Rien d'autre ne doit le redéfinir. */
export function traitCommun(taille = 17): SVGProps<SVGSVGElement> {
  return {
    width: taille,
    height: taille,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
  };
}

export type NomIcone =
  | "menu"
  | "fermer"
  | "chevron"
  | "lire"
  | "preparer"
  | "tasse"
  | "arreter"
  | "ecrire"
  | "reinitialiser"
  | "defauts"
  | "info"
  | "alerte"
  | "machine";

/** La tasse, dessinée une fois : c'est l'objet du produit et la marque, et c'est aussi l'action. */
const TASSE = (
  <>
    <path d="M6.2 7.8h9.6v4.4a4.8 4.8 0 0 1-4.8 4.8h0a4.8 4.8 0 0 1-4.8-4.8V7.8Z" />
    <path d="M15.8 9.4h1.6a2.1 2.1 0 0 1 0 4.2h-1.6" />
    <path d="M4.4 20h13.2" />
  </>
);

/** Le tracé de chaque glyphe, dans le cadre 24×24. */
const TRACES: Record<NomIcone, React.ReactNode> = {
  // Trois barres. La plus courte en bas : le triangle implicite pointe vers le contenu.
  menu: <path d="M4 7h16M4 12h16M4 17h11" />,
  fermer: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  // Chevron vers le bas, pivoté par CSS quand le panneau est ouvert (une seule forme, deux états).
  chevron: <path d="M6 9.5l6 6 6-6" />,
  // Lire : la valeur descend de la machine vers nous, et atterrit sur une tablette.
  lire: (
    <>
      <path d="M12 3.5v9.5" />
      <path d="M8 9.5l4 4 4-4" />
      <path d="M4.5 17.5v1.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
    </>
  ),
  // Préparer : la tasse. C'est un produit de café — l'action principale a le droit à son objet.
  preparer: TASSE,
  // La marque, dans la barre. Même dessin : la tasse est l'objet du produit avant d'être un verbe.
  tasse: TASSE,
  // Arrêter : le carré plein du transport. Rien d'autre ne dit « ça s'arrête maintenant ».
  arreter: <rect x="7" y="7" width="10" height="10" rx="2.2" />,
  // Écrire dans le profil : la disquette. Volontairement PAS une flèche — « lire » en est déjà
  // une, et deux flèches opposées dans la même rangée se confondent au premier coup d'œil.
  ecrire: (
    <>
      <path d="M5.5 6.5a1 1 0 0 1 1-1h8l4 4v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-12Z" />
      <path d="M9 5.5v4h5.5" />
      <path d="M8.5 14.5h7v5h-7z" />
    </>
  ),
  // Réinitialiser : revenir à ce que le profil a enregistré. Un tour en arrière, pas un rembobinage.
  reinitialiser: (
    <>
      <path d="M4.6 12a7.4 7.4 0 1 0 7.4-7.4H6.8" />
      <path d="M9.6 1.9 6.5 4.6l3.1 2.7" />
    </>
  ),
  // Valeurs par défaut du modèle : le rembobinage, deux crans plus loin en arrière que ci-dessus.
  defauts: (
    <>
      <path d="M11.5 6.5 6 12l5.5 5.5" />
      <path d="M18.5 6.5 13 12l5.5 5.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.6" />
      <circle cx="12" cy="7.7" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  /* Le triangle, et non le rond de `info` : c'est la seule paire de l'interface où deux messages
     voisins doivent se distinguer au dessin et pas seulement à la couleur. Il remplace treize
     `⚠️` — dont quatre écrits sans le sélecteur de variante, donc rendus en glyphe noir et blanc
     là où les neuf autres sortaient en émoji colorié par le système. Personne n'avait choisi cette
     différence, et aucune des deux formes ne suivait `currentColor` ni la graisse des voisines. */
  alerte: (
    <>
      <path d="M12 3.9 21.6 20.1H2.4L12 3.9Z" />
      <path d="M12 9.6v4.9" />
      <circle cx="12" cy="17.3" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // La machine : le corps et la buse. Sert d'en-tête au panneau de navigation replié.
  machine: (
    <>
      <path d="M4.5 4.8h15v5.4a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3V4.8Z" />
      <path d="M12 13.2v3.4" />
      <path d="M7.5 20h9" />
    </>
  ),
};

export default function Icone({ nom, taille }: { nom: NomIcone; taille?: number }) {
  return <svg {...traitCommun(taille)}>{TRACES[nom]}</svg>;
}
