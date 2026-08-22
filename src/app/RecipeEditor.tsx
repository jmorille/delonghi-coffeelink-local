"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useParamLabel, useUnitLabel } from "@/i18n/labels";
import { INGREDIENTS, groupeDe, presenceInitiale, valeurAbsente } from "./ingredients";
import { beverageParams, defautModele, valeurDepart, type Beverage, type Param, type RecipeParam } from "./beverage";
import Icone from "./icons";
import Alerte from "./Alerte";

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
  onWrite: (params: RecipeParam[]) => void;
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
}) {
  const t = useTranslations("editor");
  const tc = useTranslations("common");
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
  const estPerso = bev.customSlot !== null && bev.customSlot !== undefined;
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

  /** Le groupement ne vaut QUE pour un emplacement perso : ailleurs les ingrédients ne se choisissent pas. */
  const groupe = (id: number) => (estPerso ? groupeDe(id) : null);

  /**
   * Ce qui part dans la trame. Un ingrédient décoché n'est pas « omis » : il est écrit ABSENT,
   * avec la convention de la machine elle-même — quantité 0, option 255. Omettre le paramètre
   * laisserait l'ancienne valeur en place, donc l'ingrédient présent.
   */
  const valeurEnvoyee = (b: Param): number => {
    const g = groupe(b.id);
    if (g && !presents[g.cle]) return valeurAbsente(g, b.id);
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

  /** Les groupes que ce modèle déclare réellement — un ingrédient sans paramètre n'existe pas. */
  const groupes = INGREDIENTS.map((g) => ({
    g,
    qte: basic.find((b) => b.id === g.quantite) ?? null,
    opts: basic.filter((b) => g.options.includes(b.id)),
  })).filter((x) => x.qte !== null);
  /** Ce qu'aucun groupe ne couvre reste rendu tel quel : rien ne doit disparaître par oubli. */
  const horsGroupe = basic.filter((b) => groupe(b.id) === null);
  const aucunIngredient = groupes.length > 0 && groupes.every((x) => !presents[x.g.cle]);
  // Deux appels littéraux plutôt qu'une clé construite : `verif-messages.mjs` ne sait vérifier
  // que les littéraux, et une clé dynamique lui échapperait silencieusement.
  const nomGroupe = (cle: string) => (cle === "cafe" ? t("groupCoffee") : t("groupMilk"));
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
          <label className="switch">
            <input
              type="checkbox"
              checked={v === 1}
              aria-label={paramLabel(b)}
              onChange={(e) => set(b, e.target.checked ? 1 : 0)}
            />
            <span className="track" aria-hidden="true">
              <span className="knob" />
            </span>
          </label>
          {defOf(b) !== null ? (
            <button
              className="mini"
              disabled={v === defOf(b)}
              onClick={() => set(b, defOf(b) as number)}
              title={t("paramDefaultHint")}
            >
              {t("paramDefaultBool", { on: defOf(b) === 1 ? 1 : 0 })}
            </button>
          ) : (
            <span className="sub" title={t("noParamDefaultHint")}>
              {t("noParamDefault")}
            </span>
          )}
        </div>
      </div>
    );
  };

  const slider = (b: Param) => (
    <div className="paramRow" key={b.id}>
      <span className="nom">
        {paramLabel(b)}
        {b.unit ? ` (${unitLabel(b.unit)})` : ""}
      </span>
      <div className="ctl">
        <span className="sub mono">
          {b.min}
        </span>
        <input
          type="range"
          min={b.min}
          max={b.max}
          value={vals[b.id] ?? seedFor(b)}
          aria-label={`${paramLabel(b)} (${b.min}–${b.max})`}
          onChange={(e) => set(b, Number(e.target.value))}
        />
        <span className="sub mono">
          {b.max}
        </span>
        <input
          className="numField"
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
          <button
            className="mini"
            disabled={(vals[b.id] ?? seedFor(b)) === defOf(b)}
            onClick={() => set(b, defOf(b) as number)}
            title={t("paramDefaultHint")}
          >
            {t("paramDefault", { value: defOf(b) as number })}
          </button>
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
            <span className="pill off" title={t("valuesNotReadHint")}>
              {t("valuesNotRead")}
            </span>
          )}
          {dirty && (
            <button
              className="iconBtn"
              onClick={() => {
                setVals(seed);
                setPresents(presence());
              }}
              title={t("resetTitle")}
            >
              <Icone nom="reinitialiser" />
              <span className="lbl">{tc("reset")}</span>
            </button>
          )}
          <button
            className="mini iconBtn"
            disabled={atDefaults}
            onClick={applyDefaults}
            title={noDefault ? t("defaultsPartialTitle", { count: noDefault }) : t("defaultsTitle")}
          >
            <Icone nom="defauts" taille={15} />
            <span className="lbl">{t("defaults")}</span>
          </button>
        </div>
      </div>

      {/* **Un emplacement perso se règle par ingrédient**, comme l'écran de création de
          l'application : on coche, et les réglages de cet ingrédient s'ouvrent. Les boissons du
          catalogue gardent la liste à plat — leurs ingrédients ne se choisissent pas. */}
      {estPerso ? (
        <>
          <p className="chapeau">{t("ingredientsHint")}</p>
          {groupes.map(({ g, qte, opts }) => (
            <div className="blocIngredient" key={g.cle}>
              <label className="caseLibelle">
                <input
                  type="checkbox"
                  checked={!!presents[g.cle]}
                  onChange={(e) => basculerIngredient(g, e.target.checked)}
                />
                <span>{nomGroupe(g.cle)}</span>
              </label>
              {presents[g.cle] && (
                <>
                  {reglage(qte as Param)}
                  {opts.map(reglage)}
                </>
              )}
            </div>
          ))}
          {horsGroupe.map(reglage)}
          {/* Averti, pas interdit : rien dans le protocole ne dit qu'une recette vide est refusée,
              et inventer ce refus serait ajouter une règle que la machine n'a pas énoncée. */}
          {aucunIngredient && <Alerte>{t("noIngredient")}</Alerte>}
          <p className="sub">{t("noWaterHere")}</p>
        </>
      ) : (
        basic.map(reglage)
      )}

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
          <button className={"iconBtn" + (showAdvanced ? " ouvert" : "")} onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced}>
            <Icone nom="chevron" />
            <span className="lbl">{showAdvanced ? tc("hide") : t("advanced")} ({advanced.length})</span>
          </button>
        )}
        {actions?.(params)}
        {onDispense && (
          <button className="good iconBtn" disabled={busy} aria-busy={working || undefined} onClick={() => onDispense(params)}>
            <Icone nom="preparer" />
            <span className="lbl">{t("prepareWith")}</span>
          </button>
        )}
        <button
          className="primary iconBtn"
          disabled={busy}
          aria-busy={working || undefined}
          onClick={() => onWrite(params)}
          title={t("writeTitle")}
        >
          <Icone nom="machine" />
          <span className="lbl">{t("writeTo", { profile: profileName ?? tc("profileFallback", { id: profile }) })}</span>
        </button>
      </div>

      {advanced.length > 0 && showAdvanced && (
        <div className="blocSuite">
          <p className="chapeau">{t("advancedNote")}</p>
          {advanced.map(reglage)}
        </div>
      )}
    </div>
  );
}
