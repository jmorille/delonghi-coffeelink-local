"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";

interface Finding {
  level: "warn" | "info";
  title: string;
  detail: string;
}
interface Payload {
  deviceSheet: {
    _source: string;
    _privacy: string;
    capturedAt: string;
    hardware: Record<string, string | null>;
    firmware: Record<string, string | boolean | null>;
    platform: Record<string, unknown>;
    lifecycle: Record<string, unknown>;
    findings: Finding[];
  };
  model: Record<string, unknown>;
  /**
   * Identification lue sur la machine (`d270_serialnumber`). `matchesCatalog: null` = pas encore
   * lu ; `false` = la machine n'est pas celle du catalogue ci-dessus.
   */
  identification: {
    key: string | null;
    source: string;
    serialProp: string;
    tableVersion: string;
    knownModels: number;
    detected: Record<string, unknown> | null;
    catalog: Record<string, unknown>;
    matchesCatalog: boolean | null;
    serial: string | null;
    machineName: string | null;
    at: number | null;
    restored: boolean;
    lastError: { reason: string; hex: string } | null;
  };
  network: Record<string, unknown>;
  local: { reachable: boolean; status?: number; regtoken?: Record<string, unknown> | null; error?: string; at: number };
  protocol: Record<string, unknown>;
  ota: {
    lanRequests: { at: number; url: string; method: string; from: string }[];
    lanNote: string;
    cloud: { configured: boolean; note?: string; status?: number; updateAvailable?: boolean; body?: unknown; error?: string };
  };
  /** État du stockage local. Voir `src/lib/store.mjs`. */
  storage: {
    engine: string;
    file: string;
    schemaVersion: number;
    journalMode: string;
    synchronous: number;
    sqliteVersion: string;
    sizeBytes: number;
    counts: { props: number; stats: number; beanSystems: number; recipes: number };
  };
  machineState: {
    // `progress` n'existe pas : les octets 5-6 du monitor sont les capteurs (cf. server.mjs).
    lastMonitor: {
      at: number;
      stateByte: number;
      switchBits: number;
      alarms: { bit: number; name: string | null }[];
    } | null;
    lastDataResponse: { at: number; hex: string } | null;
    checksums: { at: number; profiles: Record<string, number>; customRecipes: number; names: number } | null;
    serialNumber: unknown;
    propsRead: number;
    importedAt: number | null;
  };
}

export default function Systeme() {
  const t = useTranslations("system");
  const tc = useTranslations("common");
  const [d, setD] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [idMsg, setIdMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setD(await mfetch("/api/system").then((r) => r.json()));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Demande la lecture du numéro de série. C'est une LECTURE : aucune préparation, aucune
   * écriture. La machine répond de façon asynchrone (elle pousse un datapoint), d'où l'attente
   * bornée — sans elle, la page afficherait encore l'état d'avant la demande.
   */
  const readModel = useCallback(async () => {
    setBusy(true);
    setIdMsg(t("idReading"));
    try {
      const before = d?.identification.at ?? 0;
      const r = await mfetch("/api/model", { method: "POST" }).then((x) => x.json());
      if (r.error) {
        setIdMsg(tc("error", { message: r.error }));
        return;
      }
      for (let i = 0; i < 14; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const m = await mfetch("/api/model").then((x) => x.json());
        if ((m.at ?? 0) > before || m.lastError) {
          setIdMsg(m.lastError ? t("idFailed", { reason: m.lastError.reason }) : t("idDone"));
          break;
        }
        if (i === 13) setIdMsg(t("idNoAnswer"));
      }
      await load();
    } finally {
      setBusy(false);
    }
  }, [d, load, t, tc]);

  if (!d) return <p className="sub">{t("probing")}</p>;

  const fw = d.deviceSheet.firmware;
  const builtAt = String(fw.builtAt ?? "");
  const ageYears = builtAt ? ((Date.now() - Date.parse(builtAt)) / 31557600000).toFixed(1) : null;

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro", { date: d.deviceSheet.capturedAt })}</p>

      <div className="row" style={{ marginBottom: 16 }}>
        <button className="primary" disabled={busy} onClick={load}>
          {busy ? t("refreshing") : tc("refresh")}
        </button>
      </div>

      <h2>{t("firmware")}</h2>
      <div className="card">
        <div className="kv">
          <span className="k">{t("fullVersion")}</span>
          <span className="mono">{String(fw.sw_version)}</span>
        </div>
        <div className="kv">
          <span className="k">{t("aylaAgent")}</span>
          <span className="mono">{String(fw.agent)}</span>
        </div>
        <div className="kv">
          <span className="k">{t("sdk")}</span>
          <span className="mono">{String(fw.sdk)}</span>
        </div>
        <div className="kv">
          <span className="k">{t("builtAt")}</span>
          <span className="mono">
            {ageYears ? t("builtAgo", { date: builtAt.slice(0, 10), years: ageYears }) : builtAt.slice(0, 10)}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("commit")}</span>
          <span className="mono">{String(fw.commit)}</span>
        </div>
        <div className="kv">
          <span className="k">{t("lastModuleUpdate")}</span>
          <span className="mono">
            {String(fw.module_updated_at).slice(0, 10)} {fw.neverUpdated ? t("neverUpdated") : ""}
          </span>
        </div>
      </div>

      <h2>{t("ota")}</h2>
      <div className="card">
        <div className="kv">
          <span className="k">{t("otaRequests")}</span>
          <span className="mono">{d.ota.lanRequests.length === 0 ? tc("none") : d.ota.lanRequests.length}</span>
        </div>
        <p className="sub" style={{ marginTop: 8 }}>
          {d.ota.lanNote}
        </p>
        {d.ota.lanRequests.length > 0 && (
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>{t("otaWhen")}</th>
                <th>{t("otaRequest")}</th>
                <th>{t("otaFrom")}</th>
              </tr>
            </thead>
            <tbody>
              {d.ota.lanRequests.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{new Date(r.at).toLocaleString("fr-FR")}</td>
                  <td className="mono">
                    {r.method} {r.url}
                  </td>
                  <td className="mono">{r.from}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="kv" style={{ marginTop: 10 }}>
          <span className="k">{t("cloudCheck")}</span>
          <span className="mono">
            {!d.ota.cloud.configured
              ? t("cloudDisabled")
              : d.ota.cloud.error
                ? tc("error", { message: d.ota.cloud.error })
                : d.ota.cloud.updateAvailable
                  ? t("cloudAvailable")
                  : t("cloudNone", { status: d.ota.cloud.status ?? 0 })}
          </span>
        </div>
        {d.ota.cloud.note && (
          <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>
            {d.ota.cloud.note}
          </p>
        )}
      </div>

      <h2>{t("wifiModule")}</h2>
      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          {t("liveNote", { others: "status.json, wifi_status.json, time.json, module_info.json, ota.json, wifi_scan.json" })}
        </p>
        <div className="kv">
          <span className="k">{t("reachable")}</span>
          <span className={d.local.reachable ? "pill on" : "pill off"}>
            {d.local.reachable ? t("reachableYes", { status: d.local.status ?? 0 }) : t("reachableNo", { error: d.local.error ?? "" })}
          </span>
        </div>
        {d.local.regtoken &&
          Object.entries(d.local.regtoken).map(([k, v]) => (
            <div className="kv" key={k}>
              <span className="k mono">{k}</span>
              <span className="mono">{String(v)}</span>
            </div>
          ))}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <Rows obj={d.deviceSheet.hardware} />
        </div>
      </div>

      <h2>{t("aylaPlatform")}</h2>
      <div className="card">
        <Rows obj={d.deviceSheet.platform} />
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <Rows obj={d.deviceSheet.lifecycle} />
        </div>
      </div>

      <h2>{t("machineModel")}</h2>
      <div className="card">
        <Rows
          obj={{
            type: d.model.type,
            appModelId: d.model.appModelId,
            productCode: d.model.productCode,
            protocolVersion: d.model.protocolVersion,
            protocolMinorVersion: d.model.protocolMinorVersion,
            connectionType: d.model.connectionType,
            nProfiles: d.model.nProfiles,
            nStandardRecipes: d.model.nStandardRecipes,
            nCustomRecipes: d.model.nCustomRecipes,
            creationRecipes: d.model.creationRecipes,
            customizableProfiles: d.model.customizableProfiles,
            globalTemperature: d.model.globalTemperature,
          }}
        />
        <p className="sub" style={{ marginBottom: 0, marginTop: 10 }}>
          {t("modelSource")}
        </p>
      </div>

      <h2>{t("identification")}</h2>
      <div className={d.identification.matchesCatalog === false ? "card warn" : "card"}>
        {d.identification.matchesCatalog === false && (
          <p style={{ margin: "0 0 10px" }}>
            <strong>
              ⚠{" "}
              {t("idMismatch", {
                detected: d.identification.key ?? "?",
                catalog: String(d.identification.catalog.key ?? "?"),
                catalogType: String(d.identification.catalog.type ?? "?"),
              })}
            </strong>
          </p>
        )}
        <Rows
          obj={{
            key: d.identification.key,
            source: d.identification.source,
            machineName: d.identification.machineName,
            serialNumber: d.identification.serial,
            detectedType: d.identification.detected?.type ?? null,
            detectedAppModelId: d.identification.detected?.appModelId ?? null,
            detectedRecipeCount: d.identification.detected?.recipeCount ?? null,
            detectedNProfiles: d.identification.detected?.nProfiles ?? null,
            matchesCatalog: d.identification.matchesCatalog,
            // `Rows` ne formate pas les dates : un epoch brut ne dit rien a l'oeil.
            readAt: d.identification.at ? new Date(d.identification.at).toLocaleString("fr-FR") : null,
          }}
        />
        {d.identification.key && !d.identification.detected && (
          <p className="sub" style={{ margin: "10px 0 0" }}>
            {t("idUnknownModel", { key: d.identification.key, version: d.identification.tableVersion })}
          </p>
        )}
        {d.identification.lastError && (
          <p className="sub mono" style={{ margin: "10px 0 0", fontSize: ".78rem" }}>
            {t("idFailed", { reason: d.identification.lastError.reason })} — {d.identification.lastError.hex || "(trame vide)"}
          </p>
        )}
        <div style={{ marginTop: 12 }}>
          <button onClick={readModel} disabled={busy}>
            {d.identification.key ? t("idReread") : t("idRead")}
          </button>
          {idMsg && (
            <span className="sub" style={{ marginLeft: 10 }}>
              {idMsg}
            </span>
          )}
        </div>
        <p className="sub" style={{ margin: "10px 0 0" }}>
          {t("idNote", { prop: d.identification.serialProp, count: d.identification.knownModels, version: d.identification.tableVersion })}
        </p>
        <p className="sub" style={{ margin: "6px 0 0" }}>
          {t("idScopeNote")}
        </p>
      </div>

      <h2>{t("machineState")}</h2>
      <div className="card">
        <div className="kv">
          <span className="k">{t("monitor")}</span>
          <span className="mono">
            {d.machineState.lastMonitor
              ? t("monitorDetail", {
                  state: `0x${d.machineState.lastMonitor.stateByte.toString(16).padStart(2, "0")}`,
                  sensors: `0x${d.machineState.lastMonitor.switchBits.toString(16)}`,
                  alarms: d.machineState.lastMonitor.alarms?.length
                    ? String(d.machineState.lastMonitor.alarms.length)
                    : t("monitorNoAlarm"),
                  time: new Date(d.machineState.lastMonitor.at).toLocaleTimeString("fr-FR"),
                })
              : t("monitorNone")}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("lastEcamResponse")}</span>
          <span className="mono" style={{ fontSize: ".78rem", textAlign: "right" }}>
            {d.machineState.lastDataResponse?.hex ?? tc("dash")}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("cachedProps")}</span>
          <span className="mono">{d.machineState.propsRead}</span>
        </div>
        {d.machineState.checksums && (
          <>
            <div className="kv">
              <span className="k">{t("checksumsPerProfile")}</span>
              <span className="mono">
                {Object.entries(d.machineState.checksums.profiles)
                  .map(([p, v]) => `${p}:0x${v.toString(16)}`)
                  .join("  ")}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("checksumsNamesCustom")}</span>
              <span className="mono">
                0x{d.machineState.checksums.names.toString(16)} / 0x{d.machineState.checksums.customRecipes.toString(16)}
              </span>
            </div>
          </>
        )}
      </div>

      <h2>{t("storage")}</h2>
      <div className="card">
        <div className="kv">
          <span className="k">{t("storageEngine")}</span>
          <span className="mono">
            {d.storage.engine} {d.storage.sqliteVersion} · {t("storageSchema", { v: d.storage.schemaVersion })}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("storageDurability")}</span>
          <span className="mono">
            {t("storageDurabilityValue", { journal: d.storage.journalMode.toUpperCase(), sync: d.storage.synchronous })}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("storageRows")}</span>
          <span className="mono">{t("storageRowsValue", d.storage.counts)}</span>
        </div>
        <div className="kv">
          <span className="k">{t("storageFile")}</span>
          <span className="mono" style={{ fontSize: ".78rem", textAlign: "right", wordBreak: "break-all" }}>
            {d.storage.file} ({Math.round(d.storage.sizeBytes / 1024)} ko)
          </span>
        </div>
        <p className="sub" style={{ margin: "8px 0 0" }}>{t("storageNote")}</p>
      </div>

      <h2>{t("protocolNetwork")}</h2>
      <div className="card">
        <Rows obj={d.protocol} />
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <Rows obj={d.network} />
        </div>
      </div>

      <h2>{t("findings")}</h2>
      {d.deviceSheet.findings.map((f, i) => (
        <div className={f.level === "warn" ? "card warn" : "card"} key={i} style={{ marginBottom: 10 }}>
          <strong>
            {f.level === "warn" ? "⚠ " : ""}
            {f.title}
          </strong>
          <div className="sub" style={{ margin: "4px 0 0" }}>
            {f.detail}
          </div>
        </div>
      ))}

      <p className="sub">{d.deviceSheet._privacy}</p>
      <p className="sub mono" style={{ fontSize: ".78rem" }}>
        {d.deviceSheet._source}
      </p>
    </>
  );
}

/** Rend un objet plat en lignes clé/valeur, en gardant les `null` visibles plutôt que masqués. */
function Rows({ obj }: { obj: Record<string, unknown> }) {
  return (
    <>
      {Object.entries(obj)
        .filter(([k]) => !k.startsWith("_") && k !== "note")
        .map(([k, v]) => (
          <div className="kv" key={k}>
            <span className="k mono">{k}</span>
            <span className="mono">{fmt(v)}</span>
          </div>
        ))}
      {typeof obj.note === "string" && (
        <p className="sub" style={{ marginBottom: 0, marginTop: 10 }}>
          {obj.note}
        </p>
      )}
    </>
  );
}

function fmt(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—"; // rendu neutre, pas une chaîne d'interface
  if (typeof v === "boolean") return v ? "oui" : "non"; // TODO i18n si une 2e langue arrive
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
