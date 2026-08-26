"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";
import { CROISES, INGREDIENTS, composable, croiseDe, groupeDe, presenceInitiale, valeurAbsente } from "@/lib/ingredients.mjs";
import { beverageParams, defautModele, valeurDepart, type Beverage, type Param, type RecipeParam } from "./beverage";
import Icone from "./icons";
import Alerte from "./Alerte";
import { Slider } from "@/ui/slider";
import { Input } from "@/ui/input";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Switch } from "@/ui/switch";

/**
 * **L'éditeur de recette, un seul pour tout le produit.**
 *
 * Édition de la recette du profil pour une boisson, sous les bornes du modèle. Les valeurs
 * partent de ce que la machine a enregistré pour CE profil ; à défaut, des défauts du modèle.
 * Les bornes min/max sont communes aux profils — un profil ne peut que choisir une valeur à
 * l'intérieur — donc les champs les imposent.
 *
 * Règle d'affichage : **on n'écarte rien**. Est réglable tout paramètre dont `max > min` ; les
 * paramètres à valeur unique sont montrés en lecture seule mais restent dans la trame (l'ordre
 * lait/café d'un flat white vaut toujours 1 et c'est lui qui déclenche l'action d'inversion).
 * Le regroupement « recette » / « avancé » est cosmétique : une première version filtrait sur
 * notre propre classification et masquait de vraies options (« 2 tasses », « accessoire »).
 *
 * ## Pourquoi il a quitté `/`
 *
 * `/recipes` avait le sien : un tableau Paramètre / Min / Max / Défaut machine / Profil / Valeur,
 * avec des curseurs nus. Même geste, même trame `0x83`, deux interfaces — et celle de `/recipes`
 * n'avait ni les interrupteurs pour les booléens, ni les ingrédients à cocher, ni le retour aux
 * défauts du modèle, ni le pli des réglages avancés. Un utilisateur qui apprend l'une doit
 * réapprendre l'autre, et une correction d'ergonomie n'atteignait qu'une page sur deux.
 *
 * Il reste **une** différence assumée : `/recipes` ne montre pas de bouton « Préparer ». Cette
 * page enregistre, elle ne verse pas — et `onDispense` absent suffit à le dire, sans variante
 * d'affichage à maintenir.
 *
 * ## Les deux points d'extension, et pourquoi ils ont cette forme
 *
 * `initial` impose les valeurs de départ, pour rouvrir une recette enregistrée localement : sans
 * lui l'éditeur repartirait du profil et effacerait silencieusement ce qu'on venait cliquer
 * « Modifier » pour retrouver.
 *
 * `actions` reçoit la charge utile courante au lieu que la page tienne une copie de l'état de
 * l'éditeur. Deux états pour une seule recette, c'est deux occasions de diverger — exactement ce
 * que cette extraction répare. Un bouton hôte lit ce qui partirait à la machine, à l'instant du
 * rendu, ou rien.
 */
export default function RecipeEditor({
  bev,
  profile,
  profileName,
  busy,
  working,
  initial,
  onDispense,
  onWrite,
  actions,
  panneau,
}: {
  bev: Beverage;
  profile: number;
  profileName: string | null;
  busy: boolean;
  working: boolean;
  /**
   * Valeurs de départ imposées — une recette enregistrée localement qu'on rouvre. Absent, on
   * repart de ce que le profil a enregistré sur la machine, qui est le cas courant.
   */
  initial?: RecipeParam[] | null;
  /**
   * Verser la boisson avec ces valeurs. **Absent, le bouton n'existe pas** : `/recipes`
   * enregistre des recettes, elle ne commande pas l'appareil, et un bouton qui verse un café
   * n'a pas à apparaître là par symétrie.
   */
  onDispense?: (params?: RecipeParam[]) => void;
  /**
   * Écrire dans le profil de la machine — **écriture persistante**. Absent, le bouton disparaît,
   * exactement comme `onDispense` : une page qui ne peut pas écrire ne doit pas montrer un bouton
   * qui le promet. Même règle, même mécanisme, pas de variante d'affichage à maintenir.
   */
  onWrite?: (params: RecipeParam[]) => void;
  /**
   * Boutons de l'hôte à poser dans la barre d'actions — « Infos techniques » sur `/`,
   * « Enregistrer localement » sur `/recipes`. Ils vivent chez l'hôte (c'est lui qui tient
   * leur état et leurs panneaux) mais s'affichent ici : les quatre boutons de la carte ouverte
   * étaient sur trois lignes différentes, dont deux ne contenaient qu'un bouton.
   *
   * La charge utile courante leur est PASSÉE plutôt que remontée à l'hôte : deux copies de la
   * même recette, c'est deux occasions de diverger — précisément ce que cette extraction
   * répare.
   */
  actions?: (params: RecipeParam[]) => React.ReactNode;
  /**
   * **Le contenu que ces boutons dépliés, chez l'hôte, veulent afficher — et qui a besoin de la
   * charge utile VIVANTE.** Même raison que `actions`, un cran plus loin : « Infos techniques »
   * montre la trame `0x83` que « Préparer avec ces valeurs » enverrait, et elle doit se réécrire à
   * chaque cran de curseur. Remonter les valeurs à l'hôte pour cela aurait demandé un second état,
   * un `useEffect` pour le synchroniser, et rendu possible qu'on affiche une trame d'un rendu de
   * retard — sur un panneau dont le seul intérêt est d'être exact.
   *
   * Rendu en DERNIER, après le pli « Avancé » : le panneau appartient à l'hôte, il apparaissait
   * déjà là, et un dépliant qui déplace ce qui l'entoure est un dépliant qu'on n'ose plus ouvrir.
   */
  panneau?: (params: RecipeParam[]) => React.ReactNode;
}) {
  const t = useTranslations("editor");
  const tc = useTranslations("common");
  const bevLabel = useBeverageLabel();
  const paramLabel = useParamLabel();
  const unitLabel = useUnitLabel();
  const all = beverageParams(bev);
  const adjustable = all.filter((b) => (b.max as number) > (b.min as number));
  const fixed = all.filter((b) => (b.max as number) === (b.min as number));
  const basic = adjustable.filter((b) => b.kind === "user");
  const advanced = adjustable.filter((b) => b.kind !== "user");

  /**
   * Les deux règles de valeur vivent au niveau du module (`valeurDepart`, `defautModele`) : elles
   * étaient écrites ici, et le bouton « Préparer » de la carte en avait sa propre version, plus
   * simple et fausse. Deux implémentations de « quelle valeur pour ce paramètre ? » dans le même
   * fichier, c'était deux cafés différents sous une seule et même confirmation.
   */
  const impose = new Map((initial ?? []).map((x) => [x.id, x.value]));
  const seedFor = (b: Param) => impose.get(b.id) ?? valeurDepart(bev, b);
  const seed = () => Object.fromEntries(all.map((b) => [b.id, seedFor(b)]));
  const defOf = (b: Param) => defautModele(b);
  const [vals, setVals] = useState<Record<number, number>>(seed);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /**
   * Un emplacement perso se règle par INGRÉDIENT, comme l'écran de création de l'application :
   * on coche le lait et sa quantité s'ouvre, on coche le café et sa quantité plus son arôme
   * s'ouvrent. La présence n'a pas d'état à elle — elle se LIT dans la quantité enregistrée, ce
   * qui évite d'avoir deux sources de vérité à tenir d'accord.
   */
  /**
   * **La COMPOSITION est le propre d'un emplacement PERSO, et de rien d'autre.**
   *
   * C'est là, et seulement là, que les ingrédients se *composent* : la machine y déclare café,
   * lait et leurs options, et une case décochée s'y écrit « absent » selon sa convention à elle.
   * Une boisson du catalogue a des ingrédients **fixés par le modèle** — on n'en règle que les
   * quantités. Offrir la composition partout laisserait décocher le café d'un espresso, ce qui
   * n'est pas une recette mais une demande que l'appareil n'a jamais acceptée.
   *
   * ⚠️ **Ce drapeau ne décide plus de la PRÉSENTATION, seulement de l'activité de la case.** Il
   * commandait aussi le choix entre « groupes à cocher » et « liste à plat » : deux rendus pour un
   * même objet, dont un — celui des 28 boissons du catalogue — ne disait pas ce qui relevait du café
   * et ce qui relevait du lait. Les groupes valent partout maintenant ; ici la case compose, ailleurs
   * elle est cochée et inerte et son infobulle dit pourquoi. La limite du protocole est **dite** au
   * lieu d'être obtenue en cachant la structure.
   */
  /**
   * ⚠️ **Aucun drapeau « mode libre » ici, et c'est le point.** Une composition libre de `/recipes` se
   * compose parce que sa déclaration de bornes est **calculée** et ne porte donc aucun défaut
   * d'usine : la règle mesurée répond « composable » d'elle-même. Une variante d'affichage aurait
   * fait la même chose en donnant à ce fichier une seconde façon de se comporter.
   */
  const parIngredients: boolean = composable(all);
  /**
   * **Le marqueur `255` reste propre aux emplacements perso**, alors que la composabilité, elle, est
   * désormais mesurée. Deux faits distincts, deux tests : le mug de voyage est composable ET ne
   * porte pas ce marqueur (café absent, `TASTE = 3`). Voir `valeurAbsente`.
   */
  const marqueurOption = bev.customSlot !== null && bev.customSlot !== undefined;
  // La présence se lit dans les MÊMES valeurs que les curseurs : une recette rouverte doit
  // retrouver ses ingrédients cochés comme elle retrouve ses quantités.
  const presence = () => presenceInitiale(initial ?? bev.values?.params);
  const [presents, setPresents] = useState<Record<string, boolean>>(presence);

  if (!bev.bounds) {
    return <Alerte>{t("boundsNotRead")}</Alerte>;
  }
  if (!all.length) {
    return (
      <p className="sub">
        {t("noParams")}
      </p>
    );
  }

  /**
   * **Deux questions différentes, deux fonctions — et c'est le cœur de ce bloc.**
   *
   * `groupeAffiche` répond « sous quel titre ce réglage se lit-il ? », et vaut pour TOUTES les
   * boissons : c'est ce qui donne les groupes Café et Lait aux 28 boissons du catalogue, là où il
   * n'y avait qu'une liste à plat.
   *
   * `groupe` répond « la présence de cet ingrédient se COMPOSE-t-elle ? », et reste réservée aux
   * emplacements perso — les seuls où la machine accepte qu'on retire un ingrédient.
   *
   * ⚠️ **Ne jamais fusionner les deux.** C'est `groupe` que lit `valeurEnvoyee` : les confondre
   * ferait écrire quantité 0 / option 255 sur une boisson du catalogue, autrement dit réorganiser
   * un affichage changerait le café servi. Le rendu peut devenir commun ; la charge utile, non.
   */
  const groupeAffiche = (id: number) => groupeDe(id);
  const groupe = (id: number) => (parIngredients ? groupeDe(id) : null);

  /**
   * Ce qui part dans la trame. Un ingrédient décoché n'est pas « omis » : il est écrit ABSENT,
   * avec la convention de la machine elle-même — quantité 0, option 255. Omettre le paramètre
   * laisserait l'ancienne valeur en place, donc l'ingrédient présent.
   */
  const valeurEnvoyee = (b: Param): number => {
    const g = groupe(b.id);
    if (g && !presents[g.cle]) {
      // `null` = ne rien inventer pour cette option : on garde la valeur lue. C'est le cas du mug
      // de voyage, qui ne porte pas le marqueur 255 des emplacements perso.
      const absent = valeurAbsente(g, b.id, marqueurOption);
      if (absent !== null) return absent;
    }
    return vals[b.id] ?? seedFor(b);
  };
  const params: RecipeParam[] = all.map((b) => ({ id: b.id, value: valeurEnvoyee(b) }));

  /**
   * Cocher ou décocher un ingrédient.
   *
   * En le rallumant on redonne une valeur utilisable à ses réglages : celle enregistrée est le
   * marqueur d'absence (0, ou 255 pour une option) et tombe hors des bornes, donc la laisser
   * afficherait un curseur au mauvais bout de sa course. Le défaut du modèle d'abord, le minimum
   * sinon — la même règle que `valeurDepart`, pas une seconde.
   */
  const basculerIngredient = (g: (typeof INGREDIENTS)[number], actif: boolean) => {
    setPresents((prec) => ({ ...prec, [g.cle]: actif }));
    if (!actif) return;
    setVals((v) => {
      const suite = { ...v };
      for (const b of all) {
        if (b.id !== g.quantite && !g.options.includes(b.id)) continue;
        const cur = v[b.id];
        if (cur === undefined || cur < (b.min as number) || cur > (b.max as number)) {
          suite[b.id] = defautModele(b) ?? (b.min as number);
        }
      }
      return suite;
    });
  };

  /**
   * Les deux groupes — **déclarés par ce modèle ou non**. Ils ne sont plus filtrés : un ingrédient
   * que cette boisson ne porte pas se DIT au lieu de disparaître, parce qu'une disparition ne
   * distingue jamais « cette boisson n'a pas de lait » de « on ne l'a pas cherché ».
   */
  const groupes = INGREDIENTS.map((g) => ({
    g,
    qte: basic.find((b) => b.id === g.quantite) ?? null,
    // Un réglage CROISÉ appartient au groupe pour sa valeur d'absence, mais il ne s'affiche pas
    // dedans : « ordre lait/café » sous « Lait » proposait de régler l'ordre d'un café absent.
    opts: basic.filter((b) => g.options.includes(b.id) && !croiseDe(b.id)),
  }));
  /** Ceux que ce modèle déclare réellement — un ingrédient sans paramètre de quantité n'existe pas. */
  const declares = groupes.filter((x) => x.qte !== null);
  const declare = (cle: string) => declares.some((x) => x.g.cle === cle);
  /**
   * **La case est-elle cochée ?** Sur un emplacement perso, c'est la composition qui répond. Ailleurs
   * c'est le MODÈLE : la boisson déclare le café, donc le café est là, et la case le dit en étant
   * cochée et inerte.
   *
   * ⚠️ **Jamais `presents` hors d'un emplacement perso.** `presents` lit la présence dans la quantité
   * enregistrée, et le mug de voyage porte café, lait et eau chaude à **0** parce qu'ils n'ont jamais
   * été configurés : le lire ici décocherait son café et **ferait disparaître son curseur**. C'est
   * exactement la famille de bug que la règle « ne jamais filtrer sur `kind` » interdit, et elle a
   * déjà masqué ces trois réglages une fois.
   */
  const coche = (cle: string) => (parIngredients ? !!presents[cle] : declare(cle));
  /**
   * Les réglages croisés qu'on peut montrer : ceux que ce modèle déclare et dont TOUS les
   * ingrédients sont présents. Sinon ils ne sont pas cachés par prudence, ils sont **sans objet** —
   * il n'y a pas d'ordre entre un café et un lait quand l'un des deux n'est pas là.
   *
   * Une seule règle remplace les deux branches d'avant : `coche` sait déjà que « présent » veut dire
   * « coché » sur un perso et « déclaré » ailleurs.
   */
  const croises = CROISES.map((c) => ({ c, b: basic.find((x) => x.id === c.id) ?? null })).filter(
    (x) => x.b !== null && x.c.ingredients.every(coche),
  );
  /**
   * Ce qu'aucun groupe ne couvre reste rendu tel quel : rien ne doit disparaître par oubli. Il se lit
   * sur `groupeAffiche` et non sur `groupe`, sinon une boisson du catalogue verrait tous ses réglages
   * deux fois — une fois dans son groupe, une fois ici.
   */
  const horsGroupe = basic.filter((b) => groupeAffiche(b.id) === null);
  const aucunIngredient = parIngredients && declares.length > 0 && declares.every((x) => !presents[x.g.cle]);
  // Deux appels littéraux plutôt qu'une clé construite : `verif-messages.mjs` ne sait vérifier
  // que les littéraux, et une clé dynamique lui échapperait silencieusement.
  const nomGroupe = (cle: string) =>
    cle === "cafe" ? t("groupCoffee") : cle === "lait" ? t("groupMilk") : t("groupWater");
  const set = (b: Param, raw: number) =>
    setVals((v) => ({
      ...v,
      [b.id]: Math.min(b.max as number, Math.max(b.min as number, Number.isFinite(raw) ? raw : (b.min as number))),
    }));
  const dirty =
    adjustable.some((b) => vals[b.id] !== seedFor(b)) ||
    // Décocher un ingrédient ne touche à aucun curseur : sans ça, « réinitialiser » resterait
    // grisé alors que la recette a bel et bien changé.
    INGREDIENTS.some((g) => presents[g.cle] !== presence()[g.cle]);

  /**
   * Retour aux défauts du modèle — distinct de « réinitialiser », qui revient à ce que le profil a
   * enregistré. Purement local : rien ne part vers la machine avant « Préparer » ou « Écrire ».
   */
  const applyDefaults = () =>
    setVals((v) => Object.fromEntries(all.map((b) => [b.id, defOf(b) ?? v[b.id] ?? seedFor(b)])));
  const atDefaults = adjustable.every((b) => {
    const d = defOf(b);
    return d === null || (vals[b.id] ?? seedFor(b)) === d;
  });
  const noDefault = adjustable.filter((b) => defOf(b) === null).length;

  /**
   * Une ligne de réglage. Elle était une suite de largeurs fixes — libellé 150, curseur 150, champ
   * 80, puce 78 : 558 px incompressibles pour un paramètre, dans une carte qui peut en faire 300.
   * `.paramRow` laisse le libellé prendre sa ligne quand il faut et le curseur absorber le reste.
   */
  /**
   * **Un paramètre qui ne vaut que 0 ou 1 est un interrupteur, pas un curseur.**
   *
   * `VISIBLE` et `VISIBLE_IN_PROGRAMMING` sont des booléens : un curseur de deux crans, doublé d'un
   * champ numérique et bordé de « 0 » et « 1 », demande au lecteur de traduire lui-même deux
   * nombres en oui/non — et l'invite à taper une valeur qui n'existe pas. L'interrupteur dit l'état
   * et n'en propose aucun autre.
   *
   * Le critère est **intrinsèque au paramètre** (`min === 0 && max === 1`), pas une liste de noms :
   * ces deux-là ne sont pas des cas particuliers, ce sont les seuls booléens que ce modèle expose
   * aujourd'hui. Il ne dépend pas non plus de `kind` — c'est notre propre regroupement, pas le
   * protocole, et le contrôle d'un paramètre ne doit pas changer selon le bloc où on l'a rangé.
   *
   * `INVERSION` ne passe jamais par là : `min === max`, donc il est déjà écarté par `adjustable` et
   * reste envoyé tel quel dans la charge utile, ce qui est le comportement à préserver.
   */
  const bascule = (b: Param) => {
    const v = vals[b.id] ?? seedFor(b);
    return (
      <div className="paramRow" key={b.id}>
        <span className="nom">
          {paramLabel(b)}
          {b.unit ? ` (${unitLabel(b.unit)})` : ""}
        </span>
        <div className="ctl">
          <Switch
            size="sm"
            checked={v === 1}
            aria-label={paramLabel(b)}
            onCheckedChange={(c) => set(b, c ? 1 : 0)}
          />
          {defOf(b) !== null ? (
            <Button type="button" variant="neutre" size="coquille"
              
              disabled={v === defOf(b)}
              onClick={() => set(b, defOf(b) as number)}
              title={t("paramDefaultHint")}>
              {t("paramDefaultBool", { on: defOf(b) === 1 ? 1 : 0 })}
            </Button>
          ) : (
            <span className="sub" title={t("noParamDefaultHint")}>
              {t("noParamDefault")}
            </span>
          )}
        </div>
      </div>
    );
  };

  /**
   * **Les crans que la commande imprime, et la seule condition pour qu'elle en imprime.**
   *
   * La graduation sérigraphiée autour d'une commande est la pièce qui rend ce monde visuel propre
   * à ce produit : ses crans ne sont pas décoratifs, ce sont les valeurs que la MACHINE autorise
   * pour ce paramètre. D'où la condition — une déclaration `calculee` est assemblée ici, pas lue
   * sur l'appareil (c'est le cas d'une composition libre de `/recipes`), et graduer une piste avec
   * des crans qu'aucune lecture ne fonde reviendrait à afficher comme lu ce qui ne l'a pas été.
   * Sans crans, la piste reste un creux nu : elle dit qu'on ne connaît pas les bornes.
   *
   * Le plafond à 40 n'est pas une limite de dessin mais de lisibilité : au-delà, des traits d'un
   * pixel espacés de moins de trois se fondent en une bande grise, qui ne porte plus rien. On
   * retombe alors sur un cran tous les dix pas, ce qui reste vrai.
   */
  const cransDe = (b: Param): number | null => {
    if (bev.bounds?.calculee) return null;
    const min = b.min ?? 0;
    const max = b.max ?? 0;
    const etendue = max - min;
    if (etendue < 2) return null;
    return etendue <= 40 ? etendue : Math.max(Math.round(etendue / 10), 1);
  };

  const slider = (b: Param) => (
    <div className="paramRow" key={b.id}>
      <span className="nom">
        {paramLabel(b)}
        {b.unit ? ` (${unitLabel(b.unit)})` : ""}
      </span>
      <div
        className="ctl"
        style={cransDe(b) !== null ? ({ "--crans": cransDe(b) } as React.CSSProperties) : undefined}
      >
        <span className="sub mono">
          {b.min}
        </span>
        {/* La valeur est un tableau : Radix accepte plusieurs poignées, ce curseur n'en a qu'une.
            `?? seedFor(b)` reste la même règle qu'avant — pas de valeur, on repart du défaut. */}
        <Slider
          min={b.min}
          max={b.max}
          value={[vals[b.id] ?? seedFor(b)]}
          aria-label={`${paramLabel(b)} (${b.min}–${b.max})`}
          onValueChange={([v]) => set(b, v)}
        />
        <span className="sub mono">
          {b.max}
        </span>
        <Input
          className="w-[4.6rem] flex-none text-right"
          type="number"
          min={b.min}
          max={b.max}
          value={vals[b.id] ?? seedFor(b)}
          onChange={(e) => set(b, Number(e.target.value))}
        />
        {defOf(b) !== null ? (
          /* **Cette puce reste sans icone.** C'est le seul emploi de `.mini` conforme a sa
             definition — une puce qui AFFICHE une valeur, « defaut 40 », dans une ligne de reglage
             — et le bouton global juste au-dessus porte deja le rembobinage pour la meme action.
             Le glyphe serait repete jusqu'a sept fois par carte, sur vingt-huit cartes, en
             elargissant chaque fois une ligne qui contient deja un curseur et un champ. */
          <Button type="button" variant="neutre" size="coquille"
            
            disabled={(vals[b.id] ?? seedFor(b)) === defOf(b)}
            onClick={() => set(b, defOf(b) as number)}
            title={t("paramDefaultHint")}>
            {t("paramDefault", { value: defOf(b) as number })}
          </Button>
        ) : (
          <span className="sub" title={t("noParamDefaultHint")}>
            {t("noParamDefault")}
          </span>
        )}
      </div>
    </div>
  );

  /** Aiguillage : deux états ⇒ interrupteur, sinon curseur. */
  const reglage = (b: Param) => (b.min === 0 && b.max === 1 ? bascule(b) : slider(b));

  return (
    <div className="blocEditeur">
      {/* Cet avertissement n'existait que sur `/recipes`. Il porte sur la LECTURE des bornes,
          pas sur la page : une trame mal alignée rend douteuse toute valeur affichée, quel que
          soit l'écran qui la montre. */}
      {bev.bounds.exact === false && <Alerte className="note">{t("boundsMisaligned")}</Alerte>}
      <div className="cardHead chapeau">
        {/* Un titre, pas un `strong` : les 28 cartes ont gagné leur `h3`, et le bloc qui s'ouvre
            dedans restait le seul repère de la page inaccessible à une navigation par titres. */}
        <h4 className="cardTitle">{t("heading", { profile: profileName ?? tc("profileFallback", { id: profile }) })}</h4>
        <div className="row">
          {!bev.values && (
            <Badge variant="arret" title={t("valuesNotReadHint")}>
              {t("valuesNotRead")}
            </Badge>
          )}
          {dirty && (
            <Button type="button" variant="neutre" size="commande"
              className="iconBtn"
              onClick={() => {
                setVals(seed);
                setPresents(presence());
              }}
              title={t("resetTitle")}>
              <Icone nom="reinitialiser" />
              <span className="lbl">{tc("reset")}</span>
            </Button>
          )}
          <Button type="button" variant="neutre" size="coquille"
            className="iconBtn"
            disabled={atDefaults}
            onClick={applyDefaults}
            title={noDefault ? t("defaultsPartialTitle", { count: noDefault }) : t("defaultsTitle")}>
            <Icone nom="defauts" taille={15} />
            <span className="lbl">{t("defaults")}</span>
          </Button>
        </div>
      </div>

      {/* **Un seul rendu pour les deux cas ; la case ne décide plus que de sa propre activité.**
          Il y en avait deux : les groupes à cocher d'un emplacement perso, et une liste à plat pour
          les 28 boissons du catalogue. Qui avait appris l'une devait réapprendre l'autre, et sur la
          liste à plat rien ne disait ce qui relevait du café et ce qui relevait du lait.

          ⚠️ **La case n'est ACTIVE que là où la machine accepte la composition.** Ailleurs elle est
          cochée et inerte, avec l'infobulle qui dit pourquoi : offrir la composition partout
          laisserait décocher le café d'un espresso, ce qui n'est pas une recette mais une demande
          que l'appareil n'a jamais acceptée. La limite est dite, plus cachée. */}
      {declares.length > 0 ? (
        <>
          {groupes.map(({ g, qte, opts }) =>
            qte === null ? (
              /* Un ingrédient que ce modèle ne porte pas pour cette boisson : une ligne qui le DIT,
                 pas un bloc vide. C'est la seule forme qui distingue « pas de lait ici » de « on n'a
                 pas regardé », et elle coûte une ligne au lieu d'une boîte sur les douze boissons
                 sans lait. */
              <p className="groupeAbsent" key={g.cle}>
                {/* On NOMME la boisson au lieu de dire « ce modèle ». Dans ce dépôt « modèle »
                    désigne l'ECAM 610.75.MB, mais sur une carte qui nomme une RECETTE le lecteur y
                    entend le gabarit de la recette : le fait était juste et le mot désignait autre
                    chose. « Lait — Espresso n'en porte pas » ne peut se lire que d'une façon. */}
                {t("groupNotDeclared", { group: nomGroupe(g.cle), beverage: bevLabel(bev) })}
              </p>
            ) : (
              <div className={"blocIngredient" + (parIngredients ? "" : " fixe")} key={g.cle}>
                <span className="caseLibelle" title={parIngredients ? undefined : t("groupFixedHint")}>
                  <Checkbox
                    checked={coche(g.cle)}
                    aria-label={nomGroupe(g.cle)}
                    // Inerte hors d'un emplacement perso : les ingrédients y sont fixés par le
                    // modèle, seules leurs quantités se règlent.
                    disabled={!parIngredients}
                    onCheckedChange={(v) => basculerIngredient(g, v === true)}
                  />
                  <span>{nomGroupe(g.cle)}</span>
                </span>
                {coche(g.cle) && (
                  <>
                    {reglage(qte)}
                    {opts.map(reglage)}
                  </>
                )}
              </div>
            ),
          )}
          {/* Hors des groupes, entre eux et le reste : c'est un réglage de la RELATION entre deux
              ingrédients, pas un réglage de l'un d'eux. */}
          {croises.map(({ b }) => reglage(b as Param))}
          {horsGroupe.length > 0 && (
            <>
              {/* Nommer ce tas est ce qui l'empêche d'être lu comme un oubli du groupement : « 2
                  tasses » n'est ni du café ni du lait, et le dire vaut mieux que de le poser après
                  les groupes sans un mot. */}
              <p className="etiquetteGroupe">{t("groupOutside")}</p>
              {horsGroupe.map(reglage)}
            </>
          )}
          {/* Averti, pas interdit : rien dans le protocole ne dit qu'une recette vide est refusée,
              et inventer ce refus serait ajouter une règle que la machine n'a pas énoncée. */}
          {aucunIngredient && <Alerte>{t("noIngredient")}</Alerte>}
        </>
      ) : (
        /* Ni café ni lait déclarés — l'eau chaude, le thé. Le groupement n'apprend rien ici, et deux
           lignes « non déclaré » seraient deux lignes de bruit sur une boisson qui n'a jamais
           prétendu en porter. Liste à plat, comme avant. */
        basic.map(reglage)
      )}

      {/* **Nommer ce bloc, sinon « Hors groupes » l'annexe.** Un paramètre à valeur unique est rendu
          ici, après les groupes — et « Mélange » appartient POURTANT au café (`INGREDIENTS`), il
          n'est simplement pas réglable sur ce modèle. Sous le seul titre « Hors groupes » il se
          lisait comme n'appartenant à aucun groupe, ce qui est faux. Le titre n'apparaît que quand
          il y a des groupes : sans eux (eau chaude, thé) il n'y a rien à départager, et chaque ligne
          dit déjà « (imposé) ». */}
      {declares.length > 0 && fixed.length > 0 && <p className="etiquetteGroupe">{t("groupImposed")}</p>}
      {fixed.map((b) => (
        <div className="paramRow" key={b.id}>
          <span className="nom">
            {paramLabel(b)}
            {b.unit ? ` (${unitLabel(b.unit)})` : ""}
          </span>
          <span className="sub mono" title={t("imposedHint")}>
            {t("imposed", { value: b.min ?? 0 })}
          </span>
        </div>
      ))}

      {/* **Une seule barre d'actions pour la carte ouverte.** Les quatre boutons — deux depliants
          a gauche, deux actions a droite — occupaient trois lignes, dont deux ne portaient qu'un
          bouton chacune. Les depliants restent des depliants : leur contenu s'ouvre SOUS la barre,
          jamais au-dessus, sinon cliquer en bas ferait apparaitre du texte plus haut.

          Les deux actions gardent les memes glyphes que sur /recipes pour les memes gestes : la
          tasse coule la boisson avec ces valeurs, la machine nomme la destination de l'ecriture.
          Cette derniere est PERSISTANTE sur l'appareil — c'est la seule chose de cette carte qui
          survive a la fermeture de l'onglet. */}
      <div className="row note">
        {advanced.length > 0 && (
          /* Meme bascule que « Proprietes » sur /profils, donc meme chevron : il pivote au lieu
             de changer de dessin. */
          <Button type="button" variant="neutre" size="commande" className={"iconBtn" + (showAdvanced ? " ouvert" : "")} onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced}>
            <Icone nom="chevron" />
            <span className="lbl">{showAdvanced ? tc("hide") : t("advanced")} ({advanced.length})</span>
          </Button>
        )}
        {actions?.(params)}
        {onDispense && (
          <Button type="button" variant="marche" size="commande" className="iconBtn" disabled={busy} aria-busy={working || undefined} onClick={() => onDispense(params)}>
            <Icone nom="preparer" />
            <span className="lbl">{t("prepareWith")}</span>
          </Button>
        )}
        {onWrite && (
          <Button type="button" variant="neutre" size="commande"
            className="iconBtn"
            disabled={busy}
            aria-busy={working || undefined}
            onClick={() => onWrite(params)}
            title={t("writeTitle")}>
            <Icone nom="machine" />
            <span className="lbl">{t("writeTo", { profile: profileName ?? tc("profileFallback", { id: profile }) })}</span>
          </Button>
        )}
      </div>

      {advanced.length > 0 && showAdvanced && (
        <div className="blocSuite">
          <p className="chapeau">{t("advancedNote")}</p>
          {advanced.map(reglage)}
        </div>
      )}

      {panneau?.(params)}
    </div>
  );
}
