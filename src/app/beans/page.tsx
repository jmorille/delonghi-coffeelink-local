"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch, murl } from "../machine";
import Icone from "../icons";
import { useMachinePush } from "../events";
import { useConfirm } from "../confirm";
import ReglagesGrains, { type Bound, type Brouillon } from "../ReglagesGrains";
import CarteGrain from "../CarteGrain";
import AffinageDialog from "../AffinageDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

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
  /**
   * **Le visuel de cet emplacement, et il ne vient pas de la machine.**
   *
   * Ni la torréfaction ni la photo ne sont dans la trame `0xBA` — l'appareil n'en garde aucune
   * trace. Ce sont nos deux informations à nous, servies avec la liste par `/api/beanadapt` et
   * rangées côté serveur sous l'INDEX de l'emplacement. Conséquence dite dans l'interface : changer
   * de paquet sur la machine sans le renommer laisse l'ancien visuel en place.
   */
  roast: number | null;
  /** Date d'écriture de la photo, `null` s'il n'y en a pas. Sert aussi de version dans l'URL. */
  imageAt: number | null;
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
  /** Niveau de torréfaction déclaré, 1 (clair) à 4 (foncé), `null` s'il ne l'est pas. */
  roast: number | null;
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

/**
 * Ce que la MACHINE mesure pour l'affinage — `d260_beansystem_sync_par`, mots 2 et 5.
 *
 * L'écoulement n'est pas une réponse au questionnaire : c'est un relevé de l'appareil. Le taper au
 * clavier, comme cette page le demandait, revenait à remplacer une mesure par un souvenir. Le
 * compteur d'espressos qui l'accompagne est le verrou de l'app officielle — sous le seuil, la
 * mesure porte sur trop peu de tasses pour dire quoi que ce soit de la mouture.
 *
 * Tout est `null` tant que la propriété n'est pas arrivée : « pas encore lu » n'est pas « zéro ».
 */
interface Sync {
  at: number | null;
  ecoulementMs: number | null;
  /** Les secondes tronquées, comme l'app les calcule. C'est l'unité du questionnaire. */
  ecoulementS: number | null;
  espressos: number | null;
  seuil: number;
  /** `null` quand le compteur est inconnu — ne pas savoir n'est pas refuser. */
  permis: boolean | null;
}
interface Payload {
  beans: Bean[];
  presets: Preset[];
  bounds: { grinder: Bound; aroma: Bound; temperature: Bound };
  activeProfile: number;
  scan: { next: number; to: number } | null;
  sync: Sync;
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
 *
 * ## Deux grilles d'affiches qui se retournent
 *
 * Les deux grilles — six emplacements de la machine, N configurations mémorisées — passent par
 * `CarteGrain` : **face avant l'affiche** (le visuel à la largeur de la carte, le nom, les marques,
 * une seule commande), **dos tout le reste**. Une seule grammaire pour les deux, parce qu'elles
 * montrent le même objet ; deux composants divergeraient au premier ajustement.
 *
 * ⚠️ **Un seul dos ouvert par grille, et l'état qui le dit est celui de l'ÉDITION.** Pour un
 * emplacement c'est `selected` + `draft`, pour une fiche c'est `edition` : retourner la carte, c'est
 * ouvrir son brouillon, et il n'y a donc rien de plus à retenir. Un troisième état « quelle carte est
 * retournée » aurait pu se désynchroniser du brouillon qu'il est censé accompagner.
 *
 * ⚠️ **Le formulaire du bas a disparu, et c'est le fond de la refonte.** `/beans` avait deux
 * éditeurs pour le même objet : les cartes en haut, un « Réglage manuel » en pleine largeur en bas,
 * avec ses propres curseurs. Deux copies du même formulaire, avec la conséquence que ce dépôt écrit
 * partout ailleurs — une amélioration atterrissait sur l'un et pas sur l'autre. Il ne reste que
 * l'**assistant**, qui n'est pas un éditeur mais un calcul : il propose des valeurs, et elles
 * descendent dans le brouillon de la carte ouverte.
 *
 * ⚠️ **Cet assistant a quitté le bas de page à son tour, pour un dialogue** (`AffinageDialog`). La
 * raison n'est pas la place : déplié, il montrait ses trois champs d'un coup, donc il ne disait
 * pas dans quel ORDRE s'y prendre — or on ne juge pas le goût d'une tasse qu'on n'a pas tirée. Le
 * parcours en quatre étapes est celui de l'application officielle. Et la règle du bloc précédent
 * tient toujours : il n'existe qu'UNE implémentation du questionnaire, avec deux portes vers elle
 * — la commande de l'affiche du grain actif, et un bouton au dos de chaque emplacement.
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
  /**
   * L'emplacement machine dont le dos est ouvert, et son brouillon.
   *
   * Les deux vont ensemble : `selected` sans `draft` serait une carte retournée sur un formulaire
   * vide, `draft` sans `selected` un brouillon sans destination. C'est aussi `draft` qui reçoit ce
   * que le dialogue d'affinage propose — d'où l'ouverture de la carte AVEC le dialogue.
   */
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<Brouillon | null>(null);
  /**
   * L'emplacement dont le dialogue d'affinage est ouvert, `null` quand il est fermé.
   *
   * Un index et non un booléen : le dialogue doit savoir QUEL grain il règle, et le déduire de
   * `selected` marcherait jusqu'au jour où l'on ouvrirait l'affinage sans ouvrir la carte.
   */
  const [affinage, setAffinage] = useState<number | null>(null);
  /** Création en cours dans la carte « + », `null` quand elle est fermée. */
  const [nouveau, setNouveau] = useState<Brouillon | null>(null);
  /**
   * La configuration mémorisée dont le dos est ouvert, et son brouillon.
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
    src: { name: string | null; grinder: number; temperature: number; aroma: number; roast?: number | null },
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
          /* Toujours envoyée, `null` compris — contrairement à l'image, dont l'absence veut dire
             « ne touche pas ». Voir `Brouillon.roast` : un entier part avec sa fiche. */
          roast: src.roast ?? null,
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
   * L'URL de la photo d'un emplacement de la machine. Route distincte, espace de noms distinct
   * (`s<index>` côté serveur) : un `b3` et un `s3` ne désignent pas le même objet.
   */
  const urlPhotoSlot = (bs: Bean) => murl(`/api/beans/visual/image?index=${bs.index}&v=${bs.imageAt}`);

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
    /* Pas de torréfaction par défaut : les trois réglages ont un milieu de plage plausible, un
       niveau de torréfaction n'en a pas. En proposer un ferait croire à une donnée lue. */
    roast: null,
  });

  /**
   * Ouvre une fiche en édition. `image` est laissée **absente** : tant qu'on n'y touche pas, la
   * photo enregistrée ne doit pas bouger, et c'est ce que l'absence signifie de bout en bout —
   * ici, dans `PhotoGrains`, et dans le champ `image` que reçoit le serveur.
   */
  const editer = (p: Preset) =>
    setEdition({ id: p.id, b: { name: p.name, grinder: p.grinder, temperature: p.temperature, aroma: p.aroma, roast: p.roast } });

  /**
   * Enregistre le visuel d'un emplacement machine. **Aucune trame** : c'est une écriture locale,
   * donc pas de confirmation — rien de physique, rien de persistant sur l'appareil.
   *
   * ⚠️ **Séparé de l'écriture des réglages, sur le même dos.** Les deux gestes portent sur le même
   * brouillon mais ne vont pas au même endroit : le visuel dans notre base, les trois réglages dans
   * la machine en trame `0xBB`. Un seul bouton pour les deux ferait d'un changement de photo une
   * écriture persistante sur l'appareil, à confirmer comme telle.
   */
  const enregistrerVisuel = async (index: number, v: Brouillon) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beans/visual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          index,
          roast: v.roast,
          ...(v.image === undefined ? {} : { image: v.image }),
        }),
      }).then((x) => x.json());
      if (r.error) setMsg({ text: tc("error", { message: r.error }), kind: "err" });
      else {
        // Dire ce qui s'est passé, et pas seulement « enregistré » : retirer le dernier élément
        // d'un visuel le fait disparaître, ce qui se lit comme une perte si rien ne le nomme.
        dire(
          r.roast === null && r.imageAt === null
            ? t("slotVisualCleared", { index })
            : t("slotVisualSaved", { index }),
        );
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * **Rapatrie la photo qu'un grain a dans le cloud De'Longhi.**
   *
   * Le seul geste de cette page qui sorte du réseau local, et deux raisons de le confirmer plutôt
   * que de l'exécuter : il interroge le compte De'Longhi, et il **écrase** la photo locale de cet
   * emplacement — les deux vivent sous la même clé, parce qu'il n'y a qu'une chose à montrer.
   *
   * Le compte rendu nomme ce qui est arrivé au lieu de dire « importé » : une photo absente du
   * cloud est le cas NORMAL d'un grain auquel personne n'en a donné (l'app affiche alors sa propre
   * illustration), et le taire ferait lire ce cas comme une panne.
   */
  const importerCloud = (bs: Bean) =>
    demander({
      question: t("cloudImportConfirm", { index: bs.index, name: bs.name || t("unnamed") }),
      warn: t("cloudImportWarn"),
      onConfirm: () => void importerCloudConfirme(bs),
    });

  const importerCloudConfirme = async (bs: Bean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/beans/visual/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: bs.index }),
      }).then((x) => x.json());
      if (r.error) {
        setMsg({ text: tc("error", { message: r.error }), kind: "err" });
        return;
      }
      /* `statut` est un identifiant de protocole, pas un libellé : il est en ASCII et ne se
         traduit pas — c'est la règle du dépôt pour tout ce qui traverse l'API. Le texte affiché
         vient d'ici, du catalogue. */
      const releve = r.releves?.[0];
      if (releve?.statut === "imported") {
        dire(t("cloudImportDone", { index: bs.index, ko: Math.round(releve.octets / 1024) }));
      } else if (releve?.statut === "absent") {
        dire(t("cloudImportNone", { index: bs.index }));
      } else {
        // « refusée » ou « erreur » : le serveur dit pourquoi, et c'est ce qu'on montre.
        setMsg({ text: tc("error", { message: releve?.erreur ?? t("cloudImportUnknown") }), kind: "err" });
      }
      await refresh();
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
      setEdition(null);
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
      /* **Les trois valeurs sont nommées, et c'est ce qui a remplacé une légende.** Ces puces
         écrivent les valeurs ENREGISTRÉES de la fiche, pas le brouillon ouvert juste au-dessus —
         un piège réel, qui était signalé par un paragraphe de deux lignes sur la carte. Un
         paragraphe qu'on peut ne pas lire ; un dialogue qui annonce « mouture 5, température 3,
         arôme 4 » se compare tout seul à ce qu'on a sous les yeux. */
      question: t("presetWriteConfirm", {
        name: p.name || t("unnamed"),
        index,
        current: cible?.name || t("unnamed"),
        grinder: p.grinder,
        temperature: p.temperature,
        aroma: p.aroma,
      }),
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

  /**
   * Ouvre le dos d'un emplacement : son brouillon part des valeurs lues sur la machine, **et de son
   * visuel**.
   *
   * `image` reste **absente**, comme pour une fiche mémorisée : tant qu'on n'y touche pas la photo
   * enregistrée ne doit pas bouger, et l'absence est ce que `PhotoGrains` et le serveur entendent
   * tous les deux par là.
   */
  /** Le relevé de la machine, ou `null` avant la première arrivée de `d260`. */
  const mesure = data?.sync ?? null;

  const pick = (b: Bean) => {
    setSelected(b.index);
    setDraft({ name: b.name ?? "", grinder: b.grinder, temperature: b.temperature, aroma: b.aroma, roast: b.roast });
    setMsg(null);
  };

  /**
   * **« Affiner vos paramètres de grains » — la commande de l'app officielle, ouverte en dialogue.**
   *
   * Sur l'affiche du grain ACTIF, elle remplace « Déjà actif », qui était un bouton mort à cet
   * endroit précis : la seule carte dont on ne pouvait rien faire depuis l'affiche était justement
   * celle sur laquelle on veut agir. Le dos de n'importe quel emplacement porte la même commande.
   *
   * `pick` accompagne l'ouverture parce que le parcours se termine en versant ses valeurs dans un
   * brouillon : sans carte ouverte, « Reprendre ces valeurs » n'aurait aucune destination.
   */
  const affiner = (b: Bean) => {
    pick(b);
    setAffinage(b.index);
  };

  /**
   * Ce que le parcours d'affinage rend, versé dans le brouillon ouvert.
   *
   * **Rien ne part vers la machine ici.** L'écriture reste au dos de la carte, derrière sa propre
   * confirmation — un questionnaire qui finirait par écrire dans l'appareil ferait d'un calcul une
   * action physique, sans que la dernière étape ne l'annonce jamais.
   */
  const appliquerAffinage = (v: { grinder: number; temperature: number; aroma: number }) => {
    setDraft((d) => (d ? { ...d, ...v } : d));
    setMsg({ text: t("refineApplied"), kind: "ok" });
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
        body: JSON.stringify({
          index: selected,
          name: draft.name,
          grinder: draft.grinder,
          temperature: draft.temperature,
          aroma: draft.aroma,
          visible,
        }),
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

  /**
   * Les marques d'un emplacement. `null` quand il n'y en a aucune, pour que la rangée ne soit pas
   * rendue du tout : une rangée vide de 22 px sous le nom se lit comme un alignement manqué.
   */
  const marquesBean = (bs: Bean) => {
    const p = [];
    if (bs.active) p.push(<Badge variant="marche" key="a" title={t("activeHint")}>{t("activeBadge")}</Badge>);
    if (bs.visible === false) p.push(<Badge variant="arret" key="h">{t("hiddenBadge")}</Badge>);
    if (bs.isToggle) p.push(<Badge variant="arret" key="t" title={t("toggleHint")}>{t("toggleBadge")}</Badge>);
    return p.length ? <div className="row serre note">{p}</div> : null;
  };

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
      <Card>
        <strong>{t("localTitle")}</strong>
        <div className="legende">
          {t("localDetail")}
        </div>
      </Card>

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
        <Card>
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
        </Card>
      ) : (
        // Une grille d'affiches. Son minimum est plus large que celui des autres grilles du produit
        // (`.cards.grains`) parce que l'affiche prend la largeur de la carte et que le dos est un
        // formulaire : la raison est écrite dans `surfaces.css`.
        <div className="cards grains">
          {data.beans.map((bs) => {
            /* ⚠️ **L'index 0 ne se retourne pas.** Ce n'est pas un café : c'est l'interrupteur
               « Bean Adapt » de la machine. Il n'a ni grain, ni paquet, ni photo — lui donner une
               affiche décrirait un objet qui n'existe pas, et lui donner un dos offrirait de régler
               une mouture qu'il n'a pas. Il garde donc la fiche minimale : ce qu'il est, et la
               lecture qui le rafraîchit. */
            if (bs.isToggle) {
              return (
                <Card key={bs.index}>
                  <div className="cardHead">
                    <h3 className="cardTitle">{bs.name ?? t("unnamed")}</h3>
                    <span className="sub num">#{bs.index}</span>
                  </div>
                  {marquesBean(bs)}
                  <div className="row note">
                    <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => read(bs.index)}>
                      <Icone nom="lire" />
                      <span className="lbl">{tc("read")}</span>
                    </Button>
                  </div>
                </Card>
              );
            }
            const ouvert = selected === bs.index && draft !== null;
            const apercu = bs.imageAt !== null ? urlPhotoSlot(bs) : null;
            return (
              <CarteGrain
                key={bs.index}
                idDos={`dos-emplacement-${bs.index}`}
                titre={bs.name ?? t("unnamed")}
                repere={`#${bs.index}`}
                photo={apercu}
                roast={bs.roast}
                marques={marquesBean(bs)}
                ouvert={ouvert}
                onBasculer={() => {
                  if (ouvert) {
                    setSelected(null);
                    setDraft(null);
                  } else pick(bs);
                }}
                /* **L'unique commande de l'affiche — et elle n'est pas la même sur le grain actif.**
                   Partout ailleurs c'est la coche, comme « Activer » sur /profils : le grain que la
                   machine retient, le même geste sur un autre objet, donc le même dessin.

                   Sur le grain ACTIF, cette coche n'était qu'un « Déjà actif » désactivé : la seule
                   carte dont l'affiche n'offrait rien était justement celle qu'on veut régler. Elle
                   porte donc « Affiner vos paramètres », la commande que l'app officielle met au
                   même endroit — et sous le seuil d'espressos, elle porte le décompte plutôt qu'un
                   refus muet. Voir `affinagePermis`. */
                commande={
                  bs.active === true && !bs.isToggle ? (
                    <Button
                      type="button"
                      variant="neutre"
                      size="commande"
                      className="iconBtn"
                      disabled={busy || mesure?.permis === false}
                      onClick={() => affiner(bs)}
                      title={mesure?.permis === false ? t("refineLockedHint", { seuil: mesure.seuil }) : t("refineTitle")}
                    >
                      <Icone nom="reglages" />
                      <span className="lbl">
                        {mesure?.permis === false
                          ? t("refineLocked", { reste: Math.max(0, mesure.seuil - (mesure.espressos ?? 0)) })
                          : t("refine")}
                      </span>
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="neutre"
                      size="commande"
                      className="iconBtn"
                      disabled={busy || bs.active === true}
                      onClick={() => activate(bs.index)}
                      title={t("activateTitle")}
                    >
                      <Icone nom="choisir" />
                      <span className="lbl">{bs.active ? t("alreadyActive") : t("activate")}</span>
                    </Button>
                  )
                }
                dos={
                  ouvert &&
                  draft && (
                    <>
                      <ReglagesGrains
                        prefixe={`slot${bs.index}`}
                        valeur={draft}
                        bounds={data.bounds}
                        apercu={apercu}
                        disabled={busy}
                        onChange={setDraft}
                      />

                      {/* **Trois groupes, deux frontières, et elles ne sont pas décoratives.** Ce
                          dos porte des gestes qui ne vont pas au même endroit : le visuel reste
                          dans cette maison ; les réglages partent dans l'appareil ; l'import sort
                          du réseau local. Mis dans une seule rangée ils se liraient comme des
                          variantes du même bouton.

                          ⚠️ **Les trois phrases qui expliquaient ces frontières sont passées sur les
                          boutons.** Elles faisaient neuf lignes dans une colonne de 20 rem, entre des
                          rangées de commandes qu'elles séparaient plus qu'elles n'éclairaient. Ce qui
                          les remplace n'est PAS l'infobulle seule — un doigt ne survole rien : ce qui
                          engage l'appareil est porté par le dialogue de confirmation, qui s'affiche
                          partout et que ce dépôt a déjà désigné comme l'endroit de la mise en garde.
                          L'infobulle ne garde que le pourquoi. */}
                      <div className="row note">
                        <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} title={t("slotVisualHint")} onClick={() => void enregistrerVisuel(bs.index, draft)}>
                          <Icone nom="ecrire" taille={14} />
                          <span className="lbl">{t("slotVisualSave")}</span>
                        </Button>
                        <Button type="button" variant="neutre" size="coquille" className="iconBtn" disabled={busy} title={t("cloudImportTitle")} onClick={() => importerCloud(bs)}>
                          <Icone nom="nuage" taille={14} />
                          <span className="lbl">{t("cloudImport")}</span>
                        </Button>
                      </div>

                      <div className="blocSuite">
                        <div className="row note">
                          {/* La machine nomme la destination : c'est elle qu'on écrit, en trame
                              `0xBB`, et c'est persistant. */}
                          <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} title={t("writeToMachineTitle")} onClick={() => save(true)}>
                            <Icone nom="machine" />
                            <span className="lbl">{t("writeToMachine")}</span>
                          </Button>
                          {/* La disquette garde en local : elle crée une fiche dans la
                              bibliothèque du bas, sans rien envoyer. */}
                          <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => memorise(draft, undefined, draft.image)} title={t("presetSaveTitle")}>
                            <Icone nom="ecrire" />
                            <span className="lbl">{t("presetSave")}</span>
                          </Button>
                        </div>
                        <div className="row note">
                          <Button type="button" variant="neutre" size="coquille" className="iconBtn" disabled={busy} onClick={() => read(bs.index)}>
                            <Icone nom="lire" taille={14} />
                            <span className="lbl">{tc("read")}</span>
                          </Button>
                          <Button type="button" variant="neutre" size="coquille" className="iconBtn" disabled={busy} onClick={() => pick(bs)}>
                            <Icone nom="reinitialiser" taille={14} />
                            <span className="lbl">{tc("reset")}</span>
                          </Button>
                          <Button type="button" variant="discret-arret" size="coquille" className="iconBtn" disabled={busy} onClick={() => save(false)} title={t("deleteTitle")}>
                            <Icone nom="corbeille" taille={14} />
                            <span className="lbl">{t("delete")}</span>
                          </Button>
                        </div>
                        {/* **La seconde porte vers l'affinage, et elle est la raison pour laquelle
                            le dialogue n'appartient pas au grain actif.**

                            L'affiche ne porte « Affiner » que sur le grain sélectionné : partout
                            ailleurs sa commande unique reste « Activer ». Sans ce bouton-ci, les
                            cinq autres emplacements perdraient l'assistant qu'ils avaient quand il
                            était déplié en bas de page — une fonctionnalité retirée par un
                            déménagement, ce qui est la façon la plus discrète de casser une page.

                            Le questionnaire y est le même à une chose près, dite dans le dialogue :
                            l'écoulement mesuré ne décrit QUE la dernière tasse, donc que le grain
                            actif. Sur un autre emplacement, il faut le saisir. */}
                        <div className="row note">
                          <Button type="button" variant="neutre" size="coquille" className="iconBtn" disabled={busy} title={t("refineTitle")} onClick={() => affiner(bs)}>
                            <Icone nom="reglages" taille={14} />
                            <span className="lbl">{t("refine")}</span>
                          </Button>
                        </div>
                      </div>
                    </>
                  )
                }
              />
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------ la bibliothèque locale */}
      <h2>{t("presetsHeading")}</h2>
      <p className="sub">{t("presetsIntro")}</p>
      {!data?.presets.length && <p className="sub">{t("presetsEmpty")}</p>}
      {/* **La même grammaire que les emplacements, et c'est le point.** Les deux grilles montrent le
          même objet — un café et ses trois réglages — donc la même affiche et le même demi-tour. Une
          seule différence, et elle vient du produit : une fiche mémorisée n'est dans aucun
          emplacement, donc sa face avant ne porte AUCUNE commande machine. « Activer » demanderait
          d'abord de dire lequel écraser ; les puces `#1…#5` sont au dos, avec leur confirmation. */}
      <div className="cards grains">
        {(data?.presets ?? []).map((p) => {
          const enEdition = edition?.id === p.id;
          const apercu = p.imageAt !== null ? urlPhoto(p) : null;
          return (
            <CarteGrain
              key={p.id}
              idDos={`dos-fiche-${p.id}`}
              titre={p.name || t("unnamed")}
              repere={new Date(p.at).toLocaleDateString("fr-FR")}
              photo={apercu}
              roast={p.roast}
              ouvert={enEdition}
              onBasculer={() => (enEdition ? setEdition(null) : editer(p))}
              dos={
                enEdition && edition ? (
                  <>
                    <ReglagesGrains
                      prefixe={p.id}
                      valeur={edition.b}
                      bounds={data?.bounds}
                      apercu={apercu}
                      disabled={busy}
                      onChange={(v) => setEdition({ id: p.id, b: v })}
                    />
                    <div className="row note">
                      {/* Rien ne part vers la machine : on enregistre une fiche locale. */}
                      <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => void memorise(edition.b, p.id, edition.b.image)}>
                        <Icone nom="ecrire" taille={14} />
                        <span className="lbl">{t("presetApply")}</span>
                      </Button>
                      <Button type="button" variant="neutre" size="coquille" disabled={busy} onClick={() => setEdition(null)}>{tc("cancel")}</Button>
                    </div>

                    {/* Écrire dans un emplacement : l'index 0 est écarté, ce n'est pas un café.
                        **Ces puces restent sans icone, et c'est un choix.** Leur libelle est un
                        numero d'emplacement — deux caracteres, donc pas un « bouton a texte long »
                        que l'icone viendrait remplacer. Et elles vont par cinq : le meme glyphe
                        repete cinq fois de suite n'ajoute aucune information, il elargit une rangee
                        de 25 px par puce. Ce que l'icone dirait ici, la phrase qui les introduit le
                        dit une fois pour toutes.

                        ⚠️ **Elles écrivent les valeurs ENREGISTRÉES, pas le brouillon ouvert.**
                        C'est `p` qu'elles envoient, et la confirmation le rappelle. Auparavant elles
                        étaient masquées pendant l'édition pour éviter l'ambiguïté ; le dos unique
                        les remet sous les yeux, donc c'est la phrase qui doit la lever. */}
                    <div className="blocSuite">
                      <div className="row">
                        <span className="sub">{t("presetWriteTo")}</span>
                        {(data?.beans.filter((x) => !x.isToggle) ?? []).map((x) => (
                          <Button type="button" variant="neutre" size="coquille" key={x.index} disabled={busy} onClick={() => ecrire(p, x.index)} title={t("presetWriteTitle", { index: x.index, current: x.name || t("unnamed") })}>
                            #{x.index}
                          </Button>
                        ))}
                      </div>
                      <div className="row note">
                        <Button type="button" variant="arret" size="coquille" className="iconBtn" disabled={busy} onClick={() => oublie(p)}>
                          <Icone nom="corbeille" taille={14} />
                          <span className="lbl">{t("presetForget")}</span>
                        </Button>
                      </div>
                    </div>
                  </>
                ) : null
              }
            />
          );
        })}

        {/* ------------------------------------------ créer une configuration de toutes pièces.
            **Une carte dans la grille, pas un bouton flottant** : c'est le motif de `/recettes`.
            Un seul objet visuel par chose, et le même geste pour créer que pour modifier — d'où le
            MÊME formulaire que celui d'un dos ouvert, `ReglagesGrains`.

            ⚠️ **Elle ne se retourne pas, et il n'y a rien à retourner** : une configuration qui
            n'existe pas encore n'a pas d'affiche. Elle prend donc la rangée entière (`.open`), comme
            l'éditeur de recette, plutôt que de faire semblant d'être une carte de grain. */}
        <Card className={nouveau ? "open" : undefined} key="nouvelle">
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
                    L'écriture dans un emplacement reste la puce « #n » du dos de la carte créée. */}
                <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={() => void memorise(nouveau, undefined, nouveau.image)}>
                  <Icone nom="ecrire" taille={14} />
                  <span className="lbl">{t("presetCreate")}</span>
                </Button>
                <Button type="button" variant="neutre" size="coquille"  disabled={busy} onClick={() => setNouveau(null)}>{tc("cancel")}</Button>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* **Le parcours d'affinage, dans son propre dialogue.** Il vivait ici, dépliée en pleine
          largeur : trois champs sur une rangée, un bouton, un tableau. Tout visible d'un coup, donc
          rien ne disait dans quel ORDRE s'y prendre — or l'ordre est la moitié du sens ici. Le
          composant porte le pourquoi en détail ; ce qui compte à cet endroit-ci, c'est qu'il n'y a
          plus qu'UNE implémentation du questionnaire, et que la page n'en garde aucune copie. */}
      <AffinageDialog
        ouvert={affinage !== null}
        onFermer={() => setAffinage(null)}
        grain={data?.beans.find((x) => x.index === affinage) ?? null}
        mesure={mesure}
        profileId={data?.activeProfile ?? 1}
        demander={demander}
        onAppliquer={appliquerAffinage}
      />

      {/* Permanent, jamais monté à la demande : un conteneur inséré en même temps que son texte
          n'est pas annoncé par les lecteurs d'écran. Vide, `.status:empty` le masque. */}
      <p className={"status " + (msg?.kind === "err" ? "err" : "ok")} role="status">
        {msg?.text ?? ""}
      </p>
      {dialogue}
    </>
  );
}

