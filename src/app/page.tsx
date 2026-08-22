"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useCategoryLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";
import IMAGES from "@/lib/beverage-images.json";
import { mfetch } from "./machine";
import { useMachinePush } from "./events";
import Icone from "./icons";
import Alerte from "./Alerte";
import { useConfirm } from "./confirm";
import { cleAnnonce, echecAnnonce } from "./register";
// Le libelle d etat de la machine est partage avec /pilotage : voir machineState.ts.
import { AGE_PERIME, AGE_PROGRESSION, fmtAge, sensorLabel, splitSensors, stateLabel, stepLabel, type HasTranslator, type Translator } from "./machineState";

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
  /** Nom SAISI sur la machine, s'il y en a un. C'est lui que réécrit une écriture d'icône. */
  machineName: string | null;
  /**
   * Index 0-19 de l'image, tel que la machine le stocke (octet 20 du bloc `0xAA`) — vérifié
   * dans le code de l'app, voir le commentaire de `/api/beverages` côté serveur. Non nul pour
   * les seules recettes perso nommées.
   */
  icon: number | null;
  /** Emplacement perso 1-6. Le serveur le calcule ; ne pas le redériver de `id` ici. */
  customSlot: number | null;
}
interface Status {
  /** Configuration du serveur. `lanKeySet` faux = aucun pilotage possible, il faut le dire. */
  config: { lanKeySet: boolean; serverIpProblem: string | null };
  /**
   * La machine que cette page pilote réellement. Elle DOIT être affichée : le sélecteur de la
   * barre de navigation est masqué en mono-machine, donc sans ça la page ne nomme jamais
   * l'appareil auquel elle envoie des commandes physiques.
   */
  machine: { id: string; label: string } | null;
  session: { active: boolean };
  /** Dernier profil que le serveur a demandé à la machine. */
  activeProfile: number;
  /** Faux si le serveur n'a imposé aucun profil depuis son démarrage : l'état machine est inconnu. */
  activeProfileConfirmed: boolean;
  /** `dispense` : la tâche en cours est une préparation — la seule qu'« Arrêter » puisse couper. */
  program: { active: boolean; label: string; counter: number; dispense?: boolean } | null;
  lastMonitor: {
    at: number;
    stateByte: number;
    switches: { name: string; label: string }[];
    alarmBits: number;
    /**
     * Progression de la préparation — octets 9, 10, 11 de la trame monitor. `auRepos` (`f=7,e=0`)
     * est le **seul** signal de fin fiable : relevé sur la machine, un lait chaud s'arrête à 90 %
     * puis retombe au repos sans jamais publier 100.
     */
    fonction?: number | null;
    etape?: number | null;
    pourcent?: number | null;
    etapeCle?: string | null;
    auRepos?: boolean | null;
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
/**
 * Où ranger le compte rendu d'une action : la carte machine, ou la carte d'une boisson.
 *
 * Un message unique en haut de page ne pouvait pas marcher : « Préparer » sur la 22e boisson
 * répondait à 3 000 px du doigt, hors écran. L'utilisateur remontait la page pour savoir si son
 * geste avait compté — sur un produit dont le principe est qu'un « envoyé » qui n'est pas parti
 * est le pire défaut possible.
 */
type Scope = "power" | `bev:${number}`;
const bevScope = (id: number): Scope => `bev:${id}`;

/**
 * Report avant d'imposer un profil à la machine, en millisecondes.
 *
 * Assez long pour absorber un parcours de la liste déroulante aux flèches — un `select` fermé émet
 * un `change` par valeur traversée — et assez court pour qu'un choix délibéré ne paraisse pas
 * ignoré. Ce n'est pas un anti-rebond de confort : chaque `change` non absorbé serait une trame
 * 0xA9 de plus vers un appareil réel.
 */
const DELAI_PROFIL = 400;
interface Report {
  scope: Scope;
  text: string;
  kind: "ok" | "err";
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
  const unitLabel = useUnitLabel();
  const [data, setData] = useState<Payload | null>(null);
  const [profile, setProfile] = useState(1);
  /**
   * Verrou d'envoi. Il reste **unique** — la machine n'a qu'une file de commandes, et deux
   * commandes concurrentes désynchronisent la session — mais il porte désormais sa cible, pour que
   * le bouton pressé soit le seul à s'annoncer occupé. Auparavant un booléen global grisait les
   * 88 boutons de la page sans dire pourquoi ni où regarder.
   */
  const [pending, setPending] = useState<Scope | null>(null);
  const busy = pending !== null;
  const [open, setOpen] = useState<number | null>(null);
  /**
   * **`/#b230` ouvre la carte de cette boisson.** Les emplacements perso sont modifiables ici et
   * nulle part ailleurs — leur recette est une recette comme une autre, avec les mêmes bornes du
   * modèle et les mêmes valeurs du profil — mais on les CONSULTE depuis `/profils`, qui n'en
   * montrait que le nom. Plutôt qu'un second éditeur là-bas (l'erreur que la carte boissons de
   * `/pilotage` a déjà coûtée), la page d'accueil se laisse adresser.
   *
   * Une seule fois : `data` est rafraîchi à chaque événement de la machine, et rouvrir la carte à
   * chaque fois rouvrirait celle que l'utilisateur vient de fermer. Le profil, lui, n'est PAS
   * imposé par le lien — le sélectionner enverrait un `0xA9` à la machine, et une navigation ne
   * doit rien envoyer.
   */
  const ancreFaite = useRef(false);
  useEffect(() => {
    if (ancreFaite.current || !data) return;
    const m = /^#b(\d+)$/.exec(window.location.hash);
    if (!m) { ancreFaite.current = true; return; }
    const id = Number(m[1]);
    if (!data.beverages.some((b) => b.id === id)) { ancreFaite.current = true; return; }
    ancreFaite.current = true;
    setOpen(id);
    // Après la peinture : la carte n'existe pas encore quand cet effet part.
    requestAnimationFrame(() => document.getElementById(`b${id}`)?.scrollIntoView({ block: "center" }));
  }, [data]);
  const [report, setReport] = useState<Report | null>(null);
  // Le dialogue est partagé (`confirm.tsx`) : cinq autres pages en avaient besoin.
  const { demander: setAsk, dialogue } = useConfirm();
  const [status, setStatus] = useState<Status | null>(null);
  const [lastDispensed, setLastDispensed] = useState<Beverage | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const profileInitialised = useRef(false);
  /** Le report d'activation du profil ; voir `selectProfileAndActivate`. */
  const profilDiffere = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Un report en vol au démontage enverrait une commande depuis une page qu'on a quittée.
  useEffect(() => () => { if (profilDiffere.current) clearTimeout(profilDiffere.current); }, []);
  /**
   * **Un chargement qui échoue est un état, pas un silence.**
   *
   * Mesuré, serveur injoignable : la page affichait « Chargement du catalogue… » indéfiniment,
   * pendant que douze rejets de promesse non traités partaient en console toutes les trois
   * secondes — et la carte machine, elle, offrait cinq boutons de profil actifs comme si la
   * commande pouvait aboutir. Un produit dont le principe est qu'un « envoyé » qui n'est pas
   * parti est le pire défaut possible ne peut pas rester muet quand c'est son propre serveur qui
   * ne répond plus.
   *
   * Deux états distincts, parce que les deux situations n'appellent pas la même phrase : le
   * serveur ne répond pas du tout (rien ne partira, il n'y a rien à corriger côté machine), ou
   * le catalogue seul n'a pas pu être relu (le reste de la page vaut encore).
   */
  const [serveurMuet, setServeurMuet] = useState(false);
  const [erreurCatalogue, setErreurCatalogue] = useState<string | null>(null);
  /** Les noms de profils n'ont pas pu être demandés — distinct de « pas encore lus sur la machine ». */
  const [echecProfils, setEchecProfils] = useState(false);

  /**
   * `mfetch`, pas `fetch` : un `fetch` nu vise la machine **par défaut du serveur**, pas celle qui
   * est sélectionnée. Avec deux machines de modèles différents, l'écran affichait le catalogue,
   * l'ordre des favoris, les bornes et les valeurs enregistrées de l'une pendant que « Préparer »
   * et « Écrire dans le profil » partaient sur l'autre — silencieusement, sans erreur.
   */
  const refresh = useCallback(async () => {
    try {
      const r = await mfetch(`/api/beverages?profile=${profile}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // `setData` seulement après un décodage réussi : une réponse HTML d'erreur fait échouer
      // `json()`, et écrire un `data` à moitié lu vaudrait moins que garder le précédent.
      const d = await r.json();
      setData(d);
      setErreurCatalogue(null);
      setServeurMuet(false);
    } catch (e) {
      setErreurCatalogue(raisonEchec(e, tc));
      if (injoignable(e)) setServeurMuet(true);
    }
  }, [profile, tc]);

  // Référence tenue à jour : la relance de présence doit consulter l'état COURANT, pas celui
  // capturé au montage de l'effet (qui est nul).
  const statusRef = useRef<Status | null>(null);
  const refreshStatus = useCallback(async () => {
    try {
      const r = await mfetch("/api/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = await r.json();
      statusRef.current = s;
      setStatus(s);
      setServeurMuet(false);
    } catch (e) {
      // On GARDE le dernier état connu : il est daté, la carte le dit déjà, et l'effacer
      // remplacerait une information vieille de trente secondes par aucune information.
      if (injoignable(e)) setServeurMuet(true);
    }
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
      mfetch("/api/presence", { method: "POST" })
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
  const refreshProfiles = useCallback(async () => {
    try {
      const r = await mfetch("/api/profiles");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setProfiles(d.profiles ?? []);
      setEchecProfils(false);
    } catch {
      // Le `.catch(() => {})` d'avant était silencieux, et le repli annonçait alors « Noms non
      // lus — lancer un import sur la page Profils », c'est-à-dire une cause fausse et un geste
      // inutile : la machine n'était pas en cause, le serveur n'avait pas répondu.
      setEchecProfils(true);
    }
  }, []);
  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  /** Reprendre les trois chargements après un échec. Le bouton qui manquait. */
  const reessayer = useCallback(() => {
    setErreurCatalogue(null);
    refresh();
    refreshStatus();
    refreshProfiles();
  }, [refresh, refreshStatus, refreshProfiles]);

  // Au premier chargement, on part du profil que le serveur a réellement demandé à la machine,
  // pas d'un 1 arbitraire : sinon un rechargement de page mentirait sur le profil actif.
  // Ensuite c'est le clic de l'utilisateur qui commande (et il met le serveur à jour).
  useEffect(() => {
    if (profileInitialised.current || !status) return;
    profileInitialised.current = true;
    if (status.activeProfile) setProfile(status.activeProfile);
  }, [status]);

  useEffect(() => {
    // Un premier état, tout de suite : la relance de présence en fait un aussi, mais elle peut
    // échouer sans rien dire (`.catch`) et la page resterait alors sans aucun état.
    refreshStatus();
  }, [refreshStatus]);

  /**
   * **L'état arrive poussé.** Cette page tenait deux minuteurs, et c'était la surface la plus
   * chère du produit : mesuré à 1194×834 avec un processeur ralenti 6× — la tablette, pas ce
   * bureau — 60 requêtes et 490 ko par minute au repos, et surtout **3 094 ms de trames longues
   * en 15 s, dont 2 544 bloquantes**. Un cinquième du temps passé à redessiner 28 cartes et à
   * analyser 11,4 ko de catalogue pour retrouver exactement ce qui était déjà à l'écran.
   *
   * Les deux rappels ne posent pas la même question, et c'est pourquoi il en faut deux sur un
   * seul flux :
   *
   * - `refreshStatus` sur **toute** poussée : l'état machine, le monitor, la session et le profil
   *   actif ne sont pas des données écrites, rien ne les horodate ;
   * - `refresh` (le catalogue, 11,4 ko) uniquement quand `importedAt` bouge ou qu'une lecture
   *   s'achève — la règle partagée. C'est ce qui remplace l'interrogation à 2 s pendant un import.
   */
  const { live } = useMachinePush(refresh, refreshStatus);

  /**
   * Repli, et seulement en repli : si le flux ne s'établit pas, on revient aux deux minuteurs
   * d'avant. La cadence rapide est bien conditionnée à une fenêtre **vivante** — le drapeau
   * `active` seul ne retombait jamais sur une machine qui ne répond pas, ce qui figeait la page
   * à 2 s indéfiniment (corrigé côté serveur, `fenetreOuverte`).
   */
  const enCours = status?.program?.active === true || data?.import?.active === true;
  useEffect(() => {
    if (live) return;
    const t = setInterval(refreshStatus, enCours ? 2000 : 5000);
    return () => clearInterval(t);
  }, [live, enCours, refreshStatus]);
  useEffect(() => {
    if (live || !data?.import?.active) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [live, data?.import?.active, refresh]);

  /**
   * Chemin unique pour tout appel qui agit sur la machine.
   *
   * Trois choses qu'aucun des cinq gestionnaires ne faisait, et qui décident si l'utilisateur sait
   * ce qui s'est passé : le compte rendu est rangé sous une **cible**, donc il s'affiche dans la
   * carte qui a déclenché l'action ; le verrou porte la même cible, donc le bouton pressé
   * s'annonce occupé plutôt que de laisser la page griser en silence ; et un échec réseau est
   * rapporté — une exception laissait auparavant la page muette, ce qui est exactement le cas
   * « la commande n'est jamais partie et personne ne le sait ».
   */
  const commande = async (
    cible: Scope,
    chemin: string,
    corps: Record<string, unknown>,
    ok: (r: any) => string,
    apres?: () => Promise<void> | void,
  ): Promise<boolean> => {
    setPending(cible);
    setReport(null);
    try {
      const r = await mfetch(chemin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      }).then((x) => x.json());
      /**
       * **Une commande acceptée n'est pas une commande reçue.** La file est locale ; c'est
       * `local_reg` qui prévient la machine, et lui seul. Quand l'annonce échoue, la réponse le
       * dit (`register.ok === false`) et il faut le dire aussi — sinon la page annonce « Allumer
       * envoyé » à une cafetière qui n'a rien entendu, relevé sur la machine réelle.
       */
      const annonce = echecAnnonce(r);
      /**
       * **Un compte rendu de succès VIDE est un choix, pas un oubli.** Depuis que la barre de
       * progression existe, « Commande envoyée » ne dit rien de plus que ce que la machine montre
       * elle-même une seconde plus tard, et en dit moins. `ok` peut donc rendre une chaîne vide :
       * on n'affiche alors rien. Les deux cas d'ÉCHEC restent inconditionnels — en particulier
       * l'annonce non reçue, sans quoi la page se tairait à propos d'une cafetière qui n'a rien
       * entendu.
       */
      const texte = ok(r);
      setReport(
        r.error
          ? { scope: cible, text: tc("error", { message: r.error }), kind: "err" }
          : annonce
            ? { scope: cible, text: tc(cleAnnonce(annonce)), kind: "err" }
            : texte
              ? { scope: cible, text: texte, kind: "ok" }
              : null,
      );
      await apres?.();
      return !r.error && !annonce;
    } catch (e) {
      // `String(e)` donnait « TypeError: Failed to fetch » — le nom d'une classe JavaScript là où
      // l'utilisateur attend de savoir si son café part. Une panne de liaison a sa phrase.
      setReport({ scope: cible, text: raisonEchec(e, tc), kind: "err" });
      if (injoignable(e)) setServeurMuet(true);
      return false;
    } finally {
      setPending(null);
    }
  };

  const startImport = (what: "all" | "bounds" | "values", beverageIds?: number[]) =>
    commande(
      beverageIds?.length === 1 ? bevScope(beverageIds[0]) : "power",
      "/api/beverages/import",
      { profileId: profile, what, beverageIds },
      (r) => t("importQueued", { count: r.queued }),
      refresh,
    );

  const togglePower = (next: boolean) => {
    const verb = next ? tPower("turnOn") : tPower("turnOff");
    setAsk({
      question: tPower("confirmPower", { verb }),
      // Le rinçage est le seul avertissement de cette page qui décrit de l'eau bouillante qui
      // coule : il a sa propre place dans le dialogue, pas une concaténation en fin de phrase.
      warn: next ? tPower("rinseWarning") : undefined,
      // Allumer et éteindre sont le même geste — l'interrupteur — donc le même réglage. Le
      // dialogue reste tant que l'utilisateur ne l'a pas explicitement écarté.
      geste: "power",
      onConfirm: () =>
        commande("power", "/api/command", { action: next ? "on" : "off" }, (r) => tPower("powerSent", { label: r.program }), refreshStatus),
    });
  };

  /**
   * Arrêt d'une préparation en cours : même commande 0x83 que le lancement, mais mode STOPV2.
   *
   * La trame porte un beverageId. Quand cet onglet a lancé la boisson, on le connaît. Sinon on ne
   * le connaît pas — et le bouton est alors **désactivé** (`stopAvailable`) au lieu de deviner
   * l'espresso : arrêter une boisson devinée alors que rien ne coule n'est pas un arrêt, c'est une
   * commande au hasard. Le repli sur `1` ne sert plus que dans le seul cas où la machine signale
   * bien un programme dont nous ignorons la boisson, et la confirmation ne nomme alors rien.
   */
  const stopDispense = () => {
    const target = lastDispensed;
    setAsk({
      question: tPower("confirmStop", { beverage: target ? ` (${bevLabel(target)})` : "" }),
      // Le repli sur `1` (espresso) reste nécessaire — la trame d'arrêt porte un identifiant de
      // boisson — mais il n'a plus à être tacite : quand la machine signale un programme dont
      // nous ignorons la boisson, la confirmation le dit au lieu de laisser croire qu'on arrête
      // ce qui coule.
      detail: target ? undefined : tPower("stopUnknownBeverage"),
      onConfirm: () =>
        commande(
          "power",
          "/api/command",
          { action: "stop", beverageId: target?.id ?? 1, profileId: profile },
          () => tPower("stopSent"),
          refreshStatus,
        ),
    });
  };

  /**
   * Choisir un profil fait les deux : l'affichage bascule dessus, et la machine y bascule aussi
   * (trame 0xA9). Pas de confirmation : la commande est inoffensive — c'est la même trame que le
   * serveur envoie déjà comme « présence » pendant un réveil — et désigner un profil nommé est un
   * geste sans ambiguïté.
   *
   * **L'affichage change tout de suite, l'ordre part en différé, et c'est ce délai qui rend la
   * liste déroulante utilisable.** Une rangée de boutons ne pouvait produire qu'une valeur par
   * geste ; un `select` fermé, parcouru aux flèches, émet un `change` par valeur traversée — donc
   * un 0xA9 par valeur, sur un vrai appareil. Le report ramène le parcours à une seule commande,
   * celle sur laquelle on s'arrête. C'était l'objection qui avait fait écarter la liste déroulante,
   * et c'est elle qu'il fallait lever, pas contourner.
   */
  const selectProfileAndActivate = (id: number) => {
    setProfile(id);
    if (profilDiffere.current) clearTimeout(profilDiffere.current);
    profilDiffere.current = setTimeout(() => {
      profilDiffere.current = null;
      void commande(
        "power",
        "/api/command",
        { action: "selectProfile", profileId: id },
        () => tPower("profileActivated", { name: profileLabel(profiles, id) }),
        refreshStatus,
      );
    }, DELAI_PROFIL);
  };

  const dispense = async (bev: Beverage, override?: RecipeParam[]) => {
    /**
     * **La confirmation doit décrire la boisson qui part, pas une autre.**
     *
     * Le bouton de la carte construisait ses paramètres depuis `p.def` — le défaut du MODÈLE —
     * et n'ouvrait jamais `bev.values`, qui est ce que la machine a enregistré pour ce profil.
     * L'éditeur, dans la même carte, faisait l'inverse. Les deux boutons « Préparer » d'une même
     * carte pouvaient donc couler deux cafés différents, sous un dialogue qui nommait le profil
     * dans les deux cas. Relevé sur la machine : « Préparer « Espresso macchiato » (1 — Jérôme) ?
     * Café = 30 … » alors que 30 est la valeur d'usine.
     *
     * `valeurSure` tranche dans le bon ordre — valeur du profil, sinon défaut du modèle, sinon
     * rien — et rend la provenance avec la valeur. Ce qui n'a ni l'une ni l'autre est **omis** :
     * la machine renvoie 0 ou 255 pour un réglage jamais configuré (mug de voyage, recettes perso
     * vierges), et sans paramètre elle applique le sien, ce qui vaut mieux qu'un « Café = 0 ml ».
     */
    const params: RecipeParam[] = [];
    let duProfil = 0;
    if (override) params.push(...override);
    else {
      for (const p of beverageParams(bev)) {
        const sure = valeurSure(bev, p);
        if (!sure) continue;
        params.push({ id: p.id, value: sure.value });
        if (sure.from === "profil") duProfil++;
      }
    }
    const nomProfil = profileLabel(profiles, profile);
    // Dans une phrase, « pour 1 - Profil A » se lit mal : la question porte le couple numero-nom
    // entre parentheses, la phrase de provenance n'a besoin que du nom.
    const nomSeul = profiles.find((p) => p.id === profile)?.name ?? tc("profileNumbered", { id: profile });
    const source = override
      ? t("prepareFromEditor")
      : !params.length
        ? t("confirmPrepareDefaults")
        : duProfil === params.length
          ? t("prepareFromProfile", { profile: nomSeul })
          : duProfil
            ? t("prepareFromMixed", { count: duProfil, profile: nomSeul })
            : t("prepareFromModel");
    setAsk({
      question: t("confirmPrepare", { beverage: bevLabel(bev), profile: nomProfil }),
      // Les réglages lisibles avec leur unité, pas un vidage de huit couples `nom = nombre` dont
      // quatre ne sont pas des réglages d'utilisateur. La trame, elle, les porte tous.
      detail: resumeReglages(bev, params, paramLabel, unitLabel, (c) => t("confirmPrepareMore", { count: c })) || undefined,
      source,
      warn: t("confirmPrepareWarning"),
      geste: "dispense",
      onConfirm: async () => {
        const ok = await commande(
          bevScope(bev.id),
          "/api/command",
          { action: "dispense", beverageId: bev.id, profileId: profile, params },
          /**
           * **Rien à dire : la barre de progression le dit mieux.** « Commande "Préparer
           * Espresso" envoyée. Le détail technique est dans le journal » annonçait un envoi et
           * renvoyait ailleurs ; une seconde plus tard la carte machine affiche « Mouture — 0 % »
           * puis suit la préparation jusqu'à 100 %. Le message ne faisait plus que doubler,
           * moins bien, ce que la machine raconte elle-même. Les échecs, eux, s'affichent
           * toujours — voir `commande`.
           */
          () => "",
        );
        if (ok) setLastDispensed(bev);
      },
    });
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
      return { shownProfiles: read, fallbackReason: tPower("noRenamed") };
    return {
      shownProfiles: Array.from({ length: nProfiles }, (_, i) => ({ id: i + 1, name: null, renamed: false })),
      // Deux causes, deux phrases : la machine n'a pas encore donné ses noms, ou notre propre
      // serveur n'a pas répondu. La seconde déguisée en première envoyait l'utilisateur lancer un
      // import sur une autre page pour réparer quelque chose qui n'était pas cassé là.
      fallbackReason: echecProfils ? tPower("namesUnavailable") : tPower("namesNotRead"),
    };
    // `tPower` est stable pour une locale donnée ; les deux clés existaient déjà et étaient
    // doublées en dur juste ici, ce que la contrainte « tout passe par le catalogue » interdit.
  }, [profiles, data?.model.nProfiles, echecProfils, tPower]);

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
        { key: "machine", title: t("machineOrder"), list: ordered },
        ...(rest.length ? [{ key: "rest", title: t("notListed"), list: rest }] : []),
      ];
    }
    return Object.entries(data.categories)
      .map(([key, title]) => ({ key, title: tCat(key, title), list: data.beverages.filter((b) => b.category === key) }))
      .filter((sec) => sec.list.length);
    // `t` et `tCat` sont lus ici : omis des dépendances, les titres de section resteraient ceux
    // de la langue précédente le jour où il y en a une seconde.
  }, [data, t, tCat]);

  /**
   * Écrit la recette dans le profil sur la machine (0x83, mode DONTCARE, action SAVE_BEVERAGE).
   * Modification persistante de l'appareil : elle remplace la recette enregistrée de ce profil.
   */
  /**
   * **Part au clic, sans dialogue** — demandé explicitement. L'avertissement n'a pas disparu
   * pour autant : il vit dans l'infobulle du bouton (`editor.writeTitle`, « Remplace durablement
   * la recette de ce profil… La valeur précédente est perdue »), qui la portait déjà avant. Ce
   * qu'on retire est l'interruption, pas le fait — un geste sans garde-fou ET sans énoncé serait
   * un autre changement, qui n'a pas été demandé.
   */
  const writeToProfile = (bev: Beverage, params: RecipeParam[]) =>
    commande(
      bevScope(bev.id),
      "/api/command",
      { action: "saveToProfile", beverageId: bev.id, profileId: profile, params },
      // Au moment où l'utilisateur veut savoir si sa recette est passée, on le lui dit. La somme
      // de contrôle d'avant écriture est une donnée de diagnostic, pas une réponse à sa question.
      () => tEditor("writeSent"),
    );

  /**
   * Donne son image à une recette perso — `0xAB`, **persistant sur l'appareil**.
   *
   * L'emplacement vient du serveur (`customSlot`) et n'est pas redérivé de l'identifiant : le
   * 229 qui les relie est une constante de protocole, elle n'a qu'une place.
   *
   * Le nom repart tel qu'il a été lu parce que la trame le porte dans la même entrée.
   *
   * **Part au clic, sans dialogue** — demandé explicitement. Le fait reste vrai qu'une écriture
   * d'icône réécrit le nom, alors il passe dans l'infobulle du bouton plutôt que de disparaître
   * avec le dialogue qui le portait.
   */
  const setBeverageIcon = (bev: Beverage, icon: number) =>
    commande(
      bevScope(bev.id),
      "/api/profiles/name",
      { kind: "custom", index: bev.customSlot, name: bev.machineName ?? "", icon },
      () => t("imageSent"),
    );

  const imported = data ? data.beverages.filter((b) => b.bounds || b.values).length : 0;

  // Le toggle marche/arrêt est rendu avant tout le reste : piloter la machine ne doit pas
  // dépendre du chargement du catalogue.
  return (
    <>
      <h1>{t("heading")}</h1>
      {/* Sans clé LAN, rien de ce que propose cette page ne peut atteindre la machine : le dire ici
          plutôt que de laisser cliquer 88 boutons voués à un échec silencieux. */}
      {status?.config?.serverIpProblem && (
        <Alerte>{tc("badServerIp", { problem: status.config.serverIpProblem })}</Alerte>
      )}

      {status && !status.config?.lanKeySet && (
        <Alerte>
          {tc("noLanKey")} <a href="/machines">{tc("noLanKeyLink")}</a>
        </Alerte>
      )}
      {/* Le serveur lui-même ne répond plus : c'est le premier fait à dire, avant la clé LAN et
          avant l'adresse annoncée, parce qu'aucun des deux ne peut être vérifié sans lui. */}
      {serveurMuet && (
        <Alerte>
          {tc("serverDown")}{" "}
          <button className="mini iconBtn" onClick={reessayer}>
            <Icone nom="reinitialiser" taille={14} />
            <span className="lbl">{tc("retry")}</span>
          </button>
        </Alerte>
      )}
      {!live && !serveurMuet && <p className="sub">{tc("pushOff")}</p>}
      {data && imported === 0 && <p className="sub">{t("noneRead")}</p>}
      {/* Le catalogue est affiché mais sa dernière relecture a échoué : ce qui est à l'écran est
          daté, et le dire vaut mieux que de laisser croire à un rafraîchissement silencieux. */}
      {data && erreurCatalogue && (
        <p className="legende">{t("catalogStale", { reason: erreurCatalogue })}</p>
      )}

      <PowerCard
        status={status}
        busy={busy}
        working={pending === "power"}
        onToggle={togglePower}
        onStop={stopDispense}
        /* On n'arrête que ce qu'on peut nommer, ou ce que la machine signale. Sans l'un des deux,
           le bouton reste inerte plutôt que d'envoyer un arrêt sur une boisson devinée. */
        stopAvailable={!!lastDispensed || status?.program?.dispense === true}
        shownProfiles={shownProfiles}
        fallbackReason={fallbackReason}
        confirmed={status?.activeProfileConfirmed ?? false}
        profile={profile}
        onSelectProfile={selectProfileAndActivate}
        importState={data?.import ?? null}
        report={report?.scope === "power" ? report : null}
      />

      {!data ? (
        /* Trois issues, et non deux : en attente, en échec, ou chargé. Sans la deuxième, un
           serveur injoignable laissait « Chargement du catalogue… » à l'écran indéfiniment. */
        erreurCatalogue ? (
          /* Le bandeau du haut couvre déjà le cas « serveur muet » : un second encart répéterait
             la même cause et proposerait un second bouton pour la même reprise. Mais « Chargement
             du catalogue… » ne doit pas non plus rester à l'écran — il annonce un travail en
             cours là où il n'y en a plus, sous un bandeau qui dit exactement le contraire. */
          serveurMuet ? null : (
            <Alerte>
              {t("catalogFailed", { reason: erreurCatalogue })}{" "}
              <button className="mini iconBtn" onClick={reessayer}>
                <Icone nom="reinitialiser" taille={14} />
                <span className="lbl">{tc("retry")}</span>
              </button>
            </Alerte>
          )
        ) : (
          <p className="sub">{t("loadingCatalog")}</p>
        )
      ) : (
      <>
      {sections.map((sec) => (
        <section key={sec.key}>
          <h2>
            {sec.title}{" "}
            <span className="sub">
              ({sec.list.length})
            </span>
          </h2>
          {/* Liste explicite : sans elle, le lecteur d'écran énonce 28 cartes à la file sans dire
              combien il y en a ni où l'on se trouve.
              `.cards` : grille en `auto-fill`. En une colonne, choisir un café demandait 3 300 px
              de défilement — y compris sur la tablette 11" en paysage, où trois colonnes tiennent
              et où 295 px de largeur restaient vides. */}
          <div role="list" className="cards">
            {sec.list.map((b) => (
              <BeverageCard
                key={b.id}
                bev={b}
                profile={profile}
                profileName={profiles.find((p) => p.id === profile)?.name ?? null}
                open={open === b.id}
                busy={busy}
                working={pending === bevScope(b.id)}
                report={report?.scope === bevScope(b.id) ? report : null}
                onToggle={() => setOpen(open === b.id ? null : b.id)}
                onDispense={(params) => dispense(b, params)}
                onWrite={(params) => writeToProfile(b, params)}
                onImport={() => startImport("all", [b.id])}
                onSetIcon={(icon) => setBeverageIcon(b, icon)}
              />
            ))}
          </div>
        </section>
      ))}
      {/* **Un catalogue vide est un cas documenté, pas une hypothèse.** Treize modèles de la table
          du constructeur n'ont aucune recette : `catalogFor` retombe alors sur un catalogue de
          remplacement, et si celui-là ne donne rien non plus, la page s'arrêtait net après la
          carte machine — sans titre, sans phrase, sans rien à faire. L'état nomme la cause, dit
          ce qui marche quand même, et mène à la page qui indique quel catalogue sert. */}
      {!sections.length && (
        <Alerte>
          {t("emptyCatalog", { model: data.model.type })}{" "}
          <a href="/systeme">{t("emptyCatalogLink")}</a>
        </Alerte>
      )}
      </>
      )}

      {dialogue}
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
  working,
  onToggle,
  onStop,
  stopAvailable,
  shownProfiles,
  fallbackReason,
  confirmed,
  profile,
  onSelectProfile,
  importState,
  report,
}: {
  status: Status | null;
  /** Une commande part vers la machine : toutes les autres attendent, elle n'a qu'une file. */
  busy: boolean;
  /** …et c'est CETTE carte qui l'a lancée. C'est ce qui distingue « j'attends » de « je subis ». */
  working: boolean;
  onToggle: (next: boolean) => void;
  onStop: () => void;
  stopAvailable: boolean;
  shownProfiles: ProfileInfo[];
  fallbackReason: string | null;
  confirmed: boolean;
  profile: number;
  onSelectProfile: (id: number) => void;
  importState: Payload["import"];
  report: Report | null;
}) {
  const t = useTranslations("power");
  /** Libelles de capteurs : espace de noms dedie, avec repli sur celui du serveur. */
  const tsens = useTranslations("sensor") as HasTranslator;
  const tc = useTranslations("common");
  const mon = status?.lastMonitor ?? null;
  const running = status?.program?.active === true;
  /**
   * `0x04` est le seul état positivement identifié : la veille. Tout autre état signifie que la
   * machine est éveillée — `0x00` relevé juste après un réveil (en chauffe), `0x02` écran de
   * sélection des boissons, prête. On raisonne donc « éveillée sauf 0x04 » plutôt que sur une
   * liste blanche : une version précédente n'acceptait que `0x00` et affichait « état inconnu »
   * alors que la machine était bel et bien allumée.
   *
   * **Mais une préparation en cours l'emporte sur l'octet d'état, et c'est un fait mesuré.** Un
   * espresso complet a été enregistré le 2026-08-22 avec `état=0x04` sur ses 49 trames, sans
   * qu'aucune commande « Allumer » ne soit passée (capture `espresso-veille.json`). L'octet 4 ne
   * dit donc pas « la machine ne fait rien » : une machine qui moud, infuse et verse n'est pas en
   * veille, quoi qu'annonce cet octet. Sans ce `||`, l'interrupteur affichait ÉTEINT juste
   * au-dessus d'une barre annonçant « Écoulement du café — 84 % ».
   */
  const isOn = mon != null && (mon.stateByte !== 0x04 || mon.auRepos === false);
  /**
   * **Une horloge locale, et rien d'autre.** L'âge du monitor est la seule chose de cette page qui
   * change sans que le serveur ait quoi que ce soit à pousser : personne n'écrit une ligne de
   * journal parce qu'une minute est passée. L'ancienne scrutation le rafraîchissait par accident,
   * en même temps qu'elle re-téléchargeait tout ; en passant à l'état poussé, « il y a 2 min » se
   * serait figé et le passage à « état daté » n'aurait jamais eu lieu.
   *
   * Le battement vit **dans cette carte**, pas dans la page : il ne redessine que l'état machine,
   * pas les 28 cartes de boissons. Aucune requête ne part. 15 s parce que c'est ce qui borne le
   * retard du seul basculement visible (frais → daté, à 90 s) ; au-delà, l'affichage est en
   * minutes et n'en demande pas plus.
   */
  const [, battement] = useState(0);
  useEffect(() => {
    if (!mon) return;
    // Une seconde pendant une préparation — c'est le temps écoulé qui l'exige, la machine ne
    // pousse un monitor que toutes les 1 à 3 s. Quinze sinon, comme avant.
    const id = setInterval(() => battement((n) => n + 1), mon.auRepos === false ? 1000 : 15000);
    return () => clearInterval(id);
  }, [mon]);
  const ageSec = mon ? Math.round((Date.now() - mon.at) / 1000) : null;
  const stale = ageSec != null && ageSec > AGE_PERIME;
  const capteurs = splitSensors(mon?.switches ?? []);
  /**
   * **Une préparation est en cours, et on le tient de la machine.** Pas du drapeau de la file :
   * `program.dispense` dit ce que NOUS avons envoyé, `auRepos === false` dit ce que la machine
   * FAIT. Le monitor daté est exclu, sinon une progression figée survivrait à la préparation.
   */
  const prepa = mon && ageSec != null && ageSec <= AGE_PROGRESSION && mon.auRepos === false ? mon : null;
  /**
   * **La durée est mesurée ici, parce qu'elle n'existe nulle part dans le protocole.** Aucune des
   * trois trames monitor ne porte de durée, ni écoulée ni restante — vérifié sur trois
   * préparations réelles. On date donc le premier monitor non-repos et on compte.
   */
  const [debut, setDebut] = useState<number | null>(null);
  useEffect(() => {
    if (mon?.auRepos === false) setDebut((d) => d ?? Date.now());
    else if (mon?.auRepos === true) setDebut(null);
  }, [mon?.auRepos]);
  const ecoule = prepa && debut ? Math.round((Date.now() - debut) / 1000) : null;

  let label: string;
  // Le libellé interne du programme (« Paramètres 100+9 ») ne dit rien à qui attend un café :
  // On dit qu'une commande est en cours : c'est l'information actionnable.
  if (running) label = t("running");
  /**
   * **Une préparation que NOUS n'avons pas lancée existe aussi.** Une boisson démarrée au panneau
   * de la machine ne passe par aucune tâche, donc `running` est faux — et l'octet d'état pouvant
   * rester à `0x04` pendant toute la préparation (mesuré, voir `isOn`), la ligne aurait affiché
   * « En veille » juste au-dessus d'une barre à 84 %. On ne dit pas « commande en cours », ce
   * serait s'attribuer un geste qu'on n'a pas fait : l'étape, elle, est un fait rapporté par la
   * machine, et la barre juste dessous porte le pourcentage.
   */
  else if (prepa) label = stepLabel(prepa.etapeCle ?? null, t);
  else if (!mon) label = t("unknownNoMonitor");
  else if (stale) label = t("stale", { state: stateLabel(mon.stateByte, t), age: fmtAge(ageSec!, t) });
  else label = stateLabel(mon.stateByte, t);

  return (
    <div className="card machine">
      {/* **L'interrupteur mène, l'arrêt suit.** La rangée était en `space-between` : le nom de la
          machine d'un côté, ses pastilles d'état de l'autre, 413 px de vide entre les deux dans une
          carte de 1 140 px — et un bouton rouge plein six fois plus grand que l'interrupteur dont
          dépend tout le reste. Les pastilles décrivent l'état : elles vivent maintenant sous la
          ligne d'état, pas à l'autre bout de la carte. */}
      <div className="machineHead">
        <label className="switch grand" title={isOn ? t("turnOff") : t("turnOn")}>
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
        <div className="machineIdent">
          {/* La machine est NOMMÉE. Le sélecteur de la barre de navigation est masqué en
              mono-machine : sans ce libellé, la page n'indiquait nulle part à quel appareil elle
              envoie des commandes physiques. */}
          <strong>{status?.machine?.label ? t("machineNamed", { name: status.machine.label }) : t("machine")}</strong>
          <div className="sub">{label}</div>
          {/* Les pastilles qualifient l'état : leur place est contre lui. Serrées entre elles, elles
              se lisent comme un seul objet au lieu de cinq. */}
          <div className="row etats">
            {running && <span className="pill on">{t("programBadge", { counter: status?.program?.counter ?? 0 })}</span>}
            {stale && !running && (
              <span className="pill off" title={t("staleBadgeHint")}>
                {t("staleBadge")}
              </span>
            )}
            {/* **Ce que la machine RÉCLAME n'est pas ce qu'elle rapporte.** Les treize capteurs
                arrivaient dans une seule pastille verte : « niveau d'eau bas · carafe à lait » en
                couleur de marche, à côté d'une alarme en rouge. Le produit annonçait en vert la
                seule chose qui empêchait de faire un café. Voir `splitSensors`. */}
            {capteurs.attention.length > 0 && (
              <span className="pill off" title={t("sensorsAttention")}>
                {capteurs.attention.map((sw) => sensorLabel(sw, tsens)).join(" · ")}
              </span>
            )}
            {capteurs.presents.length > 0 && (
              <span className="pill" title={t("switchesHint")}>
                {capteurs.presents.map((sw) => sensorLabel(sw, tsens)).join(" · ")}
              </span>
            )}
            {/* Un lien, pas une pastille inerte : la seule route vers « quelle alarme ? » était un
                attribut `title`, donc rien sur la tablette et le téléphone. */}
            {mon?.alarmBits ? (
              <a className="pill off" href="/pilotage#alarmes" title={t("alarmsHint")}>
                {t("alarms")}
              </a>
            ) : null}
            <span className={status?.session?.active ? "pill on" : "pill off"}>
              {status?.session?.active ? t("lanSession") : t("noSession")}
            </span>
          </div>
        </div>
        {/* `actions` : le libellé se replie à l'icône sur une carte étroite, comme les actions des
            cartes de boisson. `discret` tant qu'aucune préparation ne tourne — un rouge plein pour
            une action indisponible dominait la carte sans rien pouvoir faire. */}
        <div className="row actions">
          <button
            className={"danger iconBtn" + (running ? "" : " discret")}
            disabled={busy || !stopAvailable}
            aria-busy={working || undefined}
            aria-label={t("stop")}
            onClick={onStop}
            title={stopAvailable ? t("stopTitle") : t("stopUnavailable")}
          >
            <Icone nom="arreter" />
            <span className="lbl">{t("stop")}</span>
          </button>
        </div>
      </div>

      {/* **La progression, montée en permanence et vide au repos.** Une région `role="status"`
          créée en même temps que son contenu n'est pas annoncée — seule une modification À
          L'INTÉRIEUR d'une région déjà présente l'est. La rendre conditionnelle priverait donc de
          l'annonce exactement l'instant qui compte. `.progression:empty` la fait disparaître
          visuellement, comme `.enLigne` ailleurs. */}
      {/* `aria-atomic="false"` — même règle que la carte « Activité » de /pilotage, et ici c'est
          le temps écoulé qui l'impose : il bat à la SECONDE, donc en atomique (ce que
          `role="status"` implique par défaut) toute la région serait relue une fois par seconde.
          Seul le nœud qui change est annoncé, et le temps écoulé est retiré de l'arbre
          d'accessibilité : « depuis 12 s » n'apprend rien qu'on veuille entendre douze fois. */}
      <div className="progression" role="status" aria-live="polite" aria-atomic="false">
        {prepa && (
          <>
            <div className="progLigne">
              <span className="progEtape">{stepLabel(prepa.etapeCle ?? null, t)}</span>
              {/* Le pourcentage porte l'unité, le temps est explicitement le NÔTRE : la trame n'en
                  contient aucun, et laisser croire que la machine annonce une durée serait faux. */}
              <span className="sub mono">{prepa.pourcent != null ? t("percent", { value: prepa.pourcent }) : tc("dash")}</span>
              {ecoule != null && (
                <span className="sub" aria-hidden="true">
                  {t("elapsed", { sec: ecoule })}
                </span>
              )}
            </div>
            <div
              className="jauge"
              role="progressbar"
              aria-label={t("progressLabel")}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(prepa.pourcent != null
                ? {
                    "aria-valuenow": prepa.pourcent,
                    // Le nombre seul ne dit pas de quoi il est le pourcentage : l'étape est ce
                    // qui le rend lisible quand la barre est interrogée hors contexte.
                    "aria-valuetext": `${t("percent", { value: prepa.pourcent })} — ${stepLabel(prepa.etapeCle ?? null, t)}`,
                  }
                : {})}
            >
              {/* `pourcent` peut rester à 0 pendant toute la mouture : la barre est alors vide, ce
                  qui est exact — c'est l'étape, au-dessus, qui dit que ça avance. */}
              <span className="jaugeBarre" style={{ width: `${prepa.pourcent ?? 0}%` }} />
            </div>
          </>
        )}
      </div>

      <div className="blocSuite">
        <label htmlFor="profil-actif">{confirmed ? t("profileLabel") : t("profileUnknown")}</label>
        {/* **Une liste deroulante, comme le selecteur de la machine.** Cinq positions d'un meme
            selecteur, pas cinq commandes : c'est ce que la rangee de boutons peinait a dire, et ce
            qu'un `select` dit par construction. Il porte aussi l'etat sans le mettre en couleur et
            sans changer de taille quand on choisit — la rangee grandissait de 25 px sur le bouton
            actif, donc se decalait entiere a chaque selection, sur la page la plus parcourue.

            L'ordre part en differe (`DELAI_PROFIL`) : parcourir la liste aux fleches emet un
            `change` par valeur traversee, et sans report chacune serait une trame 0xA9 vers
            l'appareil. */}
        <select
          id="profil-actif"
          value={profile}
          disabled={busy}
          onChange={(e) => onSelectProfile(Number(e.target.value))}
          title={t("profileSelectHint")}
        >
          {/* Le profil en cours d'affichage peut ne pas figurer dans la liste : elle ne montre que
              les profils renommes, et la machine peut tres bien etre sur un autre. L'omettre ferait
              afficher au `select` une valeur qui n'est pas celle utilisee — on l'ajoute plutot que
              de mentir sur le profil courant. */}
          {(shownProfiles.some((p) => p.id === profile)
            ? shownProfiles
            : [{ id: profile, name: null, renamed: false }, ...shownProfiles]
          ).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? tc("profileNumbered", { id: p.id })}
            </option>
          ))}
        </select>
        {fallbackReason && <p className="legende">{fallbackReason}</p>}
      </div>

      {importState?.active && (
        <div className="kv blocSuite">
          <span className="k">{t("readingInProgress", { pending: importState.pending ? ` — ${importState.pending}` : "" })}</span>
          <span className="num">{t("readCounts", { ok: importState.ok, remaining: importState.remaining })}</span>
        </div>
      )}
      {/* `role="status"` permanent, jamais monté à la demande : un conteneur inséré en même temps
          que son texte n'est pas annoncé par les lecteurs d'écran. */}
      <p className={"status " + (report?.kind === "err" ? "err" : "ok")} role="status">
        {report?.text ?? (busy && !working ? tc("busyReason") : "")}
      </p>
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

/**
 * **Le visuel d'une boisson — ou rien du tout, et c'est le point.**
 *
 * Les images viennent de l'APK et sont la propriété de De'Longhi : `public/boissons/` est
 * **gitignoré** (voir `scripts/extract-images.mjs`). Une installation qui n'a pas lancé
 * l'extraction n'en a donc aucune — c'est le cas d'un clone neuf, de l'image Docker et de
 * l'archive de release, c'est-à-dire du cas NORMAL. Une carte qui afficherait alors l'icône de
 * lien brisé du navigateur, vingt-huit fois, serait une régression pour tout le monde sauf pour
 * celui qui possède l'application.
 *
 * D'où `onError` : la vignette se retire, la carte reprend exactement l'allure qu'elle avait
 * avant. L'absence d'image n'est pas une erreur à signaler, c'est l'état par défaut.
 *
 * `alt=""` et `aria-hidden` parce que le titre est **à côté** et nomme déjà la boisson : une
 * alternative textuelle y ajouterait un doublon à chacune des vingt-huit cartes. L'image est
 * décorative au sens strict — elle n'apporte aucune information que le texte ne porte pas.
 *
 * `parId` ne couvre ni les grains ni les recettes personnalisées : leur icône ne vient pas de
 * cette table (voir l'en-tête du script d'extraction). Elles n'ont donc pas de vignette, ce qui
 * est correct et non un manque.
 */
/**
 * **Les 20 images que l'application propose pour une recette perso, dans SON ordre.**
 *
 * L'ordre est la donnée : la machine ne retient qu'un index 0-19, pas un nom de dessin. Deux
 * entrées portent la même image (12 et 18, `hot_water`) — c'est ainsi dans la liste de l'app,
 * et dédoublonner décalerait tous les index suivants.
 */
const IMAGES_PERSO: string[] = IMAGES.choixRecettePerso;

/**
 * Le nom d'une image, dans son espace de noms à elle.
 *
 * Les clés sont les noms de ressources de l'app, qui ne sont **pas** nos slugs de catalogue
 * (`due_x_espresso_coffee` d'un côté, `2x_espresso` de l'autre) : les servir depuis `beverage`
 * mêlerait deux référentiels d'identifiants dans un seul espace. Repli sur la clé brute, même
 * règle que `useCategoryLabel` — une image inconnue s'affiche, elle ne fait pas tomber la carte.
 */
function useImageLabel() {
  const t = useTranslations("beverageImage");
  return (fichier: string) => (t.has(fichier) ? t(fichier) : fichier);
}

function VignetteBoisson({ id, icon }: { id?: number; icon?: number | null }) {
  const [absente, setAbsente] = useState(false);
  // La table par identifiant d'abord ; l'index d'icône ensuite, qui est le seul recours des
  // recettes perso — elles ne figurent pas dans `parId`, leur dessin étant choisi, pas fixe.
  // `id` est facultatif : le sélecteur ne montre que des index, et lui passer un identifiant
  // sentinelle pour forcer cette branche aurait été une valeur inventée de plus à maintenir.
  const fichier =
    (id === undefined ? undefined : (IMAGES.parId as Record<string, string>)[String(id)]) ??
    (icon !== null && icon !== undefined ? IMAGES_PERSO[icon] : undefined);
  if (!fichier || absente) return null;
  return (
    // `<img>` et non `next/image` : le fichier est statique, de taille connue, servi depuis
    // `public/` — l'optimiseur n'aurait rien à optimiser, et il refuse de servir ce qui manque,
    // ce qui remplacerait le repli silencieux ci-dessous par une erreur de rendu.
    <img
      className="bevVignette"
      src={`${IMAGES.chemin}/${fichier}.webp`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onError={() => setAbsente(true)}
    />
  );
}

/**
 * **Choisir l'image d'une recette perso.**
 *
 * Elle vit dans la CARTE et non dans l'éditeur de recette, parce que ce ne sont pas les mêmes
 * données : l'éditeur est titré « pour le profil N » et son écriture vise un profil, alors que
 * l'image appartient à l'emplacement et que les cinq profils la partagent. La poser sous ce
 * titre-là aurait affirmé quelque chose de faux.
 *
 * ⚠️ **La trame `0xAB` porte le nom ET l'icône dans la même entrée de 21 octets** : on ne peut
 * pas écrire l'un sans réécrire l'autre. Le nom est donc renvoyé tel qu'il a été lu, et la
 * confirmation le dit — le taire ferait d'une écriture double une écriture simple aux yeux du
 * lecteur. Renommer reste le geste de `/profils`, qui a le formulaire pour ça ; le dupliquer ici
 * ferait deux endroits pour un seul geste.
 *
 * Replié par défaut : vingt images, c'est plus haut que l'éditeur qu'on est venu ouvrir.
 */
function ChoixImage({
  actuel,
  nom,
  busy,
  working,
  onChoose,
}: {
  /**
   * L'index que porte la machine. Reçu **non nul** : le composant n'est monté que si la boisson
   * a une entrée dans le bloc de noms, et une entrée en a toujours un. L'écrire dans le type
   * évite d'avoir à inventer un code de repli pour un cas qui ne se produit pas.
   */
  actuel: number;
  /** Le nom saisi sur la machine : l'écriture le réécrit, l'infobulle du bouton le dit. */
  nom: string;
  busy: boolean;
  working: boolean;
  onChoose: (icon: number) => void;
}) {
  const t = useTranslations("beverages");
  const imageLabel = useImageLabel();
  const [ouvert, setOuvert] = useState(false);
  const [choix, setChoix] = useState<number>(actuel);
  // Rien ne borne cet octet dans le protocole : la machine peut en principe en porter un que la
  // liste de vingt ne couvre pas. On le dit alors, plutôt que d'afficher une image au hasard.
  const courant = IMAGES_PERSO[actuel] ?? null;

  return (
    <div className="blocSuite">
      <div className="row">
        {/* Ce que la machine porte AUJOURD'HUI. Un octet hors des vingt n'est pas impossible —
            rien dans le protocole ne le borne — et le dire vaut mieux que de n'afficher rien. */}
        <span className="sub">
          {courant ? t("imageOf", { image: imageLabel(courant) }) : t("imageUnknown", { code: actuel })}
        </span>
        <button
          className={"iconBtn" + (ouvert ? " ouvert" : "")}
          onClick={() => setOuvert(!ouvert)}
          aria-expanded={ouvert}
        >
          <Icone nom="chevron" />
          <span className="lbl">{ouvert ? t("imageHide") : t("imageChoose")}</span>
        </button>
      </div>

      {ouvert && (
        <>
          <p className="chapeau">{t("imageNote")}</p>
          {/* Un groupe de radios, pas vingt boutons : le choix est unique et exclusif, et c'est
              ce que `radiogroup` fait entendre. Chaque option porte le NOM de son dessin —
              sans quoi ce sont vingt cases sans étiquette, la sélection comprise. */}
          <div className="grilleImages" role="radiogroup" aria-label={t("imageChoose")}>
            {IMAGES_PERSO.map((fichier, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={choix === i}
                className={"choixImage" + (choix === i ? " actif" : "")}
                onClick={() => setChoix(i)}
                aria-label={t("imagePick", { image: imageLabel(fichier) })}
              >
                <VignetteBoisson icon={i} />
                <span className="lbl">{imageLabel(fichier)}</span>
              </button>
            ))}
          </div>
          <div className="row note">
            <button
              className="primary iconBtn"
              disabled={busy || choix === actuel}
              aria-busy={working || undefined}
              onClick={() => onChoose(choix)}
              title={t("imageConfirmWarning", { name: nom })}
            >
              <Icone nom="machine" />
              <span className="lbl">{t("imageSave")}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function BeverageCard({
  bev,
  profile,
  profileName,
  open,
  busy,
  working,
  report,
  onToggle,
  onDispense,
  onWrite,
  onImport,
  onSetIcon,
}: {
  bev: Beverage;
  profile: number;
  profileName: string | null;
  open: boolean;
  busy: boolean;
  /** Cette carte tient le verrou d'envoi : ses boutons le disent, les autres se contentent d'attendre. */
  working: boolean;
  report: Report | null;
  onToggle: () => void;
  onDispense: (params?: RecipeParam[]) => void;
  onWrite: (params: RecipeParam[]) => void;
  onImport: () => void;
  /** Écrit l'image de l'emplacement perso (`0xAB`). Absente des boissons du catalogue. */
  onSetIcon: (icon: number) => void;
}) {
  const t = useTranslations("beverages");
  const tc = useTranslations("common");
  const bevLabel = useBeverageLabel();
  const paramLabel = useParamLabel();
  const unitLabel = useUnitLabel();
  const tstat = useTranslations("stat");
  /**
   * **Le seul traducteur de la page sans repli, et il ne se contentait pas d'afficher sa clé : il
   * levait.** Une catégorie absente du catalogue fait remonter un `MISSING_MESSAGE` jusqu'à la
   * carte, et en développement c'est la page entière qui tombe — 28 cartes perdues pour un libellé
   * de compteur. Les catégories viennent de `STAT_MEANINGS`, côté serveur : il peut en gagner une
   * avant que le catalogue ne la connaisse, et ce jour-là la bonne réponse est d'afficher la clé,
   * pas de casser l'accueil. C'est exactement ce que font déjà `useCategoryLabel`, `useParamLabel`
   * et `useUnitLabel` dans `src/i18n/labels.ts` ; ce compteur était le seul à ne pas le faire.
   */
  const catLabel = (key: string) => (tstat.has(key) ? tstat(key) : key);
  const users = beverageParams(bev).filter((p) => p.kind === "user");
  const read = bev.bounds ?? bev.values;
  const [tech, setTech] = useState(false);
  const nom = bevLabel(bev);
  return (
    /* Ouverte, la carte s'étend sur toute la rangée de la grille (voir `.cards > .card.open`) :
       l'éditeur de recette a besoin de largeur, et le comprimer dans une colonne de 19 rem aurait
       fait de la grille la cause d'un formulaire illisible. */
    <div id={`b${bev.id}`} className={"card" + (open ? " open" : "")} role="listitem">
      <div className="cardHead">
        <div>
          {/* Le nom et ses pastilles sont UN objet : une rangée avec une gouttière, au lieu de
              quatre `marginLeft: 8` posés pastille par pastille. La gouttière gère aussi le repli —
              une pastille qui passe à la ligne garde son écart, une marge gauche non. */}
          <div className="titreLigne">
          {/* La vignette d'abord : `.titreLigne` est déjà une rangée souple avec gouttière, elle
              gère donc l'alignement et le repli sans qu'on ait rien à ajouter. */}
          <VignetteBoisson id={bev.id} icon={bev.icon} />
          {/* Un vrai titre, pas un `<strong>` : c'est le seul moyen de sauter de boisson en boisson
              au lecteur d'écran. Sans lui, 28 cartes n'offraient que 2 repères de navigation. */}
          <h3 className="cardTitle">{nom}</h3>
          {/* Catégorie de la boisson : pastille neutre. Le vert est réservé à ce que la
              MACHINE rapporte — le laisser ici en mettait quatre par carte, vingt-huit fois, et
              plus rien ne signalait qu'une session venait de tomber. */}
          {bev.milk && <span className="pill">{t("milk")}</span>}
          {read && <span className="pill info">{t("readFromMachine")}</span>}
          {bev.beanSystem?.name && (
            <span
              className="pill info"
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
            <span className="pill off" title={t("misalignedHint")}>
              {t("misaligned")}
            </span>
          )}
          </div>
          <div className="legende">
            {/* Le nom d'usine n'est montré que s'il apprend quelque chose. « Espresso macchiato /
                Espresso Macchiato » disait deux fois la même chose ; « Nom perso / Custom » dit que
                c'est un emplacement personnalisé, ce qui est une information. */}
            {bev.factoryName.toLowerCase() !== nom.toLowerCase() && <>{bev.factoryName} · </>}
            {t("paramCount", { count: bev.ingredients.length })}
            {users.length > 0 && bev.bounds ? ` · ${summary(users, paramLabel, unitLabel)}` : ""}
            {bev.counter && (
              <>
                {" · "}
                <span title={t("counterHint", { category: catLabel(bev.counter.category) })}>
                  {t("counterValue", {
                    value: bev.counter.value.toLocaleString("fr-FR"),
                    category: catLabel(bev.counter.category),
                  })}
                </span>
              </>
            )}
          </div>
        </div>
        {/* Les trois boutons portaient le même nom sur les 28 cartes : « Détails », « Lire »,
            « Préparer », 84 boutons homonymes pour un lecteur d'écran. Le nom accessible dit
            maintenant DE QUOI il s'agit, sans allonger le libellé visible. */}
        {/* Le libellé reste visible tant que la carte est large ; en colonne de grille il passe
            hors écran et l'icône porte l'action, comme PRODUCT.md le demande. C'est la largeur de
            la CARTE qui décide, pas celle de la fenêtre — une container query, donc.
            Le nom accessible ne bouge dans aucun des deux cas : `aria-label` l'emporte sur le
            contenu, et c'est lui qui nomme la boisson concernée (« Préparer un Espresso » plutôt
            que « Préparer », vingt-huit fois). Le libellé visible ne fait que doubler l'icône. */}
        <div className="row actions">
          <button
            className={"iconBtn" + (open ? " ouvert" : "")}
            onClick={onToggle}
            aria-label={open ? t("hideFor", { beverage: nom }) : t("detailsFor", { beverage: nom })}
          >
            <Icone nom="chevron" />
            <span className="lbl">{open ? tc("hide") : tc("details")}</span>
          </button>
          <button
            className="iconBtn"
            disabled={busy}
            aria-busy={working || undefined}
            aria-label={t("readFor", { beverage: nom })}
            onClick={onImport}
            title={t("readTitle")}
          >
            <Icone nom="lire" />
            <span className="lbl">{tc("read")}</span>
          </button>
          <button
            className="good iconBtn"
            disabled={busy}
            aria-busy={working || undefined}
            aria-label={t("prepareFor", { beverage: nom })}
            onClick={() => onDispense()}
          >
            <Icone nom="preparer" />
            <span className="lbl">{tc("prepare")}</span>
          </button>
        </div>
      </div>

      {/* Le compte rendu vit dans la carte qui a déclenché l'action, jamais en haut de page. */}
      <p className={"status " + (report?.kind === "err" ? "err" : "ok")} role="status">
        {report?.text ?? ""}
      </p>

      {open && (
        <div className="blocSuite">
          {/* Monté seulement à l'ouverture : son état repart donc des valeurs de la machine
              à chaque fois, sans logique de réinitialisation à écrire. */}
          {/* « Infos techniques » est passe a l'editeur pour tenir dans SA barre d'actions : les
              quatre boutons de la carte ouverte etaient sur trois lignes. L'etat et le panneau
              restent ici — c'est la carte qui les possede, et le panneau s'ouvre bien sous la
              barre puisqu'il est rendu juste apres l'editeur. Le libelle passe en `.lbl` comme
              les trois autres, sans quoi il ne se replierait pas avec eux en etroit. */}
          {/* Avant l'éditeur, et seulement pour un emplacement perso NOMMÉ : `customSlot` n'est
              rempli que là (la trame de noms ne couvre pas les boissons du catalogue, et une
              écriture a besoin d'un nom à réécrire). L'identité de la recette — son dessin — se
              lit avant ses valeurs pour un profil. */}
          {bev.customSlot !== null && bev.icon !== null && (
            <ChoixImage actuel={bev.icon} nom={bev.machineName ?? ""} busy={busy} working={working} onChoose={onSetIcon} />
          )}

          <RecipeEditor
            bev={bev}
            profile={profile}
            profileName={profileName}
            busy={busy}
            working={working}
            onDispense={onDispense}
            onWrite={onWrite}
            actions={
              <button className="iconBtn" onClick={() => setTech(!tech)} aria-expanded={tech} title={t("technicalInfoTitle")}>
                <Icone nom="info" />
                <span className="lbl">{tech ? t("hideTechnicalInfo") : t("technicalInfo")}</span>
              </button>
            }
          />

          {tech && (
          <>
          {/* Le tableau « Tous les paramètres » a été retiré : l'éditeur de recette au-dessus
              montre déjà chaque réglage avec ses bornes, son défaut et la valeur du profil. Le
              dupliquer ici en lecture seule n'ajoutait rien. Les informations techniques gardent ce
              qui ne se lit nulle part ailleurs : les propriétés Ayla et la trame brute. */}
          <div className="kv">
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
              <span className="mono">
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
/**
 * **Une quantité nulle veut dire « ingrédient absent », et l'option qui en dépend vaut 255.**
 *
 * Mesuré sur les six emplacements perso de la machine, profil 1 :
 *
 * ```
 * Lacteso     café   0  arôme 255  lait 100     ← une recette SANS café
 * Mini Lait   café  20  arôme   0  lait 113     ← les deux
 * test TT     café   0  arôme 255  lait  50
 * Perso 4-6   café   0  arôme 255  lait   0     ← emplacements vides
 * ```
 *
 * C'est aussi la règle de l'application : `Q6.g.i()` n'ajoute le bloc café — quantité puis
 * `TASTE` — que `if (recipeData.k() > 0)`. Cocher un ingrédient, c'est lui donner une quantité.
 *
 * ⚠️ **255 (0xFF) est le marqueur « sans objet », et il vaut aussi pour les VALEURS enregistrées,**
 * pas seulement pour les défauts du modèle comme la doc le notait. Il tombe hors des bornes
 * (`TASTE` va de 0 à 5), donc `valeurProfil` le rejetait et l'éditeur repartait du minimum : il
 * affichait « Arôme 0 » pour une recette sans café, et **réécrivait 0 à la place de 255**. Une
 * altération silencieuse d'un marqueur que la machine avait posé elle-même.
 */
const QUANTITE_ABSENTE = 0;
const OPTION_SANS_OBJET = 255;

/**
 * Les ingrédients d'une recette perso, et les réglages que chacun ouvre.
 *
 * ⚠️ **Il n'y a ni eau chaude ni thé, et ce n'est pas une omission.** Pour les six emplacements
 * perso, la machine déclare exactement `[1, 2, 4, 9, 12, 24, 25, 28]` — ni `HOT_WATER` (15) ni
 * `THE_TEMP` (13). Deux sources indépendantes le disent : la trame `0xB0` lue sur l'appareil pour
 * les six emplacements, et la table du catalogue extraite de l'APK. Les bornes sont d'ailleurs
 * **identiques sur un emplacement vide et sur un emplacement configuré**, donc ce jeu ne dépend
 * pas du contenu : il est fixé par le modèle. Que « Eau chaude » (16) existe comme boisson ne
 * change rien — la liste des paramètres est attachée à la BOISSON, elle ne se compose pas.
 *
 * L'application officielle n'offre donc rien pour le thé pour la même raison, et c'est une limite
 * de la cafetière, pas de son logiciel.
 *
 * `INVERSION` (12) et `ACCESSORIO` (28) sont rangés avec le lait : l'ordre lait/café n'a de sens
 * qu'avec du lait, et `ACCESSORIO` n'apparaît que sur les boissons lactées (16 sur 16, absent des
 * 12 autres). Un paramètre qui ne tombe dans aucun groupe reste rendu normalement — il ne doit
 * jamais DISPARAÎTRE parce qu'une table le passe sous silence.
 */
const INGREDIENTS = [
  // `BLEND` (4) suit le CAFÉ, mesuré : les deux recettes réelles sans café (« Lacteso », « test TT »)
  // le portent à 255 comme `TASTE`, celle qui a du café l'a à 0. Il n'est pas réglable sur ce modèle
  // (`min == max == 0`) donc il n'affiche aucun contrôle — mais il part quand même dans la trame,
  // et il doit y partir avec la valeur que la machine y met elle-même.
  { cle: "cafe", quantite: 1, options: [2, 4] },
  { cle: "lait", quantite: 9, options: [12, 28] },
] as const;

function RecipeEditor({
  bev,
  profile,
  profileName,
  busy,
  working,
  onDispense,
  onWrite,
  actions,
}: {
  bev: Beverage;
  profile: number;
  profileName: string | null;
  busy: boolean;
  working: boolean;
  onDispense: (params?: RecipeParam[]) => void;
  onWrite: (params: RecipeParam[]) => void;
  /**
   * Boutons de la carte à poser dans la barre d'actions de l'éditeur — aujourd'hui « Infos
   * techniques ». Il vit dans la carte (c'est elle qui tient l'état et le panneau), mais il
   * s'affiche ici : les quatre boutons de la carte ouverte étaient sur trois lignes différentes,
   * dont deux ne contenaient qu'un bouton. Passer un nœud plutôt que de remonter l'état évite de
   * déplacer le panneau technique et ses traductions.
   */
  actions?: React.ReactNode;
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
   * Les deux règles de valeur vivent au niveau du module (`valeurDepart`, `defautModele`) : elles
   * étaient écrites ici, et le bouton « Préparer » de la carte en avait sa propre version, plus
   * simple et fausse. Deux implémentations de « quelle valeur pour ce paramètre ? » dans le même
   * fichier, c'était deux cafés différents sous une seule et même confirmation.
   */
  const seedFor = (b: Param) => valeurDepart(bev, b);
  const seed = () => Object.fromEntries(all.map((b) => [b.id, seedFor(b)]));
  const defOf = (b: Param) => defautModele(b);
  const [vals, setVals] = useState<Record<number, number>>(seed);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /**
   * Un emplacement perso se règle par INGRÉDIENT, comme l'écran de création de l'application :
   * on coche le lait et sa quantité s'ouvre, on coche le café et sa quantité plus son arôme
   * s'ouvrent. La présence n'a pas d'état à elle — elle se LIT dans la quantité enregistrée, ce
   * qui évite d'avoir deux sources de vérité à tenir d'accord.
   */
  const estPerso = bev.customSlot !== null && bev.customSlot !== undefined;
  const presenceInitiale = () =>
    Object.fromEntries(
      INGREDIENTS.map((g) => [g.cle, (bev.values?.params.find((x) => x.id === g.quantite)?.value ?? 0) > 0]),
    ) as Record<string, boolean>;
  const [presents, setPresents] = useState<Record<string, boolean>>(presenceInitiale);

  if (!bev.bounds) {
    return <Alerte>{t("boundsNotRead")}</Alerte>;
  }
  if (!all.length) {
    return (
      <p className="sub">
        {t("noParams")}
      </p>
    );
  }

  /** Le groupe auquel un paramètre appartient, ou `null` — seulement pour un emplacement perso. */
  const groupeDe = (id: number) =>
    estPerso ? INGREDIENTS.find((g) => g.quantite === id || (g.options as readonly number[]).includes(id)) ?? null : null;

  /**
   * Ce qui part dans la trame. Un ingrédient décoché n'est pas « omis » : il est écrit ABSENT,
   * avec la convention de la machine elle-même — quantité 0, option 255. Omettre le paramètre
   * laisserait l'ancienne valeur en place, donc l'ingrédient présent.
   */
  const valeurEnvoyee = (b: Param): number => {
    const g = groupeDe(b.id);
    if (g && !presents[g.cle]) return g.quantite === b.id ? QUANTITE_ABSENTE : OPTION_SANS_OBJET;
    return vals[b.id] ?? seedFor(b);
  };
  const params: RecipeParam[] = all.map((b) => ({ id: b.id, value: valeurEnvoyee(b) }));

  /**
   * Cocher ou décocher un ingrédient.
   *
   * En le rallumant on redonne une valeur utilisable à ses réglages : celle enregistrée est le
   * marqueur d'absence (0, ou 255 pour une option) et tombe hors des bornes, donc la laisser
   * afficherait un curseur au mauvais bout de sa course. Le défaut du modèle d'abord, le minimum
   * sinon — la même règle que `valeurDepart`, pas une seconde.
   */
  const basculerIngredient = (g: (typeof INGREDIENTS)[number], actif: boolean) => {
    setPresents((prec) => ({ ...prec, [g.cle]: actif }));
    if (!actif) return;
    setVals((v) => {
      const suite = { ...v };
      for (const b of all) {
        if (b.id !== g.quantite && !(g.options as readonly number[]).includes(b.id)) continue;
        const cur = v[b.id];
        if (cur === undefined || cur < (b.min as number) || cur > (b.max as number)) {
          suite[b.id] = defautModele(b) ?? (b.min as number);
        }
      }
      return suite;
    });
  };

  /** Les groupes que ce modèle déclare réellement — un ingrédient sans paramètre n'existe pas. */
  const groupes = INGREDIENTS.map((g) => ({
    g,
    qte: basic.find((b) => b.id === g.quantite) ?? null,
    opts: basic.filter((b) => (g.options as readonly number[]).includes(b.id)),
  })).filter((x) => x.qte !== null);
  /** Ce qu'aucun groupe ne couvre reste rendu tel quel : rien ne doit disparaître par oubli. */
  const horsGroupe = basic.filter((b) => groupeDe(b.id) === null);
  const aucunIngredient = groupes.length > 0 && groupes.every((x) => !presents[x.g.cle]);
  // Deux appels littéraux plutôt qu'une clé construite : `verif-messages.mjs` ne sait vérifier
  // que les littéraux, et une clé dynamique lui échapperait silencieusement.
  const nomGroupe = (cle: string) => (cle === "cafe" ? t("groupCoffee") : t("groupMilk"));
  const set = (b: Param, raw: number) =>
    setVals((v) => ({
      ...v,
      [b.id]: Math.min(b.max as number, Math.max(b.min as number, Number.isFinite(raw) ? raw : (b.min as number))),
    }));
  const dirty =
    adjustable.some((b) => vals[b.id] !== seedFor(b)) ||
    // Décocher un ingrédient ne touche à aucun curseur : sans ça, « réinitialiser » resterait
    // grisé alors que la recette a bel et bien changé.
    INGREDIENTS.some((g) => presents[g.cle] !== presenceInitiale()[g.cle]);

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

  /**
   * Une ligne de réglage. Elle était une suite de largeurs fixes — libellé 150, curseur 150, champ
   * 80, puce 78 : 558 px incompressibles pour un paramètre, dans une carte qui peut en faire 300.
   * `.paramRow` laisse le libellé prendre sa ligne quand il faut et le curseur absorber le reste.
   */
  /**
   * **Un paramètre qui ne vaut que 0 ou 1 est un interrupteur, pas un curseur.**
   *
   * `VISIBLE` et `VISIBLE_IN_PROGRAMMING` sont des booléens : un curseur de deux crans, doublé d'un
   * champ numérique et bordé de « 0 » et « 1 », demande au lecteur de traduire lui-même deux
   * nombres en oui/non — et l'invite à taper une valeur qui n'existe pas. L'interrupteur dit l'état
   * et n'en propose aucun autre.
   *
   * Le critère est **intrinsèque au paramètre** (`min === 0 && max === 1`), pas une liste de noms :
   * ces deux-là ne sont pas des cas particuliers, ce sont les seuls booléens que ce modèle expose
   * aujourd'hui. Il ne dépend pas non plus de `kind` — c'est notre propre regroupement, pas le
   * protocole, et le contrôle d'un paramètre ne doit pas changer selon le bloc où on l'a rangé.
   *
   * `INVERSION` ne passe jamais par là : `min === max`, donc il est déjà écarté par `adjustable` et
   * reste envoyé tel quel dans la charge utile, ce qui est le comportement à préserver.
   */
  const bascule = (b: Param) => {
    const v = vals[b.id] ?? seedFor(b);
    return (
      <div className="paramRow" key={b.id}>
        <span className="nom">
          {paramLabel(b)}
          {b.unit ? ` (${unitLabel(b.unit)})` : ""}
        </span>
        <div className="ctl">
          <label className="switch">
            <input
              type="checkbox"
              checked={v === 1}
              aria-label={paramLabel(b)}
              onChange={(e) => set(b, e.target.checked ? 1 : 0)}
            />
            <span className="track" aria-hidden="true">
              <span className="knob" />
            </span>
          </label>
          {defOf(b) !== null ? (
            <button
              className="mini"
              disabled={v === defOf(b)}
              onClick={() => set(b, defOf(b) as number)}
              title={t("paramDefaultHint")}
            >
              {t("paramDefaultBool", { on: defOf(b) === 1 ? 1 : 0 })}
            </button>
          ) : (
            <span className="sub" title={t("noParamDefaultHint")}>
              {t("noParamDefault")}
            </span>
          )}
        </div>
      </div>
    );
  };

  const slider = (b: Param) => (
    <div className="paramRow" key={b.id}>
      <span className="nom">
        {paramLabel(b)}
        {b.unit ? ` (${unitLabel(b.unit)})` : ""}
      </span>
      <div className="ctl">
        <span className="sub mono">
          {b.min}
        </span>
        <input
          type="range"
          min={b.min}
          max={b.max}
          value={vals[b.id] ?? seedFor(b)}
          aria-label={`${paramLabel(b)} (${b.min}–${b.max})`}
          onChange={(e) => set(b, Number(e.target.value))}
        />
        <span className="sub mono">
          {b.max}
        </span>
        <input
          className="numField"
          type="number"
          min={b.min}
          max={b.max}
          value={vals[b.id] ?? seedFor(b)}
          onChange={(e) => set(b, Number(e.target.value))}
        />
        {defOf(b) !== null ? (
          /* **Cette puce reste sans icone.** C'est le seul emploi de `.mini` conforme a sa
             definition — une puce qui AFFICHE une valeur, « defaut 40 », dans une ligne de reglage
             — et le bouton global juste au-dessus porte deja le rembobinage pour la meme action.
             Le glyphe serait repete jusqu'a sept fois par carte, sur vingt-huit cartes, en
             elargissant chaque fois une ligne qui contient deja un curseur et un champ. */
          <button
            className="mini"
            disabled={(vals[b.id] ?? seedFor(b)) === defOf(b)}
            onClick={() => set(b, defOf(b) as number)}
            title={t("paramDefaultHint")}
          >
            {t("paramDefault", { value: defOf(b) as number })}
          </button>
        ) : (
          <span className="sub" title={t("noParamDefaultHint")}>
            {t("noParamDefault")}
          </span>
        )}
      </div>
    </div>
  );

  /** Aiguillage : deux états ⇒ interrupteur, sinon curseur. */
  const reglage = (b: Param) => (b.min === 0 && b.max === 1 ? bascule(b) : slider(b));

  return (
    <div className="blocEditeur">
      <div className="cardHead chapeau">
        {/* Un titre, pas un `strong` : les 28 cartes ont gagné leur `h3`, et le bloc qui s'ouvre
            dedans restait le seul repère de la page inaccessible à une navigation par titres. */}
        <h4 className="cardTitle">{t("heading", { profile: profileName ?? tc("profileFallback", { id: profile }) })}</h4>
        <div className="row">
          {!bev.values && (
            <span className="pill off" title={t("valuesNotReadHint")}>
              {t("valuesNotRead")}
            </span>
          )}
          {dirty && (
            <button
              className="iconBtn"
              onClick={() => {
                setVals(seed);
                setPresents(presenceInitiale());
              }}
              title={t("resetTitle")}
            >
              <Icone nom="reinitialiser" />
              <span className="lbl">{tc("reset")}</span>
            </button>
          )}
          <button
            className="mini iconBtn"
            disabled={atDefaults}
            onClick={applyDefaults}
            title={noDefault ? t("defaultsPartialTitle", { count: noDefault }) : t("defaultsTitle")}
          >
            <Icone nom="defauts" taille={15} />
            <span className="lbl">{t("defaults")}</span>
          </button>
        </div>
      </div>

      {/* **Un emplacement perso se règle par ingrédient**, comme l'écran de création de
          l'application : on coche, et les réglages de cet ingrédient s'ouvrent. Les boissons du
          catalogue gardent la liste à plat — leurs ingrédients ne se choisissent pas. */}
      {estPerso ? (
        <>
          <p className="chapeau">{t("ingredientsHint")}</p>
          {groupes.map(({ g, qte, opts }) => (
            <div className="blocIngredient" key={g.cle}>
              <label className="caseLibelle">
                <input
                  type="checkbox"
                  checked={!!presents[g.cle]}
                  onChange={(e) => basculerIngredient(g, e.target.checked)}
                />
                <span>{nomGroupe(g.cle)}</span>
              </label>
              {presents[g.cle] && (
                <>
                  {reglage(qte as Param)}
                  {opts.map(reglage)}
                </>
              )}
            </div>
          ))}
          {horsGroupe.map(reglage)}
          {/* Averti, pas interdit : rien dans le protocole ne dit qu'une recette vide est refusée,
              et inventer ce refus serait ajouter une règle que la machine n'a pas énoncée. */}
          {aucunIngredient && <Alerte>{t("noIngredient")}</Alerte>}
          <p className="sub">{t("noWaterHere")}</p>
        </>
      ) : (
        basic.map(reglage)
      )}

      {fixed.map((b) => (
        <div className="paramRow" key={b.id}>
          <span className="nom">
            {paramLabel(b)}
            {b.unit ? ` (${unitLabel(b.unit)})` : ""}
          </span>
          <span className="sub mono" title={t("imposedHint")}>
            {t("imposed", { value: b.min ?? 0 })}
          </span>
        </div>
      ))}

      {/* **Une seule barre d'actions pour la carte ouverte.** Les quatre boutons — deux depliants
          a gauche, deux actions a droite — occupaient trois lignes, dont deux ne portaient qu'un
          bouton chacune. Les depliants restent des depliants : leur contenu s'ouvre SOUS la barre,
          jamais au-dessus, sinon cliquer en bas ferait apparaitre du texte plus haut.

          Les deux actions gardent les memes glyphes que sur /recipes pour les memes gestes : la
          tasse coule la boisson avec ces valeurs, la machine nomme la destination de l'ecriture.
          Cette derniere est PERSISTANTE sur l'appareil — c'est la seule chose de cette carte qui
          survive a la fermeture de l'onglet. */}
      <div className="row note">
        {advanced.length > 0 && (
          /* Meme bascule que « Proprietes » sur /profils, donc meme chevron : il pivote au lieu
             de changer de dessin. */
          <button className={"iconBtn" + (showAdvanced ? " ouvert" : "")} onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced}>
            <Icone nom="chevron" />
            <span className="lbl">{showAdvanced ? tc("hide") : t("advanced")} ({advanced.length})</span>
          </button>
        )}
        {actions}
        <button className="good iconBtn" disabled={busy} aria-busy={working || undefined} onClick={() => onDispense(params)}>
          <Icone nom="preparer" />
          <span className="lbl">{t("prepareWith")}</span>
        </button>
        <button
          className="primary iconBtn"
          disabled={busy}
          aria-busy={working || undefined}
          onClick={() => onWrite(params)}
          title={t("writeTitle")}
        >
          <Icone nom="machine" />
          <span className="lbl">{t("writeTo", { profile: profileName ?? tc("profileFallback", { id: profile }) })}</span>
        </button>
      </div>

      {advanced.length > 0 && showAdvanced && (
        <div className="blocSuite">
          <p className="chapeau">{t("advancedNote")}</p>
          {advanced.map(reglage)}
        </div>
      )}
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

/**
 * Le défaut du **modèle**, ou `null` s'il ne tombe pas dans ses propres bornes — auquel cas il n'y
 * a pas de valeur d'usine à proposer, et on n'en invente pas.
 */
function defautModele(b: Param): number | null {
  const d = b.def;
  if (d === undefined || d === null) return null;
  return d >= (b.min as number) && d <= (b.max as number) ? d : null;
}

/** Ce que le **profil** a enregistré sur la machine, si c'est utilisable. */
function valeurProfil(bev: Beverage, b: Param): number | undefined {
  const v = bev.values?.params.find((p) => p.id === b.id)?.value;
  if (v === undefined) return undefined;
  return v >= (b.min as number) && v <= (b.max as number) ? v : undefined;
}

/** Valeur de départ d'un réglage : celle du profil, sinon celle du modèle, sinon le minimum. */
function valeurDepart(bev: Beverage, b: Param): number {
  return valeurProfil(bev, b) ?? defautModele(b) ?? (b.min as number);
}

/**
 * Ce qu'on peut **honnêtement** envoyer pour un paramètre, et d'où ça vient.
 *
 * `null` = ni valeur de profil ni défaut utilisable : on n'envoie rien pour ce paramètre, et la
 * machine applique le sien. C'est ce qui évite d'envoyer « Café = 0 ml » sur un mug de voyage
 * jamais configuré, tout en cessant d'ignorer la recette du profil quand elle existe.
 */
function valeurSure(bev: Beverage, b: Param): { value: number; from: "profil" | "modele" } | null {
  const p = valeurProfil(bev, b);
  if (p !== undefined) return { value: p, from: "profil" };
  const d = defautModele(b);
  if (d !== null) return { value: d, from: "modele" };
  return null;
}

/**
 * Les réglages d'une commande, en français, avec leurs unités.
 *
 * Remplace un `params.map(p => nom + " = " + valeur)` qui vidait huit couples dont quatre ne sont
 * pas des réglages d'utilisateur (« Programmable = 1 », « Visible = 1 ») et dont aucun ne portait
 * son unité — dans le dialogue même qui existait pour ne plus faire ce que faisait
 * `window.confirm()`. Les paramètres techniques ne quittent pas la **trame**, ils sont comptés au
 * lieu d'être énumérés : la règle « ne jamais filtrer les paramètres sur `kind` » porte sur ce
 * qu'on envoie, pas sur ce qu'on donne à relire avant de confirmer.
 */
function resumeReglages(
  bev: Beverage,
  params: RecipeParam[],
  paramLabel: (p: { name?: string; label?: string; id?: number }) => string,
  unitLabel: (u: string) => string,
  autres: (n: number) => string,
): string {
  const lisibles: string[] = [];
  let techniques = 0;
  for (const p of params) {
    const meta = paramOf(bev, p.id);
    if (meta && meta.kind === "user") {
      lisibles.push(paramLabel(meta) + " " + p.value + (meta.unit ? " " + unitLabel(meta.unit) : ""));
    } else techniques++;
  }
  if (!techniques) return lisibles.join(" · ");
  const queue = autres(techniques);
  return lisibles.length ? lisibles.join(" · ") + " · " + queue : queue;
}

/**
 * Un `fetch` qui rejette n'a pas atteint le serveur ; un `fetch` qui répond 500 l'a atteint. La
 * distinction décide de la phrase : dans le premier cas il n'y a rien à corriger côté machine, et
 * rien d'autre à proposer que de réessayer.
 */
function injoignable(e: unknown): boolean {
  return e instanceof TypeError;
}

/** La raison d'un échec, en langue d'intention plutôt qu'en nom de classe JavaScript. */
function raisonEchec(e: unknown, tc: Translator): string {
  if (injoignable(e)) return tc("serverUnreachable");
  return tc("error", { message: e instanceof Error ? e.message : String(e) });
}


/**
 * Libellé d'un état machine. Seule la veille (`0x04`) est certaine ; `0x00` et `0x02` sont
 * déduits d'observations concordantes, et tout autre code est affiché brut plutôt que deviné.
 */

/** Paramètre décodé (avec son identifiant d'énum) pour cette boisson — la traduction du libellé
 *  se fait ensuite via `useParamLabel`. */
const paramOf = (bev: Beverage, id: number): Param | undefined =>
  bev.bounds?.params.find((p) => p.id === id) ?? bev.values?.params.find((p) => p.id === id);
