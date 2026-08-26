"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";
import { mfetch } from "../machine";
import { useConfirm } from "../confirm";
import Icone from "../icons";
import Alerte from "../Alerte";
import BeverageCard, { type Report } from "../BeverageCard";
import { paramOf, resumeReglages, type Beverage, type Param, type RecipeParam } from "../beverage";
// La liste des réglages qui portent une QUANTITÉ vient du module qui décide déjà ce qu'un transfert
// emporte : deux listes de « ce qui remplit la tasse » divergeraient à la première correction.
import { QUANTITES } from "@/lib/transfert.mjs";
// La table des ingredients : elle sert ici a trouver la boisson qui en porte le plus, celle qui
// servira de support technique a une composition libre.
import { INGREDIENTS } from "@/lib/ingredients.mjs";
import { TWO, encodeRecipeBounds } from "@/lib/trame-bornes.mjs";
import { Input } from "@/ui/input";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

/**
 * **La bibliothèque de recettes locales, avec la carte et l'éditeur des boissons — pas les siens.**
 *
 * Cette page a déjà perdu son éditeur au profit de `RecipeEditor` ; elle perd ici sa présentation
 * au profit de `BeverageCard`. Le motif est le même les deux fois : une recette locale et une
 * boisson de la machine sont le même objet vu de deux endroits, et deux dessins pour un objet
 * divergent à la première correction — la première version listait les réglages dans une cellule
 * de tableau, la deuxième en faisait des cartes qui ressemblaient à celles de `/` sans en être.
 *
 * Ce qui reste vraiment à cette page : **nommer** une recette, lui **choisir un dessin**, la
 * garder ici, la rouvrir, la supprimer — et les deux gestes qui la mènent à l'appareil :
 *
 * - **Préparer** : la recette part telle quelle (`{action:"dispense", recipeId}`). Le chemin
 *   existait côté serveur depuis toujours et n'avait jamais eu de bouton.
 * - **Transférer** : la recette prend la place d'un emplacement perso de la machine — `0x83` pour
 *   les réglages, `0xAB` pour le nom et l'image, **une seule tâche de deux pas**. C'est une
 *   écriture persistante, d'où une confirmation qui nomme l'emplacement écrasé, comme le fait
 *   déjà `/beans` pour une configuration de grains.
 *
 * ⚠️ **Un emplacement perso ne déclare ni eau chaude ni thé** : une recette qui en porte ne peut
 * pas être transférée. C'est une limite de la cafetière, établie par trois vérifications
 * concordantes (voir `src/lib/ingredients.mjs`), et le serveur la rend sous forme de **clé** que
 * cette page traduit. Le bouton disparaît alors en DISANT pourquoi — le retirer en silence ferait
 * passer une limite de l'appareil pour une panne de l'application.
 *
 * Le choix d'image passe par la même grille que sur `/`, ouverte par la vignette de tête de la
 * carte, et n'a pas le même effet : là-bas un clic ÉCRIT dans la machine, ici il ne règle que la
 * recette locale. C'est l'infobulle portée par chaque dessin (`titreChoix`) qui le dit — il n'y a
 * plus de bouton intermédiaire pour le porter.
 */

/** Ce que l'utilisateur a enregistré. Le serveur normalise à la lecture : `icon` et `apercu`
 *  existent même pour une recette d'avant ce format. */
interface Recette {
  id: string;
  name: string;
  beverageId: number;
  profileId: number;
  params: RecipeParam[];
  icon: number | null;
  apercu: { label: string; slug: string; category: string; milk: boolean } | null;
  updatedAt: number | null;
}
/** Un emplacement perso de la machine, **nommé ou non** : on transfère volontiers dans un vierge. */
interface Emplacement {
  id: number;
  slot: number;
  name: string | null;
  icon: number | null;
  /**
   * Les réglages de la recette que CET emplacement ne déclare pas, et qui ne partiront donc pas.
   * Des identifiants : c'est ici qu'on les nomme. Vide dans le cas courant ; non vide depuis qu'une
   * recette peut porter de l'eau chaude (le mug de voyage), qu'aucun emplacement ne déclare.
   */
  retires?: number[];
}
interface Entree {
  recipe: Recette;
  /** `null` si le catalogue du modèle ne connaît pas cet identifiant — machine ou modèle changé. */
  beverage: Beverage | null;
  transfert: { possible: boolean; raison: string | null; emplacements: Emplacement[] };
}
interface Payload {
  recipes: Entree[];
  slots: Emplacement[];
}

/** Le brouillon de la carte ouverte — nouvelle recette ou recette rouverte. */
interface Brouillon {
  id: string;
  name: string;
  beverageId: number;
  icon: number | null;
}

/** Identifiant technique : il ne s'affiche plus nulle part, donc il s'engendre. */
const nouvelId = () =>
  globalThis.crypto?.randomUUID?.() ?? `r-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * La carte ouverte : une recette par son identifiant, ou la carte de création.
 *
 * Le `@` garantit l'absence de collision — les identifiants sont des UUID, qui n'en contiennent
 * jamais — sans dépendre d'un état supplémentaire pour distinguer « je crée » de « je modifie ».
 */
const NOUVELLE = "@nouvelle";

export default function Recipes() {
  const t = useTranslations("recipes");
  const tc = useTranslations("common");
  // Les confirmations de préparation sont celles de `/` : même geste, même trame, mêmes mots.
  const tb = useTranslations("beverages");
  const bevLabel = useBeverageLabel();
  const paramLabel = useParamLabel();
  const unitLabel = useUnitLabel();

  const [data, setData] = useState<Payload | null>(null);
  const [beverages, setBeverages] = useState<Beverage[]>([]);
  /** Le profil des NOUVELLES recettes. Une recette enregistrée garde le sien, et sa carte le dit. */
  /**
   * **Le profil d'une recette CRÉÉE est 1, et ce n'est plus un choix.**
   *
   * Le sélecteur a été retiré sur décision du propriétaire : une recette de `/recipes` est une
   * composition libre stockée en base, et le profil n'y servait qu'à amorcer des valeurs qu'on ne
   * veut justement plus imposer. Il reste **stocké** parce que les gestes qui atteignent l'appareil
   * en ont besoin — « Écrire dans le profil » encode `(profileId << 2) | action` — et une recette
   * enregistrée garde le sien, que sa carte affiche.
   */
  const PROFIL_LIBRE = 1;
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Brouillon | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const { demander, dialogue } = useConfirm();

  const dire = (scope: string, text: string, kind: "ok" | "err" = "ok") => setReport({ scope, text, kind });

  const load = useCallback(
    () => mfetch("/api/recipes").then((r) => r.json()).then((d: Payload) => setData(d)).catch(() => {}),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  // ⚠️ `mfetch`, JAMAIS `fetch` nu : un appel nu vise la machine PAR DÉFAUT, pas celle qui est
  // sélectionnée. Ici le prix n'est pas cosmétique — cette page lit un catalogue et des bornes
  // d'une machine, puis écrit sur une autre.
  useEffect(() => {
    mfetch(`/api/beverages?profile=${PROFIL_LIBRE}`)
      .then((r) => r.json())
      .then((d) => setBeverages(d.beverages ?? []))
      .catch(() => {});
  }, []);

  /**
   * **Le support technique d'une composition libre.**
   *
   * Une recette libre n'a plus de boisson choisie à la main. Elle en a pourtant besoin d'une : l'octet
   * 4 de la trame `0x83` EST un identifiant de boisson, et les curseurs ont besoin de bornes. On la
   * **dérive** donc au lieu de la demander — celle du modèle qui déclare le plus d'ingrédients, à
   * égalité celle qui a le plus de paramètres. Sur une ECAM 610.75.MB c'est le **mug de voyage**, la
   * seule à porter café + lait + eau chaude ; sur un autre modèle ce sera la sienne, sans rien à
   * changer ici.
   *
   * ⚠️ Elle sert de **cible** — l'identifiant que la recette stocke, celui que la trame portera — et
   * NON de source de bornes : celles-là sont calculées, voir `bevLibre`.
   */
  const supportLibre = useMemo(() => {
    const score = (b: Beverage) => INGREDIENTS.filter((g) => b.ingredients.includes(g.quantite)).length;
    return beverages.reduce<Beverage | null>(
      (meilleur, b) =>
        meilleur === null ||
        score(b) > score(meilleur) ||
        (score(b) === score(meilleur) && b.ingredients.length > meilleur.ingredients.length)
          ? b
          : meilleur,
      null,
    );
  }, [beverages]);

  /**
   * **La déclaration de bornes d'une recette libre est CALCULÉE, pas lue.**
   *
   * Une carte de boisson travaille normalement sur la trame `0xB0` que la machine a envoyée pour
   * CETTE boisson : min / défaut / max, paramètre par paramètre. Une composition libre n'a pas de
   * boisson, donc pas de trame à lire — elle a la **capacité du modèle**. On assemble donc la
   * déclaration : pour chaque paramètre d'ingrédient, l'étendue la plus large que ce modèle publie,
   * toutes boissons confondues (`min` le plus bas, `max` le plus haut).
   *
   * **Aucun défaut d'usine, délibérément.** `def` est posé hors bornes — la convention même de la
   * machine pour « jamais configuré ». C'est vrai (le modèle n'a rien décidé de cette composition) et
   * ça a une conséquence utile : la règle mesurée `composable()` répond « composable » d'elle-même,
   * donc les trois cases sont ouvertes sans qu'aucun drapeau d'affichage ait à l'imposer.
   *
   * ⚠️ **Libre porte sur la COMPOSITION, jamais sur les valeurs.** Ce qu'on choisit ici, c'est quels
   * ingrédients entrent dans la tasse ; chaque valeur reste tenue par la borne que la machine publie
   * pour CE paramètre, et les curseurs l'imposent — il n'existe donc aucune valeur hors bornes à
   * signaler. C'est ce qui a permis de retirer les deux verdicts qui vivaient ici : ils confrontaient
   * une composition libre aux bornes d'UNE boisson enregistrée, ce qui n'est pas la contrainte.
   *
   * La borne d'un paramètre est donc prise **sur le paramètre** : l'étendue la plus large que ce
   * modèle publie pour lui, toutes boissons confondues. Chaque valeur atteignable reste une valeur
   * que l'appareil déclare autorisée pour ce réglage ; aucune n'est inventée.
   */
  const bornesLarges = useMemo(() => {
    const large = new Map<number, Param>();
    for (const b of beverages) {
      for (const p of b.bounds?.params ?? []) {
        if (p.min === undefined || p.max === undefined) continue;
        const prec = large.get(p.id);
        large.set(
          p.id,
          prec
            ? { ...prec, min: Math.min(prec.min as number, p.min), max: Math.max(prec.max as number, p.max) }
            : { ...p },
        );
      }
    }
    return large;
  }, [beverages]);

  /**
   * **Un défaut qui dit « jamais configuré », et qui tient dans son octet.**
   *
   * La convention est celle de la machine : un défaut hors de ses propres bornes signifie que le
   * modèle n'a rien décidé (le mug de voyage donne 0 sous un minimum de 40). C'est ce qui fait
   * répondre `composable()` par elle-même, sans drapeau d'affichage — voir `declarationLibre`.
   *
   * ⚠️ `min - 1` seul ne suffit pas, et la trame calculée l'a démontré au premier rendu : un
   * paramètre de minimum 0 (`BLEND`, `INVERSION`, `ACCESSORIO`, `VISIBLE`…) donnait **-1**, qu'aucun
   * octet ne porte — l'encodeur lève plutôt que de tronquer, et il a eu raison. On sort donc par le
   * bas quand c'est possible, par le haut sinon. Un paramètre qui occuperait toute la largeur
   * n'aurait aucune valeur hors bornes à offrir : on garde alors le défaut tel quel, ce qui est le
   * seul énoncé vrai disponible.
   */
  const defautAbsent = (p: Param): number => {
    const min = p.min as number;
    const max = p.max as number;
    const large = TWO.has(p.id) ? 0xffff : 0xff;
    if (min > 0) return min - 1;
    if (max < large) return max + 1;
    return p.def ?? min;
  };

  /**
   * **La même déclaration pour une recette qu'on crée et pour une recette qu'on rouvre.**
   *
   * Montée sur la boisson stockée telle quelle, une carte de recette rendait ses curseurs avec les
   * bornes de CETTE boisson — donc une composition enregistrée sous des bornes de paramètre pouvait
   * se retrouver hors de celles d'une boisson, et il fallait un message pour le dire. La déclaration
   * remplace les bornes et **rien d'autre** : l'identité de la boisson est conservée, ce qui garde
   * juste ce que « Infos techniques » nomme et ce que la trame portera.
   */
  const declarationLibre = (b: Beverage): Beverage => {
    // Les ingrédients et leurs options, dans l'ordre de la table — et rien d'autre : `PROGRAMABLE`
    // et `VISIBLE` décrivent un emplacement de la machine, pas une recette gardée en base.
    const ids = INGREDIENTS.flatMap((g) => [g.quantite, ...g.options]).filter((id) => bornesLarges.has(id));
    const params = ids.map((id) => {
      const p = bornesLarges.get(id) as Param;
      return { ...p, def: defautAbsent(p) };
    });
    return {
      ...b,
      ingredients: ids,
      /**
       * **La trame est CALCULÉE, et elle est réellement construite** — pas laissée vide. « Infos
       * techniques » montrait « Trame lue (bornes 0xB0) » suivie de rien, ce qui décrivait deux
       * choses fausses à la fois : qu'il y avait eu une lecture, et qu'elle n'avait rien rendu.
       * `encodeRecipeBounds` est l'inverse exact du décodeur, et `verif-transfert.mjs` le prouve en
       * réencodant à l'identique les sept trames réelles de `doc/format-trame-boisson.md`, CRC
       * compris. Ce qui s'affiche est donc une trame que la machine reconnaîtrait.
       */
      bounds: {
        at: Date.now(),
        kind: "bounds",
        exact: true,
        params,
        hex: encodeRecipeBounds(b.id, params).hex,
        calculee: true,
      },
      /**
       * Une liste VIDE, pas `null`. `null` veut dire « on n'a pas lu les valeurs du profil » et
       * l'éditeur l'affiche en pastille — un avertissement faux ici : une composition libre n'a pas
       * de valeurs de profil, ce n'est pas une lecture manquante. Vide, chaque réglage part de son
       * minimum (aucun défaut n'est utilisable), ce qui est le comportement voulu.
       */
      values: { at: Date.now(), kind: "values", exact: true, params: [], hex: "" },
      counter: null,
      beanSystem: null,
      /**
       * **Aucune propriété, parce qu'aucune lecture.** « Propriété bornes : `d020_rec_mug_to_go` » à
       * côté d'une trame *calculée* désignerait la source d'une valeur qui n'en vient pas — la
       * contradiction exacte que l'étiquette « Trame calculée » vient de lever. Le panneau rend « — »,
       * qui est vrai.
       */
      boundsProp: null,
      valuesProp: null,
    };
  };

  const bevLibre = useMemo(
    () => (supportLibre ? declarationLibre(supportLibre) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [supportLibre, bornesLarges],
  );

  /**
   * Ouvrir une carte. Une recette rouverte repart de ce qu'elle a enregistré — c'est le rôle de
   * `initial` sur la carte — et son nom comme son dessin viennent d'elle, jamais du profil.
   */
  const ouvrir = (e: Entree) => {
    setReport(null);
    if (open === e.recipe.id) {
      setOpen(null);
      setDraft(null);
      return;
    }
    setOpen(e.recipe.id);
    setDraft({ id: e.recipe.id, name: e.recipe.name, beverageId: e.recipe.beverageId, icon: e.recipe.icon });
  };

  /**
   * **La création ne part plus d'une boisson : elle part d'une déclaration calculée.**
   *
   * ⚠️ Deux raisons se sont succédé ici et il faut les retirer toutes les deux. La première disait
   * qu'on partait d'un emplacement perso parce qu'« une boisson du catalogue est celle où rien ne se
   * compose » : faux depuis que la composabilité est mesurée (le mug de voyage est du catalogue et
   * compose). La seconde disait qu'on partait du support le plus large : plus exact, mais encore une
   * boisson.
   *
   * Sur décision du propriétaire, une recette de `/recipes` est une **composition libre stockée
   * exclusivement en base** : ses bornes sont assemblées à partir de la capacité du modèle
   * (`bevLibre`), aucune case n'est restreinte, et il n'y a plus rien à choisir au départ. La
   * boisson-cible (`supportLibre`) et le profil (`PROFIL_LIBRE`) sont dérivés et stockés parce que
   * les gestes qui atteignent l'appareil en ont besoin — ce ne sont plus des questions posées.
   */
  const ouvrirNouvelle = () => {
    setReport(null);
    if (open === NOUVELLE) {
      setOpen(null);
      setDraft(null);
      return;
    }
    if (!supportLibre) return;
    setOpen(NOUVELLE);
    // Pas de dessin imposé : c'est la recette qui en choisit un, par la vignette de sa tête de carte.
    setDraft({ id: nouvelId(), name: "", beverageId: supportLibre.id, icon: null });
  };

  const enregistrer = async (params: RecipeParam[], profil: number) => {
    if (!draft) return;
    if (!draft.name.trim()) {
      dire(draft.id, t("nameRequired"), "err");
      return;
    }
    setBusy(true);
    try {
      const r = await mfetch("/api/recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id,
          name: draft.name.trim(),
          beverageId: draft.beverageId,
          profileId: profil,
          icon: draft.icon,
          params,
        }),
      }).then((x) => x.json());
      if (r.error) {
        dire(draft.id, tc("error", { message: r.error }), "err");
        return;
      }
      setData(r);
      setOpen(null);
      setDraft(null);
      /**
       * Aucun verdict à l'enregistrement. Une version l'a essayé — « « Mug de voyage » n'accepterait
       * pas ces valeurs » — et c'était juger une composition LIBRE à l'aune d'une boisson de la
       * machine. La boisson stockée est un détail de mise en œuvre ; la confrontation avec ce que
       * l'appareil accepte se fait au moment du transfert, pas ici.
       */
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const supprimer = (e: Entree) =>
    demander({
      question: t("deleteConfirm", { name: e.recipe.name }),
      onConfirm: async () => {
        const r = await mfetch("/api/recipes?id=" + encodeURIComponent(e.recipe.id), { method: "DELETE" }).then((x) => x.json());
        if (!r.error) {
          setData(r);
          if (open === e.recipe.id) {
            setOpen(null);
            setDraft(null);
          }
        }
      },
    });

  /**
   * **Préparer.** Sans `params`, c'est la recette ENREGISTRÉE qui part (`recipeId`) ; avec, ce sont
   * les valeurs affichées dans l'éditeur. La distinction compte : les deux boutons cohabitent sur
   * une carte ouverte, et confirmer « ces valeurs » pour envoyer les autres serait exactement le
   * défaut que `/` a déjà corrigé une fois.
   */
  const preparer = (e: Entree, params?: RecipeParam[]) => {
    const bev = e.beverage;
    if (!bev) return;
    const nom = bevLabel(bev);
    const corps = params
      ? { action: "dispense", beverageId: bev.id, profileId: e.recipe.profileId, params }
      : { action: "dispense", recipeId: e.recipe.id };
    demander({
      question: tb("confirmPrepare", { beverage: e.recipe.name || nom, profile: String(e.recipe.profileId) }),
      detail: resumeReglages(bev, params ?? e.recipe.params, paramLabel, unitLabel, (c) => tb("confirmPrepareMore", { count: c })) || undefined,
      source: params ? tb("prepareFromEditor") : t("prepareFromRecipe", { name: e.recipe.name }),
      warn: tb("confirmPrepareWarning"),
      geste: "dispense",
      onConfirm: async () => {
        setBusy(true);
        try {
          const r = await mfetch("/api/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(corps),
          }).then((x) => x.json());
          // Aucun message de succès : la barre de progression de la machine raconte la suite mieux
          // qu'une phrase. Les refus, eux, s'affichent toujours.
          if (r.error) dire(e.recipe.id, tc("error", { message: r.error }), "err");
        } finally {
          setBusy(false);
        }
      },
    });
  };

  /**
   * **Écrire la recette dans le profil de la machine** — `0x83` mode DONTCARE, action SAVE_BEVERAGE.
   * Écriture persistante, qui part au clic : c'est le MÊME geste que « Écrire dans le profil » sur
   * `/`, même trame, même endpoint, et deux comportements pour un seul acte selon la page seraient
   * pires que l'un ou l'autre. L'avertissement vit dans l'infobulle du bouton de l'éditeur.
   */
  const ecrireDansProfil = async (e: Entree, params: RecipeParam[]) => {
    if (!e.beverage) return;
    setBusy(true);
    try {
      const r = await mfetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "saveToProfile", beverageId: e.beverage.id, profileId: e.recipe.profileId, params }),
      }).then((x) => x.json());
      if (r.error) dire(e.recipe.id, tc("error", { message: r.error }), "err");
      else dire(e.recipe.id, t("writeSent", { checksum: r.checksumBefore != null ? "0x" + r.checksumBefore.toString(16) : tc("unknown") }));
    } finally {
      setBusy(false);
    }
  };

  /**
   * **Transférer dans un emplacement de la machine — DEUX écritures persistantes.** La confirmation
   * nomme l'emplacement écrasé ET ce qu'il contient aujourd'hui, comme celle de `/beans` : c'est la
   * seule chose qui permette de reconnaître qu'on s'apprête à écraser la mauvaise.
   */
  const transferer = (e: Entree, slot: number) => {
    const cible = e.transfert.emplacements.find((x) => x.slot === slot) ?? null;
    const laisses = e.beverage ? perdus(e.beverage, cible?.retires, e.recipe.params) : "";
    demander({
      question: t("transferConfirm", {
        name: e.recipe.name,
        slot,
        current: cible?.name ?? t("slotUnnamed"),
      }),
      // Nommé AVANT l'écriture, pas constaté après : c'est le dernier moment où l'on peut renoncer.
      detail: laisses ? t("transferDrops", { list: laisses }) : undefined,
      warn: t("transferWarning"),
      onConfirm: async () => {
        setBusy(true);
        try {
          const r = await mfetch("/api/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "transferToSlot", recipeId: e.recipe.id, slot, profileId: e.recipe.profileId }),
          }).then((x) => x.json());
          if (r.needsIcon) dire(e.recipe.id, t("transferNeedsIcon"), "err");
          else if (r.error) dire(e.recipe.id, tc("error", { message: r.error }), "err");
          else dire(e.recipe.id, t("transferSent", { slot, count: r.plan?.params?.length ?? 0 }));
        } finally {
          setBusy(false);
        }
      },
    });
  };

  /**
   * **Ce que la carte fermée dit d'une recette : de quoi estimer le verre.**
   *
   * « Café 40 ml · Lait 100 ml », et rien d'autre. La légende habituelle d'une carte de boisson —
   * nom d'usine, compte de paramètres, compteur de catégorie — répond à la question de `/` (quelle
   * boisson de la machine ?) et pas à celle d'ici (laquelle de mes recettes, et quelle taille ?).
   *
   * Une quantité à zéro est **omise** : c'est la convention d'absence de la machine, pas un volume.
   */
  const contenance = (e: Entree, bev: Beverage) => {
    // `bev` est la déclaration (voir `declarationLibre`), pas la boisson stockée : celle-ci ne
    // déclare pas forcément le lait d'une composition libre, et l'affiche disait alors « #9 30 ».
    const bouts = e.recipe.params
      .filter((x) => QUANTITES.includes(x.id) && x.value > 0)
      .map((x) => {
        const info = paramOf(bev, x.id);
        return `${info ? paramLabel(info) : "#" + x.id} ${x.value}${info?.unit ? " " + unitLabel(info.unit) : ""}`;
      });
    return bouts.length ? bouts.join(" · ") : t("noVolume");
  };

  /**
   * **Ce qu'un transfert PERDRAIT, nommé.** Le serveur envoie des identifiants ; le nom d'un réglage
   * se lit dans la boisson visée.
   *
   * ⚠️ Ça n'arrive pas pour rien : un emplacement perso ne déclare pas l'eau chaude, donc une
   * recette du mug de voyage qui en porte se transfère quand même — le café et le lait passent — et
   * **perdrait son eau en annonçant une réussite**. `planTransfert` l'a toujours listé ; rien ne le
   * montrait.
   */
  const perdus = (bev: Beverage, ids: number[] | undefined, params: RecipeParam[]) => {
    const porte = new Map(params.map((x) => [x.id, x.value]));
    return (ids ?? [])
      /**
       * Une quantité à **zéro** est le marqueur d'absence de la machine : ne pas la transférer ne
       * perd rien, et l'annoncer transformait une non-perte en avertissement. Vu sur une recette
       * dont l'eau chaude est décochée — la ligne parlait d'une eau qui n'existait pas.
       */
      .filter((id) => !(QUANTITES.includes(id) && (porte.get(id) ?? 0) === 0))
      .map((id) => {
        const info = paramOf(bev, id);
        return info ? paramLabel(info) : "#" + id;
      })
      .join(" · ");
  };

  /** La raison d'un refus arrive en CLÉ depuis le serveur : rien de traduisible ne traverse l'API. */
  const raison = (cle: string | null) =>
    cle === "hotWaterNotInCustomSlot" ? t("reasonHotWater") : cle === "noCustomSlot" ? t("reasonNoSlot") : t("reasonNothing");

  /**
   * **Ce qui appartient à la RECETTE : son nom, et son dessin par la vignette de tête.**
   *
   * Les sélecteurs « Boisson » et « Profil » ont été retirés sur décision du propriétaire : une
   * recette de `/recipes` est une composition libre stockée exclusivement en base, donc rien ne se
   * choisit ici qui appartienne à la machine. La boisson-cible est dérivée (`supportLibre`) et le
   * profil vaut `PROFIL_LIBRE` — tous deux stockés, parce que les gestes qui atteignent l'appareil en
   * ont besoin, mais aucun des deux n'est une question posée à l'utilisateur.
   */
  const identite = () =>
    draft && (
      <>
        <div className="row">
          <div>
            <label htmlFor="rname">{t("name")}</label>
            <Input
              id="rname"
              value={draft.name}
              onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
              placeholder={t("namePlaceholder")}
              maxLength={20}
            />
          </div>
        </div>
        {/* **Le choix du dessin n'est plus ici.** Il y avait deux images de la même chose sur une
            carte ouverte — celle de la tête et celle de ce sélecteur — dont une seule était
            cliquable. C'est la vignette du titre qui ouvre la grille désormais (`onChooseIcon` sur
            `BeverageCard`), et l'infobulle qui dit que rien ne part vers l'appareil voyage avec
            elle dans `titreChoix`. */}
      </>
    );

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      <div role="list" className="cards clavier">
        {/* La carte de création est dans la grille et s'ouvre comme les autres : un seul objet
            visuel sur la page, un seul geste pour créer comme pour modifier. */}
        {open === NOUVELLE && draft && bevLibre ? (
          <BeverageCard
            /* Pas de section sur cette page : la carte est le premier niveau sous le titre. */
            niveauTitre={2}
            key="nouvelle"
            /* La déclaration CALCULÉE, pas celle d'une boisson lue : voir `bevLibre`. */
            bev={bevLibre}
            profile={PROFIL_LIBRE}
            profileName={null}
            /* Sans nom saisi, la carte s'appelle « Nouvelle recette » — PAS « Mug de voyage ».
               Le support est un choix technique dérivé ; l'annoncer comme titre ferait croire qu'on
               modifie cette boisson de la machine. */
            titre={draft.name || t("create")}
            icone={draft.icon}
            /* Même règle que la carte d'une recette enregistrée : les pastilles de provenance
               machine ne décrivent pas une recette locale. Les deux cartes de cette page sont le
               même objet — les laisser diverger ici referait, à l'intérieur d'une seule page, la
               divergence que le partage de `BeverageCard` a supprimée entre deux pages. */
            /* Ni pastille de provenance machine, ni pastille « lait » : une composition libre ne
               décrit aucune boisson de l'appareil, et son contenu se lit dans ses cases. */
            /* **Rien sous le titre.** La légende d'origine dirait « Travel Mug · 7 paramètres » sous
               une recette qui n'est pas un mug de voyage, et les deux phrases qui l'avaient remplacée
               — le support dérivé, le compte de réglages — ont été retirées sur demande : elles
               expliquaient un mécanisme que les cases montrent en s'ouvrant. `null` vide la ligne ;
               l'omettre restaurerait celle de la carte. La boisson-cible ne se dit plus nulle part à
               l'écran : c'est un détail de mise en œuvre, et les bornes ne viennent plus d'elle. */
            pastilles={null}
            legende={null}
            onChooseIcon={(icon) => setDraft({ ...draft, icon })}
            /* Rien ne part vers l'appareil : le dessin est gardé avec la recette et n'accompagnera
               son nom que si on la transfère. D'où cette infobulle, là où `/` place son
               avertissement d'écriture persistante. */
            titreChoix={t("imageLocalHint")}
            open
            busy={busy}
            working={false}
            report={report?.scope === draft.id ? report : null}
            onToggle={ouvrirNouvelle}
            initial={null}
            dessus={identite()}
            /* Pas de « Préparer » ni d'« Écrire dans le profil » tant que la recette n'existe pas :
               ces deux gestes atteignent l'appareil, et rien ne les nomme encore. */
            editorActions={(params) => (
              <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => void enregistrer(params, PROFIL_LIBRE)}>
                <Icone nom="ecrire" />
                <span className="lbl">{t("saveLocal")}</span>
              </Button>
            )}
            /* Aucune action de tête : le pli « Masquer » est celui de la carte, et en ajouter un
               second donnait deux boutons identiques côte à côte. */
          />
        ) : (
          <Card role="listitem">
            <div className="cardHead">
              <div className="toucheBev">
                <div className="titreLigne">
                  <h2 className="cardTitle">{t("create")}</h2>
                </div>
              </div>
              <div className="row actions">
                <Button type="button" variant="neutre" size="commande" className="iconBtn" onClick={ouvrirNouvelle} disabled={!bevLibre}>
                  <Icone nom="ajouter" />
                  <span className="lbl">{tc("new")}</span>
                </Button>
              </div>
            </div>
            <p className="sub">{beverages.length ? t("newCardHint") : tc("loading")}</p>
          </Card>
        )}

        {data?.recipes.map((e) => {
          const ouverte = open === e.recipe.id;
          const rep = report?.scope === e.recipe.id ? report : null;
          if (!e.beverage) {
            /* Le catalogue de ce modèle ne connaît pas cette boisson — machine ou modèle changé.
               On ne fabrique pas une boisson de circonstance : la carte le dit, ce qui est vrai et
               utile, et la suppression reste offerte. */
            return (
              <Card role="listitem" key={e.recipe.id}>
                <div className="cardHead">
                  <div className="toucheBev">
                    <div className="titreLigne">
                      <h2 className="cardTitle">{e.recipe.name}</h2>
                      <Badge variant="arret">{t("unknownBeverage", { id: e.recipe.beverageId })}</Badge>
                    </div>
                  </div>
                  <div className="row actions">
                    <Button type="button" variant="arret" size="coquille" className="iconBtn" onClick={() => supprimer(e)}>
                      <Icone nom="corbeille" taille={14} />
                      <span className="lbl">{tc("delete")}</span>
                    </Button>
                  </div>
                </div>
                <p className="sub">{e.recipe.apercu?.label ?? String(e.recipe.beverageId)}</p>
              </Card>
            );
          }
          const bev = e.beverage;
          /* Les bornes viennent du PARAMÈTRE, pas de la boisson stockée — voir `declarationLibre`.
             `bev` reste la boisson telle que le catalogue la donne, pour ce qui parle vraiment
             d'elle : la contenance affichée et les réglages qu'un emplacement perdrait. */
          const decl = declarationLibre(bev);
          return (
            <BeverageCard
            /* Pas de section sur cette page : la carte est le premier niveau sous le titre. */
            niveauTitre={2}
              key={e.recipe.id}
              bev={decl}
              profile={e.recipe.profileId}
              profileName={null}
              open={ouverte}
              busy={busy}
              working={false}
              report={rep}
              onToggle={() => ouvrir(e)}
              /* La carte nomme la RECETTE, et RIEN d'autre au-dessus de ses réglages. La boisson
                 stockée et le profil ne s'affichent plus : ce sont des détails de mise en œuvre
                 d'une composition libre, et les nommer là faisait passer la recette pour une
                 boisson de l'appareil. Ils restent lisibles dans « Infos techniques », qui est le
                 pli prévu pour le protocole. */
              titre={e.recipe.name}
              legende={null}
              /* **Les pastilles de provenance machine ne disent rien d'une recette locale.**
                 « lu sur la machine » décrit d'où viennent les BORNES de la boisson ; à côté du nom
                 d'une recette enregistrée ici, elle se lit « cette recette vient de la machine »,
                 ce qui est faux — rien n'est envoyé tant qu'on ne le demande pas. Idem pour le
                 système de grains, qui est un état de l'appareil. Reste ce qui décrit la tasse.
                 Le désalignement des bornes n'est pas perdu : l'éditeur le dit lui-même
                 (`editor.boundsMisaligned`), juste au-dessus des curseurs qu'il rend douteux. */
              pastilles={bev.milk ? <Badge variant="plaque">{tb("milk")}</Badge> : null}
              /* Le dessin choisi pour la recette, pas l'illustration d'usine de la boisson. Carte
                 ouverte, c'est celui du BROUILLON : sans ça, choisir un dessin dans la grille ne
                 changerait rien à l'écran jusqu'à l'enregistrement, et le sélecteur paraîtrait
                 inerte. */
              icone={ouverte && draft?.id === e.recipe.id ? draft.icon : e.recipe.icon}
              onChooseIcon={
                ouverte && draft?.id === e.recipe.id ? (icon) => setDraft({ ...draft, icon }) : undefined
              }
              titreChoix={t("imageLocalHint")}
              /* Fermée, la carte est une affiche : le dessin, le nom, la contenance. */
              apercuCompact={contenance(e, decl)}
              /* Sans ça l'éditeur repartirait des valeurs du PROFIL et effacerait sous les yeux de
                 l'utilisateur la recette qu'il vient d'ouvrir. */
              initial={e.recipe.params}
              onDispense={(params) => preparer(e, params)}
              onWrite={(params) => void ecrireDansProfil(e, params)}
              dessus={ouverte && draft?.id === e.recipe.id ? identite() : null}
              dessous={
                ouverte ? (
                  <div className="blocSuite">
                    {/* Un sous-bloc DANS une carte : la carte est un `h2` sur cette page (voir
                    `niveauTitre`), donc ce qu'elle contient est un `h3`. */}
                <h3>{t("transferHeading")}</h3>
                    {e.transfert.possible ? (
                      <>
                        <p className="chapeau">{t("transferNote")}</p>
                        {/* Dit avant le clic, et pas seulement dans la confirmation : découvrir
                            qu'un réglage ne passe pas au moment de valider, c'est le découvrir trop
                            tard pour changer de cible. L'union des emplacements ouverts — rien
                            n'oblige deux emplacements à déclarer le même jeu. */}
                        {(() => {
                          const ids = [...new Set(e.transfert.emplacements.flatMap((s) => s.retires ?? []))];
                          const noms = perdus(bev, ids, e.recipe.params);
                          return noms ? <Alerte className="note">{t("transferDrops", { list: noms })}</Alerte> : null;
                        })()}
                        <div className="row">
                          {e.transfert.emplacements.map((s) => (
                            <Button type="button" variant="neutre" size="commande"
                              key={s.slot}
                              className="iconBtn"
                              disabled={busy}
                              onClick={() => transferer(e, s.slot)}
                              title={t("transferWarning")}>
                              <Icone nom="machine" />
                              <span className="lbl">{t("transferTo", { slot: s.slot, current: s.name ?? t("slotUnnamed") })}</span>
                            </Button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="sub">{t("transferImpossible", { reason: raison(e.transfert.raison) })}</p>
                    )}
                    {/* Supprimer vit ici, et non dans la tête de carte : c'est le seul geste
                        irréversible de la page, et le placer parmi les boutons d'une carte fermée
                        le mettait à un clic de distance de « Préparer ». */}
                    <div className="row note">
                      <Button type="button" variant="arret" size="commande" className="iconBtn" disabled={busy} onClick={() => supprimer(e)}>
                        <Icone nom="corbeille" />
                        <span className="lbl">{tc("delete")}</span>
                      </Button>
                    </div>
                  </div>
                ) : null
              }
              editorActions={(params) =>
                draft?.id === e.recipe.id ? (
                  <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => void enregistrer(params, e.recipe.profileId)}>
                    <Icone nom="ecrire" />
                    <span className="lbl">{t("saveLocal")}</span>
                  </Button>
                ) : null
              }
              /* « Supprimer » n'est PAS ici : voir le panneau de détails. Une carte fermée n'offre
                 que ce qu'on vient y chercher — préparer — et l'irréversible se mérite l'ouverture. */
              actions={({ nom }) => (
                <Button type="button" variant="marche" size="commande"
                  className="iconBtn"
                  disabled={busy}
                  aria-label={tb("prepareFor", { beverage: e.recipe.name || nom })}
                  onClick={() => preparer(e)}>
                  <Icone nom="preparer" />
                  <span className="lbl">{tc("prepare")}</span>
                </Button>
              )}
            />
          );
        })}
      </div>

      {data && !data.recipes.length && <p className="sub">{t("emptyList")}</p>}
      {dialogue}
    </>
  );
}
