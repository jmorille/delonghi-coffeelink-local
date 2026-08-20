"use client";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";

/** Partie du monitor qu'on exploite ici — le reste de `/api/status` reste souple. */
interface Monitor {
  at: number;
  stateByte: number;
  switches: { name: string; label: string }[];
  alarmBits: number;
  alarms: { bit: number; name: string | null; ignored: boolean }[];
}

interface Recipe {
  id: string;
  name: string;
  beverageId: number;
  profileId: number;
}

export default function Dashboard() {
  const t = useTranslations("dashboard");
  const tp = useTranslations("power");
  const tc = useTranslations("common");
  const ta = useTranslations("alarm");
  const [status, setStatus] = useState<any>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [busy, setBusy] = useState(false);
  /** Retour de la dernière action. Sans lui, un refus du serveur (409 clé LAN absente) passait
   *  totalement inaperçu : la page se contentait de rafraîchir l'état, inchangé. */
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await mfetch("/api/status").then((r) => r.json());
    setStatus(s);
  }, []);

  useEffect(() => {
    refresh();
    mfetch("/api/recipes")
      .then((r) => r.json())
      .then((d) => setRecipes(d.recipes));
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const send = async (bodyObj: any) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : tp("powerSent", { label: r.program ?? "" }));
      await refresh();
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/register", { method: "POST" }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : t("registerSent", { status: r.status ?? "?" }));
      await refresh();
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const cfg = status?.config;
  const sess = status?.session;
  const mon: Monitor | null = status?.lastMonitor ?? null;

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">
        Serveur LAN mode Ayla — commande directe de la machine, sans cloud.
      </p>

      {/* Message unifié avec celui de la page d'accueil, et qui renvoie vers la page qui sait
          récupérer la clé — l'ancien texte ne parlait que de .env.local, antérieur à la page. */}
      {cfg && !cfg.lanKeySet && (
        <div className="warn">
          ⚠️ {tc("noLanKey")} <a href="/machines">{tc("noLanKeyLink")}</a>
        </div>
      )}

      {/* L'adresse annoncée était affichée comme un fait neutre, alors qu'une boucle locale rend
          tout pilotage impossible. La page montrait « 127.0.0.1:80 » et « Session LAN : en
          attente » sans jamais relier les deux. */}
      {cfg?.serverIpProblem && (
        <div className="warn">
          ⚠️ {tc("badServerIp", { problem: cfg.serverIpProblem })}
        </div>
      )}

      {msg && <p className="sub">{msg}</p>}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="kv">
              <span className="k">Session LAN</span>
              <span className={"pill " + (sess?.active ? "on" : "off")}>
                {sess?.active ? "établie" : "en attente"}
              </span>
            </div>
            <div className="kv">
              <span className="k">Machine</span>
              <span className="mono">{cfg?.machineIp} · {cfg?.dsn}</span>
            </div>
            <div className="kv">
              <span className="k">{t("server")}</span>
              <span className="mono">
                {cfg?.serverIpProblem ? "⚠️ " : ""}
                {cfg?.serverIp ?? tc("none")}:{cfg?.serverPort}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("machineStateMonitor")}</span>
              <span className="mono">
                {/* 0x04 est le seul état certain (veille) ; le reste = éveillée. « progress »
                    n'existe pas : les octets 5-6 sont les capteurs, affichés plus bas. */}
                {mon
                  ? `${mon.stateByte === 0x04 ? "⚪ " + tp("standby") : mon.stateByte === 0x02 ? "🟢 " + tp("ready") : mon.stateByte === 0x00 ? "🟠 " + tp("heating") : "🟢 0x" + mon.stateByte.toString(16).padStart(2, "0")}`
                  : tc("dash")}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("runningProgram")}</span>
              <span className="mono">
                {status?.program?.active ? `${status.program.label} (#${status.program.counter})` : "—"}
              </span>
            </div>
          </div>
          <button onClick={register} disabled={busy}>
            {t("announce")}
          </button>
        </div>
      </div>

      <h2>{t("alarms")}</h2>
      <div className="card">
        {!mon ? (
          <p className="sub" style={{ margin: 0 }}>
            {t("alarmsUnread")}
          </p>
        ) : !mon.alarms?.length ? (
          <p className="sub" style={{ margin: 0 }}>
            {t("noAlarms")}
          </p>
        ) : (
          <>
            {mon.alarms.map((a) => (
              <div className="kv" key={a.bit}>
                <span className="k">
                  {a.name ? (
                    ta.has(a.name) ? (
                      ta(a.name)
                    ) : (
                      a.name
                    )
                  ) : (
                    <span className="sub">{t("alarmIgnored")}</span>
                  )}
                </span>
                <span className="mono">{t("alarmBit", { bit: a.bit })}</span>
              </div>
            ))}
          </>
        )}
        {mon && (
          <div className="kv">
            <span className="k">{t("alarmRaw")}</span>
            <span className="mono">0x{(mon.alarmBits ?? 0).toString(16).padStart(8, "0")}</span>
          </div>
        )}
      </div>

      <h2>{t("sensors")}</h2>
      <div className="card">
        {!mon?.switches?.length ? (
          <p className="sub" style={{ margin: 0 }}>
            {mon ? t("noSensors") : t("alarmsUnread")}
          </p>
        ) : (
          <div className="row">
            {mon.switches.map((sw) => (
              <span className="pill on" key={sw.name}>
                {sw.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <h2>{t("machineCommands")}</h2>
      <div className="card row">
        <button className="good" disabled={busy} onClick={() => send({ action: "on" })}>
          {tp("turnOn")}
        </button>
        <button className="danger" disabled={busy} onClick={() => send({ action: "off" })}>
          {tp("turnOff")}
        </button>
      </div>

      <h2>{t("beverages")}</h2>
      <div className="card">
        {recipes.length === 0 && <p className="sub">{t("noRecipes")}</p>}
        <div className="grid">
          {recipes.map((r) => (
            <button
              key={r.id}
              className="primary"
              disabled={busy}
              onClick={() => send({ action: "dispense", recipeId: r.id })}
              title={`boisson ${r.beverageId} · profil ${r.profileId}`}
            >
              {r.name}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            disabled={busy}
            onClick={() => send({ action: "stop", beverageId: 1, profileId: 1 })}
          >
            {t("stopPreparation")}
          </button>
        </div>
      </div>

      <h2>{t("commandQueue")}</h2>
      <div className="card">
        {status?.queue?.length ? (
          <table>
            <thead>
              <tr>
                <th>Libellé</th>
                <th>Propriété</th>
                <th>ACK</th>
              </tr>
            </thead>
            <tbody>
              {status.queue.map((c: any) => (
                <tr key={c.id || c.queuedAt}>
                  <td>{c.label}</td>
                  <td className="mono">{c.name}</td>
                  <td>{c.needsAck ? "oui" : "non"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">File vide.</p>
        )}
      </div>

      <h2>Journal</h2>
      <div className="card log">
        {status?.log?.map((e: any, i: number) => (
          <div key={i} className={e.dir}>
            [{new Date(e.t).toLocaleTimeString()}] {e.dir.toUpperCase()}
            {/* Le journal est unique, toutes machines confondues : sans cette étiquette, deux
                cafetières produiraient une chronologie indéchiffrable. Elle n'apparaît qu'à partir
                de deux machines, sinon elle se répéterait à chaque ligne pour rien. */}
            {(status?.machines?.length ?? 0) > 1 && e.m ? ` · ${e.m}` : ""} · {e.msg}
          </div>
        ))}
      </div>
    </>
  );
}
