"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
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
  const [d, setD] = useState<Payload | null>(null);
  /** Publiées par le serveur, plus recopiées ici — voir RANGES_VIDES. */
  const plages = d?.ranges ?? RANGES_VIDES;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /**
   * Le compte rendu de la dernière copie, et de LAQUELLE des deux — sans `cle`, copier un tableau
   * ferait apparaître le message sous les deux.
   */
  const [copie, setCopie] = useState<{ cle: "known" | "unknown"; texte: string; ok: boolean } | null>(null);
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
      for (const [from, qty] of ranges) {
        const r = await mfetch("/api/stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, qty }),
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
   * Totaux dérivés. `boissons avec lait chaud` est bien la SOMME de 3001 et 3003 : c'est ce que
   * fait `p018b7/e.java` (méthode `m()`, `return iIntValue3 + iIntValue2`), et l'app n'ajoute 3003
   * que s'il est > 0. Le total général, lui, est notre propre addition — signalé comme tel.
   */
  const derived = useMemo(() => {
    if (!d) return null;
    const v = (id: number) => d.stats[String(id)];
    const black = v(3000);
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
    cle: "known" | "unknown",
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
  const StatutCopie = ({ cle }: { cle: "known" | "unknown" }) => {
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
    </>
  );
}
