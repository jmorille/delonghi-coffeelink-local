"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch, murl } from "../machine";
import Icone from "../icons";
import { useMachinePush } from "../events";
import { useConfirm } from "../confirm";
import ReglagesGrains, { type Bound, type Brouillon } from "../ReglagesGrains";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Slider } from "@/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/table";
import { Input } from "@/ui/input";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

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
  /**
   * Date d'écriture de la photo, `null` s'il n'y en a pas.
   *
   * Elle vient de la table `bean_images` et non du tableau mémorisé — voir `vueBeanPresets`
   * côté serveur. Elle sert aussi de **version** dans l'URL de la vignette : l'identifiant ne
   * change pas quand on remplace la photo, donc sans elle le navigateur resservirait l'ancienne.
   */
  imageAt: number | null;
}

/**
 * Le milieu d'une plage, pour amorcer une configuration neuve.
 *
 * Replié sur 1 tant que les bornes ne sont pas arrivées : la carte de création reste utilisable
 * avant la première réponse du serveur, et la valeur sera de toute façon revérifiée à
 * l'enregistrement, où c'est le serveur qui tranche.
 */
function milieu(b?: Bound): number {
  return b ? Math.round((b.min + b.max) / 2) : 1;
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
  /** Création en cours dans la carte « + », `null` quand elle est fermée. */
  const [nouveau, setNouveau] = useState<Brouillon | null>(null);
  /**
   * La configuration ouverte en édition : son identifiant et son brouillon.
   *
   * Un brouillon séparé de la fiche enregistrée, pour que « Annuler » soit un vrai retour en
   * arrière — modifier l'objet de la liste rendrait l'annulation impossible sans le relire.
   */
  const [edition, setEdition] = useState<{ id: string; b: Brouillon } | null>(null);

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
  const memorise = async (
    src: { name: string | null; grinder: number; temperature: number; aroma: number },
    id?: string,
    /**
     * Trois valeurs, trois sens, et le serveur les distingue : absente, la photo ne bouge pas ;
     * `null`, elle est retirée ; une data URL, elle est remplacée. Sans le `null` explicite,
     * retirer une photo demanderait de supprimer la configuration entière.
     */
    image?: string | null,
  ) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beanpresets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name: src.name ?? "",
          grinder: src.grinder,
          temperature: src.temperature,
          aroma: src.aroma,
          ...(image === undefined ? {} : { image }),
        }),
      }).then((x) => x.json());
      if (r.error) setMsg({ text: tc("error", { message: r.error }), kind: "err" });
      else {
        dire(t("presetSaved", { name: r.preset.name || t("unnamed") }));
        setNouveau(null);
        setEdition(null);
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * L'URL de la vignette d'une configuration.
   *
   * `murl` et pas un chemin écrit à la main : un `<img>` échappe à `mfetch`, et sans le paramètre
   * de machine le navigateur demanderait l'image de la machine **par défaut du serveur**.
   */
  const urlPhoto = (p: Preset) => murl(`/api/beanpresets/image?id=${encodeURIComponent(p.id)}&v=${p.imageAt}`);

  /**
   * Le brouillon d'une configuration neuve : le milieu de chaque plage.
   *
   * Un milieu plutôt qu'un minimum — le minimum est une valeur extrême que personne ne veut, et
   * la donner comme point de départ ferait croire à un réglage lu quelque part.
   */
  const vide = (): Brouillon => ({
    name: "",
    grinder: milieu(data?.bounds.grinder),
    temperature: milieu(data?.bounds.temperature),
    aroma: milieu(data?.bounds.aroma),
  });

  /**
   * Ouvre une fiche en édition. `image` est laissée **absente** : tant qu'on n'y touche pas, la
   * photo enregistrée ne doit pas bouger, et c'est ce que l'absence signifie de bout en bout —
   * ici, dans `PhotoGrains`, et dans le champ `image` que reçoit le serveur.
   */
  const editer = (p: Preset) =>
    setEdition({ id: p.id, b: { name: p.name, grinder: p.grinder, temperature: p.temperature, aroma: p.aroma } });

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
        <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy || !!data?.scan} onClick={scan}>
          <Icone nom="lire" />
          <span className="lbl">{data?.scan ? t("scanning") : t("scan")}</span>
        </Button>
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
              <Button type="button" variant="neutre" size="commande" key={i} className="iconBtn" disabled={busy} onClick={() => read(i)}>
                <Icone nom="lire" />
                <span className="lbl">{t("readIndex", { index: i })}</span>
              </Button>
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
                  <Badge variant="marche" title={t("activeHint")}>
                    {t("activeBadge")}
                  </Badge>
                )}
                {bs.visible === false && <Badge variant="arret">{t("hiddenBadge")}</Badge>}
                {bs.isToggle && (
                  <Badge variant="arret" title={t("toggleHint")}>
                    {t("toggleBadge")}
                  </Badge>
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
                <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => read(bs.index)}>
                  <Icone nom="lire" />
                  <span className="lbl">{tc("read")}</span>
                </Button>
                {!bs.isToggle && (
                  <>
                    {/* La coche, comme « Activer » sur /profils : le grain retenu par la machine.
                        C'est le meme geste sur un autre objet, donc le meme dessin. */}
                    <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy || bs.active === true} onClick={() => activate(bs.index)} title={t("activateTitle")}>
                      <Icone nom="choisir" />
                      <span className="lbl">{bs.active ? t("alreadyActive") : t("activate")}</span>
                    </Button>
                    {/* Le crayon : « Configurer » ouvre l'editeur du bas sur ce grain, il ne
                        configure rien tout seul. */}
                    <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => pick(bs)}>
                      <Icone nom="modifier" />
                      <span className="lbl">{selected === bs.index ? t("editing") : t("configure")}</span>
                    </Button>
                    <Button type="button" variant="neutre" size="coquille" className="iconBtn" disabled={busy} onClick={() => memorise(bs)} title={t("presetSaveTitle")}>
                      <Icone nom="ecrire" taille={14} />
                      <span className="lbl">{t("presetSave")}</span>
                    </Button>
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
      {!data?.presets.length && <p className="sub">{t("presetsEmpty")}</p>}
      {/* `align-items: start` sur `.cards` : sans lui une carte courte s'étire à la hauteur de la
          plus grande de sa ligne, ce qui laisse des blancs et fait croire à une donnée manquante. */}
      <div className="cards dense">
        {(data?.presets ?? []).map((p) => {
          const enEdition = edition?.id === p.id;
          return (
            <div className={`card${enEdition ? " open" : ""}`} key={p.id}>
              <div className="cardHead">
                {/* La vignette est DANS le titre, pas à côté : `.cardHead` étire son premier enfant,
                    donc une image posée en frère du titre lui volerait sa colonne. En édition elle
                    disparaît du titre — la photo est alors montrée en grand dans le formulaire, et
                    c'est là qu'on la remplace. */}
                <h3 className="cardTitle titreLigne">
                  {/* `loading`/`decoding` : contrairement aux dessins de boissons, ces photos
                      sortent de la base par l'API, une par profil, dans une liste qui descend
                      sous le pli — c'est le cas où le report change quelque chose. */}
                  {!enEdition && p.imageAt !== null && (
                    <img src={urlPhoto(p)} alt="" className="bevVignette" loading="lazy" decoding="async" />
                  )}
                  <span>{enEdition ? edition.b.name || p.name || t("unnamed") : p.name || t("unnamed")}</span>
                </h3>
                <span className="sub num">
                  {new Date(p.at).toLocaleDateString("fr-FR")}
                </span>
              </div>

              {enEdition ? (
                <>
                  <ReglagesGrains
                    prefixe={p.id}
                    valeur={edition.b}
                    bounds={data?.bounds}
                    apercu={p.imageAt !== null ? urlPhoto(p) : null}
                    disabled={busy}
                    onChange={(b) => setEdition({ id: p.id, b })}
                  />
                  <div className="row note">
                    {/* Rien ne part vers la machine : on enregistre une fiche locale. */}
                    <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => void memorise(edition.b, p.id, edition.b.image)}>
                      <Icone nom="ecrire" taille={14} />
                      <span className="lbl">{t("presetApply")}</span>
                    </Button>
                    <Button type="button" variant="neutre" size="coquille"  disabled={busy} onClick={() => setEdition(null)}>{tc("cancel")}</Button>
                  </div>
                </>
              ) : (
                <>
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
                  {/* Écrire dans un emplacement : l'index 0 est écarté, ce n'est pas un café.
                      **Ces puces restent sans icone, et c'est un choix.** Leur libelle est un numero
                      d'emplacement — deux caracteres, donc pas un « bouton a texte long » que l'icone
                      viendrait remplacer. Et elles vont par cinq : le meme glyphe repete cinq fois de
                      suite n'ajoute aucune information, il elargit une rangee de 25 px par puce. Ce que
                      l'icone dirait ici, la phrase qui les introduit le dit une fois pour toutes.

                      **Elles ne sont rendues qu'en dehors de l'édition** : elles écrivent sur la
                      machine, et les offrir pendant qu'on modifie proposerait d'écrire des valeurs
                      qui ne sont pas encore enregistrées. */}
                  <div className="row">
                    <span className="sub">{t("presetWriteTo")}</span>
                    {(data?.beans.filter((x) => !x.isToggle) ?? []).map((x) => (
                      <Button type="button" variant="neutre" size="coquille" key={x.index}  disabled={busy} onClick={() => ecrire(p, x.index)} title={t("presetWriteTitle", { index: x.index, current: x.name || t("unnamed") })}>
                        #{x.index}
                      </Button>
                    ))}
                  </div>
                  <div className="row note">
                    <Button type="button" variant="neutre" size="coquille" className="iconBtn" disabled={busy} onClick={() => editer(p)}>
                      <Icone nom="modifier" taille={14} />
                      <span className="lbl">{tc("edit")}</span>
                    </Button>
                    <Button type="button" variant="arret" size="coquille" className="iconBtn" disabled={busy} onClick={() => oublie(p)}>
                      <Icone nom="corbeille" taille={14} />
                      <span className="lbl">{t("presetForget")}</span>
                    </Button>
                  </div>
                </>
              )}
            </div>
          );
        })}

        {/* ------------------------------------------ créer une configuration de toutes pièces.
            **Une carte dans la grille, pas un bouton flottant** : c'est le motif de `/recettes`.
            Un seul objet visuel par chose, et le même geste pour créer que pour modifier — d'où le
            MÊME formulaire que celui d'une fiche ouverte en édition, `ReglagesGrains`. */}
        <div className={`card${nouveau ? " open" : ""}`} key="nouvelle">
          {!nouveau ? (
            <>
              <div className="cardHead">
                <div className="titreLigne">
                  <h3 className="cardTitle">{t("presetNew")}</h3>
                </div>
                <div className="row actions">
                  <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => setNouveau(vide())}>
                    <Icone nom="ajouter" />
                    <span className="lbl">{tc("new")}</span>
                  </Button>
                </div>
              </div>
              <p className="sub">{t("presetNewHint")}</p>
            </>
          ) : (
            <>
              <div className="cardHead">
                {/* Le titre suit la saisie, et retombe sur « Nouvelle configuration » tant qu'il
                    n'y a pas de nom — jamais sur un nom emprunté ailleurs. */}
                <h3 className="cardTitle">{nouveau.name || t("presetNew")}</h3>
              </div>
              <ReglagesGrains
                prefixe="nouvelle"
                valeur={nouveau}
                bounds={data?.bounds}
                disabled={busy}
                onChange={setNouveau}
              />
              <div className="row note">
                {/* Rien ne part vers la machine : c'est la bibliothèque locale qu'on enrichit.
                    L'écriture dans un emplacement reste la puce « #n » de la carte créée. */}
                <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => void memorise(nouveau, undefined, nouveau.image)}>
                  <Icone nom="ecrire" taille={14} />
                  <span className="lbl">{t("presetCreate")}</span>
                </Button>
                <Button type="button" variant="neutre" size="coquille"  disabled={busy} onClick={() => setNouveau(null)}>{tc("cancel")}</Button>
              </div>
            </>
          )}
        </div>
      </div>

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
                <Input id="ft" className="w-[4.6rem] flex-none text-right" type="number" min={0} max={120} value={flowTime} onChange={(e) => setFlowTime(Number(e.target.value))} />
              </div>
              <div>
                <label htmlFor="crema">{t("crema")}</label>
                <Select value={String(crema)} onValueChange={(v) => setCrema(Number(v))}>
                  <SelectTrigger id="crema" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{t("crema1")}</SelectItem>
                    <SelectItem value="2">{t("crema2")}</SelectItem>
                    <SelectItem value="3">{t("crema3")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="taste">{t("taste")}</label>
                <Select value={String(taste)} onValueChange={(v) => setTaste(Number(v))}>
                  <SelectTrigger id="taste" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{t("taste1")}</SelectItem>
                    <SelectItem value="2">{t("taste2")}</SelectItem>
                    <SelectItem value="3">{t("taste3")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={simulate}>
                <Icone nom="reglages" />
                <span className="lbl">{t("simulate")}</span>
              </Button>
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
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("setting")}</TableHead>
                      <TableHead>{t("current")}</TableHead>
                      <TableHead>{t("delta")}</TableHead>
                      <TableHead>{t("proposed")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>{t("grinder")}</TableCell>
                      <TableCell className="num">{draft.grinder}</TableCell>
                      <TableCell className="num">{fmtDelta(sim.deltas.grinder)}</TableCell>
                      <TableCell className="num">{sim.grinder}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>{t("temperature")}</TableCell>
                      <TableCell className="num">{draft.temperature}</TableCell>
                      <TableCell className="num">{fmtDelta(sim.deltas.temperature)}</TableCell>
                      <TableCell className="num">{sim.temperature}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>{t("aroma")}</TableCell>
                      <TableCell className="num">{draft.aroma}</TableCell>
                      <TableCell className="num">{fmtDelta(sim.deltas.aroma)}</TableCell>
                      <TableCell className="num">{sim.aroma}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                </div>
                {sim.notes.map((n) => (
                  <p className="legende" key={n}>
                    {t.has(`note_${n}`) ? t(`note_${n}`) : n}
                  </p>
                ))}
                <div className="row note">
                  {/* La coche, encore : retenir ce que la regle propose. Rien ne part vers la
                      machine ici — les valeurs descendent dans l'editeur juste en dessous. */}
                  <Button type="button" variant="marche" size="commande" className="iconBtn" disabled={!sim.changed} onClick={applySim}>
                    <Icone nom="choisir" />
                    <span className="lbl">{sim.changed ? t("applyToDraft") : t("nothingToChange")}</span>
                  </Button>
                </div>
              </div>
            )}
          </div>

          <h2>{t("manualHeading")}</h2>
          <div className="card">
            <div className="row">
              <div>
                <label htmlFor="bname">{t("name")}</label>
                <Input id="bname" value={draft.name} maxLength={20} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
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
                  <Slider
                    min={bound.min}
                    max={bound.max}
                    value={[draft[key]]}
                    aria-label={`${t(key)} (${bound.min}–${bound.max})`}
                    onValueChange={([v]) => setDraft({ ...draft, [key]: v })}
                  />
                  <span className="sub num">
                    {bound.max}
                  </span>
                  <Input
                    className="w-[4.6rem] flex-none text-right"
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
              {/* **La disquette passe a l'autre bouton, et c'est une correction.** Elle etait ici,
                  sur l'ecriture qui part vers l'appareil, alors que /recipes venait d'etablir la
                  regle inverse : la disquette garde en local, la machine nomme la destination. Les
                  deux boutons sont voisins dans cette rangee — « ecrire sur la machine » et
                  « memoriser sans ecrire » — donc c'est exactement l'endroit ou la confusion
                  coute quelque chose : l'un est definitif sur l'appareil, l'autre non. */}
              <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => save(true)}>
                <Icone nom="machine" />
                <span className="lbl">{t("writeToMachine")}</span>
              </Button>
              {/* Mémoriser le brouillon sans rien écrire sur la machine : c'est ce qui permet
                  d'essayer un réglage, de le garder, et de revenir à l'ancien. */}
              <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => memorise(draft)} title={t("presetSaveTitle")}>
                <Icone nom="ecrire" />
                <span className="lbl">{t("presetSaveDraft")}</span>
              </Button>
              <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => pick(bean)}>
                <Icone nom="reinitialiser" />
                <span className="lbl">{tc("reset")}</span>
              </Button>
              <Button type="button" variant="discret-arret" size="commande" className="iconBtn" disabled={busy} onClick={() => save(false)} title={t("deleteTitle")}>
                <Icone nom="corbeille" />
                <span className="lbl">{t("delete")}</span>
              </Button>
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
