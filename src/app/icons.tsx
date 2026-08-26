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

/**
 * Le contrat visuel commun : cadre, trait, jointures. Rien d'autre ne doit le redéfinir.
 *
 * **Les extrémités sont carrées et les jointures à angle vif.** Ce n'est pas un détail de goût :
 * un pictogramme de façade est *gravé* ou sérigraphié, donc il n'a pas de bouts arrondis — ceux-ci
 * appartiennent au trait écrit à la main, qui est la grammaire de toutes les bibliothèques
 * d'icônes courantes. Passer de `round` à `square`/`miter` et de 1,6 à 1,75 est ce qui range ce
 * jeu du côté de l'appareil plutôt que du côté de l'interface générique — et comme tout le monde
 * passe par ici, la bascule est d'une ligne.
 */
export function traitCommun(taille = 17): SVGProps<SVGSVGElement> {
  return {
    width: taille,
    height: taille,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "square",
    strokeLinejoin: "miter",
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
  | "machine"
  | "oeil"
  | "oeilBarre"
  | "cle"
  | "corbeille"
  | "ajouter"
  | "nuage"
  | "etoile"
  | "annonce"
  | "marche"
  | "choisir"
  | "modifier"
  | "reglages";

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
  /* **Enregistrer : la disquette.** Le commentaire disait « écrire dans le profil » ; l'usage dit
     autre chose depuis longtemps — renommer une machine, enregistrer une adresse, enregistrer une
     recette en local. C'est le geste « garder ça », et il est local. L'écriture qui part vers
     l'appareil a désormais son propre glyphe (`machine`, plus bas) : sur /recipes les deux boutons
     sont côte à côte, et « enregistrer ici » ne doit pas porter le même dessin que « envoyer
     là-bas ».
     Volontairement PAS une flèche — « lire » en est déjà une, et deux flèches opposées dans la
     même rangée se confondent au premier coup d'œil. */
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
  /* La machine : le corps et la buse. En-tête du panneau de navigation replié — et, sur /recipes,
     le glyphe de « écrire dans le profil ». Nommer la DESTINATION est ce qui distingue ce bouton de
     son voisin « enregistrer localement » ; une flèche montante aurait été le miroir exact de
     `lire`, qui est dans la même rangée, donc le seul choix à ne pas faire. */
  machine: (
    <>
      <path d="M4.5 4.8h15v5.4a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3V4.8Z" />
      <path d="M12 13.2v3.4" />
      <path d="M7.5 20h9" />
    </>
  ),
  /* L'œil, pour la bascule qui montre le mot de passe. Elle vit DANS le champ (voir `.champMdp`
     dans globals.css) : c'est la seule position où elle ne peut pas se détacher de lui, et où
     elle ne coûte aucune largeur à une rangée qui en manque déjà. */
  oeil: (
    <>
      <path d="M2.8 12c2.4-3.9 5.5-5.8 9.2-5.8s6.8 1.9 9.2 5.8c-2.4 3.9-5.5 5.8-9.2 5.8S5.2 15.9 2.8 12Z" />
      <circle cx="12" cy="12" r="2.7" />
    </>
  ),
  /* Barré, et sans pupille : à 17 px, garder le rond sous la barre donnait une tache. La barre
     seule suffit à dire « caché », et c'est le geste attendu à cet endroit. */
  oeilBarre: (
    <>
      <path d="M2.8 12c2.4-3.9 5.5-5.8 9.2-5.8s6.8 1.9 9.2 5.8c-2.4 3.9-5.5 5.8-9.2 5.8S5.2 15.9 2.8 12Z" />
      <path d="M4.6 4.6l14.8 14.8" />
    </>
  ),
  /* La clé LAN : le seul objet du produit qui vienne du compte et non de la machine.
     **Couchée, et non en diagonale.** Dessinée d'abord de biais avec un anneau de 3,4 et deux
     dents de 2,2, elle rendait à 17 px une éraflure surmontée d'un point — relevé sur la page. À
     cette taille il faut peu d'éléments et grands : un anneau de 4,2, une tige horizontale, deux
     dents franches. */
  cle: (
    <>
      <circle cx="7.4" cy="12" r="4.2" />
      <path d="M11.6 12H21" />
      <path d="M17.4 12v3.6" />
      <path d="M20.2 12v2.6" />
    </>
  ),
  /* La corbeille sert aux QUATRE effacements de la page — la machine entière, l'adresse mémorisée,
     la clé mémorisée, la session cloud. Un dessin par nuance aurait inventé des distinctions que
     l'action ne fait pas : c'est la même chose, une valeur enregistrée qui part. La couleur et le
     libellé disent laquelle et à quel point c'est grave. */
  corbeille: (
    <>
      <path d="M4.8 7.2h14.4" />
      <path d="M9.6 7.2V5.4a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v1.8" />
      <path d="M6.6 7.2l.9 12a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l.9-12" />
    </>
  ),
  ajouter: <path d="M12 5.2v13.6M5.2 12h13.6" />,
  /* Le nuage marque la SEULE action de tout le produit qui quitte le réseau local. C'est un
     contrôleur local d'abord : ce glyphe est un avertissement autant qu'une étiquette, et il ne
     doit apparaître nulle part ailleurs. */
  nuage: <path d="M6.9 18.2a3.7 3.7 0 0 1 .5-7.4 5.2 5.2 0 0 1 9.9 1.2 3.1 3.1 0 0 1 .3 6.2H6.9Z" />,
  // L'étoile : la machine visée quand aucune n'est nommée.
  etoile: (
    <path d="M12 4.4l2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.4l-4.7 2.46.9-5.23-3.8-3.7 5.25-.77L12 4.4Z" />
  ),
  /* **Annoncer : l'émission.** Les rôles HTTP de ce produit sont inversés — la machine est le
     client, et la seule requête que nous initiions est de dire où nous sommes pour qu'elle vienne.
     Un signal qui part d'un point est exactement ce geste.

     **Dessiné d'abord symétrique — un point au centre, un arc de chaque côté — et vu à l'écran :
     ça rendait « (•) ».** Les deux arcs, hauts de dix pixels et collés au point, se lisaient comme
     une paire de parenthèses ; le glyphe passait pour de la ponctuation au milieu d'un libellé.
     C'est exactement l'erreur déjà faite sur la clé, et la même leçon : à 17 px il faut peu
     d'éléments et grands. L'émission part donc d'un coin, et les deux arcs traversent le cadre au
     lieu d'encadrer le point — la forme du signal, asymétrique, donc impossible à confondre avec
     un signe de texte. */
  annonce: (
    <>
      <circle cx="6" cy="18" r="2.1" fill="currentColor" stroke="none" />
      <path d="M6 12.2a5.8 5.8 0 0 1 5.8 5.8" />
      <path d="M6 6.4a11.6 11.6 0 0 1 11.6 11.6" />
    </>
  ),
  /* **La marche : le symbole d'alimentation, et le MÊME sur les deux boutons.** « Allumer » et
     « Éteindre » sont un seul interrupteur rendu en deux commandes : le dessin nomme l'objet
     (l'alimentation), la couleur de rôle et le libellé disent le sens. Deux glyphes inventés pour
     les distinguer auraient été deux variantes du même cercle, illisibles l'une de l'autre à 17 px
     — le piège déjà rencontré avec les deux flèches de retour de l'éditeur. Ici rien ne se replie :
     les deux libellés restent visibles côte à côte, donc le sens ne dépend jamais de l'icône seule.
     Géométrie de l'arc reprise du symbole normalisé : ouverture au sommet, rayon 8, tige centrée. */
  marche: (
    <>
      <path d="M17.66 6.34a8 8 0 1 1-11.32 0" />
      <path d="M12 3.2v8.4" />
    </>
  ),
  /* **Choisir : la coche.** Activer un profil, c'est le désigner comme celui qui vaut — le rôle que
     l'ambre porte partout ailleurs dans la palette. Un seul tracé, franc, qui traverse le cadre :
     c'est ce qui le rend lisible à côté de cinq voisins identiques dans une grille de profils. */
  choisir: <path d="M4.8 12.4l4.6 4.6L19.2 7.2" />,
  /* **Reglages : deux glissieres.** Bean Adapt prend un questionnaire et en deduit une mouture, une
     temperature et un arome — c'est litteralement un reglage calcule, et la regle est reimplementee
     ici plutot qu'appelee chez De'Longhi. Rien d'autre dans le jeu ne dit ca : le rembobinage revient
     a une valeur connue, la coche en retient une, la disquette la garde. Quatre elements, larges,
     et les deux poignees decalees pour que la forme se lise a 17 px. */
  reglages: (
    <>
      <path d="M4.4 7.6h15.2" />
      <path d="M4.4 16.4h15.2" />
      <circle cx="9.2" cy="7.6" r="2.5" />
      <circle cx="15.2" cy="16.4" r="2.5" />
    </>
  ),
  /* **Modifier : le crayon.** Distinct de la disquette parce que les deux vivent sur la même page :
     reprendre une recette enregistrée pour la retoucher n'est pas l'enregistrer. Deux éléments —
     le corps fermé et le trait de virole — plutôt qu'un empilement de petits segments. */
  modifier: (
    <>
      <path d="M4.4 19.6l1.1-4.2L16.2 4.7a1.6 1.6 0 0 1 2.2 0l1 1a1.6 1.6 0 0 1 0 2.2L8.6 18.5l-4.2 1.1Z" />
      <path d="M14.8 6.1l3.2 3.2" />
    </>
  ),
};

export default function Icone({ nom, taille }: { nom: NomIcone; taille?: number }) {
  return <svg {...traitCommun(taille)}>{TRACES[nom]}</svg>;
}
