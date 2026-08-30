"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import Icone from "./icons";
import { AfficheGrain } from "./VignetteGrains";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE D'UN GRAIN — UNE AFFICHE QUI SE RETOURNE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `/beans` montrait deux grilles de fiches : nom, trois chiffres, cinq boutons, et une vignette de
 * 44 px coincée dans la ligne de titre. Une fiche décrit ; or ce qu'on cherche sur cette page, c'est
 * **quel paquet est dans la machine** — une chose qu'on reconnaît à son emballage avant de la lire.
 * La face avant devient donc une affiche : le visuel à la largeur entière de la carte, le nom, les
 * marques, et **une seule commande**. Tout le reste — les trois réglages, les lectures, le visuel,
 * l'écriture — passe au DOS.
 *
 * ## Pourquoi une rotation, et pas un tiroir
 *
 * Un tiroir qui se déplie sous la carte dit « il y a plus à lire ici ». Ce n'est pas le rapport
 * entre ces deux faces : elles ne s'additionnent pas, elles **s'excluent** — l'affiche est ce que
 * la carte EST, le dos est ce qu'on lui FAIT. Un demi-tour dit exactement ça, et il le dit sans
 * ajouter un objet à l'écran : c'est la même carte, à la même place, dans la même grille.
 *
 * ⚠️ **La carte tourne ET change de hauteur.** Le dos fait deux à trois fois l'affiche : sans
 * l'animation de hauteur, la grille sauterait d'un coup au milieu de la rotation. La hauteur est
 * donc **mesurée** sur la face visible (`ResizeObserver` sur les deux faces) et posée en pixels sur
 * le plateau. Pas `height: auto` : une transition n'a rien à interpoler entre deux `auto`, et
 * `interpolate-size` n'est pas encore partout.
 *
 * ⚠️ **Le dos n'est monté qu'après la première ouverture.** Trois raisons, dans l'ordre où elles
 * comptent : six cartes × un recadreur d'image + quatre curseurs, c'est un coût qu'une page qui
 * s'ouvre n'a aucune raison de payer ; une carte fermée n'a alors *aucun* piège de tabulation, même
 * si `inert` venait à manquer ; et le décalage d'une image entre « la rotation part » et « le dos
 * existe » est précisément ce qui rend la transition de hauteur possible (pixels → pixels, jamais
 * `auto` → pixels).
 *
 * ⚠️ **Deux faces dans le DOM, c'est deux fois les tabulations — sauf mesure explicite.** La face
 * qui n'est pas devant est `inert` **et** `aria-hidden` : sans le premier, le clavier traverse une
 * face invisible ; sans le second, un lecteur d'écran lit la carte deux fois. `backface-visibility`
 * ne cache qu'à l'œil, et c'est exactement le genre de défaut qu'aucun outil de compilation ne voit
 * — `scripts/verif-surfaces.mjs` le vérifie dans un vrai navigateur.
 *
 * **Le dos s'ouvre sur la MÊME photo, au même endroit.** Le formulaire commence par le cadre de
 * l'affiche, devenu cliquable (`PhotoGrains`, qui monte le même `AfficheGrain`) : la rotation ne
 * déplace donc pas l'image, elle la rend modifiable. C'est ce qui a fait tomber la ligne de titre du
 * dos — elle servait à rattacher le formulaire à sa carte, et l'image le fait mieux qu'un nom répété
 * une troisième fois.
 *
 * **Le déclencheur est un bouton dédié, pas la carte entière.** Une carte cliquable de bout en bout
 * avale le clic destiné à « Activer », et n'a pas de nom accessible. Il porte `aria-expanded` et
 * `aria-controls` vers le dos, et il existe sur les deux faces — on referme là où on est.
 */

/* `useLayoutEffect` avertit au rendu serveur, où il ne peut rien mesurer. Le plateau y sort sans
   hauteur imposée, donc à la hauteur naturelle de sa seule face montée : exactement la valeur que
   la mesure trouvera au premier rendu client. */
const useMesureAvantPeinture = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function CarteGrain({
  titre,
  repere,
  photo = null,
  roast = null,
  marques = null,
  commande = null,
  dos,
  ouvert,
  onBasculer,
  idDos,
}: {
  titre: string;
  /** Ce qui se lit à droite du nom : le numéro d'emplacement, ou la date d'une fiche mémorisée. */
  repere?: ReactNode;
  photo?: string | null;
  roast?: number | null;
  /** La rangée de pastilles. `null` quand il n'y en a aucune — la rangée n'est alors pas rendue. */
  marques?: ReactNode;
  /**
   * L'unique commande de la face avant, ou `null`.
   *
   * ⚠️ **Une configuration mémorisée n'en a pas, et ce n'est pas une omission.** « Activer » demande
   * une destination : une fiche de la bibliothèque locale n'est dans aucun emplacement, donc
   * l'activer n'a pas de sens tant qu'on n'a pas dit LEQUEL écraser. Ses puces `#1…#5` restent au
   * dos, avec la confirmation qui nomme l'emplacement écrasé.
   */
  commande?: ReactNode;
  dos: ReactNode;
  ouvert: boolean;
  onBasculer: () => void;
  /** Identifiant du dos, cible de l'`aria-controls` des deux déclencheurs. */
  idDos: string;
}) {
  const t = useTranslations("beanAdapt");
  const refAvant = useRef<HTMLDivElement>(null);
  const refDos = useRef<HTMLDivElement>(null);
  const [hauteur, setHauteur] = useState<number | null>(null);
  /* Le dos reste absent jusqu'à la première ouverture — voir l'en-tête. Une fois monté il le
     reste : le refermer pour le remonter ferait perdre un recadrage en cours. */
  const [dosMonte, setDosMonte] = useState(false);
  useEffect(() => {
    if (ouvert) setDosMonte(true);
  }, [ouvert]);

  /* La hauteur du plateau suit la face VISIBLE, et la suit encore quand son contenu bouge : le
     recadreur d'image s'ouvre, une rangée de boutons passe à la ligne, un compte rendu apparaît.
     Sans l'observateur, la carte garderait la hauteur qu'elle avait à l'ouverture et le dos
     déborderait derrière la carte suivante. */
  useMesureAvantPeinture(() => {
    const face = ouvert ? refDos.current : refAvant.current;
    if (!face) return;
    const mesurer = () => setHauteur(face.offsetHeight);
    mesurer();
    const observateur = new ResizeObserver(mesurer);
    observateur.observe(face);
    return () => observateur.disconnect();
  }, [ouvert, dosMonte]);

  /**
   * Le déclencheur, sur les deux faces : on referme là où on est.
   *
   * ⚠️ **Au dos il n'a plus de libellé visible, donc il en a un déclaré.** Il se pose en coin sur la
   * photo — là où un titre aurait pris une ligne entière pour redire le nom que le champ « Nom »
   * porte déjà juste en dessous. Un bouton d'icône sans `aria-label` s'annonce « bouton », et c'est
   * exactement le défaut qu'aucun outil de compilation ne voit. Son nom NOMME LE GRAIN, ce qui rend
   * à la face retournée l'identité que le titre supprimé emportait.
   */
  const declencheur = (libelle: string, coin = false) => (
    <Button
      type="button"
      variant="neutre"
      size="coquille"
      className={coin ? "grainDosRetour" : "iconBtn"}
      aria-expanded={ouvert}
      aria-controls={idDos}
      aria-label={coin ? libelle : undefined}
      title={coin ? libelle : t("cardFlipTitle")}
      onClick={onBasculer}
    >
      <Icone nom="retourner" taille={14} />
      {!coin && <span className="lbl">{libelle}</span>}
    </Button>
  );

  return (
    <Card className={`carteGrain${ouvert ? " retournee" : ""}`}>
      <div className="grainPlateau" style={hauteur === null ? undefined : { height: hauteur }}>
        <div className="grainRotor" data-face={ouvert ? "dos" : "avant"}>
          <div
            className="grainFace"
            ref={refAvant}
            inert={ouvert}
            aria-hidden={ouvert || undefined}
          >
            <AfficheGrain nom={titre} photo={photo} roast={roast} />
            {/* Le nom SOUS l'affiche, et le repère à sa droite. L'affiche a pris la ligne de titre :
                une vignette de 44 px dans le titre n'avait plus rien à y faire. */}
            <div className="cardHead">
              <h3 className="cardTitle">{titre}</h3>
              {repere !== undefined && <span className="sub num">{repere}</span>}
            </div>
            {marques}
            <div className="row note">
              {commande}
              {declencheur(t("cardFlip"))}
            </div>
          </div>

          {dosMonte && (
            <div
              className="grainFace grainDos"
              id={idDos}
              ref={refDos}
              inert={!ouvert}
              aria-hidden={!ouvert || undefined}
            >
              {/* **Le nom, sans une ligne pour lui.** Il se lisait trois fois sur une carte
                  retournée : l'affiche, ce titre, puis le champ « Nom » du formulaire. Or l'affiche
                  est `aria-hidden` quand le dos fait face — supprimer ce titre-là aurait donc retiré
                  la carte du plan des titres, et un lecteur d'écran qui parcourt la page par titres
                  aurait vu six cartes devenir cinq. D'où un titre SANS pixels : le champ le montre à
                  l'œil, celui-ci le garde dans la structure. */}
              <h3 className="sr-only">{titre}</h3>
              {/* ⚠️ **Le repère, lui, doit RESTER visible, et c'est une correction faite devant la
                  capture.** Le titre du dos pouvait partir parce que le champ « Nom » le redit deux
                  lignes plus bas ; le numéro d'emplacement, personne ne le redit. Or « Écrire dans
                  la machine » écrase l'emplacement qu'il désigne : un formulaire de destruction qui
                  ne nomme pas sa cible est un piège, même si la confirmation la nomme ensuite. Il
                  revient donc en coin de l'affiche, comme un tampon — deux caractères, aucune ligne
                  de plus, et à l'endroit exact où l'œil vient de le lire sur la face avant. */}
              {repere !== undefined && <span className="grainDosRepere sub num">{repere}</span>}
              {declencheur(t("cardFlipBackNamed", { name: titre }), true)}
              {dos}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
