"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";

/**
 * Prérequis du pilotage, dans l'ordre où ils se conditionnent :
 *
 *   1. **l'adresse de la machine** — sans elle on ne peut ni s'annoncer (`local_reg`) ni obtenir
 *      le DSN ;
 *   2. **la clé LAN** — que le cloud Ayla range sous ce DSN, d'où la dépendance.
 *
 * Les deux vivent sur cette page parce que régler le second sans le premier est impossible. Une
 * fois le DSN mémorisé, la récupération de la clé n'a plus besoin de l'adresse.
 *
 * Séparée de /systeme, qui est une fiche technique en lecture seule — un formulaire d'identifiants
 * n'a rien à y faire.
 *
 * Invariants côté serveur, rappelés ici parce qu'ils décident de ce que cette page peut afficher :
 * le mot de passe n'est ni journalisé, ni stocké, ni renvoyé, et **aucun endpoint ne renvoie
 * jamais la clé**. On ne dispose donc que de `set`, `keyId`, `source`, `cachedAt` et `dsn`.
 */

/** État de la clé LAN. La clé elle-même n'est jamais transmise — seulement sa provenance. */
interface LanKeyState {
  set: boolean;
  keyId: number | null;
  source: string;
  cachedAt: number | null;
  missingConfig: string[];
  dsn: string | null;
}

/** État de l'adresse machine. Le serveur n'a **aucune valeur par défaut**. */
interface MachineState {
  ip: string | null;
  source: string;
  /** `MACHINE_IP` dans .env.local : la saisie marche, mais l'environnement gagne au redémarrage. */
  envForced: boolean;
  cachedAt: number | null;
  dsn: string | null;
  dsnSource: string;
  serverIp: string;
  serverPort: number;
}

/** Verdict de la sonde. `reachable` dit qu'un serveur a répondu ; `isMachine`, que c'est la bonne. */
interface Probe {
  reachable: boolean;
  isMachine: boolean;
  status: number | null;
  error: string | null;
}

export default function CleLan() {
  const t = useTranslations("lankey");
  const tm = useTranslations("machine");
  const tc = useTranslations("common");

  const [machine, setMachine] = useState<MachineState | null>(null);
  const [ip, setIp] = useState("");
  const [machineMsg, setMachineMsg] = useState<string | null>(null);
  const [machineBusy, setMachineBusy] = useState(false);

  const [lanKey, setLanKey] = useState<LanKeyState | null>(null);
  const [creds, setCreds] = useState({ email: "", password: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Affichage en clair du mot de passe. Purement local à ce champ : rien n'est journalisé,
  // mémorisé ni renvoyé, le mot de passe ne sert que le temps de la requête.
  const [showPassword, setShowPassword] = useState(false);

  const load = useCallback(async () => {
    try {
      const [k, m] = await Promise.all([
        mfetch("/api/lankey").then((r) => r.json()),
        mfetch("/api/machine").then((r) => r.json()),
      ]);
      setLanKey(k);
      setMachine(m);
      // On ne réécrit pas un champ que l'utilisateur est en train de remplir.
      setIp((cur) => (cur ? cur : m.ip ?? ""));
    } catch {
      /* la page reste utilisable : c'est justement elle qui répare la configuration */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Enregistre l'adresse puis la teste : une adresse muette doit être signalée tout de suite. */
  const saveIp = async () => {
    setMachineBusy(true);
    setMachineMsg(null);
    try {
      const r = await mfetch("/api/machine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip }),
      }).then((x) => x.json());
      if (r.error) {
        setMachineMsg(tc("error", { message: r.error }));
      } else {
        const probe: Probe = r.probe;
        setMachineMsg(
          probe.isMachine
            ? tm("savedReachable", { ip: r.ip, dsn: r.dsn ?? tm("dsnNone") })
            : probe.reachable
              ? tm("savedNotAMachine", { ip: r.ip, status: String(probe.status ?? "?") })
              : tm("savedUnreachable", { ip: r.ip, reason: probe.error ?? String(probe.status ?? "?") }),
        );
        await load();
        window.dispatchEvent(new Event("lankey-changed"));
      }
    } catch (e) {
      setMachineMsg(tc("error", { message: String(e) }));
    } finally {
      setMachineBusy(false);
    }
  };

  const forgetIp = async () => {
    if (!confirm(tm("forgetConfirm"))) return;
    setMachineBusy(true);
    setMachineMsg(null);
    try {
      const r = await mfetch("/api/machine", { method: "DELETE" }).then((x) => x.json());
      setMachineMsg(tm("forgotten", { state: r.ip ?? tm("none") }));
      setIp(r.ip ?? "");
      await load();
      window.dispatchEvent(new Event("lankey-changed"));
    } finally {
      setMachineBusy(false);
    }
  };

  /**
   * Le mot de passe part vers notre serveur, qui s'en sert le temps d'interroger Gigya puis Ayla
   * et ne le conserve pas. On l'efface du formulaire dès la réponse, quelle qu'elle soit.
   */
  const discover = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/lankey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : t("found", { keyId: r.keyId, changed: r.changed ? t("changed") : t("confirmed") }));
      if (!r.error) {
        await load();
        // Le menu masque les pages qui ont besoin de la clé : il doit réapparaître tout de suite,
        // sans quoi on resterait coincé sur cette page après une récupération réussie.
        window.dispatchEvent(new Event("lankey-changed"));
      }
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    } finally {
      setCreds((c) => ({ ...c, password: "" }));
      // Le champ vidé repart masqué : un champ resté en clair d'une tentative à l'autre finirait
      // par exposer la saisie suivante sans qu'on l'ait demandé.
      setShowPassword(false);
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!confirm(t("forgetConfirm"))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/lankey", { method: "DELETE" }).then((x) => x.json());
      setMsg(t("forgotten", { state: r.set ? t("stillSet") : t("nowUnset") }));
      await load();
      window.dispatchEvent(new Event("lankey-changed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      {/* ---------------------------------------------------------------- 1. l'adresse */}
      <h2>{tm("heading")}</h2>
      <p className="sub">{t("addressWhy")}</p>

      {machine && !machine.ip && <div className="warn">⚠️ {tm("notConfigured")}</div>}

      <div className="card">
        <div className="kv">
          <span className="k">{tm("address")}</span>
          <span className="mono">{machine?.ip ?? tm("none")}</span>
        </div>
        <div className="kv">
          <span className="k">{tm("source")}</span>
          <span className="mono">{machine?.source ?? tc("dash")}</span>
        </div>
        <div className="kv">
          <span className="k">{tm("dsn")}</span>
          <span className="mono">
            {machine?.dsn ?? tm("dsnNone")}
            {machine?.dsn ? ` · ${machine.dsnSource}` : ""}
          </span>
        </div>
        <div className="kv">
          <span className="k">{tm("ourServer")}</span>
          <span className="mono">{machine ? `${machine.serverIp}:${machine.serverPort}` : tc("dash")}</span>
        </div>

        <p className="sub" style={{ marginBottom: 4 }}>{tm("setNote")}</p>
        {machine?.envForced && <p className="sub">{tm("envForced")}</p>}
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={tm("placeholder")}
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ip.trim() && !machineBusy) saveIp();
            }}
            style={{ minWidth: 240 }}
          />
          <button className="primary" onClick={saveIp} disabled={machineBusy || !ip.trim()}>
            {machineBusy ? tm("testing") : tm("save")}
          </button>
          {machine?.cachedAt && (
            <button className="mini" onClick={forgetIp} disabled={machineBusy}>
              {tm("forget")}
            </button>
          )}
        </div>
        {machineMsg && (
          <p className="sub" style={{ marginBottom: 0, marginTop: 10 }}>
            {machineMsg}
          </p>
        )}
      </div>

      {/* ---------------------------------------------------------------- 2. la clé */}
      <h2>{t("stateHeading")}</h2>
      <div className="card">
        <div className="kv">
          <span className="k">{t("state")}</span>
          <span className="mono">
            {lanKey
              ? lanKey.set
                ? t("set", { keyId: lanKey.keyId ?? 0, source: lanKey.source })
                : t("unset")
              : tc("dash")}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("cachedAt")}</span>
          <span className="mono">
            {lanKey?.cachedAt ? new Date(lanKey.cachedAt).toLocaleString("fr-FR") : t("neverDiscovered")}
          </span>
        </div>
      </div>

      <h2>{t("discoverHeading")}</h2>
      {/* La découverte range la clé sous le DSN : sans lui elle ne peut qu'échouer. Le DSN vient de
          la machine, donc de son adresse, saisie juste au-dessus. */}
      {lanKey && !lanKey.dsn && <div className="warn">⚠️ {t("needsDsn")}</div>}
      <div className="card">
        {lanKey?.missingConfig.length ? (
          <p className="sub" style={{ margin: 0 }}>
            {t("missingConfig", { vars: lanKey.missingConfig.join(", ") })}
          </p>
        ) : (
          <>
            <p className="sub" style={{ marginTop: 0 }}>{t("flow")}</p>
            <p className="sub">{t("privacy")}</p>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="email"
                autoComplete="off"
                placeholder={t("email")}
                value={creds.email}
                onChange={(e) => setCreds({ ...creds, email: e.target.value })}
                style={{ minWidth: 240 }}
              />
              {/* En clair, le champ redevient un champ texte ordinaire : sans autoCapitalize /
                  autoCorrect / spellCheck, le clavier mobile met une majuscule au premier
                  caractère et le correcteur s'en mêle. */}
              <span className="row" style={{ gap: 4, alignItems: "center" }}>
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={t("password")}
                  value={creds.password}
                  onChange={(e) => setCreds({ ...creds, password: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && creds.email && creds.password && !busy) discover();
                  }}
                  style={{ minWidth: 200 }}
                />
                <button
                  type="button"
                  className="mini"
                  aria-pressed={showPassword}
                  aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                  title={showPassword ? t("hidePassword") : t("showPassword")}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? t("hide") : t("show")}
                </button>
              </span>
              <button
                className="primary"
                onClick={discover}
                disabled={busy || !creds.email || !creds.password || (lanKey ? !lanKey.dsn : false)}
              >
                {busy ? t("working") : t("fetch")}
              </button>
            </div>
          </>
        )}
        {msg && (
          <p className="sub" style={{ marginBottom: 0, marginTop: 10 }}>
            {msg}
          </p>
        )}
      </div>

      {lanKey?.cachedAt && (
        <>
          <h2>{t("forgetHeading")}</h2>
          <div className="card">
            <p className="sub" style={{ marginTop: 0 }}>{t("forgetNote")}</p>
            <button className="mini" onClick={forget} disabled={busy}>
              {t("forget")}
            </button>
          </div>
        </>
      )}

      <p className="sub">{tm("reachabilityNote")}</p>
      <p className="sub">{t("localNote")}</p>
    </>
  );
}
