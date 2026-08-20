"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useCategoryLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";

interface Param {
  id: number;
  name: string;
  label: string;
  unit: string;
  kind: "user" | "meta" | "maint";
  min?: number;
  def?: number;
  max?: number;
  value?: number;
}
interface Decoded {
  at: number;
  kind: "bounds" | "values";
  exact: boolean;
  params: Param[];
  hex: string;
}
interface Beverage {
  id: number;
  label: string;
  factoryName: string;
  slug: string;
  category: string;
  ingredients: number[];
  milk: boolean;
  boundsProp: string | null;
  valuesProp: string | null;
  bounds: Decoded | null;
  values: Decoded | null;
  /**
   * Compteur d'usage de la CATEGORIE de cette boisson. La machine ne compte pas tasse par tasse :
   * `scope` vaut « category », et l'interface doit le dire.
   */
  counter: { id: number; value: number; category: string; scope: string } | null;
  /**
   * Configuration de grains active, pour la boisson Bean System uniquement. C'est un ATTRIBUT de
   * la boisson — le nom du grain n'est pas le nom de la tasse.
   */
  beanSystem: { index: number; name: string | null; grinder: number; temperature: number; aroma: number } | null;
}
interface Status {
  /** Configuration du serveur. `lanKeySet` faux = aucun pilotage possible, il faut le dire. */
  config: { lanKeySet: boolean; serverIpProblem: string | null };
  session: { active: boolean };
  /** Dernier profil que le serveur a demandé à la machine. */
  activeProfile: number;
  /** Faux si le serveur n'a imposé aucun profil depuis son démarrage : l'état machine est inconnu. */
  activeProfileConfirmed: boolean;
  program: { active: boolean; label: string; counter: number } | null;
  lastMonitor: {
    at: number;
    stateByte: number;
    switches: { name: string; label: string }[];
    alarmBits: number;
  } | null;
}
/** Couple (paramètre, valeur) tel qu'envoyé à la machine — distinct de `Param`, qui décrit un
 *  paramètre décodé avec ses bornes. */
interface RecipeParam {
  id: number;
  value: number;
}
interface ProfileInfo {
  id: number;
  name: string | null;
  /** false pour un nom d'usine (« Profil 4 ») ou un nom pas encore lu. */
  renamed: boolean;
}
interface Payload {
  model: { type: string; appModelId: string; productCode: string; nProfiles: number; protocolVersion: string };
  categories: Record<string, string>;
  profileId: number;
  beverages: Beverage[];
  /** Ordre d'affichage de la machine pour le profil demandé (ids), ou null si non lu. */
  order: number[] | null;
  orderProp: string;
  importedAt: number | null;
  import: { active: boolean; remaining: number; ok: number; fail: number; pending: string | null } | null;
}

export default function Boissons() {
  const t = useTranslations("beverages");
  const tPower = useTranslations("power");
  const tc = useTranslations("common");
  const tEditor = useTranslations("editor");
  const tCat = useCategoryLabel();
  const bevLabel = useBeverageLabel();
  const paramLabel = useParamLabel();
  const [data, setData] = useState<Payload | null>(null);
  const [profile, setProfile] = useState(1);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [lastDispensed, setLastDispensed] = useState<Beverage | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const profileInitialised = useRef(false);

  const refresh = useCallback(async () => {
    const d = await fetch(`/api/beverages?profile=${profile}`).then((r) => r.json());
    setData(d);
  }, [profile]);

  // Référence tenue à jour : la relance de présence doit consulter l'état COURANT, pas celui
  // capturé au montage de l'effet (qui est nul).
  const statusRef = useRef<Status | null>(null);
  const refreshStatus = useCallback(async () => {
    const s = await fetch("/api/status").then((r) => r.json());
    statusRef.current = s;
    setStatus(s);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * À l'ouverture de la page — et au retour sur l'onglet — on demande au serveur d'établir une
   * session LAN, pour que la machine pousse son état réel. Sans ça le monitor peut dater de
   * plusieurs heures et la page afficherait « état daté ».
   *
   * Le serveur étrangle l'appel (monitor récent, programme en cours, ou appel trop rapproché) :
   * plusieurs onglets ne provoquent donc pas plusieurs sessions.
   */
  useEffect(() => {
    const ping = () => {
      fetch("/api/presence", { method: "POST" })
        .then(() => refreshStatus())
        .catch(() => {});
    };
    ping();
    // La machine ne pousse pas toujours son monitor à la première session : une relance unique,
    // 10 s plus tard, suffit en pratique. Bornée volontairement — pas de boucle de sondage.
    const retry = setTimeout(() => {
      const m = statusRef.current?.lastMonitor;
      if (!m || Date.now() - m.at > 30000) ping();
    }, 10000);
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshStatus]);

  // Noms des profils : simple lecture de ce que le serveur a déjà en cache. L'import des
  // profils, lui, se fait sur la page Profils — pas ici.
  useEffect(() => {
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((d) => setProfiles(d.profiles ?? []))
      .catch(() => {});
  }, []);

  // Au premier chargement, on part du profil que le serveur a réellement demandé à la machine,
  // pas d'un 1 arbitraire : sinon un rechargement de page mentirait sur le profil actif.
  // Ensuite c'est le clic de l'utilisateur qui commande (et il met le serveur à jour).
  useEffect(() => {
    if (profileInitialised.current || !status) return;
    profileInitialised.current = true;
    if (status.activeProfile) setProfile(status.activeProfile);
  }, [status]);

  // L'état machine ne bouge que quand la machine nous pousse un monitor : on suit de près
  // pendant un programme, plus mollement au repos.
  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, status?.program?.active ? 2000 : 5000);
    return () => clearInterval(t);
  }, [refreshStatus, status?.program?.active]);

  // Pendant un import, la machine répond au fil de l'eau : on rafraîchit.
  useEffect(() => {
    if (!data?.import?.active) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [data?.import?.active, refresh]);

  const startImport = async (scope: "all" | "bounds" | "values", beverageIds?: number[]) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/beverages/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: profile, what: scope, beverageIds }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : t("importQueued", { count: r.queued }));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const togglePower = async (next: boolean) => {
    const verb = next ? tPower("turnOn") : tPower("turnOff");
    const warn = next ? ` ${tPower("rinseWarning")}` : "";
    if (!confirm(`${tPower("confirmPower", { verb })}${warn}`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: next ? "on" : "off" }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : tPower("powerSent", { label: r.program }));
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Arrêt d'une préparation en cours : même commande 0x83 que le lancement, mais mode STOPV2.
   * La trame porte un beverageId ; on reprend celui de la dernière boisson lancée, sinon
   * l'espresso, faute de savoir ce que la machine est en train de couler.
   */
  const stopDispense = async () => {
    const target = lastDispensed;
    if (!confirm(tPower("confirmStop", { beverage: target ? ` (${bevLabel(target)})` : "" }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", beverageId: target?.id ?? 1, profileId: profile }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : tPower("stopSent", { frame: r.frameHex }));
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Un clic sur un profil fait les deux : il bascule l'affichage sur ce profil et l'active sur
   * la machine (trame 0xA9). Pas de confirmation : la commande est inoffensive — c'est la même
   * trame que le serveur envoie déjà comme « présence » pendant un réveil — et le clic sur un
   * profil nommé est un geste sans ambiguïté. C'est aussi pourquoi une liste déroulante ne
   * convenait pas : la parcourir aurait envoyé une commande à chaque valeur survolée.
   */
  const selectProfileAndActivate = async (id: number) => {
    setProfile(id);
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "selectProfile", profileId: id }),
      }).then((x) => x.json());
      setMsg(r.error ? tc("error", { message: r.error }) : tPower("profileActivated", { name: profileLabel(profiles, id) }));
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const dispense = async (bev: Beverage, override?: RecipeParam[]) => {
    // Sans paramètres explicites, on n'envoie que les défauts réellement configurés : la machine
    // renvoie 0 ou 255 (0xFF) pour un emplacement vide (recettes perso jamais enregistrées, mug
    // de voyage), et envoyer « Café = 0 ml » serait invalide. Sans paramètre, la machine applique
    // les siens.
    const params =
      override ??
      beverageParams(bev)
        .filter(isSet)
        .map((p) => ({ id: p.id, value: p.def as number }));
    const detail = params.length
      ? params.map((p) => `${paramLabel(paramOf(bev, p.id) ?? { id: p.id })} = ${p.value}`).join(", ")
      : t("confirmPrepareDefaults");
    if (!confirm(`${t("confirmPrepare", { beverage: bevLabel(bev), profile: profileLabel(profiles, profile) })}\n\n${detail}\n\nLa machine va réellement couler la boisson.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dispense", beverageId: bev.id, profileId: profile, params }),
      }).then((x) => x.json());
      if (!r.error) setLastDispensed(bev);
      setMsg(r.error ? tc("error", { message: r.error }) : t("sent", { label: r.program, frame: r.frameHex }));
    } finally {
      setBusy(false);
    }
  };

  // On ne montre que les profils que l'utilisateur a réellement nommés sur la machine. Deux
  // replis, pour que le contrôle ne disparaisse jamais : noms pas encore lus → on affiche les
  // numéros ; machine sans aucun nom personnalisé → on affiche tout en le disant.
  const { shownProfiles, fallbackReason } = useMemo(() => {
    const nProfiles = data?.model.nProfiles ?? 5;
    const read = profiles.filter((p) => p.name !== null);
    const renamed = read.filter((p) => p.renamed);
    if (renamed.length) return { shownProfiles: renamed, fallbackReason: null };
    if (read.length)
      return { shownProfiles: read, fallbackReason: "Aucun profil renommé sur la machine : tous sont affichés." };
    return {
      shownProfiles: Array.from({ length: nProfiles }, (_, i) => ({ id: i + 1, name: null, renamed: false })),
      fallbackReason: "Noms non lus — lancer un import sur la page Profils pour les voir ici.",
    };
  }, [profiles, data?.model.nProfiles]);

  // Si le profil courant n'est pas dans la liste affichée, on bascule sur le premier affiché :
  // sinon la page montrerait les réglages d'un profil dont aucun bouton n'est actif. Simple
  // changement d'affichage — on n'envoie rien à la machine ici.
  useEffect(() => {
    if (shownProfiles.length && !shownProfiles.some((p) => p.id === profile)) setProfile(shownProfiles[0].id);
  }, [shownProfiles, profile]);

  /**
   * Ordre d'affichage. Si la machine nous a donné l'ordre de ce profil, on le suit à la lettre —
   * c'est celui de son écran. Sinon on retombe sur un regroupement par catégories, qui est notre
   * invention et ne reflète aucun ordre réel.
   */
  const sections = useMemo(() => {
    if (!data) return [];
    if (data.order?.length) {
      const byId = new Map(data.beverages.map((b) => [b.id, b]));
      const ordered = data.order.map((id) => byId.get(id)).filter((b): b is Beverage => !!b);
      const seen = new Set(ordered.map((b) => b.id));
      const rest = data.beverages.filter((b) => !seen.has(b.id));
      return [
        {
          key: "machine",
          title: t("machineOrder"),
          note: t("machineOrderNote", { prop: data.orderProp }),
          list: ordered,
        },
        ...(rest.length
          ? [{ key: "rest", title: t("notListed"), note: null as string | null, list: rest }]
          : []),
      ];
    }
    return Object.entries(data.categories)
      .map(([key, title]) => ({ key, title: tCat(key, title), note: null as string | null, list: data.beverages.filter((b) => b.category === key) }))
      .filter((sec) => sec.list.length);
  }, [data]);

  /**
   * Écrit la recette dans le profil sur la machine (0x83, mode DONTCARE, action SAVE_BEVERAGE).
   * Modification persistante de l'appareil : elle remplace la recette enregistrée de ce profil.
   */
  const writeToProfile = async (bev: Beverage, params: RecipeParam[]) => {
    const detail = params.map((p) => `${paramLabel(paramOf(bev, p.id) ?? { id: p.id })} = ${p.value}`).join(", ");
    if (!confirm(`${tEditor("confirmWrite", { beverage: bevLabel(bev), profile })}

${detail}

Cela remplace durablement la recette enregistrée de ce profil.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "saveToProfile", beverageId: bev.id, profileId: profile, params }),
      }).then((x) => x.json());
      setMsg(
        r.error
          ? tc("error", { message: r.error })
          : tEditor("writeSent", { checksum: r.checksumBefore != null ? "0x" + r.checksumBefore.toString(16) : tc("unknown") }),
      );
    } finally {
      setBusy(false);
    }
  };

  const imported = data ? data.beverages.filter((b) => b.bounds || b.values).length : 0;

  // Le toggle marche/arrêt est rendu avant tout le reste : piloter la machine ne doit pas
  // dépendre du chargement du catalogue.
  return (
    <>
      <h1>{t("heading")}</h1>
      {/* Sans clé LAN, rien de ce que propose cette page ne peut atteindre la machine : le dire ici
          plutôt que de laisser cliquer 88 boutons voués à un échec silencieux. */}
      {status?.config?.serverIpProblem && (
        <div className="warn">
          ⚠️ {tc("badServerIp", { problem: status.config.serverIpProblem })}
        </div>
      )}

      {status && !status.config?.lanKeySet && (
        <div className="warn">
          ⚠️ {tc("noLanKey")} <a href="/cle-lan">{tc("noLanKeyLink")}</a>
        </div>
      )}
      {data && (
        <p className="sub">
          {t("intro", { count: data.beverages.length, model: data.model.type, appModelId: data.model.appModelId, productCode: data.model.productCode })}{" "}
          {imported > 0 ? t("enriched", { count: imported }) : t("noneRead")}
        </p>
      )}

      <PowerCard
        status={status}
        busy={busy}
        onToggle={togglePower}
        onStop={stopDispense}
        shownProfiles={shownProfiles}
        fallbackReason={fallbackReason}
        confirmed={status?.activeProfileConfirmed ?? false}
        profile={profile}
        onSelectProfile={selectProfileAndActivate}
        importState={data?.import ?? null}
        message={msg}
      />

      {!data ? (
        <p className="sub">{t("loadingCatalog")}</p>
      ) : (
      <>
      {sections.map((sec) => (
        <section key={sec.key}>
          <h2>
            {sec.title}{" "}
            <span className="sub" style={{ fontWeight: 400 }}>
              ({sec.list.length})
            </span>
          </h2>
          {sec.note && (
            <p className="sub" style={{ marginTop: -4 }}>
              {sec.note}
            </p>
          )}
          {sec.list.map((b) => (
            <BeverageCard
              key={b.id}
              bev={b}
              profile={profile}
              profileName={profiles.find((p) => p.id === profile)?.name ?? null}
              open={open === b.id}
              busy={busy}
              onToggle={() => setOpen(open === b.id ? null : b.id)}
              onDispense={(params) => dispense(b, params)}
              onWrite={(params) => writeToProfile(b, params)}
              onImport={() => startImport("all", [b.id])}
            />
          ))}
        </section>
      ))}
      </>
      )}
    </>
  );
}

/**
 * Interrupteur marche/arrêt. L'état vient du monitor que la machine nous POSTe — il n'arrive
 * que pendant une session LAN active, donc il peut être périmé au repos. On le dit plutôt que
 * d'afficher un état peut-être faux : un toggle qui ment est pire qu'un toggle qui doute.
 */
function PowerCard({
  status,
  busy,
  onToggle,
  onStop,
  shownProfiles,
  fallbackReason,
  confirmed,
  profile,
  onSelectProfile,
  importState,
  message,
}: {
  status: Status | null;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onStop: () => void;
  shownProfiles: ProfileInfo[];
  fallbackReason: string | null;
  confirmed: boolean;
  profile: number;
  onSelectProfile: (id: number) => void;
  importState: Payload["import"];
  message: string | null;
}) {
  const t = useTranslations("power");
  const tc = useTranslations("common");
  const mon = status?.lastMonitor ?? null;
  const running = status?.program?.active === true;
  /**
   * `0x04` est le seul état positivement identifié : la veille. Tout autre état signifie que la
   * machine est éveillée — `0x00` relevé juste après un réveil (en chauffe), `0x02` écran de
   * sélection des boissons, prête. On raisonne donc « éveillée sauf 0x04 » plutôt que sur une
   * liste blanche : une version précédente n'acceptait que `0x00` et affichait « état inconnu »
   * alors que la machine était bel et bien allumée.
   */
  const isOn = mon != null && mon.stateByte !== 0x04;
  const ageSec = mon ? Math.round((Date.now() - mon.at) / 1000) : null;
  const stale = ageSec != null && ageSec > 90;

  let label: string;
  if (running) label = t("running", { label: status?.program?.label ?? "" });
  else if (!mon) label = t("unknownNoMonitor");
  else if (stale) label = t("stale", { state: stateLabel(mon.stateByte, t), age: fmtAge(ageSec!, t) });
  else label = stateLabel(mon.stateByte, t);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ gap: 14 }}>
          <label className="switch" title={isOn ? t("turnOff") : t("turnOn")}>
            <input
              type="checkbox"
              checked={isOn}
              disabled={busy || running}
              aria-label={isOn ? t("turnOff") : t("turnOn")}
              onChange={(e) => onToggle(e.target.checked)}
            />
            <span className="track">
              <span className="knob" />
            </span>
          </label>
          <div>
            <strong>{t("machine")}</strong>
            <div className="sub" style={{ margin: 0 }}>
              {label}
            </div>
          </div>
        </div>
        <div className="row">
          <button className="danger" disabled={busy} onClick={onStop} title={t("stopTitle")}>
            {t("stop")}
          </button>
          {running && <span className="pill on">{t("programBadge", { counter: status?.program?.counter ?? 0 })}</span>}
          {stale && !running && (
            <span className="pill off" title={t("staleBadgeHint")}>
              {t("staleBadge")}
            </span>
          )}
          {mon?.switches?.length ? (
            <span className="pill on" title={t("switchesHint")}>
              {mon.switches.map((sw) => sw.label).join(" · ")}
            </span>
          ) : null}
          {mon?.alarmBits ? (
            <span className="pill off" title={t("alarmsHint")}>
              {t("alarms", { value: "0x" + mon.alarmBits.toString(16) })}
            </span>
          ) : null}
          <span className={status?.session?.active ? "pill on" : "pill off"}>
            {status?.session?.active ? t("lanSession") : t("noSession")}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
        <label style={{ marginBottom: 8 }}>{confirmed ? t("profileLabel") : t("profileUnknown")}</label>
        <div className="row" role="group" aria-label="Profil actif">
          {shownProfiles.map((p) => {
            const active = p.id === profile && confirmed;
            return (
              <button
                key={p.id}
                className={active ? "primary" : ""}
                aria-pressed={active}
                disabled={busy}
                onClick={() => onSelectProfile(p.id)}
                title={t("activateTitle", { id: p.id })}
              >
                {p.name ?? tc("profileNumbered", { id: p.id })}
              </button>
            );
          })}
        </div>
        {fallbackReason && (
          <p className="sub" style={{ margin: "8px 0 0" }}>
            {fallbackReason}
          </p>
        )}
      </div>

      {importState?.active && (
        <div className="kv" style={{ marginTop: 12 }}>
          <span className="k">{t("readingInProgress", { pending: importState.pending ? ` — ${importState.pending}` : "" })}</span>
          <span className="mono">{t("readCounts", { ok: importState.ok, remaining: importState.remaining })}</span>
        </div>
      )}
      {message && (
        <p className="warn" style={{ marginTop: 12, marginBottom: 0 }}>
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * Libellé d'un profil : son nom lu sur la machine si on l'a, sinon son numéro. Les noms
 * arrivent de l'import fait sur la page Profils ; cette page ne fait que les afficher.
 */
function profileLabel(profiles: ProfileInfo[], id: number): string {
  const p = profiles.find((x) => x.id === id);
  return p?.name ? `${id} — ${p.name}` : `#${id}`;
}

function BeverageCard({
  bev,
  profile,
  profileName,
  open,
  busy,
  onToggle,
  onDispense,
  onWrite,
  onImport,
}: {
  bev: Beverage;
  profile: number;
  profileName: string | null;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onDispense: (params?: RecipeParam[]) => void;
  onWrite: (params: RecipeParam[]) => void;
  onImport: () => void;
}) {
  const t = useTranslations("beverages");
  const tc = useTranslations("common");
  const bevLabel = useBeverageLabel();
  const paramLabel = useParamLabel();
  const unitLabel = useUnitLabel();
  const tstat = useTranslations("stat");
  const users = beverageParams(bev).filter((p) => p.kind === "user");
  const read = bev.bounds ?? bev.values;
  const [tech, setTech] = useState(false);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{bevLabel(bev)}</strong>{" "}
          <span className="mono sub" style={{ fontSize: ".82rem" }}>
            id {bev.id}
          </span>
          {bev.milk && (
            <span className="pill on" style={{ marginLeft: 8 }}>
              {t("milk")}
            </span>
          )}
          {read && (
            <span className="pill on" style={{ marginLeft: 8 }}>
              {t("readFromMachine")}
            </span>
          )}
          {bev.beanSystem?.name && (
            <span
              className="pill on"
              style={{ marginLeft: 8 }}
              title={t("beanSystemHint", {
                grinder: bev.beanSystem.grinder,
                temperature: bev.beanSystem.temperature,
                aroma: bev.beanSystem.aroma,
              })}
            >
              {t("beanSystem", { name: bev.beanSystem.name })}
            </span>
          )}
          {read && !read.exact && (
            <span className="pill off" style={{ marginLeft: 8 }} title={t("misalignedHint")}>
              {t("misaligned")}
            </span>
          )}
          <div className="sub" style={{ margin: "2px 0 0" }}>
            {bev.factoryName} · {t("paramCount", { count: bev.ingredients.length })}
            {users.length > 0 && bev.bounds ? ` · ${summary(users, paramLabel, unitLabel)}` : ""}
            {bev.counter && (
              <>
                {" · "}
                <span title={t("counterHint", { category: tstat(bev.counter.category) })}>
                  {t("counterValue", {
                    value: bev.counter.value.toLocaleString("fr-FR"),
                    category: tstat(bev.counter.category),
                  })}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="row">
          <button onClick={onToggle}>{open ? tc("hide") : tc("details")}</button>
          <button disabled={busy} onClick={onImport} title={t("readTitle", { bounds: bev.boundsProp ?? "—", values: bev.valuesProp ?? "—" })}>
            {tc("read")}
          </button>
          <button className="good" disabled={busy} onClick={() => onDispense()}>
            {tc("prepare")}
          </button>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          {/* Monté seulement à l'ouverture : son état repart donc des valeurs de la machine
              à chaque fois, sans logique de réinitialisation à écrire. */}
          <RecipeEditor bev={bev} profile={profile} profileName={profileName} busy={busy} onDispense={onDispense} onWrite={onWrite} />

          <div className="row" style={{ marginTop: 14 }}>
            <button onClick={() => setTech(!tech)} aria-expanded={tech} title={t("technicalInfoTitle")}>
              ⓘ {tech ? t("hideTechnicalInfo") : t("technicalInfo")}
            </button>
          </div>

          {tech && (
          <>
          {/* Le tableau « Tous les paramètres » a été retiré : l'éditeur de recette au-dessus
              montre déjà chaque réglage avec ses bornes, son défaut et la valeur du profil. Le
              dupliquer ici en lecture seule n'ajoutait rien. Les informations techniques gardent ce
              qui ne se lit nulle part ailleurs : les propriétés Ayla et la trame brute. */}
          <div className="kv" style={{ marginTop: 4 }}>
            <span className="k">{t("boundsProp")}</span>
            <span className="mono">{bev.boundsProp ?? "—"}</span>
          </div>
          <div className="kv">
            <span className="k">{t("valuesProp", { profile: profileName ? `${profile} — ${profileName}` : profile })}</span>
            <span className="mono">{bev.valuesProp ?? "—"}</span>
          </div>
          {read && (
            <div className="kv">
              <span className="k">{t("readFrame", { kind: read.kind === "bounds" ? t("frameBounds") : t("frameValues") })}</span>
              <span className="mono" style={{ fontSize: ".78rem", textAlign: "right" }}>
                {read.hex}
              </span>
            </div>
          )}
          </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Édition de la recette du profil pour une boisson, sous les bornes du modèle.
 *
 * Les valeurs partent de ce que la machine a enregistré pour CE profil ; à défaut, des défauts
 * du modèle. Les bornes min/max sont communes aux profils — un profil ne peut que choisir une
 * valeur à l'intérieur — donc les champs les imposent.
 */
/**
 * Édition de la recette du profil pour une boisson, sous les bornes du modèle.
 *
 * Règle d'affichage : **on n'écarte rien**. Est réglable tout paramètre dont `max > min` ; les
 * paramètres à valeur unique sont montrés en lecture seule mais restent dans la trame (l'ordre
 * lait/café d'un flat white vaut toujours 1 et c'est lui qui déclenche l'action d'inversion).
 * Le regroupement « recette » / « avancé » est cosmétique : une première version filtrait sur
 * notre propre classification et masquait de vraies options (« 2 tasses », « accessoire »).
 */
function RecipeEditor({
  bev,
  profile,
  profileName,
  busy,
  onDispense,
  onWrite,
}: {
  bev: Beverage;
  profile: number;
  profileName: string | null;
  busy: boolean;
  onDispense: (params?: RecipeParam[]) => void;
  onWrite: (params: RecipeParam[]) => void;
}) {
  const t = useTranslations("editor");
  const tc = useTranslations("common");
  const paramLabel = useParamLabel();
  const unitLabel = useUnitLabel();
  const all = beverageParams(bev);
  const adjustable = all.filter((b) => (b.max as number) > (b.min as number));
  const fixed = all.filter((b) => (b.max as number) === (b.min as number));
  const basic = adjustable.filter((b) => b.kind === "user");
  const advanced = adjustable.filter((b) => b.kind !== "user");

  /**
   * Valeur de départ : ce que la machine a enregistré pour ce profil si c'est dans les bornes,
   * sinon le défaut du modèle s'il l'est, sinon le minimum. La machine renvoie 0 ou 255 pour un
   * paramètre jamais configuré (mug de voyage, recettes perso vierges) : retomber sur `min`
   * permet de le régler, là où une version précédente masquait purement la ligne.
   */
  const seedFor = (b: Param) => {
    const min = b.min as number;
    const max = b.max as number;
    const stored = bev.values?.params.find((p) => p.id === b.id)?.value;
    if (stored !== undefined && stored >= min && stored <= max) return stored;
    const def = b.def as number;
    if (def >= min && def <= max) return def;
    return min;
  };
  const seed = () => Object.fromEntries(all.map((b) => [b.id, seedFor(b)]));

  /**
   * Défaut du modèle, ou `null` s'il ne tombe pas dans les bornes. La machine renvoie 0 ou 255 pour
   * un paramètre jamais configuré : dans ce cas il n'y a **pas** de valeur d'usine à proposer, et on
   * n'invente rien — on laisse le réglage tel quel plutôt que de le forcer au minimum.
   */
  const defOf = (b: Param) => {
    const d = b.def as number | undefined;
    if (d === undefined || d === null) return null;
    return d >= (b.min as number) && d <= (b.max as number) ? d : null;
  };
  const [vals, setVals] = useState<Record<number, number>>(seed);
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!bev.bounds) {
    return (
      <p className="warn" style={{ margin: 0 }}>
        {t("boundsNotRead")}
      </p>
    );
  }
  if (!all.length) {
    return (
      <p className="sub" style={{ margin: 0 }}>
        {t("noParams")}
      </p>
    );
  }

  const params: RecipeParam[] = all.map((b) => ({ id: b.id, value: vals[b.id] ?? seedFor(b) }));
  const set = (b: Param, raw: number) =>
    setVals((v) => ({
      ...v,
      [b.id]: Math.min(b.max as number, Math.max(b.min as number, Number.isFinite(raw) ? raw : (b.min as number))),
    }));
  const dirty = adjustable.some((b) => vals[b.id] !== seedFor(b));

  /**
   * Retour aux défauts du modèle — distinct de « réinitialiser », qui revient à ce que le profil a
   * enregistré. Purement local : rien ne part vers la machine avant « Préparer » ou « Écrire ».
   */
  const applyDefaults = () =>
    setVals((v) => Object.fromEntries(all.map((b) => [b.id, defOf(b) ?? v[b.id] ?? seedFor(b)])));
  const atDefaults = adjustable.every((b) => {
    const d = defOf(b);
    return d === null || (vals[b.id] ?? seedFor(b)) === d;
  });
  const noDefault = adjustable.filter((b) => defOf(b) === null).length;

  const slider = (b: Param) => (
    <div className="row" key={b.id} style={{ justifyContent: "space-between", gap: 12, padding: "4px 0" }}>
      <span style={{ minWidth: 150 }}>
        {paramLabel(b)}
        {b.unit ? ` (${unitLabel(b.unit)})` : ""}
      </span>
      <div className="row" style={{ gap: 8 }}>
        <span className="sub mono" style={{ fontSize: ".78rem" }}>
          {b.min}
        </span>
        <input
          type="range"
          min={b.min}
          max={b.max}
          value={vals[b.id] ?? seedFor(b)}
          aria-label={`${paramLabel(b)} (${b.min}–${b.max})`}
          onChange={(e) => set(b, Number(e.target.value))}
          style={{ width: 150 }}
        />
        <span className="sub mono" style={{ fontSize: ".78rem" }}>
          {b.max}
        </span>
        <input
          type="number"
          min={b.min}
          max={b.max}
          value={vals[b.id] ?? seedFor(b)}
          onChange={(e) => set(b, Number(e.target.value))}
          style={{ width: 80 }}
        />
        {defOf(b) !== null ? (
          <button
            className="mini"
            style={{ minWidth: 78 }}
            disabled={(vals[b.id] ?? seedFor(b)) === defOf(b)}
            onClick={() => set(b, defOf(b) as number)}
            title={t("paramDefaultHint")}
          >
            {t("paramDefault", { value: defOf(b) as number })}
          </button>
        ) : (
          <span className="sub" style={{ minWidth: 78, fontSize: ".78rem" }} title={t("noParamDefaultHint")}>
            {t("noParamDefault")}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <strong style={{ fontSize: ".95rem" }}>{t("heading", { profile: profileName ?? tc("profileFallback", { id: profile }) })}</strong>
        <div className="row">
          {!bev.values && (
            <span className="pill off" title={t("valuesNotReadHint")}>
              {t("valuesNotRead")}
            </span>
          )}
          {dirty && (
            <button onClick={() => setVals(seed)} title={t("resetTitle")}>
              {tc("reset")}
            </button>
          )}
          <button
            className="mini"
            disabled={atDefaults}
            onClick={applyDefaults}
            title={noDefault ? t("defaultsPartialTitle", { count: noDefault }) : t("defaultsTitle")}
          >
            {t("defaults")}
          </button>
        </div>
      </div>

      {basic.map(slider)}

      {fixed.map((b) => (
        <div className="row" key={b.id} style={{ justifyContent: "space-between", gap: 12, padding: "4px 0" }}>
          <span style={{ minWidth: 150 }}>
            {paramLabel(b)}
            {b.unit ? ` (${unitLabel(b.unit)})` : ""}
          </span>
          <span className="sub mono" title={t("imposedHint")}>
            {t("imposed", { value: b.min ?? 0 })}
          </span>
        </div>
      ))}

      {advanced.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border)" }}>
          <button onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? tc("hide") : t("advanced")} ({advanced.length})
          </button>
          {showAdvanced && (
            <div style={{ marginTop: 8 }}>
              <p className="sub" style={{ marginTop: 0 }}>
                {t("advancedNote")}
              </p>
              {advanced.map(slider)}
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="good" disabled={busy} onClick={() => onDispense(params)}>
          {t("prepareWith")}
        </button>
        <button className="primary" disabled={busy} onClick={() => onWrite(params)} title={t("writeTitle")}>
          {t("writeTo", { profile: profileName ?? tc("profileFallback", { id: profile }) })}
        </button>
      </div>
    </div>
  );
}

/**
 * Tous les paramètres que le modèle déclare pour cette boisson, avec leurs bornes — **sans
 * filtrer sur `kind`**. C'est l'appelant qui décide de regrouper ; filtrer ici masquait des
 * options réellement réglables.
 */
function beverageParams(bev: Beverage): Param[] {
  const src = bev.bounds?.params ?? bev.values?.params ?? [];
  return bev.ingredients.map((id) => src.find((p) => p.id === id)).filter((p): p is Param => !!p);
}

function summary(
  users: Param[],
  paramLabel: (p: Param) => string,
  unitLabel: (u: string) => string,
): string {
  return users
    .filter(isSet)
    .map((p) => `${paramLabel(p)} ${p.def}${p.unit ? " " + unitLabel(p.unit) : ""}`)
    .join(" · ");
}

/**
 * Un défaut n'est exploitable que s'il tombe dans ses propres bornes. La machine renvoie 0 ou
 * 255 (0xFF) pour un paramètre non configuré — constaté sur les 6 recettes perso vides et sur
 * le mug de voyage lors de l'import réel.
 */
function isSet(p: Param): boolean {
  return p.def !== undefined && p.min !== undefined && p.max !== undefined && p.def >= p.min && p.def <= p.max;
}

type Translator = (key: string, values?: Record<string, string | number>) => string;

/**
 * Libellé d'un état machine. Seule la veille (`0x04`) est certaine ; `0x00` et `0x02` sont
 * déduits d'observations concordantes, et tout autre code est affiché brut plutôt que deviné.
 */
function stateLabel(state: number, t: Translator): string {
  if (state === 0x04) return t("standby");
  if (state === 0x00) return t("heating");
  if (state === 0x02) return t("ready");
  return t("onUnknownState", { state: `0x${state.toString(16).padStart(2, "0")}` });
}

function fmtAge(sec: number, t: Translator): string {
  if (sec < 90) return t("ageSeconds", { n: sec });
  if (sec < 5400) return t("ageMinutes", { n: Math.round(sec / 60) });
  return t("ageHours", { n: Math.round(sec / 3600) });
}
/** Paramètre décodé (avec son identifiant d'énum) pour cette boisson — la traduction du libellé
 *  se fait ensuite via `useParamLabel`. */
const paramOf = (bev: Beverage, id: number): Param | undefined =>
  bev.bounds?.params.find((p) => p.id === id) ?? bev.values?.params.find((p) => p.id === id);
