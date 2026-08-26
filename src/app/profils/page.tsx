"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import { useMachinePush } from "../events";
import { useConfirm } from "../confirm";
import Icone from "../icons";
import { useBeverageLabel } from "../../i18n/labels";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";

interface OrderEntry {
  id: number;
  /** Identifiant de la boisson au catalogue : c'est LUI qui se traduit. */
  slug: string | null;
  /** Libellé français du serveur, gardé en repli quand le catalogue ne connaît pas le slug. */
  label: string | null;
  /** Nom SAISI sur la machine. Donnée utilisateur : il prime, et il ne se traduit jamais. */
  machineName: string | null;
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
  model: { type: string; nProfiles: number; customizableProfiles: boolean; nCustomRecipes: number; namesCustomizable?: boolean; iconsCustomizable?: boolean };
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

/**
 * **Un seul éditeur pour les deux familles de noms.** Un profil et une recette perso se renomment
 * par la même trame à un octet de commande près (`0xA5` / `0xAB`), avec la même contrainte : 20
 * caractères, et une icône obligatoire. Deux formulaires auraient divergé sur la borne.
 */
function Editeur({
  edition, setEdition, busy, onEcrire, t, tc,
}: {
  edition: { kind: "profile" | "custom"; index: number; name: string; icon: string };
  setEdition: (e: { kind: "profile" | "custom"; index: number; name: string; icon: string } | null) => void;
  busy: boolean;
  onEcrire: () => void;
  t: (k: string, v?: Record<string, string | number>) => string;
  tc: (k: string, v?: Record<string, string | number>) => string;
}) {
  return (
    <div className="note">
      <div className="row">
        <div className="champBloc">
          <label htmlFor={`nom-${edition.kind}-${edition.index}`}>{t("renameLabel")}</label>
          <input
            id={`nom-${edition.kind}-${edition.index}`}
            className="champ"
            value={edition.name}
            maxLength={20}
            onChange={(e) => setEdition({ ...edition, name: e.target.value })}
            placeholder={t("renamePlaceholder")}
          />
        </div>
        {/* L'icône est un numéro dans un jeu propre au modèle (`profile_icons_set`), pas une image
            que nous saurions dessiner : on montre le nombre, et on dit d'où il vient. */}
        <div className="champBloc">
          <label htmlFor={`icone-${edition.kind}-${edition.index}`}>{t("iconLabel")}</label>
          <input
            id={`icone-${edition.kind}-${edition.index}`}
            className="champ"
            type="number"
            min={0}
            max={255}
            value={edition.icon}
            onChange={(e) => setEdition({ ...edition, icon: e.target.value })}
          />
        </div>
      </div>
      <div className="row">
        <button className="iconBtn" disabled={busy || !edition.name.trim()} onClick={onEcrire}>
          <Icone nom="ecrire" />
          <span className="lbl">{t("renameWrite")}</span>
        </button>
        <button className="mini discret" disabled={busy} onClick={() => setEdition(null)}>{tc("cancel")}</button>
      </div>
      <p className="legende">{t("renameNote")}</p>
    </div>
  );
}

export default function Profils() {
  const t = useTranslations("profiles");
  /**
   * **Le nom d'une boisson de l'ordre des favoris, comme partout ailleurs.** Cette page rendait le
   * `label` du serveur tel quel — seule page à ne pas passer par le helper. Elle contournait donc
   * aussi les noms saisis sur la machine, et affichait « Recette perso 1 » là où `/` affichait
   * « Lacteso » : la divergence que `machineBeverageNames` avait été écrit pour supprimer,
   * reproduite ici dans l'autre sens.
   */
  const bevLabel = useBeverageLabel();
  const nomBoisson = (o: OrderEntry) =>
    o.slug
      ? bevLabel({ slug: o.slug, machineName: o.machineName, label: o.label ?? undefined })
      : (o.machineName ?? o.label ?? `#${o.id}`);
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

  /**
   * **Renommer, et c'est le pendant d'une lecture qui existait déjà.** `/profils` lisait les noms
   * de profils (`0xA4`) et de recettes perso (`0xAA`) sans jamais pouvoir en écrire un : la trame
   * symétrique (`0xA5` / `0xAB`) n'était pas portée. Elle l'est.
   *
   * L'édition est ouverte sur UNE entrée à la fois (`edition`), et l'icône part avec le nom parce
   * que la trame les porte ensemble — 20 octets de nom puis un octet d'icône. Laisser l'icône hors
   * du formulaire aurait obligé à en deviner une, et la valeur devinée serait écrite pour de bon.
   */
  const [edition, setEdition] = useState<{ kind: "profile" | "custom"; index: number; name: string; icon: string } | null>(null);

  const ecrireNom = async () => {
    if (!edition) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/profiles/name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: edition.kind, index: edition.index, name: edition.name, icon: Number(edition.icon) }),
      }).then((x) => x.json());
      rendre(r, t("renameSent", { name: edition.name }));
      if (!r.error) setEdition(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /**
   * **L'ordre des favoris s'écrit aussi.** La lecture (`0xA8`) alimentait déjà l'ordre des cartes
   * de l'accueil ; l'écriture (`0xAD`) manquait. L'éditeur travaille sur une copie locale — rien
   * ne part avant « Écrire », et « ↺ » revient à ce que la machine a dit.
   */
  const [favoris, setFavoris] = useState<{ profileId: number; ids: number[] } | null>(null);
  const bouger = (i: number, d: -1 | 1) => {
    setFavoris((f) => {
      if (!f) return f;
      const j = i + d;
      if (j < 0 || j >= f.ids.length) return f;
      const ids = [...f.ids];
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return { ...f, ids };
    });
  };
  const ecrireFavoris = async () => {
    if (!favoris) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/profiles/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: favoris.profileId, beverageIds: favoris.ids }),
      }).then((x) => x.json());
      rendre(r, t("favoritesSent", { id: favoris.profileId }));
      if (!r.error) setFavoris(null);
      await refresh();
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
            <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <SelectTrigger id="scope" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SCOPES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {t(s.key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                      ? t("orderSummary", { count: p.order.length, list: p.order.map(nomBoisson).join(" · ") })
                      : t("orderNotRead")}
                  </div>
                  {p.source && (
                    <div className="legende mono">
                      {p.source}
                    </div>
                  )}
                </div>
                <div className="row">
                  <button className="iconBtn" disabled={busy} onClick={() => selectProfile(p.id)} title={t("activateTitle")}>
                    <Icone nom="choisir" />
                    <span className="lbl">{t("activate")}</span>
                  </button>
                  {/* **Renommer n'est proposé que si le modèle le permet.** `profileNamesCustomizable`
                      vient du catalogue extrait de l'APK : sur un modèle qui dit non, la trame
                      partirait quand même et on ne sait pas ce qu'elle y ferait. */}
                  {data.model.namesCustomizable !== false && (
                    <button
                      className="discret iconBtn"
                      disabled={busy}
                      onClick={() => setEdition(edition?.kind === "profile" && edition.index === p.id ? null : { kind: "profile", index: p.id, name: p.name ?? "", icon: String(p.icon ?? 0) })}
                      title={t("renameTitle")}
                    >
                      <Icone nom="modifier" />
                      <span className="lbl">{t("rename")}</span>
                    </button>
                  )}
                </div>
              </div>

              {edition?.kind === "profile" && edition.index === p.id && (
                <Editeur
                  edition={edition}
                  setEdition={setEdition}
                  busy={busy}
                  onEcrire={() =>
                    demander({
                      question: t("confirmRename", { name: edition.name, cible: tc("profileNumbered", { id: p.id }) }),
                      detail: t("confirmRenameDetail"),
                      onConfirm: () => void ecrireNom(),
                    })
                  }
                  t={t}
                  tc={tc}
                />
              )}

              {/* **L'ordre des favoris, modifiable là où il est déjà affiché.** Il n'est proposé
                  que s'il a été lu : réordonner une liste qu'on n'a pas encore reçue reviendrait à
                  écrire un ordre inventé sur la machine. */}
              {p.order && p.order.length > 0 && (
                <>
                  <button
                    className="discret iconBtn"
                    disabled={busy}
                    onClick={() => setFavoris(favoris?.profileId === p.id ? null : { profileId: p.id, ids: p.order!.map((o) => o.id) })}
                    title={t("favoritesTitle")}
                  >
                    <Icone nom="etoile" />
                    <span className="lbl">{t("favorites")}</span>
                  </button>
                  {favoris?.profileId === p.id && (
                    <div className="note">
                      <ol className="listeFavoris">
                        {favoris.ids.map((id, i) => (
                          <li key={`${id}-${i}`}>
                            <span>{(() => { const o = p.order!.find((x) => x.id === id); return o ? nomBoisson(o) : `#${id}`; })()}</span>
                            <span className="row">
                              <button className="mini discret" disabled={busy || i === 0} onClick={() => bouger(i, -1)} aria-label={t("moveUp")}>↑</button>
                              <button className="mini discret" disabled={busy || i === favoris.ids.length - 1} onClick={() => bouger(i, 1)} aria-label={t("moveDown")}>↓</button>
                            </span>
                          </li>
                        ))}
                      </ol>
                      <div className="row">
                        <button
                          className="iconBtn"
                          disabled={busy}
                          onClick={() =>
                            demander({
                              question: t("confirmFavorites", { id: p.id }),
                              detail: t("confirmRenameDetail"),
                              onConfirm: () => void ecrireFavoris(),
                            })
                          }
                        >
                          <Icone nom="ecrire" />
                          <span className="lbl">{t("favoritesWrite")}</span>
                        </button>
                        <button className="mini discret" disabled={busy} onClick={() => setFavoris({ profileId: p.id, ids: p.order!.map((o) => o.id) })}>
                          {t("favoritesReset")}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
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
                  <th><span className="sr-only">{t("rename")}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.customs.map((c) => (
                  <tr key={c.slot}>
                    <td>{t("customSlot", { n: c.slot })}</td>
                    <td>{c.name ?? <span className="sub">{t("unnamed")}</span>}</td>
                    <td className="num">{c.icon ?? tc("dash")}</td>
                    <td className="num">{c.beverageId}</td>
                    <td className="titreLigne">
                      <button
                        className="discret iconBtn iconSeul"
                        disabled={busy}
                        onClick={() => setEdition(edition?.kind === "custom" && edition.index === c.slot ? null : { kind: "custom", index: c.slot, name: c.name ?? "", icon: String(c.icon ?? 0) })}
                        aria-label={t("rename")}
                        title={t("renameTitle")}
                      >
                        <Icone nom="modifier" />
                      </button>
                      {/* **Le nom se change ici, la RECETTE se change sur `/`.** Un emplacement perso
                          est une boisson du catalogue (id 229+n) : son éditeur borné par le modèle,
                          avec les valeurs enregistrées du profil, « Préparer » et « Écrire dans le
                          profil », existe déjà là-bas. En remonter une copie ici donnerait deux
                          endroits pour le même geste, et celui-ci serait le moins complet — la faute
                          que la carte boissons de `/pilotage` a déjà coûtée. On adresse la carte
                          plutôt que de la dupliquer.
                          Le lien n'emporte PAS le profil : l'activer enverrait un `0xA9` à la
                          machine, et une navigation ne doit rien envoyer. */}
                      <a
                        className="discret iconBtn iconSeul"
                        href={`/#b${c.beverageId}`}
                        aria-label={t("editRecipe", { n: c.slot })}
                        title={t("editRecipeTitle")}
                      >
                        <Icone nom="reglages" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {edition?.kind === "custom" && (
              <Editeur
                edition={edition}
                setEdition={setEdition}
                busy={busy}
                onEcrire={() =>
                  demander({
                    question: t("confirmRename", { name: edition.name, cible: t("customSlot", { n: edition.index }) }),
                    detail: t("confirmRenameDetail"),
                    onConfirm: () => void ecrireNom(),
                  })
                }
                t={t}
                tc={tc}
              />
            )}
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
