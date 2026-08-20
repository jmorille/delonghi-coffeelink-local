"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";

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

  // Pendant un balayage les valeurs arrivent trame par trame : on suit. Dépendance sur un
  // booléen, pas sur l'objet `scan`, qui est recréé à chaque réponse JSON.
  const scanning = !!d?.scan;
  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [scanning, load]);

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
        // Attente bornée : la machine répond en 2-3 s, le programme dure 9 s.
        for (let i = 0; i < 20; i++) {
          await new Promise((res) => setTimeout(res, 1500));
          const s = await mfetch("/api/stats").then((x) => x.json());
          setD(s);
          if (!s.scan) break;
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

      <div className="card warn" style={{ marginBottom: 16 }}>
        <strong>⚠ {t("categoryWarningTitle")}</strong>
        <div className="sub" style={{ margin: "4px 0 0" }}>
          {t("categoryWarning")}
        </div>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button disabled={busy || scanning} onClick={() => read(RANGES_KNOWN, t("scopeKnown"))}>
          {t("readKnown")}
        </button>
        <button className="mini" disabled={busy || scanning} onClick={() => read(RANGES_ALL, t("scopeAll"))} title={t("readAllTitle")}>
          {t("readAll")}
        </button>
        {d?.scan && (
          <span className="pill on">{t("scanning", { remaining: d.scan.remaining })}</span>
        )}
        {msg && <span className="sub">{msg}</span>}
      </div>

      {!d || d.count === 0 ? (
        <div className="card">
          <p className="sub" style={{ margin: 0 }}>{t("nothingYet")}</p>
        </div>
      ) : (
        <>
          {derived && derived.total !== undefined && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="kv">
                <span className="k">{t("totalBeverages")}</span>
                <span className="mono" style={{ fontSize: "1.35rem", fontWeight: 600 }}>
                  {fmt(derived.total)}
                </span>
              </div>
              <p className="sub" style={{ margin: "6px 0 0" }}>
                {derived.complete ? t("totalNote") : t("totalPartial")}
              </p>
            </div>
          )}

          <h2>{t("knownHeading")}</h2>
          <div className="card">
            {d.known.length === 0 ? (
              <p className="sub" style={{ margin: 0 }}>{t("noKnownYet")}</p>
            ) : (
              d.known.map((k) => (
                <div className="kv" key={k.id}>
                  <span className="k">
                    {tstat(k.key)}{" "}
                    <span className="sub mono" style={{ fontSize: ".76rem" }}>
                      {k.id}
                    </span>
                  </span>
                  <span className="mono">
                    {fmt(k.value)}
                    {k.unit ? ` ${k.unit}` : ""}
                    {k.unit && (
                      <span className="sub" style={{ fontSize: ".76rem" }} title={t("rawHint")}>
                        {" "}
                        ({t("raw", { value: fmt(k.raw) })})
                      </span>
                    )}
                  </span>
                </div>
              ))
            )}
            {derived?.hot !== undefined && d.stats["3003"] !== undefined && (
              <p className="sub" style={{ margin: "10px 0 0" }}>
                {t("hotMilkSum", { total: fmt(derived.hot) })}
              </p>
            )}
          </div>

          <h2>{t("unknownHeading")}</h2>
          <div className="card">
            <p className="sub" style={{ marginTop: 0 }}>{t("unknownNote")}</p>
            {unknownIds.length === 0 ? (
              <p className="sub" style={{ margin: 0 }}>{t("unknownEmpty")}</p>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                  gap: 6,
                }}
              >
                {unknownIds.map((id) => (
                  <div className="kv" key={id} style={{ margin: 0 }}>
                    <span className="k mono" style={{ fontSize: ".8rem" }}>
                      {id}
                    </span>
                    <span className="mono" style={{ fontSize: ".8rem" }}>
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
