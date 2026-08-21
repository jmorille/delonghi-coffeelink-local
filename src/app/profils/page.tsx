"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import { useMachinePush } from "../events";
import { useConfirm } from "../confirm";
import Icone from "../icons";

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
  /** Compte rendu de la dernière action : il vivait dans un bandeau `.warn`, y compris pour un
   *  succès, et n'était annoncé à personne. */
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const rendre = (r: any, ok: string) =>
    setMsg(r.error ? { text: tc("error", { message: r.error }), kind: "err" } : { text: ok, kind: "ok" });
  const { demander, dialogue } = useConfirm();
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
      rendre(r, t("importQueued", { count: r.queued }));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const selectProfile = (id: number) =>
    demander({ question: t("confirmActivate", { id }), onConfirm: () => void activer(id) });

  const activer = async (id: number) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "selectProfile", profileId: id }),
      }).then((x) => x.json());
      rendre(r, t("activateSent", { label: r.program }));
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
      {!live && <p className="sub">{tc("pushOff")}</p>}

      <div className="card">
        <h2>{t("importHeading")}</h2>
        <p className="chapeau">{t("importNote")}</p>
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
          {/* Importer, c'est LIRE sur la machine : le glyphe est celui que /machines et l'accueil
              emploient deja pour ca — une valeur qui descend de l'appareil vers nous. */}
          <button className="primary iconBtn" disabled={busy || data?.import?.active} onClick={startImport}>
            <Icone nom="lire" />
            <span className="lbl">{data?.import?.active ? t("importing") : t("import")}</span>
          </button>
          {/* Le chevron ne change pas de dessin, il pivote : `.iconBtn.ouvert` s'en charge. Un
              second glyphe pour l'etat ouvert aurait ete deux formes pour une seule bascule. */}
          <button className={"iconBtn" + (showProps ? " ouvert" : "")} onClick={() => setShowProps(!showProps)}>
            <Icone nom="chevron" />
            <span className="lbl">
              {showProps ? tc("hide") : t("propsButton")} (
              {absentCount ? t("propsCountAbsent", { read: readCount, absent: absentCount }) : t("propsCount", { read: readCount })})
            </span>
          </button>
        </div>
        {data?.import && (
          <div className="kv blocSuite">
            <span className="k">
              {t("importState", { state: data.import.active ? t("importActive") : t("importDone") })}
              {data.import.pending ? t("importPending") : ""}
            </span>
            <span className="num">{t("importCounts", { ok: data.import.ok, remaining: data.import.remaining, fail: data.import.fail })}</span>
          </div>
        )}
        {/* Le compte rendu vit dans la carte qui l'a déclenché — c'est là que le doigt était. */}
        <p className={"status " + (msg?.kind === "err" ? "err" : "ok")} role="status">
          {msg?.text ?? ""}
        </p>
        {showProps && data && (
          <div className="tableWrap">
          <table>
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
                  <td className="num">{p.stride ?? "—"}</td>
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
          </div>
        )}
      </div>

      {!data ? (
        <p className="sub">{tc("loading")}</p>
      ) : (
        <>
          <h2>{t("listHeading", { count: data.model.nProfiles })}</h2>
          {/* **Cinq profils se comparent, donc ils se voient cote a cote.** Mesure a 1 194 px : cinq
              cartes de 1 140 x 80 px pour 49 caracteres chacune — une bande pleine largeur par nom
              de profil, et le seul geste de la carte (« Activer ») rejete a 1 000 px du nom qu'il
              active. Choisir un profil, c'est justement les mettre en regard.
              La grille ordinaire (19 rem) et non `dense` : le resume des favoris est une phrase —
              « cafe · cappuccino · … » — et des colonnes plus etroites la feraient courir sur
              quatre lignes, ce qui rendrait les cartes plus hautes qu'elles ne sont larges. */}
          <div className="cards">
          {data.profiles.map((p) => (
            <div className="card" key={p.id}>
              <div className="cardHead">
                <div>
                  {/* Le nom, sa pastille et son numéro d'icône forment UNE ligne de titre. Ils
                      étaient trois frères dans un conteneur sans gouttière : « Profil 1 — Jérôme » et
                      « icône 12 » se touchaient, sans un pixel entre eux. */}
                  <div className="titreLigne">
                    {/* Un profil est un objet nommé, activable, et il y en a cinq : c'est un titre,
                        pas une mise en gras. L'accueil donne un `<h3>` à ses cartes de boisson. */}
                    <h3 className="cardTitle">
                      {tc("profileNumbered", { id: p.id })}
                      {p.name ? ` — ${p.name}` : ""}
                    </h3>
                    {!p.name && (
                      <span className="pill off">
                        {t("nameNotRead")}
                      </span>
                    )}
                    {/* « icône 12 » est une phrase avec un nombre, pas un identifiant : le monospace
                        n'y avait rien à faire. */}
                    {p.icon != null && (
                      <span className="sub num">
                        {t("icon", { n: p.icon })}
                      </span>
                    )}
                  </div>
                  <div className="legende">
                    {p.order
                      ? t("orderSummary", { count: p.order.length, list: p.order.map((o) => o.label ?? `#${o.id}`).join(" · ") })
                      : t("orderNotRead")}
                  </div>
                  {p.source && (
                    <div className="legende mono">
                      {p.source}
                    </div>
                  )}
                </div>
                <button className="iconBtn" disabled={busy} onClick={() => selectProfile(p.id)} title={t("activateTitle")}>
                  <Icone nom="choisir" />
                  <span className="lbl">{t("activate")}</span>
                </button>
              </div>
            </div>
          ))}
          </div>

          <h2>{t("customsHeading", { count: data.model.nCustomRecipes })}</h2>
          <div className="card">
            <div className="tableWrap">
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
                    <td className="num">{c.icon ?? tc("dash")}</td>
                    <td className="num">{c.beverageId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <p className="note">
              {t("customsNote")}
            </p>
          </div>
        </>
      )}
      {dialogue}
    </>
  );
}
