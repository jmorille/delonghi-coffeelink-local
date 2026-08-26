"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useCategoryLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";
// La carte d'une boisson et le selecteur d'image vivent dans `./BeverageCard` : `/recettes` monte
// exactement la meme carte, et deux presentations d'un meme objet divergent des la premiere
// correction. Meme deplacement, meme raison, que `RecipeEditor` avant eux.
import BeverageCard, { resumeContenance, type Report } from "./BeverageCard";
import {
  beverageParams,
  resumeReglages,
  valeurSure,
  type BeanSystem,
  type Beverage,
  type Param,
  type RecipeParam,
} from "./beverage";
import { mfetch } from "./machine";
import { useMachinePush } from "./events";
import Icone from "./icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import Alerte from "./Alerte";
import { useConfirm } from "./confirm";
import { cleAnnonce, echecAnnonce } from "./register";
// Le libelle d etat de la machine est partage avec /pilotage : voir machineState.ts.
import { AGE_PERIME, AGE_PROGRESSION, fmtAge, sensorLabel, splitSensors, stateLabel, stepLabel, type HasTranslator, type Translator } from "./machineState";

// Les types de `/api/beverages` et les règles de valeur vivent dans `./beverage` : `/recipes`
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
// affiche exactement la même réponse et éditait sa propre version de ces types.
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
        /* **Le grain sélectionné est un fait d'ÉTAT MACHINE, pas une propriété d'une carte.**
           Il ne s'affichait que sur la carte « Espresso Bean Adapt » — une pastille sur vingt-huit
           cartes, donc invisible tant qu'on n'avait pas défilé jusqu'à elle, alors que c'est le
           réglage qui détermine le goût de cette tasse. Il monte donc dans la plaque du haut, à
           côté de la session et des capteurs, et il y reste visible sans rien chercher.
           Passé en prop plutôt que relu ici : `PowerCard` ne reçoit pas le catalogue, et lui
           ouvrir un second chemin vers les boissons en ferait une deuxième source de vérité. */
        bean={data?.beverages.find((b) => b.id === 200)?.beanSystem ?? null}
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
      {/* **La lampe verte des affiches se lit UNE fois, ici.** Vingt-trois cartes portaient
          « LU SUR LA MACHINE » en toutes lettres : une pastille vraie partout ne departage rien,
          et elle poussait la touche sur deux hauteurs. Reduite a un point, elle a besoin d'etre
          nommee — mais la nommer sur chaque carte reviendrait a la phrase qu'on vient de retirer,
          et un `title` seul ne se voit ni sur telephone ni sur tablette, les deux appareils que
          PRODUCT.md met au premier rang. Une legende de page, donc : le meme motif qu'un panneau
          de commande qui imprime la signification de ses temoins une fois, a cote d'eux. */}
      <p className="legendeMarques">
        <span className="lampeLue" aria-hidden="true" />
        {t("readFromMachineLegend")}
      </p>
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
          <div role="list" className="cards clavier">
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
                /* Les deux gestes de CETTE page : relire la boisson sur la machine, et la
                   preparer. `/recettes` en a d'autres, d'ou le fait qu'ils soient fournis ici
                   plutot que cables dans la carte. */
                /* **Une seule commande en tete, et c'est la seule qui serve debout devant la
                   machine : preparer.** « Lire » est descendu dans la carte depliee, ou il rejoint
                   « Infos techniques ».

                   ⚠️ Il n'a PAS ete supprime : `startImport("all", [b.id])` etait l'unique point
                   d'entree de la relecture d'une boisson sur cette page, un seul site d'appel dans
                   tout le fichier. Le retirer aurait retire la capacite du produit. Il vit
                   maintenant la ou vivent deja les gestes qui se meritent l'ouverture — et la
                   rangee de l'affiche n'a plus qu'un voisin a 8 px de l'action physique. */
                actions={({ nom }) => (
                  <button
                    className="good iconBtn"
                    disabled={busy}
                    aria-busy={pending === bevScope(b.id) || undefined}
                    aria-label={t("prepareFor", { beverage: nom })}
                    onClick={() => dispense(b)}
                  >
                    <Icone nom="preparer" />
                    <span className="lbl">{tc("prepare")}</span>
                  </button>
                )}
                /* La barre d'actions de l'EDITEUR, apres « Infos techniques ». La charge utile ne
                   sert pas ici : relire interroge la machine, elle n'envoie pas de reglages. */
                editorActions={() => (
                  <button
                    className="iconBtn"
                    disabled={busy}
                    aria-busy={pending === bevScope(b.id) || undefined}
                    aria-label={t("readFor", { beverage: bevLabel(b) })}
                    onClick={() => startImport("all", [b.id])}
                    title={t("readTitle")}
                  >
                    <Icone nom="lire" />
                    <span className="lbl">{tc("read")}</span>
                  </button>
                )}
                /* **La ligne de l'affiche : la contenance, deux valeurs au plus.** Voir
                   `resumeContenance`. La legende complete — nom d'usine, nombre de parametres,
                   compteur de categorie — reste celle de la carte OUVERTE : on la lit apres avoir
                   reconnu la boisson, jamais avant. */
                apercuCompact={resumeContenance(
                  beverageParams(b).filter((p) => p.kind === "user"),
                  paramLabel,
                  unitLabel,
                )}
                /* **Le bandeau de marques : ce qui departage, et rien d'autre.**

                   « lait » departage la moitie du catalogue. L'anomalie « desaligne » est rare,
                   donc informative. « lu sur la machine » est vraie sur les vingt-trois cartes :
                   en toutes lettres elle n'apprenait rien et occupait une ligne, elle se reduit
                   donc a une lampe — verte, parce que le vert de ce produit est reserve a ce que
                   la MACHINE rapporte, et parce que l'ambre doit rester le « choisi » de la touche
                   ouverte. Le point n'a pas de nom accessible a lui : il porte un texte hors vue,
                   et sa signification est enoncee UNE fois par page (voir `.legendeMarques`
                   ci-dessus) plutot que vingt-trois fois. Un `title` seul ne se voit ni sur
                   telephone ni sur tablette.

                   Le systeme de grains descend dans la carte ouverte : « Bean Adapt : Grain A »
                   est un attribut a lire quand on regle, pas quand on choisit. */
                marques={
                  <>
                    {b.milk && <span className="pill">{t("milk")}</span>}
                    {(() => {
                      const lu = b.bounds ?? b.values;
                      if (!lu) return null;
                      if (!lu.exact) {
                        return (
                          <span className="pill off aDroite" title={t("misalignedHint")}>
                            {t("misaligned")}
                          </span>
                        );
                      }
                      return (
                        <span className="lampeLue aDroite">
                          <span className="horsVue">{t("readFromMachine")}</span>
                        </span>
                      );
                    })()}
                  </>
                }
                /* **La vignette de tete de la carte ouvre la grille des dessins**, et c'est tout ce
                   que la carte fait : l'EFFET reste un geste de cette page-ci, puisqu'ici il ECRIT
                   dans la machine (`0xAB`). Le selecteur qui vivait dans `dessus` a disparu — il
                   montrait une deuxieme image du meme dessin, juste sous celle du titre, et c'etait
                   la plus basse des deux qui etait cliquable.

                   Toujours **seulement pour un emplacement perso NOMME** : `customSlot` n'est rempli
                   que la, et une ecriture `0xAB` a besoin d'un nom a reecrire. Ailleurs la prop est
                   absente, donc la vignette reste une image. */
                onChooseIcon={
                  b.customSlot !== null && b.icon !== null ? (icon) => setBeverageIcon(b, icon) : undefined
                }
                /* Un clic sur un dessin ÉCRIT dans la machine (`0xAB`, et le nom voyage dans la même
                   entrée de 21 octets). Le bouton « Enregistrer l'image » qui portait cet
                   avertissement a disparu ; l'avertissement, lui, suit les dessins. */
                titreChoix={t("imageConfirmWarning", { name: b.machineName ?? "" })}
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
  bean,
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
  /** La configuration de grains sélectionnée, ou `null` si le catalogue n'est pas encore chargé. */
  bean: BeanSystem | null;
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
  /**
   * **Et la question d'avant : est-ce qu'on SAIT ?**
   *
   * `isOn` est un booléen, donc il répond « éteinte » à deux questions différentes — « la machine
   * est éteinte » et « nous n'avons aucune idée ». Le premier principe du produit est de dire
   * l'état réel, **y compris l'ignorance**, et la ligne d'état juste en dessous le fait déjà avec
   * soin : « État inconnu — aucun monitor reçu », « En veille il y a 4 min — peut avoir changé
   * depuis ». L'interrupteur, six fois plus visible, affirmait ÉTEINT dans les deux cas.
   *
   * Deux situations, et elles ne se valent pas :
   * - `mon == null` — rien n'est jamais arrivé. On ne sait pas, point.
   * - `stale` — on a su, il y a plus de 90 s, et la machine ne parle que pendant une session
   *   LAN : la valeur affichée peut être fausse depuis longtemps.
   *
   * Dans les deux cas la position de la poignée est retirée (voir `.switch.inconnu`) et la
   * commande est désarmée : basculer un interrupteur dont on ne connaît pas la position, c'est
   * envoyer « Allumer » à une machine peut-être allumée. Le chemin reste ouvert — lancer une
   * lecture depuis /pilotage rétablit la session, et l'état avec.
   */
  const alimentationConnue = mon != null && !stale;
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
        {/* Le nom accessible dit l'ÉTAT quand il est inconnu, et l'ACTION quand il est connu :
            « Éteindre » sur un interrupteur dont on ignore la position est un mensonge, et c'est
            le seul texte qu'un lecteur d'écran reçoit de cette commande. */}
        <label
          className={"switch grand" + (alimentationConnue ? "" : " inconnu")}
          title={
            alimentationConnue
              ? isOn
                ? t("turnOff")
                : t("turnOn")
              : mon == null
                ? t("powerUnknown")
                : t("powerStale", { age: fmtAge(ageSec ?? 0, t) })
          }
        >
          <input
            type="checkbox"
            checked={alimentationConnue && isOn}
            disabled={busy || running || !alimentationConnue}
            aria-label={
              alimentationConnue
                ? isOn
                  ? t("turnOff")
                  : t("turnOn")
                : mon == null
                  ? t("powerUnknown")
                  : t("powerStale", { age: fmtAge(ageSec ?? 0, t) })
            }
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
            {/* **Un témoin vert n'a le droit de s'allumer que sur ce qu'on OBSERVE.** Hors session,
                un programme signalé plus tôt n'est plus observé : il devient une valeur en attente,
                et c'est la hachure d'attente qui le porte — pas la lampe de marche. Sans cette
                distinction, la plaque allumait simultanément un témoin vert « programme en cours »
                et un témoin rouge « hors session », deux sens opposés au même instant, sans qu'on
                puisse savoir lequel primait. */}
            {running && (
              <span
                className={status?.session?.active ? "pill on" : "pill attente"}
                title={status?.session?.active ? undefined : t("staleBadgeHint")}
              >
                {t("programBadge", { counter: status?.program?.counter ?? 0 })}
              </span>
            )}
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
            {/* **Le grain sélectionné.** Un lien, pas une pastille inerte, et pour la même raison
                que les alarmes juste au-dessus : la seule route vers « lequel, et pourquoi
                celui-là » était un attribut `title`, donc rien sur le téléphone ni la tablette —
                les deux appareils que PRODUCT.md met au premier rang. Il mène à `/beans`, où le
                grain se change et se relit.

                Deux formes, parce que deux choses distinctes peuvent être vraies : on sait
                TOUJOURS quel index est sélectionné (une lecture de propriété suffit), mais on ne
                sait le NOMMER qu'après un balayage `0xBA`. Afficher « Grain n° 2 » est alors
                exact ; inventer un nom, ou masquer la pastille, le serait moins. */}
            {bean && (
              <a
                className="pill"
                href="/beans"
                title={
                  bean.name
                    ? t("beanHint", { grinder: bean.grinder ?? 0, temperature: bean.temperature ?? 0, aroma: bean.aroma ?? 0 })
                    : t("beanHintNoName", { index: bean.index })
                }
              >
                {bean.name ? t("bean", { name: bean.name }) : t("beanIndex", { index: bean.index })}
              </a>
            )}
            {/* **Un désaccord est DIT, jamais arbitré.** Le serveur rend les deux index parce qu'il
                refuse de trancher (voir `activeBeanSystem`) ; s'il le disait et que l'interface le
                taisait, ce refus ne servirait à rien — l'écran montrerait l'un des deux comme s'il
                n'y avait jamais eu de doute. */}
            {bean?.disagree && (
              <a
                className="pill off"
                href="/beans"
                title={t("beanDisagreeHint", { sync: bean.disagree.sync, flag: bean.disagree.flag })}
              >
                {t("beanDisagree")}
              </a>
            )}
            <span className={status?.session?.active ? "pill on" : "pill off"}>
              {status?.session?.active ? t("lanSession") : t("noSession")}
            </span>
          </div>
        </div>
        {/*
          **La garde.** L'arrêt d'une préparation en cours est le seul geste de cette plaque qui
          interrompe l'appareil, et il vivait au coude à coude avec les commandes de lecture. La
          discipline retenue de la direction « console » veut qu'une action destructrice ou
          irréversible soit séparée dans l'ESPACE, pas seulement protégée par un dialogue : elle
          est donc posée dans son propre creux, cerné d'un filet rouge, à l'écart de tout ce qui
          ne fait que lire. Le capot au-dessus de l'interrupteur qu'on ne bascule pas par mégarde.

          Le libellé se replie à l'icône sur une carte étroite, comme les actions des cartes de
          boisson. `discret` tant qu'aucune préparation ne tourne — un rouge plein pour une action
          indisponible dominait la carte sans rien pouvoir faire.
        */}
        <div className="garde actions">
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
              {/* **Une échelle, pas une largeur.** Animer `width` fait recalculer la mise en page à
                  chaque image, et c'est le seul moment où cette page bouge toutes les secondes —
                  pendant une préparation, donc exactement quand on la regarde. `scaleX` sur une
                  barre pleine largeur donne le même dessin sans toucher au flux. */}
              <span
                className="jaugeBarre"
                style={{ transform: `scaleX(${(prepa.pourcent ?? 0) / 100})` }}
              />
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
        {/* ⚠️ **Ce n'était pas un `<select>` par hasard, et ce n'en est plus un — régression assumée.**

            Le `<select>` natif ouvre le sélecteur du SYSTÈME : sur téléphone, la molette sous le
            pouce, en bas de l'écran. Radix ouvre une liste dans la page. C'est un recul mesurable
            sur l'appareil le plus utilisé debout devant la machine, et il est pris en connaissance
            de cause : garder `<select>` sous `pointer: coarse` aurait donné DEUX implémentations du
            même choix, à tenir d'accord — le défaut que ce dépôt a déjà payé sur l'éditeur de
            recette et la carte de boisson, deux fois de suite. Une seule liste, dite dans la doc. */}
        <Select
          value={String(profile)}
          disabled={busy}
          onValueChange={(v) => onSelectProfile(Number(v))}
        >
          <SelectTrigger id="profil-actif" className="w-full" title={t("profileSelectHint")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* Le profil en cours d'affichage peut ne pas figurer dans la liste : elle ne montre que
                les profils renommes, et la machine peut tres bien etre sur un autre. L'omettre ferait
                afficher a la liste une valeur qui n'est pas celle utilisee — on l'ajoute plutot que
                de mentir sur le profil courant. */}
            {(shownProfiles.some((p) => p.id === profile)
              ? shownProfiles
              : [{ id: profile, name: null, renamed: false }, ...shownProfiles]
            ).map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name ?? tc("profileNumbered", { id: p.id })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
// La vignette et le nom d'une image vivent dans `./BeverageImage` : `/recipes` montre les mêmes
// dessins pour les mêmes boissons, et deux tables d'images seraient deux occasions de diverger.






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

