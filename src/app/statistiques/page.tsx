"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import { useBeverageLabel } from "@/i18n/labels";
import Icone from "../icons";
import { attendreLibre, useMachinePush } from "../events";
import { TitreAlerte } from "../Alerte";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

/** Compteur dont la signification est établie (voir `STAT_MEANINGS` côté serveur). */
interface Known {
  id: number;
  key: string;
  /** Valeur brute lue sur la machine. */
  raw: number;
  /** Valeur convertie quand il y a une unité (eau : 0,5 ml → litres). */
  value: number;
  unit: string | null;
  at: number;
}

/**
 * Un mot du paramètre 500 — le **second** espace de paramètres de la machine, lu par `0xA1` et non
 * par le `0xA2` des compteurs. `key` est `null` tant qu'aucune source ne l'a nommé : la page affiche
 * alors l'identifiant nu, jamais une étiquette de circonstance.
 */
interface SyncWord {
  id: number;
  rang: number;
  value: number;
  key: string | null;
  unit: string | null;
}

interface SyncBlock {
  prop: string;
  param: number;
  at: number | null;
  words: SyncWord[];
}

/**
 * Un compteur **nommé** : le second canal de statistiques, celui des propriétés Ayla (voir
 * `src/lib/compteurs.mjs`). Il ne vient pas du balayage `0xA2` mais d'une propriété dont le nom dit
 * ce qu'elle compte.
 *
 * `key` **ou** `slug`, jamais les deux : un compteur de catégorie s'étiquette par une clé de
 * traduction, un compteur propre à une boisson par le catalogue — même règle que partout ici, rien
 * de traduisible ne traverse l'API.
 *
 * Trois états distincts, et il faut qu'ils le restent : présent avec une valeur, `absent` (la
 * machine a répondu vide, on ne redemandera plus), `illisible` (elle a répondu autre chose qu'un
 * nombre). Une propriété jamais lue n'est simplement pas dans la liste.
 */
interface Named {
  prop: string;
  key: string | null;
  beverageId: number | null;
  slug: string | null;
  label: string | null;
  source: "apk" | "eletta";
  famille: "usage" | "entretien";
  absent: boolean;
  illisible: boolean;
  raw: number | null;
  value: number | null;
  unit: string | null;
  breakdown: Record<string, unknown> | null;
  at: number | null;
}

/** Les quatre tableaux copiables de la page. */
type CleCopie = "known" | "unknown" | "sync" | "named";

interface Payload {
  /** id brut → valeur, pour les 62 paramètres, connus ou non. */
  stats: Record<string, number>;
  readAt: Record<string, number>;
  count: number;
  scan: { remaining: number; total: number } | null;
  appIds: number[];
  known: Known[];
  /** Plages de balayage publiées par le serveur (`STAT_RANGES`). */
  ranges?: { known: [number, number][]; all: [number, number][] };
  /** Les dix mots du paramètre 500, ou `null` s'ils n'ont jamais été lus. */
  sync?: SyncBlock | null;
  /** Les compteurs nommés déjà lus au moins une fois — jamais ceux qui n'ont pas été demandés. */
  named?: Named[];
  /** Ce qu'il y a à demander dans chaque portée. Publié par le serveur, comme `ranges`. */
  namedScopes?: Record<string, number>;
}

/**
 * **Les plages viennent du serveur** (`GET /api/stats` → `ranges`), elles ne sont plus écrites ici.
 *
 * Elles y étaient, et le serveur en a désormais besoin lui aussi pour « Tout lire » : deux copies
 * d'une table de protocole finissent toujours par diverger, et celle-ci décide de ce qu'on lit sur
 * un appareil. Trois plages suffisent aux 10 compteurs connus, huit couvrent les 62 relevés, parce
 * que la machine **énumère** — un id inexistant renvoie les suivants qui existent, en sautant les
 * trous.
 *
 * Ce repli ne sert qu'au premier rendu, avant la première réponse : sans lui les deux boutons
 * seraient inertes pendant une fraction de seconde, ce qui se remarque au doigt.
 */
const RANGES_VIDES: { known: [number, number][]; all: [number, number][] } = { known: [], all: [] };

/**
 * **Poser un texte dans le presse-papiers, sur un serveur en http simple.**
 *
 * ⚠️ **`navigator.clipboard` N'EXISTE PAS ici la plupart du temps, et c'est structurel.** L'API
 * n'est exposée que dans un *contexte sûr* — https, ou `localhost`. Or ce serveur s'annonce par son
 * adresse de réseau local (`SERVER_IP`) et se consulte depuis une tablette murale ou un téléphone :
 * `http://192.168.x.x`, donc pas de contexte sûr, donc `navigator.clipboard === undefined`. Un
 * bouton écrit avec la seule API moderne aurait marché sur la machine du développeur (localhost) et
 * nulle part ailleurs — exactement le genre de défaut que ce dépôt attrape trop tard.
 *
 * D'où les deux chemins, dans cet ordre : l'API quand elle est là, sinon le `<textarea>` +
 * `document.execCommand("copy")`, qui est déprécié mais reste le SEUL mécanisme disponible hors
 * contexte sûr. Le champ est posé hors écran plutôt que caché : `display: none` n'est pas
 * sélectionnable, donc la copie ne prendrait rien.
 *
 * **Rend un booléen, et l'appelant en fait un compte rendu.** Un `catch` muet aurait donné le pire
 * retour possible — un bouton qui a l'air d'avoir marché sur un presse-papiers vide.
 */
async function copierTexte(texte: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(texte);
      return true;
    } catch {
      /* Refus de permission : on tente quand même le repli, qui ne dépend pas de la permission. */
    }
  }
  try {
    const champ = document.createElement("textarea");
    champ.value = texte;
    champ.setAttribute("readonly", "");
    /* `position: fixed` + hors écran : le champ doit être RENDU pour être sélectionnable, et ne doit
       pas faire défiler la page en recevant le focus. */
    champ.style.position = "fixed";
    champ.style.top = "0";
    champ.style.left = "-9999px";
    document.body.appendChild(champ);
    champ.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(champ);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Les lignes d'un tableau, en colonnes séparées par des tabulations.
 *
 * **TSV et non CSV, et `\r\n` et non `\n`.** La tabulation évite la question du séparateur décimal
 * français — un CSV à virgules coupe « 61,5 » en deux colonnes dans un tableur fr-FR. Le retour
 * chariot est celui qu'attendent les applications Windows, qui sont le poste de consultation ici.
 *
 * Les nombres partent en chiffres NUS, sans le séparateur de milliers de `fmt()` : celui-ci est un
 * espace fine insécable (U+202F), qui est juste à l'écran et illisible pour tout ce qui reparse.
 */
const tsv = (lignes: (string | number)[][]) => lignes.map((l) => l.join("\t")).join("\r\n");

export default function Statistiques() {
  const t = useTranslations("stats");
  const tc = useTranslations("common");
  const tstat = useTranslations("stat");
  /**
   * Même défaut, même page que l'accueil : `tstat` **lève** sur une clé absente, et l'erreur
   * remonte jusqu'à faire tomber la page entière. Les clés viennent de `STAT_MEANINGS` côté
   * serveur : il peut en gagner une avant le catalogue, et ce jour-là afficher la clé vaut mieux
   * que perdre les 62 compteurs. Repli identique à `useCategoryLabel` / `useParamLabel`.
   */
  const statLabel = (key: string) => (tstat.has(key) ? tstat(key) : key);
  const bevLabel = useBeverageLabel();
  /**
   * Le libellé d'un compteur nommé : par le catalogue quand il compte une boisson, par la clé de
   * traduction sinon, et par le nom de la propriété quand il n'a ni l'un ni l'autre.
   *
   * Le repli final n'est pas décoratif : la table de `compteurs.mjs` peut gagner un nom avant que
   * `messages/fr.json` ne gagne sa clé, et ce jour-là afficher `d738_cold_brew_bev` vaut mieux que
   * faire tomber la page — `tstat` lève sur une clé absente. Même repli que `statLabel`.
   */
  const nomCompteur = (c: Named) =>
    c.slug ? bevLabel({ slug: c.slug, label: c.label ?? undefined }) : c.key ? statLabel(c.key) : c.prop;
  const [d, setD] = useState<Payload | null>(null);
  /** Publiées par le serveur, plus recopiées ici — voir RANGES_VIDES. */
  const plages = d?.ranges ?? RANGES_VIDES;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /**
   * Le compte rendu de la dernière copie, et de LAQUELLE des deux — sans `cle`, copier un tableau
   * ferait apparaître le message sous les deux.
   */
  const [copie, setCopie] = useState<{ cle: CleCopie; texte: string; ok: boolean } | null>(null);
  /* Le succès s'efface, l'échec reste. Un « copié » qui persiste devient du bruit au bout de deux
     clics ; un échec qui s'efface emporte la seule explication de ce qu'il faut faire à la place. */
  useEffect(() => {
    if (!copie?.ok) return;
    const id = setTimeout(() => setCopie(null), 4000);
    return () => clearTimeout(id);
  }, [copie]);

  const load = useCallback(async () => {
    try {
      setD(await mfetch("/api/stats").then((r) => r.json()));
    } catch {
      /* la page reste lisible avec ce qu'elle a déjà */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Les valeurs arrivent trame par trame, et le serveur nous le dit : chaque réponse `0xA2` passe
   * par `putStats`, qui horodate `importedAt`. Plus de minuteur.
   */
  const { live, busy: pending, busyRef } = useMachinePush(load);

  // Repli : si le flux n'a pas pu s'établir, on retombe sur une scrutation, et seulement pendant
  // qu'un balayage tourne.
  const scanning = !!d?.scan;
  useEffect(() => {
    if (live || !scanning) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [live, scanning, load]);

  /**
   * Enchaîne les plages, une requête par plage, en attendant que la machine soit libre entre
   * chacune.
   *
   * ⚠️ Le motif d'origine a disparu : le serveur REFUSAIT une seconde lecture tant que la
   * précédente tournait (409), parce qu'elle l'aurait écrasée. Depuis la file de tâches
   * (`src/lib/tasks.mjs`) il n'écrase plus rien — les huit plages pourraient partir d'un coup et
   * former une seule tâche de huit pas, comme le fait « Tout lire ». L'attente ci-dessous est donc
   * devenue superflue ; elle est conservée telle quelle parce qu'elle est correcte et que la
   * remplacer demande d'étendre `/api/stats` à une liste de plages.
   */
  const read = async (ranges: [number, number][], label: string) => {
    setBusy(true);
    setMsg(t("reading", { what: label }));
    try {
      for (const [i, [from, qty]] of ranges.entries()) {
        /**
         * **`sync` sur la DERNIÈRE plage seulement.** Le serveur joint alors la lecture de
         * `d260_beansystem_sync_par` — les paramètres 500 à 509, dont l'écoulement mesuré — à la
         * même tâche que les compteurs (voir `scanStats`). Le mettre sur chaque plage relirait la
         * même propriété trois ou huit fois pour rien ; le mettre sur la première la daterait
         * d'avant le balayage, donc d'un autre état de la machine que les compteurs qu'on veut lui
         * comparer. La dernière est celle qui colle aux valeurs les plus fraîches.
         */
        const r = await mfetch("/api/stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, qty, sync: i === ranges.length - 1 }),
        }).then((x) => x.json());
        if (r.error) {
          setMsg(tc("error", { message: r.error }));
          return;
        }
        // Le serveur refuse une seconde lecture tant que la précédente tourne (409) : on attend
        // donc qu'il soit libre. `attendreLibre` scrute l'état POUSSÉ, en mémoire — aucune requête
        // ne part, là où cette boucle interrogeait /api/stats toutes les 1,5 s, vingt fois par
        // plage. Le repli garde l'ancienne attente quand le flux est indisponible.
        if (live) {
          await attendreLibre(busyRef);
        } else {
          for (let i = 0; i < 20; i++) {
            await new Promise((res) => setTimeout(res, 1500));
            const s = await mfetch("/api/stats").then((x) => x.json());
            setD(s);
            if (!s.scan) break;
          }
        }
      }
      setMsg(t("readDone"));
      await load();
    } finally {
      setBusy(false);
    }
  };

  /**
   * **Lecture des compteurs nommés : un POST, pas de boucle sur des plages.**
   *
   * L'autre canal ne se balaye pas — il n'y a pas d'espace d'identifiants à parcourir, mais une
   * liste de noms. Le serveur en fait UNE tâche d'autant de pas, et saute lui-même ceux qu'il sait
   * absents : rien à enchaîner ici, donc rien de l'attente entre plages du bouton voisin.
   *
   * Le cas `empty` n'est pas une erreur : la portée est épuisée, tous ses noms ont déjà répondu
   * vide. Le dire évite de relancer indéfiniment une lecture qui n'a rien à ramener.
   */
  const [msgNamed, setMsgNamed] = useState<string | null>(null);
  const readNamed = async (portee: "app" | "tous", label: string) => {
    setBusy(true);
    setMsgNamed(t("reading", { what: label }));
    try {
      const r = await mfetch("/api/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ named: portee }),
      }).then((x) => x.json());
      if (r.error) return setMsgNamed(tc("error", { message: r.error }));
      if (r.empty) return setMsgNamed(t("namedNothingToRead", { total: r.total }));
      setMsgNamed(r.skipped ? t("namedSkipped", { count: r.skipped }) : t("readDone"));
      if (live) await attendreLibre(busyRef);
      await load();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Totaux dérivés. `boissons avec lait chaud` est bien la SOMME de 3001 et 3003 : c'est ce que
   * fait `p018b7/e.java` (méthode `m()`, `return iIntValue3 + iIntValue2`), et l'app n'ajoute 3003
   * que s'il est > 0. Le total général, lui, est notre propre addition — signalé comme tel.
   */
  const derived = useMemo(() => {
    if (!d) return null;
    const v = (id: number) => d.stats[String(id)];
    /**
     * `boissons sans lait` est la SOMME de 3000 et 3077, exactement comme `l()` dans `p018b7/e.java`
     * — et le second terme n'entre que s'il est > 0, comme là-bas.
     *
     * Ça ne change rien sur l'ECAM 610.75.MB, où 3077 n'existe pas : la lecture le montre en
     * renvoyant le bloc 23xxx à sa place. Ça compte sur les Striker, où l'app le demande. Prendre
     * 3000 seul y aurait donné un total franchement faux, sans rien qui le signale.
     */
    const black = v(3000) === undefined ? undefined : v(3000) + (v(3077) && v(3077) > 0 ? v(3077) : 0);
    const hot = v(3001) === undefined ? undefined : v(3001) + (v(3003) && v(3003) > 0 ? v(3003) : 0);
    const cold = v(3017);
    const tea = v(3025);
    const choco = v(3021);
    const parts = [black, hot, cold, tea, choco].filter((x): x is number => x !== undefined);
    return {
      black,
      hot,
      tea,
      choco,
      total: parts.length ? parts.reduce((a, b) => a + b, 0) : undefined,
      complete: [black, hot, tea, choco].every((x) => x !== undefined),
    };
  }, [d]);

  const fmt = (n: number) => n.toLocaleString("fr-FR");
  /* Lues d'un côté, absentes de l'autre : les deux listes ne se rendent pas de la même façon et ne
     se copient pas ensemble. L'ordre est celui du serveur, qui est celui de la table — l'APK
     d'abord, le relevé Eletta ensuite. */
  const nommesLus = useMemo(() => (d?.named ?? []).filter((c) => !c.absent), [d]);
  const nommesAbsents = useMemo(() => (d?.named ?? []).filter((c) => c.absent), [d]);
  const unknownIds = useMemo(() => {
    if (!d) return [];
    const known = new Set(d.known.map((k) => k.id));
    return Object.keys(d.stats)
      .map(Number)
      .filter((id) => !known.has(id))
      .sort((a, b) => a - b);
  }, [d]);

  /**
   * **Les deux tableaux, tels qu'ils sont à l'écran.** Une copie qui diffère de ce qu'on voit est le
   * défaut silencieux de ce genre de bouton : les lignes viennent donc des mêmes sources que le
   * rendu — `d.known` dans son ordre, `unknownIds` dans le sien — et non d'un second parcours de
   * `d.stats` qui pourrait trier autrement.
   *
   * Une ligne d'en-tête, parce que le tableau des non identifiés est deux colonnes de chiffres nus :
   * collé sans titre dans une note, personne ne saura six mois plus tard laquelle est l'id.
   *
   * Pour un compteur identifié, c'est `value` qui part — la valeur convertie, celle que la page
   * annonce — avec son unité dans une colonne à elle. Le brut reste à l'écran, entre parenthèses :
   * l'emporter aurait demandé une cinquième colonne vide pour les neuf compteurs sans unité.
   */
  const lignesConnus = (): (string | number)[][] => [
    [t("colCounter"), t("colId"), t("colValue"), t("colUnit")],
    ...(d?.known ?? []).map((k) => [statLabel(k.key), k.id, k.value, k.unit ?? ""]),
  ];
  const lignesInconnus = (): (string | number)[][] => [
    [t("colId"), t("colValue")],
    ...unknownIds.map((id) => [id, d?.stats[String(id)] ?? ""]),
  ];
  /* Les dix mots dans l'ordre où la machine les envoie — le rang EST le décalage du paramètre, donc
     un tri par valeur ou par nom ferait perdre la seule chose qui identifie un mot anonyme. */
  const lignesSync = (): (string | number)[][] => [
    [t("colId"), t("colCounter"), t("colValue"), t("colUnit")],
    ...(d?.sync?.words ?? []).map((w) => [w.id, w.key ? statLabel(w.key) : "", w.value, w.unit ?? ""]),
  ];
  /**
   * Les compteurs nommés, **avec leur source en colonne**.
   *
   * À l'écran seuls les noms venus d'un relevé tiers portent une marque : redire « APK » sur les
   * quatorze autres serait du bruit. Dans un tableau collé dans une note, c'est l'inverse — une
   * colonne ne coûte rien et c'est exactement ce qu'on cherchera six mois plus tard pour savoir
   * lequel de ces noms est prouvé par le binaire. Les absents en sont exclus : leur valeur n'existe
   * pas, et une ligne vide dans un tableur se lit comme un zéro.
   */
  const lignesNommes = (): (string | number)[][] => [
    [t("colCounter"), t("colProp"), t("colValue"), t("colUnit"), t("colSource")],
    ...(d?.named ?? [])
      .filter((c) => !c.absent && c.value !== null)
      .map((c) => [nomCompteur(c), c.prop, c.value ?? "", c.unit ?? "", c.source]),
  ];

  /** L'heure d'une lecture, en horloge et non en âge : c'est la comparaison de DEUX heures qui sert ici. */
  const heure = (ms: number | null | undefined) =>
    ms ? new Date(ms).toLocaleTimeString(undefined, { hour12: false }) : "—";
  /* Le plus récent des horodatages de compteurs : c'est lui qui date le relevé `0xA2` face au `0xA1`. */
  const compteursAt = useMemo(() => {
    const v = Object.values(d?.readAt ?? {});
    return v.length ? Math.max(...v) : null;
  }, [d]);

  /**
   * Le bouton de copie d'un tableau : **une icône seule, et donc un `aria-label` obligatoire.**
   *
   * `iconBtn iconSeul` est le motif déjà employé par `/profils` et `/pilotage` — pas de libellé du
   * tout, remplissage latéral ramené à 10 px, hauteur et cible tactile intactes. Le glyphe passe à
   * la coche pendant les quatre secondes qui suivent un succès : le compte rendu est juste en
   * dessous, mais l'œil qui vient de cliquer est sur le bouton.
   *
   * ⚠️ **`variant="discret"` et non `neutre`** : ce bouton ne touche pas la machine et ne change
   * rien: il déplace du texte. Lui donner le relief d'une commande l'aurait mis au même rang que
   * « Lire les compteurs », juste au-dessus, qui elle parle à l'appareil.
   */
  const boutonCopier = (
    cle: CleCopie,
    nom: string,
    produire: () => (string | number)[][],
    lignes: number,
  ) => (
    <Button
      type="button"
      variant="discret"
      size="commande"
      className="iconBtn iconSeul"
      disabled={!lignes}
      aria-label={nom}
      title={t("copyTitle")}
      onClick={async () => {
        const ok = await copierTexte(tsv(produire()));
        setCopie({ cle, ok, texte: ok ? t("copyDone", { count: lignes }) : t("copyFailed") });
      }}
    >
      <Icone nom={copie?.cle === cle && copie.ok ? "choisir" : "copier"} />
    </Button>
  );

  /**
   * Le compte rendu de la copie, sur la carte qu'il commente.
   *
   * **Monté en permanence, vide quand il n'y a rien** — même raison qu'à `/pilotage` : un
   * `role="status"` créé en même temps que son contenu n'est pas annoncé, seul un changement DANS
   * une région déjà présente l'est. `.enLigne:empty` le retire de la mise en page sans le démonter.
   * L'échec prend le pictogramme d'alerte, comme le bandeau en tête de cette page.
   */
  const StatutCopie = ({ cle }: { cle: CleCopie }) => {
    const r = copie?.cle === cle ? copie : null;
    return (
      <span className={"enLigne" + (r && !r.ok ? " alerte" : "")} role="status">
        {r && (
          <>
            {!r.ok && <Icone nom="alerte" taille={15} />}
            <span>{r.texte}</span>
          </>
        )}
      </span>
    );
  };

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      {/* Ce que le flux dit de l'activité de la machine. Sans ça, une lecture demandée n'a aucune
          trace à l'écran entre le clic et l'arrivée des valeurs. */}
      {pending && <p className="sub">{t("pushWaiting")}</p>}
      {!live && <p className="sub">{tc("pushOff")}</p>}

      <Card className="warn">
        <TitreAlerte>{t("categoryWarningTitle")}</TitreAlerte>
        <div className="legende">
          {t("categoryWarning")}
        </div>
      </Card>

      <div className="row barreActions">
        {/* **Le meme glyphe sur les deux, et c'est exact.** Les deux boutons font la meme chose —
            demander des compteurs a la machine — et ne different que par l'etendue : trois requetes
            pour les dix compteurs identifies, huit pour l'espace complet. Inventer un second dessin
            aurait affirme une difference de nature qui n'existe pas ; la difference d'echelle est
            deja portee par `.mini`, qui rend le second en 13 px estompes a cote d'un 16 px plein. */}
        <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy || scanning || !plages.known.length} onClick={() => read(plages.known, t("scopeKnown"))}>
          <Icone nom="lire" />
          <span className="lbl">{t("readKnown")}</span>
        </Button>
        <Button type="button" variant="neutre" size="coquille" className="iconBtn" disabled={busy || scanning || !plages.all.length} onClick={() => read(plages.all, t("scopeAll"))} title={t("readAllTitle")}>
          <Icone nom="lire" taille={14} />
          <span className="lbl">{t("readAll")}</span>
        </Button>
        {d?.scan && (
          <Badge variant="marche">{t("scanning", { remaining: d.scan.remaining })}</Badge>
        )}
      </div>
      {/* Le compte rendu sort de la barre : `.barreActions` est une rangee de commandes centrees,
          et une phrase y devenait le quatrieme element d'une liste de boutons — centree sur leur
          hauteur, donc alignee sur rien. Elle appartient a la ligne d'en dessous. */}
      {msg && <p className="legende">{msg}</p>}

      {!d || d.count === 0 ? (
        <Card>
          <p className="sub">{t("nothingYet")}</p>
        </Card>
      ) : (
        <>
          {derived && derived.total !== undefined && (
            <Card>
              <div className="kv">
                <span className="k">{t("totalBeverages")}</span>
                <span className="valeur">
                  {fmt(derived.total)}
                </span>
              </div>
              <p className="legende">
                {derived.complete ? t("totalNote") : t("totalPartial")}
              </p>
            </Card>
          )}

          <h2>{t("knownHeading")}</h2>
          <Card>
            {/* **Une tête de carte qui ne porte qu'une action, et pas de titre.** Le titre est le
                `<h2>` juste au-dessus : le redire ici en ferait deux pour une seule section. D'où
                `ms-auto`, et `flex-none` sur le bloc d'actions — sans le second, la règle
                `.cardHead:not(.compacte) > :first-child` lui donne `flex: 1 1 12rem` (elle vaut
                (0,3,0), donc elle bat `.cardHead > .actions`) et le bouton se retrouve collé à
                gauche d'un bloc étiré.

                ⚠️ **`ms-auto` alors que `surfaces.css` dit « pas de `margin-left: auto` ».** La
                règle y est écrite pour une tête qui a un bloc de TITRE : celui-ci est en
                `flex: 1 1 12rem` et pousse donc les actions au bord droit tout seul. Ici il n'y a
                pas de titre du tout sur la carte des compteurs, et sur celle des non identifiés le
                chapeau est **borné par la mesure de lecture** (`max-width: var(--mesure)`) : il
                s'arrête à 600 px dans une carte de 1 400, donc il ne pousse rien. Mesuré : bord
                droit du bouton à 629 px pour une carte finissant à 1 428. `justify-between` aurait
                réglé la ligne unique et cassé le repli — sur téléphone, une action seule sur sa
                ligne serait repartie à gauche. Les utilitaires plutôt qu'une règle dans
                `surfaces.css` : `utilities` bat `surfaces`, c'est la loi de ce dépôt. */}
            <div className="cardHead">
              <div className="row actions flex-none ms-auto">
                {boutonCopier("known", t("copyKnown"), lignesConnus, d.known.length)}
              </div>
            </div>
            <StatutCopie cle="known" />
            {d.known.length === 0 ? (
              <p className="sub">{t("noKnownYet")}</p>
            ) : (
              d.known.map((k) => (
                <div className="kv" key={k.id}>
                  <span className="k">
                    {statLabel(k.key)}{" "}
                    <span className="sub num">
                      {k.id}
                    </span>
                  </span>
                  <span className="num">
                    {fmt(k.value)}
                    {k.unit ? ` ${k.unit}` : ""}
                    {k.unit && (
                      <span className="sub" title={t("rawHint")}>
                        {" "}
                        ({t("raw", { value: fmt(k.raw) })})
                      </span>
                    )}
                  </span>
                </div>
              ))
            )}
            {derived?.hot !== undefined && d.stats["3003"] !== undefined && (
              <p className="note">
                {t("hotMilkSum", { total: fmt(derived.hot) })}
              </p>
            )}
          </Card>

          <h2>{t("unknownHeading")}</h2>
          <Card>
            {/* Ici la tête a de quoi remplir sa gauche : le chapeau y monte, et il pousse l'action
                au bord droit tout seul (`flex: 1 1 12rem` sur le premier enfant). Deux lignes
                deviennent une, ce qui est la raison d'être de cette tête plutôt qu'une action
                flottant au-dessus du chapeau. */}
            <div className="cardHead">
              <p className="chapeau">{t("unknownNote")}</p>
              <div className="row actions flex-none ms-auto">
                {boutonCopier("unknown", t("copyUnknown"), lignesInconnus, unknownIds.length)}
              </div>
            </div>
            <StatutCopie cle="unknown" />
            {unknownIds.length === 0 ? (
              <p className="sub">{t("unknownEmpty")}</p>
            ) : (
              <div className="grilleBrute">
                {unknownIds.map((id) => (
                  <div className="kv" key={id}>
                    <span className="k mono">
                      {id}
                    </span>
                    <span className="num">
                      {fmt(d.stats[String(id)])}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <p className="sub">{t("protocolNote", { count: d.count })}</p>
        </>
      )}

      {/* **Les compteurs nommés, hors du bloc conditionnel ci-dessus — même raison que le bloc
          suivant.** Ils ne viennent pas du balayage `0xA2` : `d.count` peut valoir zéro alors que
          quatorze propriétés ont répondu. Les ranger sous `d.count > 0` aurait rendu invisibles les
          seuls compteurs lus, et surtout les DEUX BOUTONS qui permettent de les lire — la page
          n'aurait alors offert aucun moyen d'en sortir. */}
      <section aria-labelledby="titre-nommes">
        <h2 id="titre-nommes">{t("namedHeading")}</h2>
        <Card>
          <div className="cardHead">
            <p className="chapeau">{t("namedNote")}</p>
            <div className="row actions flex-none ms-auto">
              {boutonCopier("named", t("copyNamed"), lignesNommes, nommesLus.length)}
            </div>
          </div>
          <StatutCopie cle="named" />
          {/* Le même couple que la barre du haut, et pour la même raison : deux étendues d'une
              seule et même demande. Le second en `coquille` + glyphe 14 px, comme « Tout balayer ». */}
          <div className="row barreActions">
            <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy || scanning} onClick={() => readNamed("app", t("scopeNamedApp"))}>
              <Icone nom="lire" />
              <span className="lbl">{t("readNamedApp")}</span>
            </Button>
            <Button type="button" variant="neutre" size="coquille" className="iconBtn" disabled={busy || scanning} onClick={() => readNamed("tous", t("scopeNamedAll"))} title={t("readNamedAllTitle")}>
              <Icone nom="lire" taille={14} />
              <span className="lbl">{t("readNamedAll")}</span>
            </Button>
          </div>
          {msgNamed && <p className="legende">{msgNamed}</p>}

          {nommesLus.length === 0 ? (
            <p className="sub">{t("namedEmpty")}</p>
          ) : (
            <>
              {(["usage", "entretien"] as const).map((famille) => {
                const lignes = nommesLus.filter((c) => c.famille === famille);
                if (!lignes.length) return null;
                /* L'entretien est un GROUPE NOMMÉ, pas un titre décoratif : un pourcentage avant
                   détartrage n'est pas un total à vie, et la distinction doit s'entendre autant
                   qu'elle se voit. Même motif que les sections de la carte de grain. */
                const titre = famille === "entretien" ? t("namedMaintenance") : null;
                return (
                  <div key={famille} role={titre ? "group" : undefined} aria-label={titre ?? undefined}>
                    {titre && <p className="etiquetteGroupe">{titre}</p>}
                    {lignes.map((c) => (
                      <div className="kv" key={c.prop}>
                        <span className="k">
                          {nomCompteur(c)} <span className="sub mono">{c.prop}</span>
                          {/* Marqué uniquement quand le nom NE vient PAS du binaire. Redire « APK »
                              sur les quatorze autres serait du bruit ; l'absence de marque est le
                              cas ordinaire, et le chapeau le dit. La source part en colonne dans la
                              copie, où elle ne coûte rien. */}
                          {c.source === "eletta" && (
                            <span className="sub" title={t("namedFromEletta_title")}> · {t("namedFromEletta")}</span>
                          )}
                        </span>
                        <span className="num">
                          {c.illisible || c.value === null ? (
                            <span className="sub">{t("namedUnreadable")}</span>
                          ) : (
                            <>
                              {fmt(c.value)}
                              {c.unit ? ` ${c.unit}` : ""}
                              {c.unit && c.raw !== null && (
                                <span className="sub" title={t("rawHint")}> ({t("raw", { value: fmt(c.raw) })})</span>
                              )}
                            </>
                          )}
                        </span>
                        {/* La ventilation des compteurs en objet JSON (Striker). C'est elle qui porte
                            l'information ; la somme au-dessus n'en est qu'un résumé, et l'afficher
                            seule reviendrait à jeter ce que la machine a pris la peine d'envoyer. */}
                        {c.breakdown && (
                          <p className="legende">
                            {Object.entries(c.breakdown).map(([k, v]) => `${k} = ${String(v)}`).join(" · ")}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )}

          {/* Les absentes en fin de carte, en clair : « absente sur ce modèle » et « jamais lue »
              sont deux choses différentes, et seule la première se sait. */}
          {nommesAbsents.length > 0 && (
            <p className="note">
              {t("namedAbsent", { props: nommesAbsents.map((c) => c.prop).join(", ") })} {t("namedAbsentNote")}
            </p>
          )}
        </Card>
      </section>

      {/* **Le second espace de paramètres, hors du bloc conditionnel ci-dessus — et c'est voulu.**
          Il ne vient pas du balayage `0xA2` mais de la propriété `d260_beansystem_sync_par`, qui a
          pu être lue par `/beans` ou par « Tout lire » sans qu'aucun compteur ne le soit. Le ranger
          sous `d.count > 0` l'aurait rendu invisible dans exactement ce cas-là. */}
      {d?.sync && d.sync.words.length > 0 && (
        /* Une `<section>` nommée plutôt qu'un `<h2>` nu comme ses voisines : c'est le seul bloc de
           la page dont le contenu ne vient pas du balayage `0xA2`, et un lecteur d'écran comme un
           test ont besoin de pouvoir le désigner. Même motif que les deux journaux de `/pilotage`,
           où l'absence de nom faisait mesurer le mauvais des deux. */
        <section aria-labelledby="titre-sync">
          <h2 id="titre-sync">{t("syncHeading")}</h2>
          <Card>
            <div className="cardHead">
              <p className="chapeau">{t("syncNote")}</p>
              <div className="row actions flex-none ms-auto">
                {boutonCopier("sync", t("copySync"), lignesSync, d.sync.words.length)}
              </div>
            </div>
            <StatutCopie cle="sync" />
            {/* Les deux heures côte à côte : c'est la seule chose qui dise si un relevé différentiel
                porte sur un état de la machine ou sur deux. Aucun seuil n'est inventé ici — on
                montre les deux valeurs et on laisse lire. */}
            <p className="legende">
              {t("syncReadAt", { mots: heure(d.sync.at), compteurs: heure(compteursAt) })}
            </p>
            <div className="grilleBrute">
              {d.sync.words.map((w) => (
                <div className="kv" key={w.id}>
                  <span className={w.key ? "k" : "k mono"}>
                    {w.key ? (
                      <>
                        {statLabel(w.key)} <span className="sub num">{w.id}</span>
                      </>
                    ) : (
                      w.id
                    )}
                  </span>
                  <span className="num">
                    {fmt(w.value)}
                    {w.unit ? ` ${w.unit}` : ""}
                    {/* La seconde tronquée de l'app (`parameter.b() / 1000`, division ENTIÈRE) :
                        c'est la valeur qu'attend le questionnaire d'affinage, donc celle qu'on
                        compare à ce qu'il affiche. Sur l'unité, jamais sur la clé — toute durée en
                        millisecondes se relit ainsi, celle-ci comme la prochaine. */}
                    {w.unit === "ms" && (
                      <span className="sub"> ({t("syncSeconds", { n: Math.trunc(w.value / 1000) })})</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <p className="note">{t("syncSpaces")}</p>
          </Card>
        </section>
      )}
    </>
  );
}
