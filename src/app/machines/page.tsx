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
 * - le **catalogue de boissons vient du modèle détecté** de chaque machine. Deux familles restent
 *   hors de portée, et la carte le dit : les modèles dont la table constructeur ne donne aucune
 *   recette, et les boissons « iced »/« mug » des Striker, qui passent par une autre nomenclature ;
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
  /**
   * Session cloud : `refresh_token` mémorisé, qui évite de retaper le mot de passe.
   *
   * Décoché par défaut, et ça n'est pas une précaution de façade : c'est le seul secret de niveau
   * **compte** que ce serveur puisse écrire sur le disque. La clé LAN, elle, ne donne que le
   * pilotage local d'une cafetière — et encore faut-il être sur le réseau.
   */
  const [remember, setRemember] = useState(false);
  const [cloud, setCloud] = useState<{ set: boolean; at: number | null } | null>(null);

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
      const [p, c] = (await Promise.all([
        fetch("/api/machines").then((r) => r.json()),
        fetch("/api/cloudsession").then((r) => r.json()),
      ])) as [Payload, { set: boolean; at: number | null }];
      setD(p);
      setCloud(c);
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

  /**
   * Applique un état poussé en **ne remplaçant que les machines qui ont changé**.
   *
   * C'est là que se joue la réactivité fine : une machine inchangée garde son identité d'objet,
   * donc React ne redessine pas sa carte. Sans ça, chaque évènement reconstruirait toutes les
   * cartes — ce qui ramènerait le défaut qu'on voulait corriger, en poussé au lieu de sondé.
   *
   * La comparaison est faite sur la sérialisation : les résumés sont petits et entièrement
   * sérialisables, et une comparaison champ par champ serait à re-écrire à chaque nouveau champ.
   */
  const applyPush = useCallback((p: { machines: MachineSummary[]; defaultId: string }) => {
    setD((cur) => {
      if (!cur) return { ...p, server: { ip: null, port: 0, problem: null }, discovery: { missingConfig: [] } };
      const machines = p.machines.map((m) => {
        const avant = cur.machines.find((x) => x.id === m.id);
        return avant && JSON.stringify(avant) === JSON.stringify(m) ? avant : m;
      });
      // `server` et `discovery` ne changent pas en cours de route : on garde ceux du chargement.
      return { ...cur, defaultId: p.defaultId, machines };
    });
  }, []);

  useEffect(() => {
    setSelected(currentMachine());
    load();
  }, [load]);

  /**
   * L'état arrive **poussé** par le serveur (`/api/events`, Server-Sent Events).
   *
   * Une lecture de propriété n'est pas synchrone : le POST rend la main dès l'annonce, et c'est la
   * machine qui pousse la valeur deux secondes plus tard. Sonder, c'était re-télécharger la liste
   * entière toutes les deux secondes pour voir un champ changer — et se tromper de toute façon sur
   * le moment. Ici la page ne demande rien : elle est prévenue.
   *
   * Le repli n'est pas oublié : si le flux échoue (proxy qui ne le laisse pas passer, navigateur
   * sans EventSource), on retombe sur une scrutation, et seulement pendant qu'une lecture tourne.
   */
  const [flux, setFlux] = useState(true);
  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setFlux(false);
      return;
    }
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        applyPush(JSON.parse(e.data));
        setFlux(true);
      } catch {
        /* une trame illisible ne doit pas casser l'abonnement */
      }
    };
    es.onerror = () => setFlux(false);
    return () => es.close();
  }, [applyPush]);

  const enCours = d?.machines.some((m) => m.reading || m.running) ?? false;
  useEffect(() => {
    // Uniquement en repli, et uniquement tant qu'une lecture tourne. `reading` est borné côté
    // serveur par la fenêtre de l'import : la scrutation s'arrête donc d'elle-même.
    if (flux || !enCours) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [flux, enCours, load]);

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
      const suite = r.initialRead?.length ? " " + t("initialRead", { count: r.initialRead.length }) : "";
      const probe: Probe = r.probe;
      return (probe.isMachine
        ? tm("savedReachable", { ip: r.ip, dsn: r.dsn ?? tm("dsnNone") })
        : probe.reachable
          ? tm("savedNotAMachine", { ip: r.ip, status: String(probe.status ?? "?") })
          : tm("savedUnreachable", { ip: r.ip, reason: probe.error ?? String(probe.status ?? "?") })) + suite;
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
          body: JSON.stringify({ ...cred(m.id), remember }),
        }).then((x) => x.json());
        if (r.error) return tc("error", { message: r.error });
        // La lecture qui suit est asynchrone : la machine doit se connecter et pousser les
        // propriétés. On l'annonce, sans faire attendre l'utilisateur devant un compteur.
        return (
          tk("found", { keyId: r.keyId, changed: r.changed ? tk("changed") : tk("confirmed") }) +
          (r.initialRead?.length ? " " + t("initialRead", { count: r.initialRead.length }) : "") +
          // Ayla ne renvoie pas toujours un refresh_token : une case cochée sans effet serait un
          // mensonge, donc on ne l'annonce que si le serveur confirme l'avoir mémorisée.
          (remember && r.cloudSession ? t("cloudSessionKept") : "")
        );
      } finally {
        setCreds((c) => ({ ...c, [m.id]: { email: cred(m.id).email, password: "" } }));
        setShowPassword((s) => ({ ...s, [m.id]: false }));
      }
    });

  /**
   * Vérifie si une mise à jour OTA est proposée pour cette machine.
   *
   * Côté cloud, obligatoirement : le module n'expose que `regtoken.json` hors mode point d'accès, et
   * les requêtes OTA qu'il nous adresse disent qu'il en veut une, pas qu'il en existe une.
   *
   * Les identifiants déjà saisis pour la clé servent ici aussi — c'est le même chemin
   * d'authentification. S'ils sont vides, le serveur se rabat sur AYLA_TOKEN. Le mot de passe est
   * effacé du formulaire comme pour la clé : il ne doit pas rester à l'écran d'une action à l'autre.
   */
  const checkOta = (m: MachineSummary) =>
    run(m.id, async () => {
      const c = cred(m.id);
      try {
        const r = await fetch(forId("/api/ota", m.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(c.email ? { ...c, remember } : {}),
        }).then((x) => x.json());
        if (r.error) return tc("error", { message: r.error });
        return r.updateAvailable
          ? t("otaAvailable", { version: r.version ?? t("otaNoVersion") })
          : t("otaNone", { status: String(r.status) });
      } finally {
        setCreds((cur) => ({ ...cur, [m.id]: { email: c.email, password: "" } }));
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
   * Suppression — ou **remise à zéro** s'il ne reste qu'une machine : elle ne peut pas quitter le
   * registre, alors le serveur efface tout son contenu et garde l'entrée vide. Les deux cas
   * emportent le même contenu, donc les deux confirmations nomment ce qui part ; seul le sort de
   * l'entrée elle-même diffère, et le libellé du bouton le dit d'avance.
   */
  const remove = async (m: MachineSummary) => {
    const derniere = (d?.machines.length ?? 0) <= 1;
    const params = { name: m.label, props: m.counts.props, stats: m.counts.stats };
    if (!confirm(derniere ? t("resetConfirm", params) : t("deleteConfirm", params))) return;
    setBusy(m.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/machines/${encodeURIComponent(m.id)}`, { method: "DELETE" }).then((x) => x.json());
      if (r.error) {
        setMsg(tc("error", { message: r.error }));
      } else if (r.reset) {
        // L'environnement reprend la main sur ce qu'il force : sans le dire, la remise à zéro
        // aurait l'air de n'avoir rien fait.
        setMsg(
          t("resetDone", { name: m.label, props: r.cleared.props, stats: r.cleared.stats }) +
            (r.envRestored?.length ? " " + t("resetEnv", { vars: r.envRestored.join(", ") }) : ""),
        );
        // Plus aucun prérequis : le bloc de configuration doit être sous les yeux.
        setOpen((o) => ({ ...o, [m.id]: true }));
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

  /**
   * Renomme. Un libellé vide n'est pas une erreur : il rend son nom **dérivé** à la machine
   * (modèle lu, puis DSN, puis identifiant), ce qui est le comportement par défaut.
   */
  const rename = (m: MachineSummary) =>
    patch(m, { label: renaming[m.id] ?? "" }, (r) => {
      setRenaming((cur) => {
        const next = { ...cur };
        delete next[m.id];
        return next;
      });
      return t("renamed", { name: r.machine.label });
    });

  /**
   * Demande le modèle à la machine (`d270_serialnumber`). Une **lecture** : rien n'est préparé ni
   * écrit sur l'appareil.
   *
   * La réponse n'arrive pas dans le corps du POST — c'est la machine qui doit se connecter à nous
   * et pousser la propriété, en deux à quatre secondes d'après les relevés. On scrute donc la
   * liste, borné dans le temps : sans borne, une machine éteinte laisserait la page tourner.
   */
  const readModel = (m: MachineSummary) =>
    run(m.id, async () => {
      const r = await fetch(forId("/api/model", m.id), { method: "POST" }).then((x) => x.json());
      if (r.error) return tc("error", { message: r.error });
      for (let i = 0; i < 10; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const p: Payload = await fetch("/api/machines").then((x) => x.json());
        setD(p);
        const lu = p.machines.find((x) => x.id === m.id)?.model;
        if (lu?.key) {
          return lu.matchesCatalog === false
            ? t("modelReadMismatch", { key: lu.key })
            : t("modelReadOk", { key: lu.key, name: lu.machineName ?? lu.key });
        }
      }
      return t("modelReadTimeout");
    });

  /** Oublie le `refresh_token` mémorisé. Le mot de passe redeviendra nécessaire. */
  const forgetCloud = async () => {
    if (!confirm(t("cloudSessionForget") + " ?")) return;
    setBusy("cloud");
    try {
      await fetch("/api/cloudsession", { method: "DELETE" });
      setMsg(t("cloudSessionForgotten"));
      await load();
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

      {/* Le repli fonctionne, mais il vaut mieux le dire : sans ça, une page qui met deux secondes
          à se mettre à jour au lieu d'être instantanée passerait pour une lenteur. */}
      {!flux && enCours && <p className="sub">{t("liveOff")}</p>}

      {d?.machines.map((m) => {
        const occupe = busy === m.id;
        const ouvert = open[m.id] ?? false;
        const c = cred(m.id);
        // Le champ non touché reflète le libellé enregistré ; vidé, il rend son nom dérivé.
        const nom = renaming[m.id] ?? m.custom ?? "";
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
                {m.reading && (
                  <span className="pill on">{t("readingNow", { remaining: m.reading.remaining })}</span>
                )}
                {m.running && <span className="pill on">{m.running}</span>}
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
                  {d.machines.length <= 1 ? t("reset") : t("delete")}
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
                ⚠️ {t("modelMismatch", { detected: m.model.key ?? "?", catalog: m.model.catalogType })}
              </div>
            )}

            <div className="kv">
              <span className="k">{t("name")}</span>
              <span>{m.custom ?? <span className="sub">{t("nameDerived", { label: m.label })}</span>}</span>
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
              <span className="row">
                <span>
                  {m.model.key ? `${m.model.key}${m.model.machineName ? ` · ${m.model.machineName}` : ""}` : t("unknown")}{" "}
                  <span className="sub">
                    ({m.model.source}) · {t("catalogOf", { type: m.model.catalogType, count: m.model.catalogBeverages })}
                  </span>
                </span>
                {/* Le modèle est demandé automatiquement dès que les deux prérequis sont réunis
                    (voir maybeReadModel côté serveur). Ce bouton couvre le reste : machine déjà
                    configurée avant que ça n'existe, lecture qui a expiré, ou simple vérification.
                    C'est une LECTURE — rien n'est préparé ni écrit. */}
                {m.ready && (
                  <button className="mini" onClick={() => readModel(m)} disabled={occupe}>
                    {m.model.key ? t("modelReread") : t("modelRead")}
                  </button>
                )}
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
                {/* 0. le nom — purement décoratif, donc en premier : c'est le réglage sans
                       conséquence, et celui qu'on vient changer le plus souvent. */}
                <h3 style={{ margin: "0 0 6px" }}>{t("nameHeading")}</h3>
                <div className="row">
                  <input
                    value={nom}
                    placeholder={m.label}
                    onChange={(e) => setRenaming({ ...renaming, [m.id]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !occupe && nom !== (m.custom ?? "")) rename(m);
                    }}
                    style={{ minWidth: 240 }}
                  />
                  <button className="primary" onClick={() => rename(m)} disabled={occupe || nom === (m.custom ?? "")}>
                    {t("rename")}
                  </button>
                  {m.custom && (
                    <button className="mini" onClick={() => setRenaming({ ...renaming, [m.id]: "" })} disabled={occupe}>
                      {t("nameClear")}
                    </button>
                  )}
                  <span className="sub">{t("nameNote")}</span>
                </div>

                {/* 1. l'adresse — elle conditionne la clé, d'où cet ordre. */}
                <h3 style={{ margin: "18px 0 6px" }}>{tm("heading")}</h3>
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
                  <span className="sub">{tm("setNote")}</span>
                </div>

                {/* 2. la clé — rangée chez Ayla sous le DSN, donc dépendante de ce qui précède. */}
                <h3 style={{ margin: "18px 0 6px" }}>{tk("heading")}</h3>
                {!m.dsn && <div className="warn" style={{ marginBottom: 10 }}>⚠️ {tk("needsDsn")}</div>}
                {d.discovery.missingConfig.length ? (
                  <p className="sub">{tk("missingConfig", { vars: d.discovery.missingConfig.join(", ") })}</p>
                ) : (
                  <>
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
                      <span className="sub">{tk("privacy")}</span>
                    </div>
                    <label className="row" style={{ marginTop: 6, marginBottom: 0 }}>
                      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                      <span>{t("remember")}</span>
                      <span className="sub">{t("rememberNote")}</span>
                    </label>
                    {/* Même authentification, donc même endroit : le jeton Ayla que la
                        récupération de clé obtient ouvre aussi la fiche OTA. */}
                    <div className="row" style={{ marginTop: 10 }}>
                      <button onClick={() => checkOta(m)} disabled={occupe || !m.dsn}>
                        {t("otaCheck")}
                      </button>
                      <span className="sub">{t("otaNote")}</span>
                    </div>
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

      {/* Ce qui limite le multi-machines, en trois lignes. Le détail — protocole, réseau,
          conteneur — vit dans doc/ et DOCKER.md, pas dans un écran de saisie. */}
      <div className="card">
        <div className="kv">
          <span className="k">{tm("ourServer")}</span>
          <span className="mono">
            {d?.server.ip ? `${d.server.ip}:${d.server.port}` : tc("dash")}
            {d?.server.problem ? " ⚠️" : ""}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("cloudSession")}</span>
          <span className="row">
            {cloud?.set ? (
              <>
                <span>{t("cloudSessionSince", { date: new Date(cloud.at ?? 0).toLocaleString("fr-FR") })}</span>
                <button className="mini" onClick={forgetCloud} disabled={!!busy}>
                  {t("cloudSessionForget")}
                </button>
              </>
            ) : (
              <span className="sub">{t("cloudSessionNone")}</span>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("limitsTitle")}</span>
          <span className="sub" style={{ textAlign: "right" }}>
            {t("limitsCatalog")}
            <br />
            {t("limitsEnv")}
            <br />
            {t("limitsRouting")}
          </span>
        </div>
      </div>
    </>
  );
}
