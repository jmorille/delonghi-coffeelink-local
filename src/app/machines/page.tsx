"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { MachineSummary, currentMachine, setCurrentMachine } from "../machine";

/**
 * Gestion des machines : en ajouter, les nommer, choisir celle qui est pilotée par défaut, en
 * supprimer.
 *
 * Volontairement séparée de /cle-lan, qui règle les prérequis d'UNE machine (son adresse, sa clé).
 * Ici on gère la liste ; là-bas on configure celle qui est sélectionnée.
 *
 * Deux choses que cette page doit dire sans détour, parce qu'elles ne se devinent pas :
 *
 * - **le catalogue de boissons est celui d'un seul modèle** (`machine-model.json`). Le modèle
 *   détecté sur chaque machine est comparé à celui du catalogue, et un écart est signalé : sur une
 *   machine d'un autre modèle, l'adressage des propriétés de recette ne correspond pas, et une
 *   lecture fausse ressemble à une lecture normale ;
 * - **les variables d'environnement ne décrivent que la première machine**. Une adresse saisie
 *   ici sur celle-là sera reprise par `MACHINE_IP` au prochain démarrage.
 *
 * Aucun secret n'est affiché : de la clé LAN, on ne voit que sa présence et son `key_id`, qui
 * circule en clair dans l'échange de clés.
 */

interface Payload {
  defaultId: string;
  machines: MachineSummary[];
}

interface Probe {
  reachable: boolean;
  isMachine: boolean;
  status: number | null;
  error: string | null;
}

const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("fr-FR") : null);

export default function Machines() {
  const t = useTranslations("machines");
  const tc = useTranslations("common");

  const [d, setD] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ label: "", ip: "" });
  /** Renommage en cours : identifiant → texte saisi. */
  const [renaming, setRenaming] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      // Pas `mfetch` ici : cet endpoint n'est rattaché à aucune machine, et c'est justement lui
      // qui répare le cas d'un identifiant courant devenu invalide.
      setD(await fetch("/api/machines").then((r) => r.json()));
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    }
  }, [tc]);

  useEffect(() => {
    setSelected(currentMachine());
    load();
  }, [load]);

  const add = async () => {
    setBusy(true);
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
      }
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>, done: (r: { machine: MachineSummary }) => string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/machines/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : done(r));
      await load();
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Suppression : elle emporte tout ce qui a été lu sur cette machine, et sa clé LAN mémorisée.
   * D'où la confirmation qui nomme précisément ce qui part.
   */
  const remove = async (m: MachineSummary) => {
    if (!confirm(t("deleteConfirm", { name: m.label, props: m.counts.props, stats: m.counts.stats }))) return;
    setBusy(true);
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
    } catch (e) {
      setMsg(tc("error", { message: String(e) }));
    } finally {
      setBusy(false);
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
        const ecart = m.model.matchesCatalog === false;
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
                  <button onClick={() => select(m.id)} disabled={busy}>
                    {t("select")}
                  </button>
                )}
                {m.id !== d.defaultId && (
                  <button
                    className="mini"
                    onClick={() => patch(m.id, { makeDefault: true }, (r) => t("defaultSet", { name: r.machine.label }))}
                    disabled={busy}
                  >
                    {t("makeDefault")}
                  </button>
                )}
                <button className="danger" onClick={() => remove(m)} disabled={busy}>
                  {t("delete")}
                </button>
              </div>
            </div>

            {ecart && (
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
                  disabled={busy || renaming[m.id] === undefined}
                  onClick={() =>
                    patch(m.id, { label: renaming[m.id] ?? "" }, (r) => {
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
              <span className="k">{t("address")}</span>
              <span>
                {m.ip ? <span className="mono">{m.ip}</span> : t("noAddress")} <span className="sub">({m.ipSource})</span>
                {m.envForced.ip && <span className="pill"> {t("envForced")}</span>}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("lanKey")}</span>
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

            {m.id === courante && (
              <div className="row" style={{ marginTop: 10 }}>
                <a href="/cle-lan">
                  <button className="primary">{t("configure")}</button>
                </a>
              </div>
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
          <button className="primary" onClick={add} disabled={busy}>
            {t("add")}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("limitsTitle")}</h2>
        <p className="sub" style={{ marginBottom: 0 }}>
          {t("limitsCatalog")}
        </p>
        <p className="sub" style={{ marginBottom: 0 }}>
          {t("limitsEnv")}
        </p>
        <p className="sub" style={{ marginBottom: 0 }}>
          {t("limitsRouting")}
        </p>
      </div>
    </>
  );
}
