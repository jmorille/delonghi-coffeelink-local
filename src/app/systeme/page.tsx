"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import Alerte, { TitreAlerte } from "../Alerte";
import Icone from "../icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/table";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

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
  /**
   * Fiche du catalogue **en service**, pas nécessairement celui de la machine : `fallback` dit
   * quand c'est un remplaçant, et `detectedKey` ce que la machine a réellement annoncé. Les deux
   * sont typés parce qu'on les lit ; le reste part dans `Rows` sans être nommé.
   */
  model: Record<string, unknown> & { fallback?: boolean; detectedKey?: string | null };
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
    /**
     * Ce qu'on SAIT, pas une requête : ouvrir cette page ne déclenche plus d'appel au cloud.
     * `last` est le dernier relevé mémorisé, `null` si la vérification n'a jamais été faite.
     */
    cloud: {
      tokenConfigured: boolean;
      last: { at: number; status: number; updateAvailable: boolean; version: string | null; type: string | null } | null;
    };
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
  /**
   * **Les deux modes de monitor restés hors Wi-Fi.** `getByteMonitorMode` de l'application
   * décompilée construit trois trames — `0x60`, `0x70`, `0x75` — mais son service Wi-Fi n'envoie
   * jamais que la dernière ; les deux autres n'apparaissent que du côté Bluetooth. On ne sait donc
   * pas si le module y répond en LAN, ni ce que contiendrait la réponse.
   *
   * D'où une SONDE et non une fonctionnalité : on envoie, et on lit ce qui revient dans « Dernière
   * réponse ECAM », juste au-dessus. Aucun décodeur : inventer une structure pour des octets
   * jamais observés produirait des champs plausibles et faux. C'est aussi pourquoi ce bloc est
   * ici, sur la page qui décrit le protocole, et pas dans une page de pilotage — ce n'est pas un
   * geste courant, c'est une mesure.
   */
  const [sondeMsg, setSondeMsg] = useState<string | null>(null);
  const sonder = useCallback(async (mode: number) => {
    setBusy(true);
    setSondeMsg(t("probeSending", { mode }));
    try {
      const avant = d?.machineState.lastDataResponse?.at ?? 0;
      const r = await mfetch("/api/monitormode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      }).then((x) => x.json());
      if (r.error) {
        setSondeMsg(tc("error", { message: r.error }));
        return;
      }
      // La réponse arrive de façon asynchrone : la machine se connecte, prend la commande, puis
      // pousse sa réponse. On attend qu'un `data_response` PLUS RÉCENT que le nôtre apparaisse.
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const j = await mfetch("/api/system").then((x) => x.json());
        setD(j);
        if ((j.machineState?.lastDataResponse?.at ?? 0) > avant) {
          setSondeMsg(t("probeAnswered", { mode, hex: j.machineState.lastDataResponse.hex }));
          return;
        }
      }
      setSondeMsg(t("probeSilent", { mode }));
    } finally {
      setBusy(false);
    }
  }, [d, t, tc]);

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

      <div className="row barreActions">
        {/* **Rafraichir est une LECTURE**, pas un retour en arriere : la page reinterroge la
            machine et relit l'etat local. La fleche circulaire aurait ete le reflexe, mais c'est le
            dessin de « revenir aux valeurs enregistrees » dans l'editeur — deux sens pour un
            glyphe. Ici la valeur descend de l'appareil, comme partout ailleurs. */}
        <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={load}>
          <Icone nom="lire" />
          <span className="lbl">{busy ? t("refreshing") : tc("refresh")}</span>
        </Button>
      </div>

      {/* **Neuf sujets independants, et ils etaient neuf bandes de 1 140 px.** Mesure a
          1 194 px — la tablette 11" en paysage, et une page que PRODUCT.md donne au bureau :
          15 cartes empilees sur une seule colonne, 6 034 px de haut, ~87 lignes cle/valeur dont
          la valeur commence a 208 px dans une bande de 1 140. La moitie droite de la page ne
          portait rien. C'est exactement le defaut que `.panneaux` a corrige sur /pilotage, laisse
          en place sur la page qui en compte le plus.

          Le titre et la carte qu'il titre etaient FRERES : rien ne les tenait ensemble, donc rien
          ne pouvait garantir qu'ils restent dans la meme colonne. Chaque sujet devient une
          `<section>` — ce qu'il etait deja par le sens. */}
      <div className="panneaux">
        <section>
          <h2>{t("firmware")}</h2>
          <Card>
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
          </Card>
        </section>
        <section>
          <h2>{t("ota")}</h2>
          <Card>
            <div className="kv">
              <span className="k">{t("otaRequests")}</span>
              <span className="num">{d.ota.lanRequests.length === 0 ? tc("none") : d.ota.lanRequests.length}</span>
            </div>
            <p className="note">
              {d.ota.lanNote}
            </p>
            {d.ota.lanRequests.length > 0 && (
              <div className="tableWrap">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("otaWhen")}</TableHead>
                    <TableHead>{t("otaRequest")}</TableHead>
                    <TableHead>{t("otaFrom")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.ota.lanRequests.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="num">{new Date(r.at).toLocaleString("fr-FR")}</TableCell>
                      <TableCell className="mono">
                        {r.method} {r.url}
                      </TableCell>
                      <TableCell className="mono">{r.from}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
    {/* Une seule ligne. L'ancienne version affichait « désactivée », puis une phrase qui se
                terminait par « vérification cloud désactivée » : le libellé et la note disaient la même
                chose. Et la vérification n'est plus subordonnée à AYLA_TOKEN — elle se lance depuis la
                page Machines, avec les identifiants du compte. */}
            <div className="kv blocSuite">
              <span className="k">{t("cloudCheck")}</span>
              <span>
                {!d.ota.cloud.last ? (
                  <span className="sub">{t("cloudNever")}</span>
                ) : d.ota.cloud.last.updateAvailable ? (
                  <>
                    <Badge variant="arret">{t("cloudAvailable")}</Badge>{" "}
                    <span className="sub">
                      {d.ota.cloud.last.version ?? ""} · {new Date(d.ota.cloud.last.at).toLocaleString("fr-FR")}
                    </span>
                  </>
                ) : (
                  <>
                    {t("cloudNone", { status: d.ota.cloud.last.status })}{" "}
                    <span className="sub">{new Date(d.ota.cloud.last.at).toLocaleString("fr-FR")}</span>
                  </>
                )}
              </span>
            </div>
          </Card>
        </section>
        <section>
          <h2>{t("wifiModule")}</h2>
          <Card>
            <p className="sub">
              {t("liveNote", { others: "status.json, wifi_status.json, time.json, module_info.json, ota.json, wifi_scan.json" })}
            </p>
            <div className="kv">
              <span className="k">{t("reachable")}</span>
              <Badge variant={d.local.reachable ? "marche" : "arret"}>
                {d.local.reachable ? t("reachableYes", { status: d.local.status ?? 0 }) : t("reachableNo", { error: d.local.error ?? "" })}
              </Badge>
            </div>
            {d.local.regtoken &&
              Object.entries(d.local.regtoken).map(([k, v]) => (
                <div className="kv" key={k}>
                  <span className="k mono">{k}</span>
                  <span className="mono">{String(v)}</span>
                </div>
              ))}
            <div className="blocSuite">
              <Rows obj={d.deviceSheet.hardware} />
            </div>
          </Card>
        </section>
        <section>
          <h2>{t("aylaPlatform")}</h2>
          <Card>
            <Rows obj={d.deviceSheet.platform} />
            <div className="blocSuite">
              <Rows obj={d.deviceSheet.lifecycle} />
            </div>
          </Card>
        </section>
        <section>
          <h2>{t("machineModel")}</h2>
          <Card>
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
            <p className="note">
              {t("modelSource")}
            </p>
            {/* Ce bloc décrit le catalogue EN SERVICE. Quand c'est un remplaçant, il décrit donc un
                modèle qui n'est pas celui de la machine : le taire serait affirmer le contraire. */}
            {d.model.fallback && (
              <Alerte className="note">
                {t("modelFallback", { detected: d.model.detectedKey ?? "?", type: String(d.model.type ?? "?") })}
              </Alerte>
            )}
          </Card>
        </section>
        <section>
          <h2>{t("identification")}</h2>
          <Card className={d.identification.matchesCatalog === false ? "warn" : undefined}>
            {d.identification.matchesCatalog === false && (
              <p className="chapeau">
                <TitreAlerte>
                  {t("idMismatch", {
                    detected: d.identification.key ?? "?",
                    catalog: String(d.identification.catalog.key ?? "?"),
                    catalogType: String(d.identification.catalog.type ?? "?"),
                  })}
                </TitreAlerte>
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
              <p className="note">
                {t("idUnknownModel", { key: d.identification.key, version: d.identification.tableVersion })}
              </p>
            )}
            {d.identification.lastError && (
              <p className="note mono">
                {t("idFailed", { reason: d.identification.lastError.reason })} — {d.identification.lastError.hex || "(trame vide)"}
              </p>
            )}
            <div className="blocSuite">
              <Button type="button" variant="neutre" size="commande" className="iconBtn" onClick={readModel} disabled={busy}>
                <Icone nom="lire" />
                <span className="lbl">{d.identification.key ? t("idReread") : t("idRead")}</span>
              </Button>
              {idMsg && (
                <span className="sub">
                  {idMsg}
                </span>
              )}
            </div>
            <p className="note">
              {t("idNote", { prop: d.identification.serialProp, count: d.identification.knownModels, version: d.identification.tableVersion })}
            </p>
            <p className="legende">
              {t("idScopeNote")}
            </p>
          </Card>
        </section>
        <section>
          <h2>{t("machineState")}</h2>
          <Card>
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
              <span className="mono">
                {d.machineState.lastDataResponse?.hex ?? tc("dash")}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("cachedProps")}</span>
              <span className="num">{d.machineState.propsRead}</span>
            </div>
            {/* **Sondes de protocole.** Deux trames que l'application construit sans jamais les
                envoyer par Wi-Fi : on les essaie, et le résultat est la ligne « Dernière réponse
                ECAM » ci-dessus. Aucune écriture. */}
            <h3 className="titreBloc">{t("probesHeading")}</h3>
            <p className="legende">{t("probesNote")}</p>
            <div className="row">
              <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => sonder(0)} title={t("probeTitle", { cmd: "0x60" })}>
                <Icone nom="oeil" />
                <span className="lbl">{t("probe", { cmd: "0x60" })}</span>
              </Button>
              <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => sonder(1)} title={t("probeTitle", { cmd: "0x70" })}>
                <Icone nom="oeil" />
                <span className="lbl">{t("probe", { cmd: "0x70" })}</span>
              </Button>
            </div>
            {sondeMsg && <p className="status ok" role="status">{sondeMsg}</p>}
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
          </Card>
        </section>
        <section>
          <h2>{t("storage")}</h2>
          <Card>
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
              {/* Pas de coupure en ligne : `.kv > *` porte déjà `overflow-wrap: anywhere`, et
                  c'est le bon des deux réglages — `break-all` scindait aussi le « (48 ko) » de
                  la fin, qui avait pourtant où se replier. */}
              <span className="mono">
                {d.storage.file} ({Math.round(d.storage.sizeBytes / 1024)} ko)
              </span>
            </div>
            <p className="note">{t("storageNote")}</p>
          </Card>
        </section>
        <section>
          <h2>{t("protocolNetwork")}</h2>
          <Card>
            <Rows obj={d.protocol} />
            <div className="blocSuite">
              <Rows obj={d.network} />
            </div>
          </Card>
        </section>
        {/* Les constats se rangent en grille : onze cartes de 70 a 113 px de haut, homogenes,
            faites pour etre balayees — une bande de 1 140 px par constat les rendait plus longs a
            parcourir que la fiche entiere.
            **Et ils coulent dans les colonnes au lieu de les enjamber.** Essaye en `column-span:
            all`, ce qui paraissait naturel pour une liste : le bloc doit alors attendre la plus
            haute des deux colonnes, ce qui rouvrait un vide de 558 x 511 px en bas a droite —
            exactement le defaut que cette passe supprime. Mesure : 3 670 px avec l'enjambement,
            3 381 px sans, et le desequilibre des colonnes tombe de 511 a 133 px. */}
        <section>
          <h2>{t("findings")}</h2>
          <div className="cards dense">
            {d.deviceSheet.findings.map((f, i) => (
              <Card className={f.level === "warn" ? "warn" : undefined} key={i}>
                {/* Onze constats, dont quatre en avertissement : le pictogramme est ce qui les distingue
                    en balayant la liste, et il est maintenant dessiné comme les autres. */}
                {f.level === "warn" ? <TitreAlerte>{f.title}</TitreAlerte> : <strong>{f.title}</strong>}
                <div className="legende">
                  {f.detail}
                </div>
              </Card>
            ))}
          </div>
        </section>
      </div>

      <p className="sub">{d.deviceSheet._privacy}</p>
      <p className="sub mono">
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
        <p className="note">
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
