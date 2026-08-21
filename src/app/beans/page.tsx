"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import Icone from "../icons";
import { useMachinePush } from "../events";
import { useConfirm } from "../confirm";

interface Bean {
  index: number;
  name: string | null;
  grinder: number;
  temperature: number;
  aroma: number;
  at: number;
  isToggle: boolean;
  /** Octet 50 de la trame 0xBA : le grain sélectionné sur la machine. */
  active: boolean | null;
  /** Octet 49 : profil non supprimé. */
  visible: boolean | null;
}
interface Bound {
  min: number;
  max: number;
  verified: boolean;
}
/**
 * Configuration mémorisée **par le serveur**, pas par la machine.
 *
 * La machine n'a que six emplacements, dont un qui n'est pas un café, et les écraser fait perdre le
 * réglage précédent. Cette bibliothèque garde un réglage par café, sans occuper d'emplacement.
 */
interface Preset {
  id: string;
  name: string;
  grinder: number;
  temperature: number;
  aroma: number;
  createdAt?: number;
  at: number;
}
interface Payload {
  beans: Bean[];
  presets: Preset[];
  bounds: { grinder: Bound; aroma: Bound; temperature: Bound };
  activeProfile: number;
  scan: { next: number; to: number } | null;
}
interface Simulation {
  grinder: number;
  temperature: number;
  aroma: number;
  deltas: { grinder: number; temperature: number; aroma: number };
  changed: boolean;
  notes: string[];
  error?: string;
}

/** Réglages en cours d'édition pour un profil. */
interface Draft {
  name: string;
  grinder: number;
  temperature: number;
  aroma: number;
}

/**
 * Bean Adapt : les configurations de grains de la machine (mouture, température, arôme).
 *
 * **L'état arrive poussé** (`/api/events`). Une lecture `0xBA` n'est pas synchrone : le POST rend
 * la main dès l'annonce, et c'est la machine qui pousse la valeur deux à quatre secondes plus tard.
 * Cette page attendait avec un `setTimeout(refresh, 6000)` après une lecture et un
 * `setInterval(refresh, 3000)` pendant un balayage — deux minuteurs qui ne pouvaient que se
 * tromper : trop tôt ils montraient l'état d'avant, trop tard ils faisaient attendre pour rien.
 *
 * Désormais on relit `/api/beanadapt` quand le serveur signale que la machine a écrit quelque
 * chose (`importedAt` bouge, ou une lecture vient de se terminer), et à ce moment-là seulement.
 */
export default function Beans() {
  const t = useTranslations("beanAdapt");
  const tc = useTranslations("common");
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Compte rendu de la dernière action.
   *
   * Il s'affichait dans un `<p className="warn">` — le bandeau d'avertissement ambre — quel que
   * soit son contenu : « Configuration mémorisée » et « Erreur : … » dans la même boîte d'alerte.
   * `.status` sépare les deux et porte `role="status"`, sinon rien n'est annoncé.
   */
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const dire = (text: string) => setMsg({ text, kind: "ok" });
  const rendre = (r: any, ok: string) =>
    setMsg(r.error ? { text: tc("error", { message: r.error }), kind: "err" } : { text: ok, kind: "ok" });
  const { demander, dialogue } = useConfirm();
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [flowTime, setFlowTime] = useState(15);
  const [crema, setCrema] = useState(2);
  const [taste, setTaste] = useState(2);
  const [sim, setSim] = useState<Simulation | null>(null);

  const refresh = useCallback(async () => {
    setData(await mfetch("/api/beanadapt").then((r) => r.json()));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // La règle « quand relire » vit dans `useMachinePush` : trois pages la partagent.
  const { live, busy: pending } = useMachinePush(refresh);

  // Repli : si le flux n'a pas pu s'établir, on retombe sur une scrutation — mais seulement
  // pendant qu'un balayage tourne, et en le disant.
  const scanning = !!data?.scan;
  useEffect(() => {
    if (live || !scanning) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [live, scanning, refresh]);

  const bean = data?.beans.find((b) => b.index === selected) ?? null;

  /** Lit un profil sur la machine (commande 0xBA) puis rafraîchit. */
  const read = async (index: number) => {
    setBusy(true);
    setMsg(null);
    try {
      await mfetch("/api/beansystem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      // Pas de minuteur : la valeur arrivera quand la machine l'aura poussée, et le flux nous le
      // dira. C'est exactement ce que le `setTimeout(refresh, 6000)` d'avant essayait de devimer.
      dire(t("readQueued", { index }));
    } finally {
      setBusy(false);
    }
  };

  /** Balaye les index 0..5 : une commande 0xBA par grain, enchaînées côté serveur. */
  const scan = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beanadapt/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: 0, to: 5 }),
      }).then((x) => x.json());
      rendre(r, t("scanStarted", { from: r.from, to: r.to }));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Mémorise les réglages d'un grain de la machine dans la bibliothèque locale. Aucune trame : on
   * envoie au serveur des valeurs qu'on a déjà à l'écran.
   */
  const memorise = async (src: { name: string | null; grinder: number; temperature: number; aroma: number }, id?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beanpresets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: src.name ?? "", grinder: src.grinder, temperature: src.temperature, aroma: src.aroma }),
      }).then((x) => x.json());
      if (r.error) setMsg({ text: tc("error", { message: r.error }), kind: "err" });
      else {
        dire(t("presetSaved", { name: r.preset.name || t("unnamed") }));
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const oublie = (p: Preset) =>
    demander({ question: t("presetForgetConfirm", { name: p.name || t("unnamed") }), onConfirm: () => void oublieConfirme(p) });

  const oublieConfirme = async (p: Preset) => {
    setBusy(true);
    try {
      await mfetch(`/api/beanpresets?id=${encodeURIComponent(p.id)}`, { method: "DELETE" });
      dire(t("presetForgotten", { name: p.name || t("unnamed") }));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Écrit une configuration mémorisée dans un emplacement de la machine (trame `0xBB`).
   *
   * **Écriture persistante** : elle remplace le réglage de cet emplacement. D'où la confirmation qui
   * nomme l'emplacement écrasé — et l'index 0 est exclu, ce n'est pas un café.
   */
  const ecrire = (p: Preset, index: number) => {
    const cible = data?.beans.find((x) => x.index === index);
    demander({
      question: t("presetWriteConfirm", { name: p.name || t("unnamed"), index, current: cible?.name || t("unnamed") }),
      warn: t("persistentWarning"),
      onConfirm: () => void ecrireConfirme(p, index),
    });
  };

  const ecrireConfirme = async (p: Preset, index: number) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beanadapt/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index, name: p.name, grinder: p.grinder, temperature: p.temperature, aroma: p.aroma, visible: true }),
      }).then((x) => x.json());
      rendre(r, t("presetWritten", { name: p.name || t("unnamed"), index }));
    } finally {
      setBusy(false);
    }
  };

  const pick = (b: Bean) => {
    setSelected(b.index);
    setDraft({ name: b.name ?? "", grinder: b.grinder, temperature: b.temperature, aroma: b.aroma });
    setSim(null);
    setMsg(null);
  };

  /** Rejoue la règle Bean Adapt côté serveur — aucune écriture, aucun appel au cloud. */
  const simulate = async () => {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    try {
      const r: Simulation = await mfetch("/api/beanadapt/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, flowTime, crema, taste }),
      }).then((x) => x.json());
      if (r.error) setMsg({ text: tc("error", { message: r.error }), kind: "err" });
      else setSim(r);
    } finally {
      setBusy(false);
    }
  };

  const applySim = () => {
    if (!sim || !draft) return;
    setDraft({ ...draft, grinder: sim.grinder, temperature: sim.temperature, aroma: sim.aroma });
    setSim(null);
  };

  /** Écrit le profil dans la machine (0xBB). Modification persistante. */
  const save = (visible = true) => {
    if (!draft || selected == null) return;
    demander({
      // La mise en garde était collée à la question par deux retours à la ligne, faute d'un
      // endroit pour la mettre : `window.confirm()` n'a qu'un seul champ. Le dialogue en a trois.
      question: visible
        ? t("confirmSave", { index: selected, name: draft.name || t("unnamed"), grinder: draft.grinder, temperature: draft.temperature, aroma: draft.aroma })
        : t("confirmDelete", { index: selected }),
      warn: t("persistentWarning"),
      onConfirm: () => void saveConfirme(visible),
    });
  };

  const saveConfirme = async (visible: boolean) => {
    if (!draft || selected == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beanadapt/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: selected, ...draft, visible }),
      }).then((x) => x.json());
      rendre(r, t("saveSent"));
      setTimeout(refresh, 8000);
    } finally {
      setBusy(false);
    }
  };

  /** Sélectionne ce Bean System comme actif sur la machine (0xB9). */
  const activate = (index: number) =>
    demander({ question: t("confirmActivate", { index }), onConfirm: () => void activateConfirme(index) });

  const activateConfirme = async (index: number) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "selectBean", beanId: index }),
      }).then((x) => x.json());
      rendre(r, t("activateSent"));
    } finally {
      setBusy(false);
    }
  };

  const b = data?.bounds;

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      {/* Ce que le flux nous dit de l'activité de la machine. Sans ça, une lecture demandée n'a
          aucune trace à l'écran entre le clic et l'arrivée de la valeur. */}
      {pending && <p className="sub">{t("pushWaiting")}</p>}
      {!live && <p className="sub">{tc("pushOff")}</p>}

      {/* **Ce n'est pas un avertissement.** « Calcul local, sans le cloud » est la bonne nouvelle
          de cette page : le questionnaire ne sort pas du réseau. Elle portait pourtant `card warn`,
          la teinte ambre que le reste du produit emploie pour la mise en garde — et depuis que
          l'avertissement se reconnaît aussi à son triangle, une boîte ambre sans triangle ne veut
          plus rien dire. Une carte ordinaire, dont le titre suffit. */}
      <div className="card">
        <strong>{t("localTitle")}</strong>
        <div className="legende">
          {t("localDetail")}
        </div>
      </div>

      <h2>{t("profilesHeading")}</h2>
      {/* Une carte pour une phrase et un bouton : le gabarit tenait lieu de composition. C'est une
          barre d'actions, elle vit sous le titre de section sans conteneur à elle. */}
      <div className="cardHead barreActions">
        <span className="sub">{t("scanNote")}</span>
        <button className="primary" disabled={busy || !!data?.scan} onClick={scan}>
          {data?.scan ? t("scanning") : t("scan")}
        </button>
      </div>
      {!data ? (
        <p className="sub">{tc("loading")}</p>
      ) : !data.beans.length ? (
        <div className="card">
          <p className="sub">
            {t("noneRead")}
          </p>
          <div className="row note">
            {[0, 1, 2, 3].map((i) => (
              <button key={i} disabled={busy} onClick={() => read(i)}>
                {t("readIndex", { index: i })}
              </button>
            ))}
          </div>
        </div>
      ) : (
        // Une carte par emplacement. La grille aligne les valeurs d'une carte à l'autre, ce que la
        // disposition en pleine largeur ne permettait pas : on comparait mal deux grains.
        // `alignItems: start` évite qu'une carte courte s'étire à la hauteur de la plus grande de sa
        // ligne, ce qui laisserait des blancs et ferait croire à une donnée manquante.
        <div className="cards dense">
          {data.beans.map((bs) => (
            <div className="card" key={bs.index}>
              <div className="cardHead">
                {/* Le nom d'un emplacement de grain : un titre, pas une mise en gras. Les deux
                    grilles de cette page — six emplacements machine, N configurations mémorisées —
                    n'avaient aucun titre de carte, donc rien à parcourir au lecteur d'écran, là où
                    l'accueil donne un `<h3>` à chacune de ses 28 cartes de boisson. */}
                <h3 className="cardTitle">{bs.name ?? t("unnamed")}</h3>
                <span className="sub num">
                  #{bs.index}
                </span>
              </div>
              <div className="row serre note">
                {bs.active && (
                  <span className="pill on" title={t("activeHint")}>
                    {t("activeBadge")}
                  </span>
                )}
                {bs.visible === false && <span className="pill off">{t("hiddenBadge")}</span>}
                {bs.isToggle && (
                  <span className="pill off" title={t("toggleHint")}>
                    {t("toggleBadge")}
                  </span>
                )}
              </div>
              {!bs.isToggle && (
                <div className="chapeau">
                  <div className="kv">
                    <span className="k">{t("grinder")}</span>
                    <span className="num">{bs.grinder}</span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("temperature")}</span>
                    <span className="num">{bs.temperature}</span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("aroma")}</span>
                    <span className="num">{bs.aroma}</span>
                  </div>
                </div>
              )}
              <div className="row">
                <button disabled={busy} onClick={() => read(bs.index)}>
                  {tc("read")}
                </button>
                {!bs.isToggle && (
                  <>
                    <button disabled={busy || bs.active === true} onClick={() => activate(bs.index)} title={t("activateTitle")}>
                      {bs.active ? t("alreadyActive") : t("activate")}
                    </button>
                    <button className="primary" disabled={busy} onClick={() => pick(bs)}>
                      {selected === bs.index ? t("editing") : t("configure")}
                    </button>
                    <button className="mini" disabled={busy} onClick={() => memorise(bs)} title={t("presetSaveTitle")}>
                      {t("presetSave")}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------------------------ la bibliothèque locale */}
      <h2>{t("presetsHeading")}</h2>
      <p className="sub">{t("presetsIntro")}</p>
      {!data?.presets.length ? (
        <div className="card">
          <p className="sub">
            {t("presetsEmpty")}
          </p>
        </div>
      ) : (
        // `alignItems: start` : sans lui une carte courte s'étire à la hauteur de la plus grande de
        // sa ligne, ce qui laisse des blancs et fait croire à une donnée manquante.
        <div className="cards dense">
          {data.presets.map((p) => (
            <div className="card" key={p.id}>
              <div className="cardHead">
                <h3 className="cardTitle">{p.name || t("unnamed")}</h3>
                <span className="sub num">
                  {new Date(p.at).toLocaleDateString("fr-FR")}
                </span>
              </div>
              <div className="chapeau">
                <div className="kv">
                  <span className="k">{t("grinder")}</span>
                  <span className="num">{p.grinder}</span>
                </div>
                <div className="kv">
                  <span className="k">{t("temperature")}</span>
                  <span className="num">{p.temperature}</span>
                </div>
                <div className="kv">
                  <span className="k">{t("aroma")}</span>
                  <span className="num">{p.aroma}</span>
                </div>
              </div>
              {/* Écrire dans un emplacement : l'index 0 est écarté, ce n'est pas un café. */}
              <div className="row">
                <span className="sub">{t("presetWriteTo")}</span>
                {(data?.beans.filter((x) => !x.isToggle) ?? []).map((x) => (
                  <button key={x.index} className="mini" disabled={busy} onClick={() => ecrire(p, x.index)} title={t("presetWriteTitle", { index: x.index, current: x.name || t("unnamed") })}>
                    #{x.index}
                  </button>
                ))}
              </div>
              <div className="row note">
                <button className="mini" disabled={busy} onClick={() => memorise({ name: p.name, grinder: p.grinder, temperature: p.temperature, aroma: p.aroma }, p.id)} title={t("presetUpdateTitle")}>
                  {t("presetUpdate")}
                </button>
                <button className="mini danger" disabled={busy} onClick={() => oublie(p)}>
                  {t("presetForget")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && bean && b && (
        <>
          <h2>{t("assistantHeading", { name: bean.name ?? t("unnamed") })}</h2>
          <div className="card">
            <p className="sub">
              {t("assistantIntro")}
            </p>

            <div className="row">
              <div>
                <label htmlFor="ft">{t("flowTime")}</label>
                <input id="ft" className="numField" type="number" min={0} max={120} value={flowTime} onChange={(e) => setFlowTime(Number(e.target.value))} />
              </div>
              <div>
                <label htmlFor="crema">{t("crema")}</label>
                <select id="crema" value={crema} onChange={(e) => setCrema(Number(e.target.value))}>
                  <option value={1}>{t("crema1")}</option>
                  <option value={2}>{t("crema2")}</option>
                  <option value={3}>{t("crema3")}</option>
                </select>
              </div>
              <div>
                <label htmlFor="taste">{t("taste")}</label>
                <select id="taste" value={taste} onChange={(e) => setTaste(Number(e.target.value))}>
                  <option value={1}>{t("taste1")}</option>
                  <option value={2}>{t("taste2")}</option>
                  <option value={3}>{t("taste3")}</option>
                </select>
              </div>
              <button className="primary" disabled={busy} onClick={simulate}>
                {t("simulate")}
              </button>
            </div>

            {flowTime >= 10 && flowTime < 20 ? (
              <p className="sub">
                {t("windowOk")}
              </p>
            ) : (
              <p className="sub">
                {t("windowOut")}
              </p>
            )}

            {sim && (
              <div className="blocSuite">
                <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("setting")}</th>
                      <th>{t("current")}</th>
                      <th>{t("delta")}</th>
                      <th>{t("proposed")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{t("grinder")}</td>
                      <td className="num">{draft.grinder}</td>
                      <td className="num">{fmtDelta(sim.deltas.grinder)}</td>
                      <td className="num">{sim.grinder}</td>
                    </tr>
                    <tr>
                      <td>{t("temperature")}</td>
                      <td className="num">{draft.temperature}</td>
                      <td className="num">{fmtDelta(sim.deltas.temperature)}</td>
                      <td className="num">{sim.temperature}</td>
                    </tr>
                    <tr>
                      <td>{t("aroma")}</td>
                      <td className="num">{draft.aroma}</td>
                      <td className="num">{fmtDelta(sim.deltas.aroma)}</td>
                      <td className="num">{sim.aroma}</td>
                    </tr>
                  </tbody>
                </table>
                </div>
                {sim.notes.map((n) => (
                  <p className="legende" key={n}>
                    {t.has(`note_${n}`) ? t(`note_${n}`) : n}
                  </p>
                ))}
                <div className="row note">
                  <button className="good" disabled={!sim.changed} onClick={applySim}>
                    {sim.changed ? t("applyToDraft") : t("nothingToChange")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <h2>{t("manualHeading")}</h2>
          <div className="card">
            <div className="row">
              <div>
                <label htmlFor="bname">{t("name")}</label>
                <input id="bname" value={draft.name} maxLength={20} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
            </div>
            <p className="legende">
              {t("nameHint")}
            </p>

            {(
              [
                ["grinder", b.grinder],
                ["temperature", b.temperature],
                ["aroma", b.aroma],
              ] as const
            ).map(([key, bound]) => (
              <div className="paramRow" key={key}>
                <span className="nom">
                  {t(key)}
                  {!bound.verified && (
                    <span className="sub" title={t("unverifiedHint")}>
                      {" "}
                      ({t("unverified")})
                    </span>
                  )}
                </span>
                <div className="ctl">
                  <span className="sub num">
                    {bound.min}
                  </span>
                  <input
                    type="range"
                    min={bound.min}
                    max={bound.max}
                    value={draft[key]}
                    aria-label={`${t(key)} (${bound.min}–${bound.max})`}
                    onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
                  />
                  <span className="sub num">
                    {bound.max}
                  </span>
                  <input
                    className="numField"
                    type="number"
                    min={bound.min}
                    max={bound.max}
                    value={draft[key]}
                    onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
                  />
                </div>
              </div>
            ))}

            <div className="row note">
              <button className="primary iconBtn" disabled={busy} onClick={() => save(true)}>
                <Icone nom="ecrire" />
                <span className="lbl">{t("writeToMachine")}</span>
              </button>
              {/* Mémoriser le brouillon sans rien écrire sur la machine : c'est ce qui permet
                  d'essayer un réglage, de le garder, et de revenir à l'ancien. */}
              <button disabled={busy} onClick={() => memorise(draft)} title={t("presetSaveTitle")}>
                {t("presetSaveDraft")}
              </button>
              <button className="iconBtn" disabled={busy} onClick={() => pick(bean)}>
                <Icone nom="reinitialiser" />
                <span className="lbl">{tc("reset")}</span>
              </button>
              <button className="danger discret" disabled={busy} onClick={() => save(false)} title={t("deleteTitle")}>
                {t("delete")}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Permanent, jamais monté à la demande : un conteneur inséré en même temps que son texte
          n'est pas annoncé par les lecteurs d'écran. Vide, `.status:empty` le masque. */}
      <p className={"status " + (msg?.kind === "err" ? "err" : "ok")} role="status">
        {msg?.text ?? ""}
      </p>
      {dialogue}
    </>
  );
}

const fmtDelta = (d: number) => (d === 0 ? "—" : d > 0 ? `+${d}` : String(d));
