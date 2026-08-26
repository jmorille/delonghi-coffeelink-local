"use client";
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";
import { IMAGES_PERSO, Monogramme, VignetteBoisson, useImageLabel } from "./BeverageImage";
import RecipeEditor from "./RecipeEditor";
import { beverageParams, isSet, type Beverage, type Param, type RecipeParam } from "./beverage";
// **Le constructeur de trame de PRODUCTION, celui que `server.mjs` appelle.** Pur et sans
// `Buffer`, donc importable ici — c'est sa raison d'être. Recopier l'assemblage dans la page
// aurait donné une ligne « Trame » qui ressemble à ce qui part sans en être la preuve.
import { MODE, actionPreparer, encodeDispense } from "@/lib/trame-boisson.mjs";
import Icone from "./icons";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

/**
 * **La carte d'une boisson — le composant que `/` et `/recettes` montent tous les deux.**
 *
 * Elle vivait dans `page.tsx`, donc n'appartenait qu'a l'accueil. `/recettes` affichait ses
 * recettes enregistrees avec un rendu a elle : d'abord un tableau, puis des cartes qui
 * ressemblaient a celles-ci sans en etre. Meme objet, deux dessins - exactement ce qui etait deja
 * arrive a l'editeur de recette avant qu'il ne soit extrait, et pour la meme raison : ce qu'on
 * corrige d'un cote n'atteint pas l'autre, et qui a appris l'un doit reapprendre l'autre.
 *
 * **Ce que la carte possede** : la vignette, le titre, les pastilles, la legende, la barre de
 * boutons de tete, le compte rendu, et - ouverte - l'editeur de recette avec le pli
 * « Infos techniques ». C'est la presentation d'une boisson, et elle est la meme partout.
 *
 * **Ce qu'elle ne possede pas** : ce que chaque page FAIT de cette boisson. Les boutons de tete
 * (`actions`), ce qui s'insere avant l'editeur (`dessus`) et apres (`dessous`) sont fournis par
 * l'appelant.
 *
 * Le choix d'image est le cas limite, et la couture y est passee une fois : la carte possede
 * maintenant le **declencheur** (sa vignette) et l'**ouverture** de la grille, la page garde
 * l'**effet**. C'est ce partage qui est juste, et non l'ancien « tout a la page » : sur `/`,
 * choisir un dessin ECRIT dans la machine (`0xAB`) ; sur `/recettes`, cela ne regle que la recette
 * locale. Un seul declencheur, deux effets — et la carte n'a toujours pas besoin de savoir quelle
 * page la monte, puisqu'elle ne fait que rendre `onChooseIcon`.
 */

/**
 * Ou ranger le compte rendu d'une action. Le type vit ici parce que c'est la carte qui l'affiche ;
 * `/` en garde la logique d'aiguillage, qui lui est propre (elle a aussi une carte « machine »).
 */
export interface Report {
  scope: string;
  text: string;
  kind: "ok" | "err";
}

function summary(
  users: Param[],
  paramLabel: (p: Param) => string,
  unitLabel: (u: string) => string,
): string {
  return users
    .filter(isSet)
    .map((p) => `${paramLabel(p)} ${p.def}${p.unit ? " " + unitLabel(p.unit) : ""}`)
    .join(" · ");
}

/**
 * **La ligne de la carte FERMÉE : deux valeurs, et ce sont des contenances.**
 *
 * La légende complète en aligne jusqu'à huit — « Espresso macchiato · 3 paramètres · Café 30 ml ·
 * Arôme 3 niveau · Lait 40 ml · Accessoire 2 · 2 503 (boissons avec lait chaud) ». Mesurée sur les
 * vingt-huit boissons de l'appareil, cette phrase fait jusqu'à quatre-vingts caractères dont
 * environ vingt-cinq varient d'une carte à l'autre : « 9 127 (boissons sans lait) » est identique
 * sur les dix-huit cartes sans lait, et le compteur est un compteur de CATÉGORIE, pas de tasse.
 * Trois lignes de gris qui ne départagent rien, sur la page qu'on ouvre trois fois par jour.
 *
 * Ce qui départage, quand on choisit un café debout devant la machine, c'est **la taille de la
 * tasse**. D'où les contenances seules, deux au plus : « Café 30 ml · Lait 40 ml ».
 *
 * ⚠️ **Le repli sur les niveaux n'est pas une commodité.** Cinq boissons de ce modèle ne déclarent
 * aucun paramètre en millilitres — « Mug de voyage » n'expose qu'arôme, ordre lait/café et
 * accessoire. Sans repli leur affiche perdait sa ligne, et une carte muette au milieu de vingt-sept
 * cartes qui parlent se lit comme une donnée manquante, pas comme une boisson sans contenance
 * réglable. Les deux registres ne se MÊLENT jamais pour autant : un espresso qui déclare 40 ml
 * affiche « Café 40 ml » et rien d'autre, plutôt que d'aller compléter avec un arôme qui ne dit
 * pas la taille. Ordre / accessoire ne remontent dans aucun des deux cas — ce sont des réglages,
 * pas une contenance, et leur place est l'éditeur.
 */
export function resumeContenance(
  users: Param[],
  paramLabel: (p: Param) => string,
  unitLabel: (u: string) => string,
): string {
  const poses = users.filter(isSet);
  const volumes = poses.filter((p) => p.unit === "ml");
  const retenus = (volumes.length ? volumes : poses.filter((p) => p.unit === "niveau")).slice(0, 2);
  return summary(retenus, paramLabel, unitLabel);
}

/**
 * **La grille des vingt dessins — la moitié « choix » du sélecteur d'image.**
 *
 * Elle n'a plus de déclencheur à elle : c'est la **vignette de tête de la carte** qui l'ouvre (voir
 * `BeverageCard`, prop `onChooseIcon`). Il y avait deux images du même dessin sur une carte
 * ouverte — celle de la tête et celle du sélecteur juste en dessous — dont une seule était
 * cliquable, et c'était la plus basse. Le raisonnement qui avait déjà fait du dessin son propre
 * bouton (« il y avait une phrase et un bouton à côté pour désigner une chose qui se montre »)
 * condamnait aussi le doublon : on garde l'image qui était déjà là.
 *
 * Ce composant ne tient donc plus d'état d'ouverture. Il sait dessiner vingt choix et dire lequel
 * est le courant, rien d'autre.
 */
export function GrilleImages({
  actuel,
  busy,
  working,
  onChoose,
  titreChoix,
}: {
  /**
   * L'index actuellement porté, ou `null` : une recette locale n'a pas forcément de dessin, et
   * l'annoncer ainsi vaut mieux que de prétendre qu'elle porte le numéro 0.
   */
  actuel: number | null;
  busy: boolean;
  working: boolean;
  onChoose: (icon: number) => void;
  /**
   * L'infobulle portée par CHAQUE dessin de la grille.
   *
   * ⚠️ C'est ici que vit l'avertissement d'écriture persistante de `/` : un clic applique le choix,
   * il n'y a plus de bouton « Enregistrer l'image » pour le porter. **L'avertissement a déménagé,
   * il n'a pas disparu** — même règle que lorsque les dialogues d'écriture ont été retirés : ce
   * qu'on retire est l'interruption, jamais le fait.
   */
  titreChoix?: string;
}) {
  const t = useTranslations("beverages");
  const imageLabel = useImageLabel();

  return (
    /* Un groupe de radios, pas vingt boutons : le choix est unique et exclusif, et c'est ce que
       `radiogroup` fait entendre. Chaque option porte le NOM de son dessin — sans quoi ce sont
       vingt cases sans étiquette, la sélection comprise. */
    <div className="grilleImages" role="radiogroup" aria-label={t("imageChoose")}>
      {IMAGES_PERSO.map((fichier, i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={actuel === i}
          disabled={busy}
          aria-busy={working || undefined}
          className={"choixImage" + (actuel === i ? " actif" : "")}
          // Choisir applique et referme : il n'y a pas d'étape de validation, donc pas d'état
          // intermédiaire à tenir — l'index affiché est celui qui fait foi. C'est l'appelant qui
          // referme, puisque c'est lui qui tient l'ouverture.
          onClick={() => onChoose(i)}
          aria-label={t("imagePick", { image: imageLabel(fichier) })}
          title={titreChoix}
        >
          <VignetteBoisson icon={i} />
          <span className="lbl">{imageLabel(fichier)}</span>
        </button>
      ))}
    </div>
  );
}

export default function BeverageCard({
  bev,
  profile,
  profileName,
  open,
  busy,
  working,
  report,
  onToggle,
  onDispense,
  onWrite,
  initial = null,
  titre,
  sousTitre,
  icone,
  apercuCompact,
  actions,
  editorActions,
  dessus,
  dessous,
  onChooseIcon,
  titreChoix,
  pastilles,
  marques,
  legende,
  niveauTitre = 3,
}: {
  bev: Beverage;
  profile: number;
  profileName: string | null;
  open: boolean;
  busy: boolean;
  /** Cette carte tient le verrou d'envoi : ses boutons le disent, les autres se contentent d'attendre. */
  working: boolean;
  report: Report | null;
  onToggle: () => void;
  /** Absent = pas de bouton « Preparer » dans l'editeur. */
  onDispense?: (params?: RecipeParam[]) => void;
  onWrite?: (params: RecipeParam[]) => void;
  /**
   * Valeurs de depart imposees a l'editeur. Sans elles il repart de ce que le profil a enregistre
   * sur la machine - ce qui est juste pour `/`, et effacerait sous les yeux de l'utilisateur la
   * recette locale que `/recettes` vient d'ouvrir.
   */
  initial?: RecipeParam[] | null;
  /**
   * Le titre de la carte, quand ce n'est pas le nom de la boisson. Sur `/recettes`, une carte
   * nomme la RECETTE : afficher « Espresso » sur une recette appelée « Mon serré » ferait de la
   * bibliothèque un second catalogue, et deux recettes de la même boisson y porteraient le même
   * titre. Le nom de la boisson ne disparaît pas pour autant — il passe dans `sousTitre`.
   */
  titre?: string;
  /** Une ligne sous la légende : de quelle boisson et de quel profil cette carte parle. */
  sousTitre?: ReactNode;
  /**
   * Le dessin de la carte, quand ce n'est pas celui de la boisson. Une recette locale choisit le
   * sien : la carte doit montrer CE dessin, pas l'illustration d'usine de la boisson dont elle
   * part. `null` ou absent, on retombe sur celle de la boisson — « pas encore d'image » se montre
   * mieux par le dessin de la boisson que par un vide.
   */
  icone?: number | null;
  /**
   * **Ce que la carte dit quand elle est FERMÉE.** Fourni, la tête devient une affiche : grande
   * image centrée, nom, et cette ligne — rien d'autre.
   *
   * La tête normale empile le nom d'usine, le compte de paramètres, le résumé des réglages et le
   * compteur de catégorie. C'est ce qu'il faut sur `/`, où l'on compare vingt-huit boissons de la
   * machine. Sur une bibliothèque de recettes on cherche **la sienne**, et on la reconnaît à son
   * dessin : le reste occupait la place que le dessin méritait. Ouverte, la carte reprend sa tête
   * complète — les pastilles et la légende sont alors du contexte, plus du bruit.
   */
  apercuCompact?: ReactNode;
  /** Les boutons de tete, apres « Details » - ils appartiennent a la page, pas a la carte. */
  actions?: (ctx: { nom: string; busy: boolean; working: boolean }) => ReactNode;
  /** Ce que la page ajoute a la barre d'actions de l'EDITEUR, apres « Infos techniques ». */
  editorActions?: (params: RecipeParam[]) => ReactNode;
  /** Insere dans le panneau ouvert, avant l'editeur. */
  dessus?: ReactNode;
  /** Insere dans le panneau ouvert, apres l'editeur et son pli technique. */
  dessous?: ReactNode;
  /**
   * **Presente, la vignette de tete devient le bouton qui ouvre la grille des vingt dessins.**
   * Absente, elle reste une image : `/` ne l'offre que sur un emplacement perso NOMME (une
   * ecriture `0xAB` a besoin d'un nom a reecrire), et une boisson du catalogue n'a pas de dessin
   * a choisir.
   *
   * L'effet appartient a la page : ici on ecrit dans la machine, la on regle une recette locale.
   */
  onChooseIcon?: (icon: number) => void;
  /**
   * L'infobulle portee par chaque dessin de la grille — c'est la que vit l'avertissement
   * d'ecriture persistante de `/`, puisqu'un clic applique le choix.
   */
  titreChoix?: string;
  /**
   * **Les pastilles du titre, quand la carte ne nomme pas une boisson de la machine.**
   *
   * Celles d'origine decrivent ce que la MACHINE detient sur cette boisson : « lu sur la machine »
   * (provenance des bornes), le systeme de grains actif, un desalignement de lecture. C'est juste
   * sur `/`, ou l'on compare vingt-huit boissons de l'appareil.
   *
   * ⚠️ Posees a cote du nom d'une RECETTE LOCALE, elles affirment autre chose : « lu sur la
   * machine » se lit « cette recette vient de la machine », ce qui est faux — la recette est
   * enregistree ici et n'est pas envoyee. Rapporte a l'usage, et c'etait juste.
   *
   * Fournie, cette prop remplace la rangee entiere ; absente, rien ne change (`/`).
   */
  pastilles?: ReactNode;
  /**
   * **Le bandeau de marques de l'affiche — ce qui se lit sans lire, carte fermée.**
   *
   * Il tient au-dessus du dessin, HORS du flux du texte, et c'est sa raison d'être : posées à côté
   * du nom, les pastilles passaient à la ligne dès qu'un nom était long, ce qui faisait respirer la
   * touche sur deux hauteurs différentes selon la boisson — sur une grille de vingt-huit affiches,
   * les dessins ne s'alignaient plus d'une colonne à l'autre.
   *
   * Une marque n'a droit à ce bandeau que si elle DÉPARTAGE : « lait » (la moitié du catalogue) et
   * l'anomalie « désaligné » (rare, donc informative) le font ; « lu sur la machine » ne le fait pas
   * en toutes lettres puisqu'elle est vraie partout — elle se réduit à une lampe verte, le vert
   * étant réservé dans tout ce produit à ce que la MACHINE rapporte.
   *
   * Absent, on retombe sur `pastilles` : `/recettes` passait déjà sa pastille « lait » par là et n'a
   * rien à changer.
   */
  marques?: ReactNode;
  /**
   * **La legende sous le titre, quand celle de la carte ne dit rien de juste.**
   *
   * Celle d'origine decrit une boisson de la MACHINE : son nom d'usine, son nombre de parametres, le
   * resume de ses reglages, son compteur de categorie. C'est ce qu'il faut sur `/`.
   *
   * ⚠️ Sur une composition libre de `/recipes`, la boisson n'est qu'un support technique derive : la
   * legende affichait « Travel Mug » sous une recette qui n'est pas un mug de voyage. Fournie, cette
   * prop remplace la ligne entiere ; absente, rien ne change.
   */
  legende?: ReactNode;
  /**
   * **Le niveau du titre de la carte, parce qu'il appartient à la page.**
   *
   * `/` range ses vingt-huit cartes sous des `h2` de catégorie (« Cafés », « Boissons lactées ») :
   * une carte y est un `h3`, et c'est le défaut. `/recettes` n'a pas de sections — une seule
   * liste sous le titre de page — donc ses cartes sont le premier niveau, et sauter de `h1` à
   * `h3` y laissait un barreau vide dans la seule échelle qu'un lecteur d'écran peut parcourir.
   *
   * Aucun effet visuel : `.cardTitle` porte la taille, le poids et la marge.
   */
  niveauTitre?: 2 | 3;
}) {
  const t = useTranslations("beverages");
  const tc = useTranslations("common");
  /* La balise est calculée une fois : deux `<h2>{nom}</h2>` / `<h3>{nom}</h3>` côte à côte dans
     le rendu auraient été deux endroits à garder d'accord pour un seul titre. */
  const Titre = `h${niveauTitre}` as "h2" | "h3";
  const bevLabel = useBeverageLabel();
  const paramLabel = useParamLabel();
  const unitLabel = useUnitLabel();
  const tstat = useTranslations("stat");
  /**
   * **Le seul traducteur de la page sans repli, et il ne se contentait pas d'afficher sa clé : il
   * levait.** Une catégorie absente du catalogue fait remonter un `MISSING_MESSAGE` jusqu'à la
   * carte, et en développement c'est la page entière qui tombe — 28 cartes perdues pour un libellé
   * de compteur. Les catégories viennent de `STAT_MEANINGS`, côté serveur : il peut en gagner une
   * avant que le catalogue ne la connaisse, et ce jour-là la bonne réponse est d'afficher la clé,
   * pas de casser l'accueil. C'est exactement ce que font déjà `useCategoryLabel`, `useParamLabel`
   * et `useUnitLabel` dans `src/i18n/labels.ts` ; ce compteur était le seul à ne pas le faire.
   */
  const catLabel = (key: string) => (tstat.has(key) ? tstat(key) : key);
  const users = beverageParams(bev).filter((p) => p.kind === "user");
  const read = bev.bounds ?? bev.values;
  const [tech, setTech] = useState(false);
  // `nom` sert AUSSI aux noms accessibles des boutons (« Préparer : … ») : le titre visible et ce
  // que le lecteur d'écran annonce doivent désigner le même objet.
  const nom = titre ?? bevLabel(bev);
  /** L'affiche ne vaut que fermée : ouverte, la carte a besoin de tout ce qu'elle sait dire. */
  const compacte = !open && apercuCompact !== undefined;
  const [grille, setGrille] = useState(false);
  const imageLabel = useImageLabel();
  /**
   * **Quel index est le dessin courant.** `undefined` et `null` ne disent PAS la même chose ici :
   * `/` ne passe pas `icone` du tout (le dessin est celui que la machine porte, `bev.icon`), tandis
   * que `/recettes` passe `null` quand la recette n'a encore choisi aucun dessin. Confondre les deux
   * ferait apparaître l'illustration d'usine comme « déjà sélectionnée » dans la grille.
   */
  const iconeCourante = icone !== undefined ? icone : bev.icon ?? null;
  const nomImage = iconeCourante === null ? null : IMAGES_PERSO[iconeCourante] ?? null;
  /**
   * `id` est omis quand la carte porte son propre dessin : `VignetteBoisson` préfère sa table par
   * identifiant, donc le passer écraserait l'image choisie par l'illustration d'usine de la boisson.
   */
  /**
   * **Le repli du dessin est le même nœud aux deux tailles**, et c'est le CSS qui décide laquelle :
   * `.monogramme` porte la taille d'une vignette de ligne de titre, `.vignetteGrande .monogramme`
   * celle d'une affiche. Deux nœuds auraient été deux marques à garder d'accord pour une seule
   * boisson — la divergence habituelle de ce dépôt, en plus petit.
   */
  const repli = <Monogramme nom={nom} />;
  const dessin =
    icone != null ? (
      <VignetteBoisson icon={icone} repli={repli} />
    ) : (
      <VignetteBoisson id={bev.id} icon={bev.icon} repli={repli} />
    );
  /**
   * Le bandeau de marques de l'affiche. `marques` d'abord — `/` y met sa lampe de provenance et son
   * anomalie —, `pastilles` en repli, ce que `/recettes` passait déjà. Aucun des deux : pas de
   * bandeau, donc pas de rangée vide à réserver.
   */
  const marquesAffiche = marques !== undefined ? marques : pastilles;
  /**
   * **La vignette EST le déclencheur du choix d'image — et seulement carte OUVERTE.**
   *
   * Il y avait deux images du même dessin sur une carte ouverte : celle-ci, et celle du sélecteur
   * juste en dessous. Une seule était cliquable, et c'était la plus basse. Le raisonnement qui
   * avait déjà fait du dessin son propre bouton condamnait le doublon : on garde l'image qui était
   * déjà là.
   *
   * ⚠️ **Fermée, la vignette n'est pas un bouton, et c'est délibéré.** Sur `/`, un clic dans la
   * grille ÉCRIT dans la machine (`0xAB`, le nom voyageant dans la même entrée de 21 octets).
   * Garder le déclencheur sur une carte fermée mettrait une écriture persistante à un clic de la
   * plus grande vignette du produit — l'affiche de `/recettes`. C'est la règle que cette page
   * applique déjà à « Supprimer » : l'irréversible se mérite l'ouverture. Et elle vaut des deux
   * côtés, sinon le même dessin se comporterait de deux façons selon la page qui le montre.
   */
  const vignette = () =>
    open && onChooseIcon ? (
      <button
        type="button"
        className={"vignetteBouton" + (grille ? " ouvert" : "")}
        onClick={() => setGrille(!grille)}
        aria-expanded={grille}
        // Sans nom accessible, c'est un bouton dont le contenu est une image décorative : rien à
        // annoncer. Le nom du dessin courant est ce qui rend le bouton identifiable.
        aria-label={nomImage ? t("imageChange", { image: imageLabel(nomImage) }) : t("imageChoose")}
      >
        {dessin}
      </button>
    ) : (
      dessin
    );
  /** Replier la grille en fermant la carte : rouverte, elle ne doit pas retrouver un choix en cours. */
  const basculer = () => {
    setGrille(false);
    onToggle();
  };

  /**
   * **« Infos techniques » — ce qui ne se lit nulle part ailleurs.**
   *
   * Le tableau « Tous les paramètres » a été retiré : l'éditeur au-dessus montre déjà chaque
   * réglage avec ses bornes, son défaut et la valeur du profil. Restent les propriétés Ayla, la
   * trame lue, et — depuis que l'éditeur passe ses valeurs vivantes — la trame qui PARTIRAIT.
   *
   * `params` est la charge utile de l'éditeur à cet instant précis, celle que « Préparer avec ces
   * valeurs » enverrait. La trame est donc assemblée à chaque rendu : bouger l'arôme d'un cran
   * réécrit la ligne sous le curseur, sans réseau et sans état à synchroniser.
   */
  const panneauTechnique = (params: RecipeParam[]) => (
    <>
      <div className="kv">
        <span className="k">{t("boundsProp")}</span>
        <span className="mono">{bev.boundsProp ?? "—"}</span>
      </div>
      <div className="kv">
        <span className="k">{t("valuesProp", { profile: profileName ? `${profile} — ${profileName}` : profile })}</span>
        <span className="mono">{bev.valuesProp ?? "—"}</span>
      </div>
      {read && (
        <div className="kv">
          {/* « Trame lue » sur une trame qu'on a assemblée soi-même affirmerait une lecture qui
              n'a pas eu lieu. La provenance vient de la trame, pas de la page qui la montre. */}
          <span className="k">
            {read.calculee
              ? t("computedFrame", { kind: read.kind === "bounds" ? t("frameBounds") : t("frameValues") })
              : t("readFrame", { kind: read.kind === "bounds" ? t("frameBounds") : t("frameValues") })}
          </span>
          <span className="mono">
            {read.hex}
          </span>
        </div>
      )}
      {/* **La trame de la commande, pas celle de la lecture** — et les deux se lisent l'une sous
          l'autre parce que c'est là qu'on les compare. Elle est dite « calculée » comme sa voisine
          d'au-dessus : rien ne l'a encore envoyée, et l'afficher sans le dire laisserait croire
          qu'un café est parti.

          ⚠️ Elle change avec l'INVERSION (paramètre 12) : `actionPreparer` est la règle de l'app,
          pas une supposition d'ici, et un flat white ne porte donc pas la même action qu'un
          cappuccino droit. La montrer était la seule façon que ce fait cesse d'être invisible. */}
      <div className="kv">
        {/* La MÊME phrase que la trame calculée d'au-dessus, avec une troisième nature : trois
            libellés pour trois trames auraient laissé « calculée » se dire de trois façons. */}
        <span className="k">{t("computedFrame", { kind: t("framePrepare") })}</span>
        <span className="mono">{encodeDispense(bev.id, profile, MODE.START, actionPreparer(params), params).hex}</span>
      </div>
    </>
  );

  return (
    /* Ouverte, la carte s'étend sur toute la rangée de la grille (voir `.cards > .card.open`) :
       l'éditeur de recette a besoin de largeur, et le comprimer dans une colonne de 19 rem aurait
       fait de la grille la cause d'un formulaire illisible. */
    <Card
      id={`b${bev.id}`}
      /* Fermée, la carte de boisson EST une touche du clavier — voir `card.tsx`. Ouverte, elle
         redevient la plaque ordinaire : c'est ce contraste qui dit lequel des 28 est le sujet. */
      variant={open ? "plaque" : "touche"}
      className={open ? "open" : undefined}
      role="listitem"
    >
      {compacte ? (
        /* **L'affiche — et c'est maintenant la forme de la carte fermée des DEUX pages.**
           L'image d'abord, en grand et centrée : c'est elle qu'on balaie du regard pour retrouver
           une boisson, et c'était le plus petit élément de la carte tant qu'elle tenait 44 px à
           gauche du nom. Le chevron ne porte plus le mot « Détails » — un libellé qui répétait ce
           que la flèche dit déjà, sur chaque carte de la grille. Son nom accessible, lui, reste
           complet : c'est le seul repère d'un lecteur d'écran.

           L'ordre est celui de la lecture d'une touche d'appareil : les marques, le dessin, le nom
           gravé dessous, la contenance, puis les commandes sous un filet. */
        <div className="cardHead compacte">
          {marquesAffiche ? <div className="marques">{marquesAffiche}</div> : null}
          <div className="vignetteGrande">{dessin}</div>
          <Titre className="cardTitle">{nom}</Titre>
          {apercuCompact ? <p className="sub">{apercuCompact}</p> : null}
          <div className="row actions">
            <Button type="button" variant="neutre" size="commande"
              className="iconBtn"
              onClick={basculer}
              aria-label={t("detailsFor", { beverage: nom })}
              aria-expanded={false}>
              <Icone nom="chevron" />
            </Button>
            {actions?.({ nom, busy, working })}
          </div>
        </div>
      ) : (
      <div className="cardHead">
        {/* **La face de la touche.** Fermée, cette boîte EST la touche : creusée dans le boîtier,
            biseau inversé, le dessin et le nom sérigraphiés dessus, les pastilles d'état en guise
            de lampes. Ouverte, elle redevient un simple bloc de titre — la carte est alors le
            sujet de la page, plus un élément d'un clavier. Voir `.toucheBev` dans surfaces.css. */}
        <div className="toucheBev">
          {/* Le nom et ses pastilles sont UN objet : une rangée avec une gouttière, au lieu de
              quatre `marginLeft: 8` posés pastille par pastille. La gouttière gère aussi le repli —
              une pastille qui passe à la ligne garde son écart, une marge gauche non. */}
          <div className="titreLigne">
          {/* La vignette d'abord : `.titreLigne` est déjà une rangée souple avec gouttière, elle
              gère donc l'alignement et le repli sans qu'on ait rien à ajouter. Ouverte, elle est
              AUSSI le bouton qui ouvre la grille des dessins — voir `vignette()`. */}
          {vignette()}
          {/* Un vrai titre, pas un `<strong>` : c'est le seul moyen de sauter de boisson en boisson
              au lecteur d'écran. Sans lui, 28 cartes n'offraient que 2 repères de navigation. */}
          <Titre className="cardTitle">{nom}</Titre>
          {/* Catégorie de la boisson : pastille neutre. Le vert est réservé à ce que la
              MACHINE rapporte — le laisser ici en mettait quatre par carte, vingt-huit fois, et
              plus rien ne signalait qu'une session venait de tomber. */}
          {pastilles !== undefined ? (
            pastilles
          ) : (
            <>
          {bev.milk && <Badge variant="plaque">{t("milk")}</Badge>}
          {read && <Badge variant="choisi">{t("readFromMachine")}</Badge>}
          {bev.beanSystem?.name && (
            <Badge variant="choisi"
             
              /* **Pas d'infobulle plutôt qu'une infobulle à zéros.** Le nom du grain et ses trois
                 réglages arrivent dans la même trame `0xBA`, donc en pratique ils vont ensemble —
                 mais l'index du grain, lui, peut venir de la lecture rapide seule, et le type le
                 dit désormais (`grinder: number | null`). Un `?? 0` aurait affiché « mouture 0,
                 température 0, arôme 0 » : trois réglages plausibles et faux, sur l'écran même qui
                 sert à décider du goût d'un café. */
              title={
                bev.beanSystem.grinder !== null && bev.beanSystem.temperature !== null && bev.beanSystem.aroma !== null
                  ? t("beanSystemHint", {
                      grinder: bev.beanSystem.grinder,
                      temperature: bev.beanSystem.temperature,
                      aroma: bev.beanSystem.aroma,
                    })
                  : undefined
              }
            >
              {t("beanSystem", { name: bev.beanSystem.name })}
            </Badge>
          )}
          {read && !read.exact && (
            <Badge variant="arret" title={t("misalignedHint")}>
              {t("misaligned")}
            </Badge>
          )}
            </>
          )}
          </div>
          {sousTitre && <p className="sub">{sousTitre}</p>}
        </div>
        {/* Sérigraphiée SOUS la touche, sur le boîtier : le nom d'usine, le compte de paramètres,
            le résumé des réglages, le compteur de catégorie. C'est la ligne qu'on lit après avoir
            reconnu la boisson, jamais avant — d'où sa place et sa taille. */}
        <div className="legende">
            {legende !== undefined ? legende : <>
            {/* Le nom d'usine n'est montré que s'il apprend quelque chose. « Espresso macchiato /
                Espresso Macchiato » disait deux fois la même chose ; « Nom perso / Custom » dit que
                c'est un emplacement personnalisé, ce qui est une information. */}
            {bev.factoryName.toLowerCase() !== nom.toLowerCase() && <>{bev.factoryName} · </>}
            {t("paramCount", { count: bev.ingredients.length })}
            {users.length > 0 && bev.bounds ? ` · ${summary(users, paramLabel, unitLabel)}` : ""}
            {bev.counter && (
              <>
                {" · "}
                <span title={t("counterHint", { category: catLabel(bev.counter.category) })}>
                  {t("counterValue", {
                    value: bev.counter.value.toLocaleString("fr-FR"),
                    category: catLabel(bev.counter.category),
                  })}
                </span>
              </>
            )}
            </>}
        </div>
        {/* Les trois boutons portaient le même nom sur les 28 cartes : « Détails », « Lire »,
            « Préparer », 84 boutons homonymes pour un lecteur d'écran. Le nom accessible dit
            maintenant DE QUOI il s'agit, sans allonger le libellé visible. */}
        {/* Le libellé reste visible tant que la carte est large ; en colonne de grille il passe
            hors écran et l'icône porte l'action, comme PRODUCT.md le demande. C'est la largeur de
            la CARTE qui décide, pas celle de la fenêtre — une container query, donc.
            Le nom accessible ne bouge dans aucun des deux cas : `aria-label` l'emporte sur le
            contenu, et c'est lui qui nomme la boisson concernée (« Préparer un Espresso » plutôt
            que « Préparer », vingt-huit fois). Le libellé visible ne fait que doubler l'icône. */}
        <div className="row actions">
          <Button
            type="button"
            variant="neutre"
            size="commande"
            className={"iconBtn" + (open ? " ouvert" : "")}
            onClick={basculer}
            aria-label={open ? t("hideFor", { beverage: nom }) : t("detailsFor", { beverage: nom })}
          >
            <Icone nom="chevron" />
            <span className="lbl">{open ? tc("hide") : tc("details")}</span>
          </Button>
          {/* « Details » reste a la carte : c'est son propre pli. Tout le reste appartient a la
              page - `/` lit et prepare, `/recettes` prepare, transfere et supprime. */}
          {actions?.({ nom, busy, working })}
        </div>
      </div>
      )}

      {/* Le compte rendu vit dans la carte qui a déclenché l'action, jamais en haut de page. */}
      <p className={"status " + (report?.kind === "err" ? "err" : "ok")} role="status">
        {report?.text ?? ""}
      </p>

      {open && (
        <div className="blocSuite">
          {/* **La grille s'ouvre sous la tête, pas sous l'éditeur.** Elle est commandée par la
              vignette du titre : un panneau dépliant doit apparaître sous son déclencheur, sinon
              cliquer en haut fait surgir du contenu ailleurs. Et le dessin appartient à
              l'emplacement — les cinq profils le partagent — donc il n'a rien à faire sous un
              éditeur titré « pour le profil N ». */}
          {onChooseIcon && grille && (
            <GrilleImages
              actuel={iconeCourante}
              busy={busy}
              working={working}
              onChoose={(i) => {
                setGrille(false);
                onChooseIcon(i);
              }}
              titreChoix={titreChoix}
            />
          )}
          {/* Monté seulement à l'ouverture : son état repart donc des valeurs de la machine
              à chaque fois, sans logique de réinitialisation à écrire. */}
          {/* « Infos techniques » est passe a l'editeur pour tenir dans SA barre d'actions : les
              quatre boutons de la carte ouverte etaient sur trois lignes. L'etat et le panneau
              restent ici — c'est la carte qui les possede, et le panneau s'ouvre bien sous la
              barre puisqu'il est rendu juste apres l'editeur. Le libelle passe en `.lbl` comme
              les trois autres, sans quoi il ne se replierait pas avec eux en etroit. */}
          {/* Avant l'éditeur, et seulement pour un emplacement perso NOMMÉ : `customSlot` n'est
              rempli que là (la trame de noms ne couvre pas les boissons du catalogue, et une
              écriture a besoin d'un nom à réécrire). L'identité de la recette — son dessin — se
              lit avant ses valeurs pour un profil. */}
          {dessus}

          <RecipeEditor
            bev={bev}
            profile={profile}
            profileName={profileName}
            busy={busy}
            working={working}
            initial={initial}
            onDispense={onDispense}
            onWrite={onWrite}
            // Le nœud est rendu par une fonction qui recoit la charge utile : « Infos techniques »
            // ne s'en sert pas, « Enregistrer localement » de `/recettes` en a besoin.
            actions={(params) => (
              <>
                <Button type="button" variant="neutre" size="commande" className="iconBtn" onClick={() => setTech(!tech)} aria-expanded={tech} title={t("technicalInfoTitle")}>
                  <Icone nom="info" />
                  <span className="lbl">{tech ? t("hideTechnicalInfo") : t("technicalInfo")}</span>
                </Button>
                {editorActions?.(params)}
              </>
            )}
            /* **Le panneau est rendu par l'éditeur pour qu'il reçoive les valeurs VIVANTES.** Il
               appartient toujours à la carte — c'est elle qui tient `tech` et qui décide de ce
               qu'on y lit — mais la trame « Préparer » qu'il affiche doit se réécrire au cran de
               curseur près, et l'état des curseurs est chez l'éditeur. Le remonter ici aurait
               demandé un second état à synchroniser, donc la possibilité d'afficher la trame du
               rendu précédent sur le seul panneau dont l'exactitude est tout l'intérêt.
               Visuellement rien ne bouge : `panneau` est rendu en dernier, là où ce bloc était. */
            panneau={(params) => (tech ? panneauTechnique(params) : null)}
          />

          {dessous}
        </div>
      )}
    </Card>
  );
}
