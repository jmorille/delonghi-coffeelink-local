"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";

interface Bean {
  index: number;
  name: string | null;
  grinder: number;
  temperature: number;
  aroma: number;
  at: number;
  isToggle: boolean;
  /** Octet 50 de la trame 0xBA : le grain sélectionné sur la machine. */
  active: boolean | null;
  /** Octet 49 : profil non supprimé. */
  visible: boolean | null;
}
interface Bound {
  min: number;
  max: number;
  verified: boolean;
}
interface Payload {
  beans: Bean[];
  bounds: { grinder: Bound; aroma: Bound; temperature: Bound };
  activeProfile: number;
  scan: { next: number; to: number } | null;
}
interface Simulation {
  grinder: number;
  temperature: number;
  aroma: number;
  deltas: { grinder: number; temperature: number; aroma: number };
  changed: boolean;
  notes: string[];
  error?: string;
}

/** Réglages en cours d'édition pour un profil. */
interface Draft {
  name: string;
  grinder: number;
  temperature: number;
  aroma: number;
}

export default function BeanAdapt() {
  const t = useTranslations("beanAdapt");
  const tc = useTranslations("common");
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [flowTime, setFlowTime] = useState(15);
  const [crema, setCrema] = useState(2);
  const [taste, setTaste] = useState(2);
  const [sim, setSim] = useState<Simulation | null>(null);

  const refresh = useCallback(async () => {
    setData(await mfetch("/api/beanadapt").then((r) => r.json()));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Pendant un balayage la liste se remplit grain par grain : on suit.
  // Dépendance sur un booléen, pas sur `data.scan` : cet objet est recréé à chaque réponse JSON,
  // donc l'effet se démontait et se remontait à chaque rafraîchissement — le minuteur repartait
  // de zéro au lieu de tenir la cadence de 3 s.
  const scanning = !!data?.scan;
  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [scanning, refresh]);

  const bean = data?.beans.find((b) => b.index === selected) ?? null;

  /** Lit un profil sur la machine (commande 0xBA) puis rafraîchit. */
  const read = async (index: number) => {
    setBusy(true);
    setMsg(null);
    try {
      await mfetch("/api/beansystem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      setMsg(t("readQueued", { index }));
      setTimeout(refresh, 6000);
    } finally {
      setBusy(false);
    }
  };

  /** Balaye les index 0..5 : une commande 0xBA par grain, enchaînées côté serveur. */
  const scan = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beanadapt/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: 0, to: 5 }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : t("scanStarted", { from: r.from, to: r.to }));
    } finally {
      setBusy(false);
    }
  };

  const pick = (b: Bean) => {
    setSelected(b.index);
    setDraft({ name: b.name ?? "", grinder: b.grinder, temperature: b.temperature, aroma: b.aroma });
    setSim(null);
    setMsg(null);
  };

  /** Rejoue la règle Bean Adapt côté serveur — aucune écriture, aucun appel au cloud. */
  const simulate = async () => {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    try {
      const r: Simulation = await mfetch("/api/beanadapt/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, flowTime, crema, taste }),
      }).then((x) => x.json());
      if (r.error) setMsg(tc("error", { message: r.error }));
      else setSim(r);
    } finally {
      setBusy(false);
    }
  };

  const applySim = () => {
    if (!sim || !draft) return;
    setDraft({ ...draft, grinder: sim.grinder, temperature: sim.temperature, aroma: sim.aroma });
    setSim(null);
  };

  /** Écrit le profil dans la machine (0xBB). Modification persistante. */
  const save = async (visible = true) => {
    if (!draft || selected == null) return;
    const what = visible
      ? t("confirmSave", { index: selected, name: draft.name || t("unnamed"), grinder: draft.grinder, temperature: draft.temperature, aroma: draft.aroma })
      : t("confirmDelete", { index: selected });
    if (!confirm(`${what}\n\n${t("persistentWarning")}`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beanadapt/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: selected, ...draft, visible }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : t("saveSent", { frame: r.frameHex }));
      setTimeout(refresh, 8000);
    } finally {
      setBusy(false);
    }
  };

  /** Sélectionne ce Bean System comme actif sur la machine (0xB9). */
  const activate = async (index: number) => {
    if (!confirm(t("confirmActivate", { index }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "selectBean", beanId: index }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : t("activateSent", { frame: r.frameHex }));
    } finally {
      setBusy(false);
    }
  };

  const b = data?.bounds;

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      <div className="card warn">
        <strong>{t("localTitle")}</strong>
        <div className="sub" style={{ margin: "4px 0 0" }}>
          {t("localDetail")}
        </div>
      </div>

      <h2>{t("profilesHeading")}</h2>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="sub">{t("scanNote")}</span>
          <button className="primary" disabled={busy || !!data?.scan} onClick={scan}>
            {data?.scan ? t("scanning") : t("scan")}
          </button>
        </div>
      </div>
      {!data ? (
        <p className="sub">{tc("loading")}</p>
      ) : !data.beans.length ? (
        <div className="card">
          <p className="sub" style={{ margin: 0 }}>
            {t("noneRead")}
          </p>
          <div className="row" style={{ marginTop: 10 }}>
            {[0, 1, 2, 3].map((i) => (
              <button key={i} disabled={busy} onClick={() => read(i)}>
                {t("readIndex", { index: i })}
              </button>
            ))}
          </div>
        </div>
      ) : (
        data.beans.map((bs) => (
          <div className="card" key={bs.index}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{bs.name ?? t("unnamed")}</strong>{" "}
                <span className="sub mono" style={{ fontSize: ".8rem" }}>
                  index {bs.index}
                </span>
                {bs.active && (
                  <span className="pill on" style={{ marginLeft: 8 }} title={t("activeHint")}>
                    {t("activeBadge")}
                  </span>
                )}
                {bs.visible === false && (
                  <span className="pill off" style={{ marginLeft: 8 }}>
                    {t("hiddenBadge")}
                  </span>
                )}
                {bs.isToggle && (
                  <span className="pill off" style={{ marginLeft: 8 }} title={t("toggleHint")}>
                    {t("toggleBadge")}
                  </span>
                )}
                <div className="sub" style={{ margin: "2px 0 0" }}>
                  {t("summary", { grinder: bs.grinder, temperature: bs.temperature, aroma: bs.aroma })}

                </div>
              </div>
              <div className="row">
                <button disabled={busy} onClick={() => read(bs.index)}>
                  {tc("read")}
                </button>
                {!bs.isToggle && (
                  <>
                    <button disabled={busy || bs.active === true} onClick={() => activate(bs.index)} title={t("activateTitle")}>
                      {bs.active ? t("alreadyActive") : t("activate")}
                    </button>
                    <button className="primary" disabled={busy} onClick={() => pick(bs)}>
                      {selected === bs.index ? t("editing") : t("configure")}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))
      )}

      {draft && bean && b && (
        <>
          <h2>{t("assistantHeading", { name: bean.name ?? t("unnamed") })}</h2>
          <div className="card">
            <p className="sub" style={{ marginTop: 0 }}>
              {t("assistantIntro")}
            </p>

            <div className="row">
              <div>
                <label htmlFor="ft">{t("flowTime")}</label>
                <input id="ft" type="number" min={0} max={120} value={flowTime} onChange={(e) => setFlowTime(Number(e.target.value))} style={{ width: 90 }} />
              </div>
              <div>
                <label htmlFor="crema">{t("crema")}</label>
                <select id="crema" value={crema} onChange={(e) => setCrema(Number(e.target.value))}>
                  <option value={1}>{t("crema1")}</option>
                  <option value={2}>{t("crema2")}</option>
                  <option value={3}>{t("crema3")}</option>
                </select>
              </div>
              <div>
                <label htmlFor="taste">{t("taste")}</label>
                <select id="taste" value={taste} onChange={(e) => setTaste(Number(e.target.value))}>
                  <option value={1}>{t("taste1")}</option>
                  <option value={2}>{t("taste2")}</option>
                  <option value={3}>{t("taste3")}</option>
                </select>
              </div>
              <button className="primary" disabled={busy} onClick={simulate}>
                {t("simulate")}
              </button>
            </div>

            {flowTime >= 10 && flowTime < 20 ? (
              <p className="sub" style={{ marginBottom: 0 }}>
                {t("windowOk")}
              </p>
            ) : (
              <p className="sub" style={{ marginBottom: 0 }}>
                {t("windowOut")}
              </p>
            )}

            {sim && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                <table>
                  <thead>
                    <tr>
                      <th>{t("setting")}</th>
                      <th>{t("current")}</th>
                      <th>{t("delta")}</th>
                      <th>{t("proposed")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{t("grinder")}</td>
                      <td className="mono">{draft.grinder}</td>
                      <td className="mono">{fmtDelta(sim.deltas.grinder)}</td>
                      <td className="mono">{sim.grinder}</td>
                    </tr>
                    <tr>
                      <td>{t("temperature")}</td>
                      <td className="mono">{draft.temperature}</td>
                      <td className="mono">{fmtDelta(sim.deltas.temperature)}</td>
                      <td className="mono">{sim.temperature}</td>
                    </tr>
                    <tr>
                      <td>{t("aroma")}</td>
                      <td className="mono">{draft.aroma}</td>
                      <td className="mono">{fmtDelta(sim.deltas.aroma)}</td>
                      <td className="mono">{sim.aroma}</td>
                    </tr>
                  </tbody>
                </table>
                {sim.notes.map((n) => (
                  <p className="sub" key={n} style={{ margin: "6px 0 0" }}>
                    {t.has(`note_${n}`) ? t(`note_${n}`) : n}
                  </p>
                ))}
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="good" disabled={!sim.changed} onClick={applySim}>
                    {sim.changed ? t("applyToDraft") : t("nothingToChange")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <h2>{t("manualHeading")}</h2>
          <div className="card">
            <div className="row">
              <div>
                <label htmlFor="bname">{t("name")}</label>
                <input id="bname" value={draft.name} maxLength={20} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
            </div>
            <p className="sub" style={{ marginTop: 4 }}>
              {t("nameHint")}
            </p>

            {(
              [
                ["grinder", b.grinder],
                ["temperature", b.temperature],
                ["aroma", b.aroma],
              ] as const
            ).map(([key, bound]) => (
              <div className="row" key={key} style={{ justifyContent: "space-between", padding: "4px 0" }}>
                <span style={{ minWidth: 150 }}>
                  {t(key)}
                  {!bound.verified && (
                    <span className="sub" title={t("unverifiedHint")}>
                      {" "}
                      ({t("unverified")})
                    </span>
                  )}
                </span>
                <div className="row" style={{ gap: 8 }}>
                  <span className="sub mono" style={{ fontSize: ".78rem" }}>
                    {bound.min}
                  </span>
                  <input
                    type="range"
                    min={bound.min}
                    max={bound.max}
                    value={draft[key]}
                    aria-label={`${t(key)} (${bound.min}–${bound.max})`}
                    onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
                    style={{ width: 160 }}
                  />
                  <span className="sub mono" style={{ fontSize: ".78rem" }}>
                    {bound.max}
                  </span>
                  <input
                    type="number"
                    min={bound.min}
                    max={bound.max}
                    value={draft[key]}
                    onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
                    style={{ width: 70 }}
                  />
                </div>
              </div>
            ))}

            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" disabled={busy} onClick={() => save(true)}>
                {t("writeToMachine")}
              </button>
              <button disabled={busy} onClick={() => pick(bean)}>
                {tc("reset")}
              </button>
              <button className="danger" disabled={busy} onClick={() => save(false)} title={t("deleteTitle")}>
                {t("delete")}
              </button>
            </div>
          </div>
        </>
      )}

      {msg && <p className="warn">{msg}</p>}
    </>
  );
}

const fmtDelta = (d: number) => (d === 0 ? "—" : d > 0 ? `+${d}` : String(d));
