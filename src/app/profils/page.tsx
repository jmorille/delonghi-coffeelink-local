"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import { useMachinePush } from "../events";

interface OrderEntry {
  id: number;
  label: string | null;
}
interface Profile {
  id: number;
  name: string | null;
  icon: number | null;
  source: string | null;
  order: OrderEntry[] | null;
}
interface Custom {
  slot: number;
  beverageId: number;
  name: string | null;
  icon: number | null;
  source: string | null;
}
interface PropRow {
  prop: string;
  kind: string;
  stride: number | null;
  state: "read" | "absent" | "unread";
}
interface Payload {
  model: { type: string; nProfiles: number; customizableProfiles: boolean; nCustomRecipes: number };
  profiles: Profile[];
  customs: Custom[];
  props: PropRow[];
  importedAt: number | null;
  import: { active: boolean; remaining: number; ok: number; fail: number; pending: string | null } | null;
}

type Scope = "all" | "names" | "customNames" | "order";

const SCOPES: { value: Scope; key: string }[] = [
  { value: "all", key: "scopeAll" },
  { value: "names", key: "scopeNames" },
  { value: "customNames", key: "scopeCustomNames" },
  { value: "order", key: "scopeOrder" },
];

export default function Profils() {
  const t = useTranslations("profiles");
  const tc = useTranslations("common");
  const [data, setData] = useState<Payload | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showProps, setShowProps] = useState(false);

  const refresh = useCallback(async () => {
    setData(await mfetch("/api/profiles").then((r) => r.json()));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * La machine répond au fil de ses connexions : on est **prévenu** plutôt que de demander.
   *
   * Un import de profils lit des propriétés de noms et de priorités ; chaque valeur reçue passe par
   * `putProp`, qui horodate `importedAt`. C'est donc le signal exact d'une réponse arrivée, là où le
   * `setInterval(refresh, 2000)` d'avant re-téléchargeait la page entière deux fois par seconde de
   * trop, et se trompait de toute façon sur le moment.
   */
  const { live, busy: pending } = useMachinePush(refresh);

  // Repli : si le flux n'a pas pu s'établir, on retombe sur une scrutation, et seulement pendant
  // qu'un import tourne.
  const importing = !!data?.import?.active;
  useEffect(() => {
    if (live || !importing) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [live, importing, refresh]);

  const startImport = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/profiles/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what: scope }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : t("importQueued", { count: r.queued }));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const selectProfile = async (id: number) => {
    if (!confirm(t("confirmActivate", { id }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "selectProfile", profileId: id }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : t("activateSent", { label: r.program }));
    } finally {
      setBusy(false);
    }
  };

  const readCount = data?.props.filter((p) => p.state === "read").length ?? 0;
  const absentCount = data?.props.filter((p) => p.state === "absent").length ?? 0;

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro", { count: data?.model.nProfiles ?? 5, customs: data?.model.nCustomRecipes ?? 6 })}</p>

      {/* Ce que le flux dit de l'activité de la machine. Sans ça, une lecture demandée n'a aucune
          trace à l'écran entre le clic et l'arrivée des valeurs. */}
      {pending && <p className="sub">{t("pushWaiting")}</p>}
      {!live && <p className="sub">{t("pushOff")}</p>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("importHeading")}</h2>
        <p className="sub" style={{ marginBottom: 12 }}>{t("importNote")}</p>
        <div className="row">
          <div>
            <label htmlFor="scope">{t("whatToRead")}</label>
            <select id="scope" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {t(s.key)}
                </option>
              ))}
            </select>
          </div>
          <button className="primary" disabled={busy || data?.import?.active} onClick={startImport}>
            {data?.import?.active ? t("importing") : t("import")}
          </button>
          <button onClick={() => setShowProps(!showProps)}>
            {showProps ? tc("hide") : t("propsButton")} (
            {absentCount ? t("propsCountAbsent", { read: readCount, absent: absentCount }) : t("propsCount", { read: readCount })})
          </button>
        </div>
        {data?.import && (
          <div className="kv" style={{ marginTop: 12 }}>
            <span className="k">
              {t("importState", { state: data.import.active ? t("importActive") : t("importDone") })}
              {data.import.pending ? t("importPending", { prop: data.import.pending }) : ""}
            </span>
            <span className="mono">{t("importCounts", { ok: data.import.ok, remaining: data.import.remaining, fail: data.import.fail })}</span>
          </div>
        )}
        {msg && (
          <p className="warn" style={{ marginTop: 12, marginBottom: 0 }}>
            {msg}
          </p>
        )}
        {showProps && data && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>{t("propAyla")}</th>
                <th>{t("propRole")}</th>
                <th>{t("propStride")}</th>
                <th>{t("propState")}</th>
              </tr>
            </thead>
            <tbody>
              {data.props.map((p) => (
                <tr key={p.prop}>
                  <td className="mono">{p.prop}</td>
                  <td>{p.kind === "profileNames" ? t("roleProfileNames") : p.kind === "customNames" ? t("roleCustomNames") : p.kind === "priority" ? t("rolePriority") : p.kind}</td>
                  <td className="mono">{p.stride ?? "—"}</td>
                  <td>
                    {p.state === "read" ? (
                      t("stateRead")
                    ) : p.state === "absent" ? (
                      <span className="sub" title={t("stateAbsentHint")}>
                        {t("stateAbsent")}
                      </span>
                    ) : (
                      tc("dash")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!data ? (
        <p className="sub">{tc("loading")}</p>
      ) : (
        <>
          <h2>{t("listHeading", { count: data.model.nProfiles })}</h2>
          {data.profiles.map((p) => (
            <div className="card" key={p.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>
                    {tc("profileNumbered", { id: p.id })}
                    {p.name ? ` — ${p.name}` : ""}
                  </strong>
                  {!p.name && (
                    <span className="pill off" style={{ marginLeft: 8 }}>
                      {t("nameNotRead")}
                    </span>
                  )}
                  {p.icon != null && (
                    <span className="sub mono" style={{ marginLeft: 8, fontSize: ".8rem" }}>
                      {t("icon", { n: p.icon })}
                    </span>
                  )}
                  <div className="sub" style={{ margin: "2px 0 0" }}>
                    {p.order
                      ? t("orderSummary", { count: p.order.length, list: p.order.map((o) => o.label ?? `#${o.id}`).join(" · ") })
                      : t("orderNotRead")}
                  </div>
                  {p.source && (
                    <div className="sub mono" style={{ margin: "2px 0 0", fontSize: ".78rem" }}>
                      {p.source}
                    </div>
                  )}
                </div>
                <button disabled={busy} onClick={() => selectProfile(p.id)} title={t("activateTitle")}>
                  {t("activate")}
                </button>
              </div>
            </div>
          ))}

          <h2>{t("customsHeading", { count: data.model.nCustomRecipes })}</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>{t("slot")}</th>
                  <th>{t("machineName")}</th>
                  <th>{t("iconColumn")}</th>
                  <th>{t("beverageId")}</th>
                </tr>
              </thead>
              <tbody>
                {data.customs.map((c) => (
                  <tr key={c.slot}>
                    <td>{t("customSlot", { n: c.slot })}</td>
                    <td>{c.name ?? <span className="sub">{t("unnamed")}</span>}</td>
                    <td className="mono">{c.icon ?? tc("dash")}</td>
                    <td className="mono">{c.beverageId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sub" style={{ marginBottom: 0, marginTop: 10 }}>
              {t("customsNote")}
            </p>
          </div>
        </>
      )}
    </>
  );
}
