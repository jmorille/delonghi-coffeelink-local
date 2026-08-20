"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { MachineSummary, currentMachine, forId, setCurrentMachine } from "../machine";

/**
 * Machines : la page qui les liste, les nomme, les configure et les supprime.
 *
 * **Elle configure sur place.** Une version précédente renvoyait vers `/cle-lan` pour l'adresse et
 * la clé, c'est-à-dire pour la moitié de ce qu'on vient faire ici : ajouter une machine obligeait à
 * changer de page, et cette page-là ne savait travailler que sur la machine *sélectionnée* — donc
 * il fallait d'abord basculer dessus. Deux allers-retours pour un réglage. Tout est maintenant dans
 * la carte de la machine concernée, et chaque requête nomme sa machine (`forId`), ce qui permet de
 * configurer une cafetière sans quitter celle qu'on regarde.
 *
 * L'ordre à l'intérieur d'une carte suit la dépendance réelle, elle n'est pas décorative :
 *
 *   1. **l'adresse** — sans elle on ne peut ni s'annoncer (`local_reg`) ni obtenir le DSN ;
 *   2. **la clé LAN** — que le cloud Ayla range sous ce DSN, d'où la dépendance.
 *
 * Le bloc de configuration est **ouvert d'office sur une machine incomplète** et replié sur une
 * machine prête : c'est le réglage qui manque qu'il faut avoir sous les yeux, pas un formulaire de
 * plus sur une machine qui marche.
 *
 * Deux limites du multi-machines sont écrites en bas, parce qu'elles ne se devinent pas :
 *
 * - le **catalogue de boissons est celui d'un seul modèle** (`machine-model.json`). Le modèle
 *   détecté est comparé, et un écart signalé : sur une machine d'un autre modèle l'adressage des
 *   propriétés de recette ne correspond pas, et une lecture fausse ressemble à une lecture normale ;
 * - les **variables d'environnement ne décrivent que la première machine**.
 *
 * Invariants côté serveur, qui décident de ce que cette page peut montrer : le mot de passe n'est
 * ni journalisé, ni stocké, ni renvoyé, et **aucun endpoint ne renvoie jamais la clé**. On ne
 * dispose donc que de `lanKeySet`, `lanKeyId`, `lanKeySource` et `lanKeyCachedAt`.
 */

interface Payload {
  defaultId: string;
  machines: MachineSummary[];
  /** L'adresse que nous ANNONÇONS aux machines : globale, un seul serveur écoute. */
  server: { ip: string | null; port: number; problem: string | null };
  /** Ce qui manquerait pour interroger le cloud. Normalement vide. */
  discovery: { missingConfig: string[] };
}

/** Verdict de la sonde. `reachable` dit qu'un serveur a répondu ; `isMachine`, que c'est la bonne. */
interface Probe {
  reachable: boolean;
  isMachine: boolean;
  status: number | null;
  error: string | null;
}

const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("fr-FR") : null);

export default function Machines() {
  const t = useTranslations("machines");
  const tk = useTranslations("lankey");
  const tm = useTranslations("machine");
  const tc = useTranslations("common");

  const [d, setD] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", ip: "" });

  // États par machine. Un enregistrement par identifiant plutôt qu'un état global : deux cartes
  // peuvent être en cours d'édition, et le message de l'une n'a rien à faire sous l'autre.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const [ip, setIp] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<Record<string, { email: string; password: string }>>({});
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      // Pas `mfetch` : cet endpoint n'est rattaché à aucune machine, et c'est justement lui qui
      // répare le cas d'un identifiant courant devenu invalide.
      const p: Payload = await fetch("/api/machines").then((r) => r.json());
      setD(p);
      // Le champ d'adresse est semé avec la valeur connue, sans jamais réécrire une saisie en cours.
      setIp((cur) => {
        const next = { ...cur };
        for (const m of p.machines) if (next[m.id] === undefined) next[m.id] = m.ip ?? "";
        return next;
      });
      // Ouvert d'office là où il manque un prérequis : c'est ce qu'on vient faire.
      setOpen((cur) => {
        const next = { ...cur };
        for (const m of p.machines) if (next[m.id] === undefined && !m.ready) next[m.id] = true;
        return next;
      });
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    }
  }, [tc]);

  useEffect(() => {
    setSelected(currentMachine());
    load();
  }, [load]);

  const cred = (id: string) => creds[id] ?? { email: "", password: "" };

  /**
   * Enveloppe commune : un seul verrou par machine, le message rangé sous sa carte, et la liste
   * rechargée. `lankey-changed` prévient la barre de navigation, qui masque les pages dépendant
   * des prérequis — sans quoi le menu ne reviendrait qu'au prochain rechargement complet.
   */
  const run = async (id: string, action: () => Promise<string | null>) => {
    setBusy(id);
    setNote((n) => ({ ...n, [id]: "" }));
    try {
      const message = await action();
      if (message) setNote((n) => ({ ...n, [id]: message }));
      await load();
      window.dispatchEvent(new Event("lankey-changed"));
    } catch (e) {
      setNote((n) => ({ ...n, [id]: tc("error", { message: String(e) }) }));
    } finally {
      setBusy(null);
    }
  };

  /** Enregistre l'adresse puis la teste : une adresse muette doit être signalée tout de suite. */
  const saveIp = (m: MachineSummary) =>
    run(m.id, async () => {
      const r = await fetch(forId("/api/machine", m.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: ip[m.id] ?? "" }),
      }).then((x) => x.json());
      if (r.error) return tc("error", { message: r.error });
      const probe: Probe = r.probe;
      return probe.isMachine
        ? tm("savedReachable", { ip: r.ip, dsn: r.dsn ?? tm("dsnNone") })
        : probe.reachable
          ? tm("savedNotAMachine", { ip: r.ip, status: String(probe.status ?? "?") })
          : tm("savedUnreachable", { ip: r.ip, reason: probe.error ?? String(probe.status ?? "?") });
    });

  const forgetIp = (m: MachineSummary) => {
    if (!confirm(tm("forgetConfirm"))) return;
    return run(m.id, async () => {
      const r = await fetch(forId("/api/machine", m.id), { method: "DELETE" }).then((x) => x.json());
      setIp((cur) => ({ ...cur, [m.id]: r.ip ?? "" }));
      return tm("forgotten", { state: r.ip ?? tm("none") });
    });
  };

  /**
   * Le mot de passe part vers notre serveur, qui s'en sert le temps d'interroger Gigya puis Ayla et
   * ne le conserve pas. On l'efface du formulaire dès la réponse, quelle qu'elle soit, et le champ
   * repart masqué : laissé en clair d'une tentative à l'autre, il finirait par exposer la saisie
   * suivante sans qu'on l'ait demandé.
   */
  const discover = (m: MachineSummary) =>
    run(m.id, async () => {
      try {
        const r = await fetch(forId("/api/lankey", m.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cred(m.id)),
        }).then((x) => x.json());
        return r.error
          ? tc("error", { message: r.error })
          : tk("found", { keyId: r.keyId, changed: r.changed ? tk("changed") : tk("confirmed") });
      } finally {
        setCreds((c) => ({ ...c, [m.id]: { email: cred(m.id).email, password: "" } }));
        setShowPassword((s) => ({ ...s, [m.id]: false }));
      }
    });

  const forgetKey = (m: MachineSummary) => {
    if (!confirm(tk("forgetConfirm"))) return;
    return run(m.id, async () => {
      const r = await fetch(forId("/api/lankey", m.id), { method: "DELETE" }).then((x) => x.json());
      return tk("forgotten", { state: r.set ? tk("stillSet") : tk("nowUnset") });
    });
  };

  const add = async () => {
    setBusy("+");
    setMsg(null);
    try {
      const r = await fetch("/api/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: form.label || null, ip: form.ip || null }),
      }).then((x) => x.json());
      if (r.error) {
        setMsg(tc("error", { message: r.error }));
      } else {
        const probe: Probe | null = r.probe;
        setMsg(
          !probe
            ? t("added", { name: r.machine.label })
            : probe.isMachine
              ? t("addedReachable", { name: r.machine.label, dsn: r.machine.dsn ?? "?" })
              : probe.reachable
                ? t("addedNotAMachine", { name: r.machine.label, status: String(probe.status ?? "?") })
                : t("addedUnreachable", { name: r.machine.label, reason: probe.error ?? String(probe.status ?? "?") }),
        );
        setForm({ label: "", ip: "" });
        await load();
        window.dispatchEvent(new Event("lankey-changed"));
      }
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const patch = (m: MachineSummary, body: Record<string, unknown>, done: (r: { machine: MachineSummary }) => string) =>
    run(m.id, async () => {
      const r = await fetch(`/api/machines/${encodeURIComponent(m.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      return r.error ? tc("error", { message: r.error }) : done(r);
    });

  /**
   * Suppression : elle emporte tout ce qui a été lu sur cette machine, et sa clé LAN mémorisée.
   * D'où la confirmation qui nomme précisément ce qui part.
   */
  const remove = async (m: MachineSummary) => {
    if (!confirm(t("deleteConfirm", { name: m.label, props: m.counts.props, stats: m.counts.stats }))) return;
    setBusy(m.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/machines/${encodeURIComponent(m.id)}`, { method: "DELETE" }).then((x) => x.json());
      if (r.error) {
        setMsg(tc("error", { message: r.error }));
      } else {
        setMsg(t("deleted", { name: m.label }));
        // Si c'était la machine affichée, on repasse sur celle par défaut du serveur.
        if (currentMachine() === m.id) {
          setCurrentMachine(null);
          setSelected(null);
        }
      }
      await load();
      window.dispatchEvent(new Event("lankey-changed"));
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const select = (id: string) => {
    setCurrentMachine(id);
    setSelected(id);
    setMsg(t("selected", { name: d?.machines.find((x) => x.id === id)?.label ?? id }));
  };

  const courante = selected ?? d?.defaultId ?? null;

  return (
    <>
      <h1>{t("title")}</h1>
      <p className="sub">{t("intro")}</p>

      {msg && <div className="warn">{msg}</div>}

      {d?.machines.map((m) => {
        const occupe = busy === m.id;
        const ouvert = open[m.id] ?? false;
        const c = cred(m.id);
        return (
          <div className="card" key={m.id}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <div className="row">
                <strong style={{ fontSize: "1.05rem" }}>{m.label}</strong>
                <span className="mono sub" style={{ margin: 0 }}>
                  {m.id}
                </span>
                {m.id === courante && <span className="pill on">{t("current")}</span>}
                {m.id === d.defaultId && <span className="pill">{t("isDefault")}</span>}
                <span className={`pill ${m.ready ? "on" : "off"}`}>{m.ready ? t("ready") : t("notReady")}</span>
                {m.sessionActive && <span className="pill on">{t("session")}</span>}
              </div>
              <div className="row">
                {m.id !== courante && (
                  <button onClick={() => select(m.id)} disabled={!!busy}>
                    {t("select")}
                  </button>
                )}
                <button className={ouvert ? "" : "primary"} onClick={() => setOpen({ ...open, [m.id]: !ouvert })}>
                  {ouvert ? t("configureHide") : t("configure")}
                </button>
                {m.id !== d.defaultId && (
                  <button
                    className="mini"
                    onClick={() => patch(m, { makeDefault: true }, (r) => t("defaultSet", { name: r.machine.label }))}
                    disabled={!!busy}
                  >
                    {t("makeDefault")}
                  </button>
                )}
                <button className="danger" onClick={() => remove(m)} disabled={!!busy}>
                  {t("delete")}
                </button>
              </div>
            </div>

            {/* Deux entrees pour un seul appareil : une seule recevra la session, l'autre
                restera muette. C'est l'erreur naturelle (nom court puis nom complet), et rien
                d'autre ne la signalerait. */}
            {m.duplicates.length > 0 && (
              <div className="warn" style={{ marginBottom: 10 }}>
                ⚠️{" "}
                {t("duplicate", {
                  names: m.duplicates.map((x) => x.label).join(", "),
                  reason: m.duplicates.some((x) => x.reason === "dsn") ? t("duplicateDsn") : t("duplicateAddress"),
                })}
              </div>
            )}

            {m.model.matchesCatalog === false && (
              <div className="warn" style={{ marginBottom: 10 }}>
                ⚠️ {t("modelMismatch", { detected: m.model.key ?? "?" })}
              </div>
            )}

            <div className="kv">
              <span className="k">{t("name")}</span>
              <span className="row">
                <input
                  value={renaming[m.id] ?? m.custom ?? ""}
                  placeholder={m.label}
                  onChange={(e) => setRenaming({ ...renaming, [m.id]: e.target.value })}
                  style={{ width: 200 }}
                />
                <button
                  className="mini"
                  disabled={!!busy || renaming[m.id] === undefined}
                  onClick={() =>
                    patch(m, { label: renaming[m.id] ?? "" }, (r) => {
                      setRenaming((cur) => {
                        const next = { ...cur };
                        delete next[m.id];
                        return next;
                      });
                      return t("renamed", { name: r.machine.label });
                    })
                  }
                >
                  {t("rename")}
                </button>
              </span>
            </div>
            <div className="kv">
              <span className="k">{tm("address")}</span>
              <span>
                {m.ip ? <span className="mono">{m.ip}</span> : t("noAddress")} <span className="sub">({m.ipSource})</span>
                {m.envForced.ip && <span className="pill"> {t("envForced")}</span>}
              </span>
            </div>
            <div className="kv">
              <span className="k">{tk("heading")}</span>
              <span>
                {m.lanKeySet ? t("lanKeyPresent", { keyId: String(m.lanKeyId ?? "?") }) : t("lanKeyAbsent")}{" "}
                <span className="sub">({m.lanKeySource})</span>
              </span>
            </div>
            <div className="kv">
              <span className="k">DSN</span>
              <span>
                {m.dsn ? <span className="mono">{m.dsn}</span> : t("unknown")} <span className="sub">({m.dsnSource})</span>
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("model")}</span>
              <span>
                {m.model.key ? `${m.model.key}${m.model.machineName ? ` · ${m.model.machineName}` : ""}` : t("unknown")}{" "}
                <span className="sub">({m.model.source})</span>
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("read")}</span>
              <span>
                {t("counts", {
                  props: m.counts.props,
                  stats: m.counts.stats,
                  beans: m.counts.beanSystems,
                  recipes: m.counts.recipes,
                })}
                {m.importedAt && <span className="sub"> · {date(m.importedAt)}</span>}
              </span>
            </div>

            {/* ------------------------------------------------ configuration, sur place */}
            {ouvert && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                {/* 1. l'adresse — elle conditionne la clé, d'où cet ordre. */}
                <h3 style={{ margin: "0 0 4px" }}>{tm("heading")}</h3>
                <p className="sub" style={{ marginBottom: 8 }}>
                  {tk("addressWhy")}
                </p>
                {!m.ip && <div className="warn" style={{ marginBottom: 10 }}>⚠️ {tm("notConfigured")}</div>}
                <p className="sub" style={{ marginBottom: 6 }}>
                  {tm("setNote")}
                </p>
                {m.envForced.ip && <p className="sub">{tm("envForced")}</p>}
                <div className="row">
                  <input
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={tm("placeholder")}
                    value={ip[m.id] ?? ""}
                    onChange={(e) => setIp({ ...ip, [m.id]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (ip[m.id] ?? "").trim() && !occupe) saveIp(m);
                    }}
                    style={{ minWidth: 240 }}
                  />
                  <button className="primary" onClick={() => saveIp(m)} disabled={occupe || !(ip[m.id] ?? "").trim()}>
                    {occupe ? tm("testing") : tm("save")}
                  </button>
                  {m.ipCachedAt && (
                    <button className="mini" onClick={() => forgetIp(m)} disabled={occupe}>
                      {tm("forget")}
                    </button>
                  )}
                </div>

                {/* 2. la clé — rangée chez Ayla sous le DSN, donc dépendante de ce qui précède. */}
                <h3 style={{ margin: "18px 0 4px" }}>{tk("discoverHeading")}</h3>
                <div className="kv">
                  <span className="k">{tk("cachedAt")}</span>
                  <span className="mono">{date(m.lanKeyCachedAt) ?? tk("neverDiscovered")}</span>
                </div>
                {!m.dsn && <div className="warn" style={{ margin: "10px 0" }}>⚠️ {tk("needsDsn")}</div>}
                {d.discovery.missingConfig.length ? (
                  <p className="sub">{tk("missingConfig", { vars: d.discovery.missingConfig.join(", ") })}</p>
                ) : (
                  <>
                    <p className="sub" style={{ marginBottom: 4 }}>
                      {tk("flow")}
                    </p>
                    <p className="sub" style={{ marginBottom: 8 }}>
                      {tk("privacy")}
                    </p>
                    <div className="row">
                      <input
                        type="email"
                        autoComplete="off"
                        placeholder={tk("email")}
                        value={c.email}
                        onChange={(e) => setCreds({ ...creds, [m.id]: { ...c, email: e.target.value } })}
                        style={{ minWidth: 240 }}
                      />
                      {/* En clair, le champ redevient un champ texte ordinaire : sans autoCapitalize /
                          autoCorrect / spellCheck, le clavier mobile met une majuscule au premier
                          caractère et le correcteur s'en mêle. */}
                      <span className="row" style={{ gap: 4 }}>
                        <input
                          type={showPassword[m.id] ? "text" : "password"}
                          autoComplete="off"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          placeholder={tk("password")}
                          value={c.password}
                          onChange={(e) => setCreds({ ...creds, [m.id]: { ...c, password: e.target.value } })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && c.email && c.password && !occupe) discover(m);
                          }}
                          style={{ minWidth: 200 }}
                        />
                        <button
                          type="button"
                          className="mini"
                          aria-pressed={!!showPassword[m.id]}
                          aria-label={showPassword[m.id] ? tk("hidePassword") : tk("showPassword")}
                          title={showPassword[m.id] ? tk("hidePassword") : tk("showPassword")}
                          onClick={() => setShowPassword({ ...showPassword, [m.id]: !showPassword[m.id] })}
                        >
                          {showPassword[m.id] ? tk("hide") : tk("show")}
                        </button>
                      </span>
                      <button className="primary" onClick={() => discover(m)} disabled={occupe || !c.email || !c.password || !m.dsn}>
                        {occupe ? tk("working") : tk("fetch")}
                      </button>
                      {m.lanKeyCachedAt && (
                        <button className="mini" onClick={() => forgetKey(m)} disabled={occupe}>
                          {tk("forget")}
                        </button>
                      )}
                    </div>
                    {m.lanKeyCachedAt && (
                      <p className="sub" style={{ marginBottom: 0, marginTop: 8 }}>
                        {tk("forgetNote")}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {note[m.id] && (
              <p className="sub" style={{ marginBottom: 0, marginTop: 10 }}>
                {note[m.id]}
              </p>
            )}
          </div>
        );
      })}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("addTitle")}</h2>
        <p className="sub">{t("addNote")}</p>
        <div className="row">
          <span>
            <label>{t("nameOptional")}</label>
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={t("namePlaceholder")} />
          </span>
          <span>
            <label>{t("addressOptional")}</label>
            <input value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} placeholder="192.168.1.42" />
          </span>
          <button className="primary" onClick={add} disabled={!!busy}>
            {t("add")}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("limitsTitle")}</h2>
        <div className="kv">
          <span className="k">{tm("ourServer")}</span>
          <span className="mono">
            {d?.server.ip ? `${d.server.ip}:${d.server.port}` : tc("dash")}
            {d?.server.problem ? " ⚠️" : ""}
          </span>
        </div>
        <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
          {t("limitsCatalog")}
        </p>
        <p className="sub" style={{ marginBottom: 0 }}>
          {t("limitsEnv")}
        </p>
        <p className="sub" style={{ marginBottom: 0 }}>
          {t("limitsRouting")}
        </p>
        <p className="sub" style={{ marginBottom: 0 }}>
          {tm("reachabilityNote")}
        </p>
        <p className="sub" style={{ marginBottom: 0 }}>
          {tk("localNote")}
        </p>
      </div>
    </>
  );
}
