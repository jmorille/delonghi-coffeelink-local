"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import Icone from "../icons";
import { attendreLibre, useMachinePush } from "../events";
import { TitreAlerte } from "../Alerte";

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
}

/**
 * Trois plages suffisent à couvrir les 10 compteurs connus, parce que la machine **énumère** :
 * elle renvoie les paramètres existants suivants en sautant les trous. Dix requêtes unitaires
 * prendraient deux minutes, trois plages en prennent trente secondes.
 */
const RANGES_KNOWN: [number, number][] = [
  [100, 10], // 100, 101, 105, 106, 108, 109, 111, 115, 116, 3000
  [3001, 10], // 3001..3010
  [3017, 10], // 3017..3038
];

/** Balayage complet de l'espace de paramètres relevé sur ce modèle (62 entrées). */
const RANGES_ALL: [number, number][] = [
  [100, 10],
  [3001, 10],
  [3011, 10],
  [3021, 10],
  [3039, 10],
  [23000, 10],
  [23009, 10],
  [43011, 10],
];

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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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
   * Enchaîne les plages côté client : le serveur refuse une seconde lecture tant que la
   * précédente tourne (409), donc on attend que `scan` retombe à null entre chaque.
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

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      {/* Ce que le flux dit de l'activité de la machine. Sans ça, une lecture demandée n'a aucune
          trace à l'écran entre le clic et l'arrivée des valeurs. */}
      {pending && <p className="sub">{t("pushWaiting")}</p>}
      {!live && <p className="sub">{tc("pushOff")}</p>}

      <div className="card warn">
        <TitreAlerte>{t("categoryWarningTitle")}</TitreAlerte>
        <div className="legende">
          {t("categoryWarning")}
        </div>
      </div>

      <div className="row barreActions">
        {/* **Le meme glyphe sur les deux, et c'est exact.** Les deux boutons font la meme chose —
            demander des compteurs a la machine — et ne different que par l'etendue : trois requetes
            pour les dix compteurs identifies, huit pour l'espace complet. Inventer un second dessin
            aurait affirme une difference de nature qui n'existe pas ; la difference d'echelle est
            deja portee par `.mini`, qui rend le second en 13 px estompes a cote d'un 16 px plein. */}
        <button className="iconBtn" disabled={busy || scanning} onClick={() => read(RANGES_KNOWN, t("scopeKnown"))}>
          <Icone nom="lire" />
          <span className="lbl">{t("readKnown")}</span>
        </button>
        <button className="mini iconBtn" disabled={busy || scanning} onClick={() => read(RANGES_ALL, t("scopeAll"))} title={t("readAllTitle")}>
          <Icone nom="lire" taille={14} />
          <span className="lbl">{t("readAll")}</span>
        </button>
        {d?.scan && (
          <span className="pill on">{t("scanning", { remaining: d.scan.remaining })}</span>
        )}
      </div>
      {/* Le compte rendu sort de la barre : `.barreActions` est une rangee de commandes centrees,
          et une phrase y devenait le quatrieme element d'une liste de boutons — centree sur leur
          hauteur, donc alignee sur rien. Elle appartient a la ligne d'en dessous. */}
      {msg && <p className="legende">{msg}</p>}

      {!d || d.count === 0 ? (
        <div className="card">
          <p className="sub">{t("nothingYet")}</p>
        </div>
      ) : (
        <>
          {derived && derived.total !== undefined && (
            <div className="card">
              <div className="kv">
                <span className="k">{t("totalBeverages")}</span>
                <span className="chiffre">
                  {fmt(derived.total)}
                </span>
              </div>
              <p className="legende">
                {derived.complete ? t("totalNote") : t("totalPartial")}
              </p>
            </div>
          )}

          <h2>{t("knownHeading")}</h2>
          <div className="card">
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
          </div>

          <h2>{t("unknownHeading")}</h2>
          <div className="card">
            <p className="chapeau">{t("unknownNote")}</p>
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
          </div>

          <p className="sub">{t("protocolNote", { count: d.count })}</p>
        </>
      )}
    </>
  );
}
