"use client";
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import GRAINS from "@/lib/bean-images.json";
import { Monogramme } from "./BeverageImage";
import { FORMAT_IMAGE, TORREFACTIONS } from "@/lib/image-grains.mjs";
import { RadioGroup, RadioGroupCran } from "@/ui/radio-group";

/**
 * **Le visuel d'un grain, et l'ordre dans lequel il se décide.**
 *
 * Trois sources possibles, une seule précédence, écrite ici et nulle part ailleurs :
 *
 *   1. la **photo** de l'utilisateur — son paquet, cadré par `PhotoGrains` ;
 *   2. à défaut, le visuel du **niveau de torréfaction** qu'il a déclaré ;
 *   3. à défaut, ce que l'appelant passe en `repli` — les initiales, comme pour les boissons.
 *
 * C'est le mécanisme de l'application officielle, repris tel quel : elle associe un visuel à la
 * réponse « torréfaction » du questionnaire (`prequestion_2`), et laisse une photo le remplacer.
 * La différence est où vivent les octets — chez elle un datum Ayla `BS<id>IMG`, donc le cloud ;
 * ici la table `bean_images` de ce serveur.
 *
 * **Un seul endroit pour la précédence, et c'est la raison d'être du fichier.** Les deux grilles de
 * `/beans` — six emplacements machine, N configurations mémorisées — montrent le même objet. Deux
 * copies de « photo sinon torréfaction sinon initiales » divergeraient au premier ajustement, et
 * divergeraient en silence : chaque grille afficherait quelque chose de plausible.
 *
 * ⚠️ **Le Dockerfile ne copie pas `public/`.** Les visuels sont versionnés depuis le 2026-09-01,
 * donc un clone frais les a ; l'image publiée, elle, n'en a pas un seul — et ils appartiennent à
 * De'Longhi (voir l'en-tête de `scripts/import-bean-images.mjs`). L'absence reste donc un état
 * courant : le `onError` ci-dessous et le `repli` de l'appelant sont ce qui la rend normale plutôt
 * que visible. Même discipline que `BeverageImage.tsx`, et pour la même raison.
 */

/* Les niveaux viennent de `image-grains.mjs`, pas d'ici : `server.mjs` valide contre la MÊME
   liste. Voir son en-tête pour la raison de ce voisinage. */
const NIVEAUX: readonly number[] = TORREFACTIONS;

/**
 * Les libellés des quatre niveaux, **écrits en clés littérales**.
 *
 * ⚠️ `t(\`roast${n}\`)` aurait tenu en une ligne et aurait été INVISIBLE à
 * `scripts/verif-messages.mjs`, qui ne voit que les clés littérales écrites sur place. C'est le
 * défaut même qui a fait naître ce script : une clé calculée manque au catalogue sans que rien ne
 * le dise, et l'interface affiche alors la clé brute. Quatre appels littéraux coûtent trois lignes
 * et rendent l'oubli impossible.
 *
 * Une fonction et non une constante de module : `useTranslations` est un hook.
 */
function useLibellesTorrefaction(): Record<number, string> {
  const t = useTranslations("beanAdapt");
  return { 1: t("roast1"), 2: t("roast2"), 3: t("roast3"), 4: t("roast4") };
}

/**
 * L'URL d'un visuel importé.
 *
 * `?v=` n'est pas un ornement : sans lui, `next.config.mjs` n'a rien à reconnaître et ces images
 * repartent en requêtes conditionnelles à chaque navigation. L'extension vient de la table et non
 * d'ici — la source livre du PNG aujourd'hui, et le jour où elle livre autre chose, une seule
 * déclaration doit bouger.
 */
export function urlGrain(role: string): string {
  return `${GRAINS.chemin}/${role}.${GRAINS.extension}?v=${GRAINS.version}`;
}

/** Le fichier d'un niveau de torréfaction, ou `undefined` si le niveau n'est pas dans la table. */
function fichierTorrefaction(niveau: number | null | undefined): string | undefined {
  if (niveau === null || niveau === undefined) return undefined;
  return (GRAINS.torrefaction as Record<string, string>)[String(niveau)];
}

/** Le fichier d'un aspect de crema. Mêmes identifiants que `bean-adapt.mjs` : 1, 2, 3. */
function fichierCrema(niveau: number | null | undefined): string | undefined {
  if (niveau === null || niveau === undefined) return undefined;
  return (GRAINS.crema as Record<string, string>)[String(niveau)];
}

/**
 * Le visuel d'un grain : photo, sinon torréfaction, sinon `repli`.
 *
 * `photo` est une URL déjà construite par l'appelant (avec sa version), parce que c'est lui qui
 * sait de quelle machine et de quel objet il parle — une configuration mémorisée et un emplacement
 * de la machine ne se servent pas au même endroit.
 */
export function VignetteGrains({
  photo = null,
  roast = null,
  repli = null,
  className = "bevVignette",
  classNameRoast,
}: {
  photo?: string | null;
  roast?: number | null;
  /** Ce qui s'affiche quand il n'y a ni photo, ni niveau, ni fichier. Passé par l'appelant : la
      vignette d'une ligne de titre et l'affiche d'une carte n'ont pas la même taille. */
  repli?: ReactNode;
  className?: string;
  /**
   * La classe du DESSIN de torréfaction, quand elle diffère de celle de la photo.
   *
   * ⚠️ **Les deux ne s'ajustent pas pareil, et c'est le seul endroit où ça se voit.** Dans une
   * vignette de 44 px les deux tiennent dans le même carré ; dans l'affiche d'une carte, la photo
   * REMPLIT le cadre (`cover` — elle est déjà au rapport du cadre) et le dessin s'y INSCRIT
   * (`contain`, plus petit) : c'est une illustration sur fond transparent, la rogner lui couperait
   * les grains du bord. Retombe sur `className`, qui reste le cas courant.
   */
  classNameRoast?: string;
}) {
  /* Deux drapeaux et non un : une photo illisible doit retomber sur la TORRÉFACTION, pas
     directement sur les initiales. Un seul état les confondrait, et le repli sauterait un
     échelon sans que rien ne le dise. */
  const [photoAbsente, setPhotoAbsente] = useState(false);
  const [grainAbsent, setGrainAbsent] = useState(false);
  const t = useTranslations("beanAdapt");
  const libelles = useLibellesTorrefaction();

  if (photo && !photoAbsente) {
    return (
      // `<img>` et non `next/image` : la source est une route de ce serveur qui rend des octets
      // bruts déjà au format voulu. Même raison qu'ailleurs dans ce dépôt.
      <img
        src={photo}
        alt=""
        aria-hidden="true"
        className={className}
        loading="lazy"
        decoding="async"
        onError={() => setPhotoAbsente(true)}
      />
    );
  }
  const fichier = fichierTorrefaction(roast);
  if (fichier && !grainAbsent) {
    return (
      /* `alt` PLEIN et pas `aria-hidden`, contrairement à la photo : ce visuel PORTE une
         information que rien d'autre sur la carte ne donne — le niveau de torréfaction déclaré.
         La photo, elle, est décorative : le nom du grain est juste à côté. */
      <img
        src={urlGrain(fichier)}
        alt={t("roastAlt", { level: libelles[roast as number] })}
        className={classNameRoast ?? className}
        loading="lazy"
        decoding="async"
        onError={() => setGrainAbsent(true)}
      />
    );
  }
  return <>{repli}</>;
}

/**
 * **L'affiche du grain : un creux fraisé dans la tôle, jamais un cadre vide.**
 *
 * Le cadre de `VignetteGrains` à la largeur d'une carte. Il vit ICI, avec la précédence qu'il
 * enveloppe, et non dans `CarteGrain.tsx` où il est né : **il a deux hôtes, pas un.** La face avant
 * le montre ; le bouton de `PhotoGrains` le montre aussi, au dos, en le rendant cliquable. C'est ce
 * qui fait que la photo ne BOUGE PAS pendant le demi-tour — la carte tourne autour d'un rectangle
 * qui reste à sa place et à sa taille. Deux cadres déclarés séparément auraient divergé au premier
 * ajustement, et la rotation aurait fait sauter l'image d'un cran.
 *
 * Le rapport du cadre est celui de `FORMAT_IMAGE` et **il en est déduit**, pas recopié : c'est ce
 * que `PhotoGrains` produit, donc une photo de cette maison remplit le cadre exactement. Deux
 * déclarations de « 300 × 340 » divergeraient au premier ajustement, et le cadrage se tromperait
 * en silence.
 *
 * Les trois états d'un visuel passent par le même cadre — photo, sinon dessin de torréfaction,
 * sinon initiales gravées — et c'est `VignetteGrains` qui tranche, comme partout ailleurs.
 * **L'absence reste un état courant** (le Dockerfile ne copie pas `public/`, donc l'image publiée
 * n'emporte aucun visuel) : les initiales à la taille de l'affiche ne sont pas un pis-aller, c'est
 * l'état
 * normal du produit, et le cadre doit y être aussi juste qu'avec une photo. D'où le fond brossé —
 * un creux usiné, et non un rectangle uni qui se lirait « image manquante ».
 *
 * ⚠️ **Deux ajustements, et aucun des deux ne rogne** — `contain` pour la photo, `contain` plus
 * petit pour le dessin. Le premier a été mesuré : `cover` sur une photo VENUE DU CLOUD (que l'app
 * officielle stocke en 5:3) coupait les deux moitiés du nom de la marque sur un paquet réel. La
 * raison complète est dans `surfaces.css`, sur la règle qui l'applique.
 */
export function AfficheGrain({
  nom,
  photo = null,
  roast = null,
}: {
  nom: string;
  photo?: string | null;
  roast?: number | null;
}) {
  return (
    /* `brosse` vient de `globals.css` : l'aluminium brossé du boîtier, la matière du fond du creux.
       Nommée ici plutôt que recopiée dans `surfaces.css` — c'est un matériau du monde, pas un
       ornement de cette carte. */
    <div className="afficheGrain brosse" style={{ aspectRatio: `${FORMAT_IMAGE.largeur} / ${FORMAT_IMAGE.hauteur}` }}>
      <VignetteGrains
        photo={photo}
        roast={roast}
        className="afficheGrainPhoto"
        classNameRoast="afficheGrainDessin"
        repli={<Monogramme nom={nom} />}
      />
    </div>
  );
}

/**
 * Le rail des quatre torréfactions — **un choix exclusif dessiné comme un rail de touches**.
 *
 * `RadioGroupCran` et non `RadioGroupItem` : quatre nuances de brun se choisissent en les
 * comparant, donc en les VOYANT côte à côte. Une liste de pastilles rondes aurait mis les libellés
 * en avant et les images en second, ce qui est l'inverse du geste.
 *
 * ⚠️ **Un `RadioGroupCran` est un `<button>`.** Son nom accessible vient de son CONTENU, d'où le
 * libellé visible à l'intérieur et l'`alt` vide sur l'image — sans le texte, quatre boutons se
 * seraient annoncés « bouton », et avec un `alt` plein ils se seraient annoncés deux fois. Le
 * groupe, lui, est nommé par `aria-labelledby` vers sa légende : un `<label>` ne nomme pas un
 * groupe, et n'aurait de toute façon rien à cibler.
 *
 * **La case « non précisée » existe exprès.** Sans elle, un niveau choisi par erreur ne pourrait
 * plus être retiré : un rail de radios n'a pas de geste pour revenir à rien.
 */
export function ChoixTorrefaction({
  value,
  onChange,
  disabled = false,
  prefixe,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  /** Plusieurs cartes peuvent être ouvertes : la légende a besoin d'un identifiant à elle. */
  prefixe: string;
}) {
  const t = useTranslations("beanAdapt");
  const libelles = useLibellesTorrefaction();
  const idLegende = `${prefixe}-torrefaction-legende`;

  return (
    <div className="paramRow">
      <span className="nom" id={idLegende}>
        {t("roast")}
      </span>
      <div className="ctl">
        <RadioGroup
          aria-labelledby={idLegende}
          disabled={disabled}
          /**
           * ⚠️ **`orientation` n'est pas une indication de style, c'est le mappage des flèches.**
           * Sans elle, Radix laisse le groupe en vertical : le rail se dessine en rangée et ne
           * répond qu'à Haut/Bas — les flèches qui correspondent à ce qu'on VOIT ne font rien.
           * Défaut constaté dans un vrai navigateur par `verif-surfaces.mjs`, invisible autrement :
           * rien n'est rouge, le clic marche, et seul le clavier perd le rail.
           */
          orientation="horizontal"
          /* `grid gap-3` par défaut dans la primitive, donc une COLONNE. Un rail est une rangée :
             elle est reprise ici, sur le composant, et non dans `surfaces.css` — `utilities` bat
             `surfaces` dans la cascade, et une rangée écrite là-bas perdrait en silence. */
          className="flex flex-wrap items-end gap-1"
          value={value === null ? "" : String(value)}
          onValueChange={(v) => onChange(v === "" ? null : Number(v))}
        >
          {NIVEAUX.map((n) => {
            const fichier = fichierTorrefaction(n);
            return (
              /* 3,6 rem et non 4,25 : les cinq crans tiennent alors sur UNE rangée dans la colonne
                 de `.cards.grains` (5 × 56 + 4 × 4 = 296 px pour 304 px utiles, mesuré). À 4,25 rem
                 le rail passait à 4 + 1, et « Non précisée » se retrouvait seule sous les quatre
                 bruns — ce qui la faisait lire comme un cinquième niveau plutôt que comme le retrait
                 du choix. */
              <RadioGroupCran key={n} value={String(n)} className="w-[3.5rem] gap-1 p-1">
                {fichier ? (
                  <img
                    src={urlGrain(fichier)}
                    alt=""
                    className="h-8 w-auto max-w-full object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                ) : null}
                <span className="text-legende leading-tight text-center">{libelles[n]}</span>
              </RadioGroupCran>
            );
          })}
          <RadioGroupCran value="" className="w-[3.5rem] gap-1 p-1">
            <span className="text-legende leading-tight text-center">{t("roastNone")}</span>
          </RadioGroupCran>
        </RadioGroup>
      </div>
    </div>
  );
}

/**
 * Le visuel d'un aspect de crema, pour l'assistant.
 *
 * Rien de plus qu'une image nommée : le sélecteur voisin porte déjà le libellé, et c'est lui qui
 * est le contrôle. D'où `aria-hidden` — l'annoncer ferait entendre deux fois « crema foncée ».
 * Rend `null` quand le fichier manque, ce qui est le cas d'un dépôt sans import : l'assistant doit
 * rester lisible sans une seule de ces images.
 */
export function ImageCrema({ niveau, className = "" }: { niveau: number; className?: string }) {
  const [absente, setAbsente] = useState(false);
  const fichier = fichierCrema(niveau);
  if (!fichier || absente) return null;
  return (
    <img
      src={urlGrain(fichier)}
      alt=""
      aria-hidden="true"
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => setAbsente(true)}
    />
  );
}
