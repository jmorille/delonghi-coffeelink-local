"use client";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import { useMachineEvents } from "../events";
import { useConfirm } from "../confirm";
import ConfirmSettings from "../ConfirmSettings";
import { cleAnnonce, echecAnnonce } from "../register";
import { AGE_PERIME, AGE_PROGRESSION, fmtAge, sensorLabel, splitSensors, stateLabel, stateTone, stepLabel, taskLabel } from "../machineState";
import Alerte from "../Alerte";
import Icone from "../icons";
import { Badge } from "@/ui/badge";

/**
 * `stateTone` rend le vocabulaire des anciennes classes (`""`, `"on"`, `"info"`) ; les plaquettes
 * parlent maintenant en variantes. La table est ici plutôt que dans `machineState.ts` : cette
 * fonction décrit un ÉTAT MACHINE, et le nom de sa teinte est une affaire d'affichage.
 */
const TON_PLAQUETTE = { "": "plaque", on: "marche", info: "choisi" } as const;

/** Partie du monitor qu'on exploite ici — le reste de `/api/status` reste souple. */
interface Monitor {
  at: number;
  stateByte: number;
  switches: { name: string; label: string }[];
  alarmBits: number;
  alarms: { bit: number; name: string | null; ignored: boolean }[];
  /** Progression — octets 9, 10, 11. Voir `MONITOR_ETAPES` dans `server.mjs`. */
  fonction?: number | null;
  etape?: number | null;
  pourcent?: number | null;
  etapeCle?: string | null;
  auRepos?: boolean | null;
}

/** Le panneau qui a envoyé la commande : c'est là que son compte rendu s'affiche, pas en haut. */
type Scope = "liaison" | "power" | "activite";

export default function Dashboard() {
  const t = useTranslations("dashboard");
  const tp = useTranslations("power");
  const tc = useTranslations("common");
  const ta = useTranslations("alarm");
  const tsens = useTranslations("sensor");
  const ttask = useTranslations("task");
  const tbev = useTranslations("beverage");
  const tset = useTranslations("settings");
  const tpw = useTranslations("profilesWhat");
  const tconf = useTranslations("confirmations");
  const tapps = useTranslations("apps");
  /**
   * **Le nom d'une tâche, dit par nous et non par le serveur.** Les libellés de tâches étaient la
   * dernière chose que le serveur envoyait en français pour affichage direct, et ce panneau était
   * l'endroit où ça se voyait.
   *
   * `deref` résout les identifiants imbriqués dans leur propre espace — un slug de boisson, une
   * clé de réglage, la famille lue d'un import de profils. Sans lui il faudrait recopier ces
   * traductions dans l'espace `task`, et deux copies d'un même libellé divergent toujours.
   */
  const nomTache = useCallback(
    (tache: { label?: string; i18n?: any }) =>
      taskLabel(tache, ttask as any, (ns, cle) => {
        if (ns === "beverage") return tbev.has(cle) ? tbev(cle as any) : cle;
        if (ns === "setting") return tset.has(`label_${cle}`) ? tset(`label_${cle}` as any) : cle;
        if (ns === "profilesWhat") return tpw.has(cle) ? tpw(cle as any) : cle;
        return cle;
      }),
    [ttask, tbev, tset, tpw],
  );
  const [status, setStatus] = useState<any>(null);
  /**
   * Les applications branchées sur ce serveur quand il joue la machine. Lu dans le même
   * rafraîchissement que l'état : chaque évènement d'application passe par `L()`, donc par
   * `sseTouch`, donc ce panneau suit le flux sans minuteur à lui.
   */
  const [apps, setApps] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Retour de la dernière action. Sans lui, un refus du serveur (409 clé LAN absente) passait
   * totalement inaperçu : la page se contentait de rafraîchir l'état, inchangé.
   *
   * Il porte maintenant le **panneau** qui l'a déclenché. Il n'y en avait qu'un, tout en haut de la
   * page, alors que trois cartes envoient des commandes et que la dernière — les boissons — est à
   * ~900 px du titre sur une tablette : la confirmation d'un « Allumer » s'affichait hors écran.
   * C'est le défaut que PRODUCT.md nomme comme le pire possible pour ce produit, et l'accueil
   * l'avait déjà corrigé exactement de cette façon.
   */
  const [report, setReport] = useState<{ scope: Scope; text: string; kind: "ok" | "err" } | null>(null);
  const { demander, dialogue } = useConfirm();

  const refresh = useCallback(async () => {
    // En parallèle : deux requêtes indépendantes, et faire attendre l'état pour la liste des
    // applications n'aurait aucun sens. Un échec sur l'une ne doit pas emporter l'autre.
    const [s, a] = await Promise.all([
      mfetch("/api/status").then((r) => r.json()),
      mfetch("/api/apps").then((r) => r.json()).catch(() => null),
    ]);
    setStatus(s);
    if (a) setApps(a);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Cette page était la dernière à interroger `/api/status` sur un minuteur — toutes les 3 s, sans
   * fin, machine éteinte comprise. Mesuré : 9 requêtes et 47 ko en 16 s pour n'apprendre
   * strictement rien, et un rendu complet du journal à chaque fois.
   *
   * `useMachineEvents` et non `useMachinePush` : ce qu'on affiche ici — le journal, le monitor,
   * l'état de session, la file — n'est pas de la donnée *écrite* que `importedAt` horodate. C'est
   * de l'état, et le seul signal qui le concerne est la poussée elle-même. Le serveur n'émet que
   * quand une ligne de journal paraît (`sseTouch`) et bat à 2 s pendant qu'une fenêtre est ouverte
   * (`sseWatch`) : au repos, plus une seule requête ; pendant un programme, exactement la cadence
   * que le minuteur cherchait à imiter. Relire `/api/status` ne journalise rien, donc pas de
   * boucle (vérifié : dix appels, zéro évènement provoqué).
   */
  const { live } = useMachineEvents(refresh);

  // Repli, et seulement là : si le flux ne s'établit pas, on revient au minuteur, et on le dit.
  useEffect(() => {
    if (live) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [live, refresh]);

  const send = async (scope: Scope, bodyObj: any, ok?: (r: any) => string) => {
    setBusy(true);
    setReport(null);
    try {
      const r = await mfetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
      }).then((x) => x.json());
      // Même règle que l'accueil, et pour la même raison : voir `register.ts`. Annoncer un envoi
      // que l'annonce a démenti est ce qui a fait passer une machine injoignable pour un bouton
      // cassé.
      const annonce = echecAnnonce(r);
      setReport(
        r.error
          ? { scope, text: tc("error", { message: r.error }), kind: "err" }
          : annonce
            ? { scope, text: tc(cleAnnonce(annonce)), kind: "err" }
            : { scope, text: ok ? ok(r) : tp("powerSent", { label: r.program ?? "" }), kind: "ok" },
      );
      await refresh();
    } catch (e) {
      setReport({ scope, text: tc("error", { message: String(e) }), kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Allumer et éteindre passaient par un simple `onClick` : un clic, et de l'eau chaude coule par
   * la buse. L'accueil demande confirmation pour ce geste depuis toujours, avec la mise en garde
   * du rinçage à sa propre place dans le dialogue. Le même geste ne peut pas être protégé sur une
   * page et pas sur l'autre.
   */
  const power = (next: boolean) => {
    const verb = next ? tp("turnOn") : tp("turnOff");
    demander({
      question: tp("confirmPower", { verb }),
      warn: next ? tp("rinseWarning") : undefined,
      geste: "power",
      onConfirm: () => send("power", { action: next ? "on" : "off" }),
    });
  };

  /**
   * **L'arrêt ne dépend plus d'une boisson lancée depuis cette page** — il n'y en a plus. C'est la
   * règle que l'accueil applique déjà : le bouton est actif dès que la machine signale un programme
   * en cours, et quand nous ignorons quelle boisson coule, la confirmation le DIT au lieu de
   * laisser croire qu'on arrête ce qu'on voit.
   *
   * Le repli sur l'espresso reste nécessaire — la trame d'arrêt porte un identifiant de boisson —
   * mais il n'est plus tacite, et c'était tout le défaut : arrêter une boisson devinée alors que
   * rien ne coule n'est pas un arrêt, c'est une commande au hasard.
   */
  const stop = () => {
    if (!arretPossible) return;
    demander({
      question: tp("confirmStop", { beverage: "" }),
      detail: tp("stopUnknownBeverage"),
      // Le compte rendu suit le bouton : il est maintenant dans « Commandes machine ». Un refus
      // affiché à 400 px du geste qui l'a provoqué est un refus que personne ne lit.
      onConfirm: () =>
        send(
          "power",
          { action: "stop", beverageId: 1, profileId: status?.activeProfile ?? 1 },
          () => tp("stopSent"),
        ),
    });
  };

  /**
   * Lecture complète : six familles de données, six tâches. Rien n'est préparé ni écrit.
   *
   * La question posée ne porte pas sur un danger — il n'y en a aucun — mais sur la DURÉE, qui est
   * la seule vraie surprise : quelques minutes pendant lesquelles la machine sera occupée à nous
   * répondre. Elle dit aussi qu'une commande passera devant, sans quoi on pourrait croire la
   * cafetière confisquée le temps du balayage.
   */
  /**
   * **Sans confirmation, et c'est la file qui le permet.** La question posée avant servait à
   * prévenir d'un engorgement : sept tâches d'un coup, dans un serveur où chaque nouvelle demande
   * écrasait la précédente. Ce risque n'existe plus — les tâches s'empilent au rang `LECTURE`, une
   * commande passe devant, le panneau « Activité » les montre une par une et chacune a son
   * « Annuler ». Confirmer ne protège plus de rien ; il ne reste qu'un clic de plus.
   *
   * Les confirmations gardées ailleurs le sont pour la raison inverse : elles précèdent un geste
   * qui agit sur l'appareil — rinçage à l'eau chaude, écriture persistante — et qu'aucune file ne
   * rattrape après coup. Ici rien n'est préparé et rien n'est écrit : on ne fait que demander.
   */
  /**
   * **Interroger l'état : la commande `0x75`, forcée.**
   *
   * C'est la seule trame qui demande à la machine de dire où elle en est — état (veille / chauffe /
   * prête), capteurs, alarmes. `/api/presence` l'envoie déjà, mais **étranglé** : monitor de moins
   * de 30 s, file non vide, ou appel il y a moins de 8 s, et il refuse. C'est la bonne règle pour
   * l'appel automatique fait à l'ouverture d'une page — quatre onglets ne doivent pas ouvrir quatre
   * sessions. C'est la mauvaise pour un clic : on clique justement parce que la ligne « État de la
   * machine » est vide ou datée, et s'entendre répondre « monitor récent, ignoré » serait la
   * réponse inverse de la question. D'où `force: true`.
   *
   * Rang `LECTURE` comme toute lecture, et c'est voulu : une demande d'état ne doit pas doubler une
   * commande en cours. Elle double en revanche un balayage de compteurs (`LECTURE_BASSE`), qui est
   * le long travail derrière lequel on risquait vraiment d'attendre.
   */
  const readState = async () => {
    setBusy(true);
    setReport(null);
    try {
      const r = await mfetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      }).then((x) => x.json());
      const annonce = echecAnnonce(r);
      setReport(
        r.error
          ? { scope: "power", text: tc("error", { message: r.error }), kind: "err" }
          : annonce
            ? { scope: "power", text: tc(cleAnnonce(annonce)), kind: "err" }
            : { scope: "power", text: t("readStateSent"), kind: "ok" },
      );
      await refresh();
    } catch (e) {
      setReport({ scope: "power", text: tc("error", { message: String(e) }), kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  const readAll = async () => {
    setBusy(true);
    setReport(null);
    try {
      const r = await mfetch("/api/readall", { method: "POST" }).then((x) => x.json());
      const annonce = echecAnnonce(r);
      setReport(
        r.error
          ? { scope: "power", text: tc("error", { message: r.error }), kind: "err" }
          : annonce
            ? { scope: "power", text: tc(cleAnnonce(annonce)), kind: "err" }
            : { scope: "power", text: t("readAllSent", { count: r.count, steps: r.steps }), kind: "ok" },
      );
      await refresh();
    } catch (e) {
      setReport({ scope: "power", text: tc("error", { message: String(e) }), kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    setReport(null);
    try {
      const r = await mfetch("/api/register", { method: "POST" }).then((x) => x.json());
      setReport(
        r.error
          ? { scope: "liaison", text: tc("error", { message: r.error }), kind: "err" }
          : { scope: "liaison", text: t("registerSent", { status: r.status ?? "?" }), kind: "ok" },
      );
      await refresh();
    } catch (e) {
      setReport({ scope: "liaison", text: tc("error", { message: String(e) }), kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Le rang d'une tâche : c'est lui qui explique l'ordre affiché. Sans lui, voir « Arrêt » passer
   * devant un balayage lancé bien avant ressemble à un défaut plutôt qu'à une règle.
   */
  const Rang = ({ n }: { n: number }) => (
    <Badge variant={n === 0 ? "arret" : "plaque"}>{t(("rank" + n) as any)}</Badge>
  );

  /**
   * `role="status"` permanent, jamais monté à la demande : un conteneur inséré en même temps que
   * son texte n'est pas annoncé par les lecteurs d'écran. Vide, `.status:empty` le masque, donc la
   * carte ne porte pas une boîte creuse en attendant.
   */
  const Statut = ({ scope }: { scope: Scope }) => (
    <p className={"status " + (report?.scope === scope && report.kind === "err" ? "err" : "ok")} role="status">
      {report?.scope === scope ? report.text : ""}
    </p>
  );

  /**
   * **Le compte rendu de la liaison se lit sur la ligne qu'il décrit, pas dans un pavé sous le
   * bouton.** « Annonce envoyée à la machine (HTTP 202) » EST un état de la machine : le mettre
   * dans un encadré à part obligeait à faire l'aller-retour entre le bouton, le pavé, et la ligne
   * « État de la machine » qu'il commente — trois endroits pour une seule information, dans une
   * carte de quatre lignes.
   *
   * L'élément est monté en permanence, vide quand il n'y a rien : un `role="status"` créé en même
   * temps que son contenu n'est pas annoncé par les lecteurs d'écran, seul un changement DANS une
   * région déjà présente l'est. `.enLigne:empty` le fait disparaître visuellement sans le démonter.
   * L'échec garde le pictogramme d'alerte de la ligne « Serveur » juste au-dessus : même carte,
   * même avertissement, même dessin.
   */
  const StatutEnLigne = ({ scope }: { scope: Scope }) => {
    const r = report?.scope === scope ? report : null;
    return (
      <span className={"enLigne" + (r?.kind === "err" ? " alerte" : "")} role="status">
        {r && (
          <>
            {r.kind === "err" && <Icone nom="alerte" taille={15} />}
            <span>{r.text}</span>
          </>
        )}
      </span>
    );
  };

  const cfg = status?.config;
  const sess = status?.session;
  const mon: Monitor | null = status?.lastMonitor ?? null;

  /**
   * **L'âge de la dernière réponse, parce que « Session LAN : établie » ne le dit pas.**
   *
   * `session.active` vaut `!!m.session` côté serveur, et cette session n'est abandonnée que sur un
   * changement de configuration — clé LAN, adresse, réinitialisation. Jamais sur une inactivité,
   * jamais sur un délai. Elle affiche donc « établie » des heures après que la machine a cessé de
   * répondre, et c'est précisément la situation où l'on vient sur cette page. La seule preuve
   * datée qu'on possède est l'horodatage du monitor affiché juste à côté : la montrer transforme
   * une pastille qui affirme en une pastille qui se situe dans le temps.
   *
   * Battement local de 15 s, pour la même raison que sur l'accueil : personne ne pousse un
   * événement parce qu'une minute est passée. Sans lui, « il y a 12 s » resterait figé à 12 s et
   * le basculement vers « périmé » n'arriverait jamais. Aucune requête ne part, et il ne tourne
   * que s'il y a un monitor à dater.
   */
  const [, battement] = useState(0);
  useEffect(() => {
    if (!mon) return;
    const id = setInterval(() => battement((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, [mon]);
  const ageSec = mon ? Math.round((Date.now() - mon.at) / 1000) : null;
  const perime = ageSec != null && ageSec > AGE_PERIME;
  /**
   * **La progression a son PROPRE seuil de fraîcheur, bien plus court que `AGE_PERIME`.**
   *
   * Pendant une préparation la machine pousse une trame toutes les 1 à 3 secondes ; une lecture de
   * vingt secondes ne veut donc pas dire « ça avance lentement », elle veut dire qu'on a perdu le
   * contact. Sans ce seuil la ligne affirmait « Préparation en cours · 100 % » à partir d'une trame
   * vieille de 94 secondes, alors que le café était bu — constaté sur la page. L'accueil corrigeait
   * déjà ce défaut avec `AGE_PROGRESSION` ; cette page ne l'avait jamais reçu, et deux pages qui
   * datent différemment la même lecture est exactement la divergence que ce projet traque.
   *
   * Ici on ne cache pas la ligne comme le fait l'accueil : c'est la page de diagnostic, les trois
   * octets bruts sont ce qu'on vient y lire. On cesse seulement de les présenter comme un état
   * actuel.
   */
  const progFraiche = ageSec != null && ageSec <= AGE_PROGRESSION;
  /**
   * Âge du dernier ÉCHANGE, tous datapaquets confondus — pas seulement du monitor. C'est ce que
   * regarde le coupe-circuit, et c'est ce qui distingue « la session existe » de « la machine
   * répond ». Le même battement de 15 s le rafraîchit.
   */
  const contactSec = sess?.lastContactAt ? Math.round((Date.now() - sess.lastContactAt) / 1000) : null;
  const contactVieux = contactSec == null || contactSec > AGE_PERIME;

  /**
   * **La file de tâches, telle que le serveur la publie** (`machineActivity` → `vueFile`).
   *
   * Il n'y a plus « quatre états d'activité » à recoller : il y a UNE file, et tout ce que la
   * machine fait pour nous y est. Auparavant la page lisait `program` seul — une synchro des
   * profils, qui n'est pas un programme, n'y laissait aucune trace — et par ailleurs un
   * `status.queue` qui n'a jamais existé côté serveur.
   */
  const file = status?.queue ?? null;
  const encours = file?.encours ?? null;
  const attente: any[] = file?.attente ?? [];
  const finies: any[] = file?.finies ?? [];
  /**
   * **La derniere boisson preparee, tiree de la file.**
   *
   * Une tache de preparation est reconnue par sa cle de traduction (`i18n.k === "dispense"`), posee
   * dans la seule branche `dispense` de `/api/command` — c'est un identifiant du protocole, pas un
   * libelle a analyser : lire le francais de `label` pour en extraire un nom de boisson serait la
   * meme faute que traduire une chaine du serveur.
   *
   * L'ordre compte : la tache EN COURS d'abord (si c'est une preparation, c'est celle-la qui
   * coule), puis les terminees, que la file range de la plus recente a la plus ancienne. Les
   * taches EN ATTENTE sont exclues : elles n'ont rien prepare.
   *
   * Le nom vient de la meme source que le libelle de la tache : un nom SAISI sur la machine est un
   * parametre simple et ne se traduit pas ; sinon c'est un slug du catalogue, que le client nomme
   * lui-meme. Deux limites assumees : la file ne garde que cinq taches terminees, et une boisson
   * lancee au panneau de la machine n'est jamais passee par nous.
   */
  const derniereBoisson: string | null = (() => {
    const t = [encours, ...finies].find((x: any) => x?.i18n?.k === "dispense");
    if (!t) return null;
    const brut = (t as any).i18n;
    const perso = brut.p?.boisson;
    if (typeof perso === "string" && perso) return perso;
    const ref = brut.refs?.boisson;
    if (ref?.cle) return tbev.has(ref.cle) ? tbev(ref.cle as any) : ref.cle;
    return null;
  })();
  const rienEnFile = !encours && attente.length === 0 && finies.length === 0;
  /**
   * **Arrêter est possible dès que la machine signale un programme en cours** — plus « dès que cet
   * onglet a lancé une boisson », puisque cette page n'en lance plus. Même critère que l'accueil
   * (`stopAvailable`), qui a réglé cette question le premier : sans lui le bouton serait
   * définitivement inerte, ce qui est pire que de demander confirmation d'un arrêt imprécis.
   */
  /**
   * **Arrêtable = une préparation, pas « une tâche tourne ».** Depuis la file, `program.active`
   * est vrai dès qu'une lecture est en cours ; s'y fier allumait « Arrêter » pendant un balayage
   * de compteurs, en proposant de l'interrompre avec une trame d'arrêt de boisson. Le serveur
   * marque désormais la seule tâche qui se coupe (`dispense`). Limite assumée et inchangée depuis
   * toujours : une boisson lancée au panneau de la machine ne passe pas par nous, donc ne
   * s'affiche pas ici.
   */
  const arretPossible = status?.program?.dispense === true;

  /** La première tâche « muette » de la liste : la seule qui porte l'explication. Voir plus bas. */
  const premiereMuette = finies.find((t2: any) => t2.motif === "muette")?.id ?? null;

  /** Annule une tâche, ou toute la file. Rien ne part vers la machine : on retire du travail. */
  const annulerTaches = async (taskId?: string) => {
    const suite = async () => {
      setBusy(true);
      try {
        const r = await mfetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "clear", ...(taskId ? { taskId } : {}) }),
        }).then((x) => x.json());
        setReport({ scope: "activite", text: t("taskCancelled", { count: r.cleared ?? 0 }), kind: "ok" });
        await refresh();
      } catch (e) {
        setReport({ scope: "activite", text: tc("error", { message: String(e) }), kind: "err" });
      } finally {
        setBusy(false);
      }
    };
    // Une tâche seule part sans question — c'est du travail qu'on retire, rien n'atteint la
    // machine. Vider la file entière en demande une : elle emporte aussi ce qui est en cours.
    if (taskId) return suite();
    demander({
      question: t("taskCancelAllConfirm", { count: attente.length + (encours ? 1 : 0) }),
      onConfirm: suite,
    });
  };

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      {/* Message unifié avec celui de la page d'accueil, et qui renvoie vers la page qui sait
          récupérer la clé — l'ancien texte ne parlait que de .env.local, antérieur à la page. */}
      {cfg && !cfg.lanKeySet && (
        <Alerte>
          {tc("noLanKey")} <a href="/machines">{tc("noLanKeyLink")}</a>
        </Alerte>
      )}

      {/* L'adresse annoncée était affichée comme un fait neutre, alors qu'une boucle locale rend
          tout pilotage impossible. La page montrait « 127.0.0.1:80 » et « Session LAN : en
          attente » sans jamais relier les deux. */}
      {cfg?.serverIpProblem && <Alerte>{tc("badServerIp", { problem: cfg.serverIpProblem })}</Alerte>}

      {!live && <p className="sub">{tc("pushOff")}</p>}

      {/* **Sept bandes pleine largeur sont devenues des panneaux.** Quatre d'entre elles ne
          contenaient qu'une phrase — « Aucun monitor reçu », « Aucune commande en attente » — dans
          une carte de 1 150 px de large : le gabarit était répété, il ne décrivait pas le contenu.
          Les commandes machine remontent contre l'état, parce que c'est ce qu'on vient faire après
          l'avoir lu, et sur téléphone aussi ce voisinage est le bon. Le journal, seul bloc dense,
          prend la rangée entière. */}
      <div className="panneaux">
      <section aria-labelledby="titre-liaison">
      {/* Six sections sur sept portaient un titre ; celle-ci n'en avait pas, et les deux colonnes
          démarraient donc à des hauteurs différentes. Un panneau se nomme. */}
      <h2 id="titre-liaison">{t("connection")}</h2>
      <div className="card">
        {/* Le bouton était à droite d'un `space-between`, donc à 700 px des lignes qu'il concerne
            dans une carte pleine largeur. On lit l'état, puis on agit : il passe dessous. */}
        {/* **`<dl>`, et pas un `<div>` de `<span>`.** Ces lignes SONT des paires nom/valeur, et
            l'appariement n'existait qu'à l'œil : la grille à deux colonnes. Lu en linéaire — lecteur
            d'écran, ou agent qui lit l'arbre d'accessibilité — on recevait « Session LAN », « en
            attente », « Adresse et numéro de série », « 192.168.30.42 »… huit textes de suite dont
            rien ne disait lesquels vont ensemble. `<dt>`/`<dd>` le disent. Le `<div className="kv">`
            reste : il porte la grille, et il est permis comme groupe dans un `<dl>`. */}
        <dl className="kvListe">
            <div className="kv">
              <dt className="k">{t("lanSession")}</dt>
              {/* **« Établie » ne suffit pas, parce que c'est un verrou.** Côté serveur `active`
                  vaut `!!m.session` et n'est abandonné que sur un changement de configuration :
                  jamais sur une inactivité, jamais sur un délai. Il affirmait donc une liaison
                  vivante sur la foi d'un échange de clés qui pouvait dater de plusieurs heures —
                  précisément le cas où l'on vient ici parce que « la session est établie mais elle
                  ne répond pas ». `lastContactAt` est daté par chaque datapaquet reçu : au-delà de
                  `AGE_PERIME`, la pastille cesse d'être verte et la ligne dit depuis quand. */}
              <dd className="titreLigne">
                <Badge variant={sess?.active ? (contactVieux ? "plaque" : "marche") : "arret"}>
                  {sess?.active ? t("sessionEstablished") : t("sessionWaiting")}
                </Badge>
                {sess?.active && contactSec != null && (
                  <span className="sub">
                    {contactVieux
                      ? t("sessionStale", { age: fmtAge(contactSec, tp) })
                      : t("sessionFresh", { age: fmtAge(contactSec, tp) })}
                  </span>
                )}
                {sess?.active && contactSec == null && <span className="sub">{t("sessionNoContact")}</span>}
              </dd>
            </div>
            <div className="kv">
              <dt className="k">{t("machineAddress")}</dt>
              <dd className="mono">{cfg?.machineIp} · {cfg?.dsn}</dd>
            </div>
            <div className="kv">
              <dt className="k">{t("server")}</dt>
              {/* La ligne fautive porte le pictogramme du bandeau, pas un émoji : c'est le même
                  avertissement, et il doit se reconnaître au même dessin. */}
              <dd className={cfg?.serverIpProblem ? "mono alerte" : "mono"}>
                {cfg?.serverIpProblem && <Icone nom="alerte" taille={15} />}
                <span>
                  {cfg?.serverIp ?? tc("none")}:{cfg?.serverPort}
                </span>
              </dd>
            </div>
            <div className="kv">
              <dt className="k">{t("machineStateMonitor")}</dt>
              <dd className="titreLigne">
                {/* Même pastille que la ligne « Session LAN » quatre lignes plus haut, et même
                    fonction de libellé que l'accueil (`machineState.ts`). Avant : trois émojis
                    (⚪ 🟢 🟠) et une cascade de ternaires recopiée — le même état de la même
                    machine avait deux apparences selon la page. */}
                {mon ? (
                  <Badge variant={TON_PLAQUETTE[stateTone(mon.stateByte)]}>{stateLabel(mon.stateByte, tp)}</Badge>
                ) : (
                  tc("dash")
                )}
                {/* Au-delà de `AGE_PERIME`, la mention dit en toutes lettres que l'état affiché
                    peut avoir changé — même seuil et même formule que l'accueil (`fmtAge`), sinon
                    les deux pages daterait la même lecture différemment. */}
                {ageSec != null && (
                  <span className="sub">
                    {perime
                      ? t("monitorAgeStale", { age: fmtAge(ageSec, tp) })
                      : t("monitorAge", { age: fmtAge(ageSec, tp) })}
                  </span>
                )}
                {/* Le retour de « Rappeler la machine » : voir `StatutEnLigne`. La pastille dit ce
                    que la machine rapporte, ce texte dit ce que NOUS venons de tenter — les deux
                    répondent à « où en est la liaison », donc ils tiennent sur la même ligne. */}
                <StatutEnLigne scope="liaison" />
              </dd>
            </div>
            {/* **La progression, en valeurs BRUTES — c'est la page du protocole.** L'accueil en
                fait une barre pour qui attend son café ; ici on montre les trois octets tels
                qu'ils arrivent, parce que c'est ce qu'on vient lire quand une préparation se
                comporte mal. La ligne disparaît au repos plutôt que d'afficher trois tirets :
                `f=7 e=0` n'apprend rien à personne. */}
            {mon && mon.auRepos === false && (
              <div className="kv">
                {/* **L'etiquette suit la fraicheur, sinon elle ment.** « Preparation en cours »
                    au-dessus d'une lecture vieille de 94 secondes est exactement le defaut
                    signale : la boisson etait bue. Fraiche, la ligne decrit ce qui coule ;
                    datee, elle decrit la derniere preparation connue — et le contenu le dit
                    deja (pastille d'age, nom de la boisson). */}
                <dt className="k">{progFraiche ? t("monitorProgress") : t("monitorProgressLast")}</dt>
                <dd className="titreLigne">
                  {/* **Ne pas répéter le libellé de la ligne dans sa valeur.** `stepLabel(null)`
                      rend « Préparation en cours », mot pour mot ce que dit déjà le `dt` : sur une
                      étape sans nom — il y en a cinq d'observées — la ligne s'affichait deux fois
                      d'affilée. On ne nomme donc l'étape que lorsqu'elle A un nom. */}
                  {progFraiche ? (
                    mon.etapeCle ? <span>{stepLabel(mon.etapeCle, tp)}</span> : null
                  ) : (
                    <Badge variant="arret" title={t("monitorProgressStaleHint")}>
                      {t("monitorProgressStale", { age: fmtAge(ageSec as number, tp) })}
                    </Badge>
                  )}
                  {/* **Le nom de la boisson plutot que les trois octets.** « 100 % · fonction 0,
                      etape 2 » ne dit rien a personne a cote d'un libelle qui annonce une
                      preparation ; le nom de ce qui vient de couler, si. Les octets ne sont pas
                      perdus pour autant — ils restent en infobulle, parce que c'est encore la page
                      du protocole et qu'ils sont ce qu'on vient y lire quand une preparation se
                      comporte mal. Sans boisson connue (file ecoulee, ou boisson lancee au panneau
                      de la machine), on retombe sur les octets en clair : mieux vaut une valeur
                      brute qu'une ligne vide. */}
                  {derniereBoisson ? (
                    <span title={t("monitorProgressRaw", { percent: mon.pourcent ?? -1, f: mon.fonction ?? -1, e: mon.etape ?? -1 })}>
                      {derniereBoisson}
                    </span>
                  ) : (
                    <span className="sub mono">
                      {t("monitorProgressRaw", {
                        percent: mon.pourcent ?? -1,
                        f: mon.fonction ?? -1,
                        e: mon.etape ?? -1,
                      })}
                    </span>
                  )}
                </dd>
              </div>
            )}
            {/* La ligne « Programme en cours » vivait ici et répondait « oui » ou « — ». Elle est
                partie dans le panneau « Activité » juste dessous, qui la remplace en nommant ce qui
                tourne : « oui » ne distinguait pas un café qui coule d'une lecture de compteurs, et
                surtout il ne connaissait qu'un des quatre états d'activité du serveur. */}
        </dl>
        <div className="row note">
          {/* **Le libellé reste visible sur cette page, donc pas d'`aria-label`.** /machines en pose
              un partout parce que ses libellés PEUVENT disparaitre : le repli a l'icone est une
              container query sur `.actions`, qui n'existe pas ici. Doubler un texte visible par un
              `aria-label` identique n'ajoute rien et cree un endroit ou les deux peuvent diverger —
              ce qui casse la regle « le nom accessible contient le texte vu ». */}
          <button className="iconBtn" onClick={register} disabled={busy} title={t("announceTitle")}>
            <Icone nom="annonce" />
            <span className="lbl">{t("announce")}</span>
          </button>
        </div>
      </div>
      </section>

      <section aria-labelledby="titre-commandes">
      <h2 id="titre-commandes">{t("machineCommands")}</h2>
      <div className="card">
        <div className="row">
          <button className="good iconBtn" disabled={busy} onClick={() => power(true)}>
            <Icone nom="marche" />
            <span className="lbl">{tp("turnOn")}</span>
          </button>
          <button className="danger discret iconBtn" disabled={busy} onClick={() => power(false)}>
            <Icone nom="marche" />
            <span className="lbl">{tp("turnOff")}</span>
          </button>
          {/* **Le troisième ordre donné à l'appareil, à côté des deux autres.** Il reste désactivé
              tant que le serveur ne signale aucune préparation (`program.dispense`) : sans boisson
              en cours, la trame d'arrêt partirait avec un espresso deviné. Rouge en contour, le
              traitement que le produit réserve à ce qui interrompt. */}
          <button
            className="danger discret iconBtn"
            disabled={busy || !arretPossible}
            onClick={stop}
            title={arretPossible ? tp("stopTitle") : t("stopUnavailable")}
          >
            <Icone nom="arreter" />
            <span className="lbl">{t("stopPreparation")}</span>
          </button>
        </div>

        {/* **Séparé des trois au-dessus, et c'est le point.** Ces trois-là agissent sur l'appareil ;
            celui-ci ne fait que demander. Les mettre dans la même rangée aurait donné le même poids
            à « couper l'eau chaude » et à « relire des compteurs ». */}
        <h3 className="titreBloc">{t("commandsRead")}</h3>
        <div className="row">
          {/* **L'état d'abord, le reste ensuite — mais au même gabarit.** Une trame contre
              quatre-vingt-dix : « Lire l'état » est la question qu'on pose le plus souvent (« elle
              est allumée ? elle répond ? ») et la moins chère, d'où sa place en tête. La différence
              d'étendue s'arrête là : les deux boutons sont de même nature (ils ne font que
              demander), donc de même taille. Le `.mini` essayé ici venait de /statistiques, où il
              oppose deux balayages de la MÊME action ; entre deux lectures distinctes il ne disait
              plus « moins large », il disait « moins important », à côté d'une rangée de commandes
              pleine hauteur. Ne pas le réintroduire. */}
          <button className="iconBtn" disabled={busy} onClick={readState} title={t("readStateTitle")}>
            <Icone nom="oeil" />
            <span className="lbl">{t("readState")}</span>
          </button>
          <button className="iconBtn" disabled={busy} onClick={readAll} title={t("readAllTitle")}>
            <Icone nom="lire" />
            <span className="lbl">{t("readAll")}</span>
          </button>
        </div>
        <Statut scope="power" />
      </div>
      </section>

      {/* **Le panneau qui manquait, à la place d'une table qui ne pouvait rien afficher.**
          Ici se trouvait « File de commandes », qui lisait `status.queue` — un champ que
          `/api/status` n'a jamais renvoyé. Cette forme (`label` / `needsAck` / `queuedAt`) vient de
          `src/lib/session.ts`, une des copies fantômes qui ne tournent pas : `server.mjs` n'a pas de
          file de commandes ECAM, il tient UNE trame en vol (`m.program`) et une file de LECTURES
          (`m.import`). La table annonçait donc « Aucune commande en attente » cent pour cent du
          temps, balayage des grains compris.

          Ce qu'on venait y chercher est réel, mais vivait ailleurs : sur quatre états d'activité,
          `/api/status` n'en publiait qu'un. Une synchro des profils — un `startImport` pur, sans
          aucun programme — ne laissait aucune trace sur cette page, et un balayage des grains n'y
          disait ni quel grain ni où il en était.

          **Sa place est sous les commandes, et c'est la lecture naturelle de la page** : la liaison
          dit si la machine nous entend, les commandes sont ce qu'on vient faire, l'activité est ce
          qui en découle. Au-dessus, le panneau demandait de suivre une file avant d'avoir vu ce qui
          la remplit — et le geste le plus fréquent, allumer, se trouvait repoussé sous un bloc qui
          dit « rien en file » la plupart du temps. */}
      <section aria-labelledby="titre-activite">
      <h2 id="titre-activite">{t("activity")}</h2>
      {/* **La seule carte de la page qui change toute seule, donc la seule qui doit s'annoncer.**
          Elle se remet à jour toutes les deux secondes pendant qu'un programme tourne, et rien n'en
          avertissait un lecteur d'écran : `role="status"` le fait.
          `aria-atomic="false"` est délibéré et n'est pas un détail : `role="status"` implique
          `atomic=true`, donc la carte ENTIÈRE serait relue à chaque fois — et comme `étape n`
          s'incrémente toutes les deux secondes, ce serait quatre lignes relues en boucle. À `false`,
          seul le fragment qui a bougé est annoncé : « étape 5 », ou la ligne qui vient d'apparaître. */}
      <div className="card" role="status" aria-atomic="false">
        {rienEnFile ? (
          <p className="sub">{t("activityIdle")}</p>
        ) : (
          <>
            {encours && (
              <>
                <h3 className="titreBloc">{t("taskRunning")}</h3>
                <dl className="kvListe">
                  <div className="kv">
                    {/* Le rang vit dans la colonne des VALEURS, pas dans celle du libellé : la
                        colonne de gauche est bornée à 13 rem, donc « Balayage des grains 0–5 »
                        suivi d'une pastille repliait et la pastille retombait sous le nom, où elle
                        ressemblait à un deuxième libellé. */}
                    <dt className="k">{nomTache(encours)}</dt>
                    <dd className="titreLigne">
                      <Rang n={encours.rang} />
                      <Badge variant="marche">{t("taskProgress", { faits: encours.faits, total: encours.total })}</Badge>
                      {/* Le pas courant est un nom de propriété Ayla ou un libellé de trame :
                          chasse fixe, comme partout où cette page montre du protocole. */}
                      {encours.pasCourant && <span className="mono sub">{t("taskStep", { pas: encours.pasCourant })}</span>}
                      {encours.repris > 0 && <span className="sub">{t("taskRetried", { count: encours.repris })}</span>}
                    </dd>
                  </div>
                </dl>
              </>
            )}

            {/* **La file d'attente, et c'est le cœur de ce que cette page ne pouvait pas montrer.**
                Ce qui arrivait pendant qu'une tâche tournait écrasait la précédente sans un mot :
                il n'y avait rien à afficher parce qu'il n'y avait rien qui attendait. */}
            {attente.length > 0 && (
              <>
                <h3 className="titreBloc">{t("taskWaiting")}</h3>
                <dl className="kvListe">
                  {attente.map((tache) => (
                    <div className="kv" key={tache.id}>
                      <dt className="k">{nomTache(tache)}</dt>
                      <dd className="titreLigne etire">
                        <Rang n={tache.rang} />
                        <span className="sub">{t("taskSteps", { count: tache.total })}</span>
                        {/* **Icône seule, et le nom accessible reste.** Une ligne de file, c'est un
                            libellé de tâche, un rang, un nombre de pas — le mot « Annuler » répété à
                            chaque ligne pesait plus lourd que ce qu'il annule, et poussait le rang
                            et le compte de pas vers la gauche. Le geste, lui, ne change pas de
                            nature : `aria-label` le nomme pour un lecteur d'écran, `title` pour la
                            souris. Ne pas retirer l'un des deux — une icône ne nomme rien.
                            « Vider la file », en dessous, garde son libellé : il est unique sur la
                            carte et n'annule pas la même chose. */}
                        <button
                          className="danger discret iconBtn iconSeul aDroite"
                          disabled={busy}
                          onClick={() => annulerTaches(tache.id)}
                          aria-label={t("taskCancel")}
                          title={t("taskCancelTitle")}
                        >
                          <Icone nom="fermer" />
                        </button>
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            {/* **Le verdict des tâches terminées, qui disparaissait avec elles.** Une lecture qui
                n'a rien lu est indiscernable d'une lecture qui n'a pas encore répondu si on ne
                montre que ce qui tourne. */}
            {finies.length > 0 && (
              <>
                <h3 className="titreBloc">{t("taskDone")}</h3>
                <dl className="kvListe">
                  {finies.map((tache) => (
                    <div className="kv" key={tache.id}>
                      <dt className="k">{nomTache(tache)}</dt>
                      <dd className="titreLigne">
                        <Badge variant={tache.etat === "faite" ? "marche" : "arret"}>
                          {t(("state_" + tache.etat) as any)}
                        </Badge>
                        <span className="sub">{t("taskProgress", { faits: tache.faits, total: tache.total })}</span>
                        {/* **Le compte des demandes repliées.** Les terminées se replient sur leur
                            clé : une présence rejouée cinq fois ne laisse que son dernier verdict,
                            les quatre précédents décrivant un état révolu. Mais le compte reste,
                            même règle que le repli du journal juste en dessous — « réussie » sans
                            « ×5 » ferait oublier qu'il a fallu s'y reprendre. Il vit dans la
                            colonne de VALEUR : la colonne d'étiquette est bornée à 13 rem, une
                            pastille y passe sous le label et se lit comme un second label. */}
                        {tache.repetitions > 1 && (
                          <span className="sub" title={t("taskRepeatsHint")}>
                            {t("taskRepeats", { count: tache.repetitions })}
                          </span>
                        )}
                        {tache.nonLus > 0 && <span className="sub">{t("taskUnread", { count: tache.nonLus })}</span>}
                        {/* Le motif « muette » a une cause précise et une réparation précise : la
                            dire ici évite d'aller la chercher dans le journal. Mais **une seule
                            fois** : un coupe-circuit annule toute la file d'un coup, et la même
                            explication de trois lignes répétée cinq fois chassait de l'écran les
                            verdicts qu'elle est censée expliquer. */}
                        {tache.motif === "muette" && tache.id === premiereMuette && (
                          <span className="sub">{t("taskMuteHint")}</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            {(encours || attente.length > 0) && (
              <div className="row note">
                <button className="danger discret iconBtn" disabled={busy} onClick={() => annulerTaches()}>
                  <Icone nom="fermer" />
                  <span className="lbl">{t("taskCancelAll")}</span>
                </button>
              </div>
            )}
          </>
        )}
        <Statut scope="activite" />
      </div>
      </section>

      {/* `id` : la pastille « alarme signalée » de l'accueil mène ici. C'était la seule route vers
          « quelle alarme ? », et elle vivait dans un attribut `title` — donc nulle part au doigt. */}

      {/**
        * **Les applications branchées, c'est-à-dire qui d'autre parle à cette machine.**
        *
        * Sa raison d'être tient à une mesure du 2026-08-22 (`doc/analyse-connexion-wifi.md` §7ter) :
        * la machine ne retient qu'UN interlocuteur local, et une application De'Longhi ouverte sur
        * le réseau évince ce serveur **sans aucun signal** — nos annonces restent acceptées, la
        * machine cesse simplement de venir. Ce panneau est le seul endroit d'où l'on peut voir la
        * différence entre « une application a pris la main » et « la machine est éteinte », qui
        * jusqu'ici produisaient exactement le même symptôme.
        *
        * Placé juste après « Activité » : la file dit ce qui est demandé, ceci dit par qui.
        *
        * Rendu **même quand le multiplexeur est éteint**, ce qui est le cas par défaut. Masquer la
        * section rendrait la fonctionnalité invisible à quiconque ne lit pas la documentation, et
        * surtout : « aucune application » et « on ne regarde pas » ne sont pas la même information.
        */}
      <section aria-labelledby="titre-apps">
      <h2 id="titre-apps">{tapps("heading")}</h2>
      <div className="card">
        {/* Trois états, pas deux. Tant que `/api/apps` n'a pas répondu, on ne sait pas — et la
            première version affichait « multiplexeur éteint » pendant ce temps, c'est-à-dire une
            affirmation fausse sur un onglet fraîchement ouvert alors qu'une vraie application était
            branchée. Même règle que le menu et son `lanKeySet === null` : l'inconnu ne se rend pas
            comme le négatif. Une carte vide le temps d'un aller-retour vaut mieux qu'une phrase à
            démentir. */}
        {!apps ? null : !apps.actif ? (
          <>
            <p className="sub">{tapps("off")}</p>
            <p className="sub">{tapps("offHint")}</p>
          </>
        ) : (
          <>
            {/* Le port avant tout le reste : c'est la réponse à « pourquoi rien n'arrive ». */}
            {!apps.portOk && (
              <p className="sub attention">{tapps("portWarn", { port: apps.port, attendu: apps.portAttendu })}</p>
            )}
            <p className="sub">{tapps("warning")}</p>
            {!apps.apps?.length ? (
              <>
                <p className="sub">{tapps("none")}</p>
                <p className="sub">{tapps("noneHint")}</p>
              </>
            ) : (
              <dl className="kvListe">
                {apps.apps.map((a: any) => (
                  <div className="kv" key={a.id}>
                    <dt className="k">{a.ip}:{a.port}</dt>
                    <dd>
                      <span className={`pill${a.etat === "etablie" ? "" : " off"}`}>
                        {a.etat === "etablie" ? tapps("stateEstablished") : a.etat === "expiree" ? tapps("stateExpired") : tapps("stateAnnounced")}
                      </span>
                      {a.machine && <span className="sub">{tapps("machine", { machine: a.machine })}</span>}
                      <span className="sub">{tapps("traffic", { datapoints: a.datapoints, commandes: a.commandes })}</span>
                      <span className="sub">{tapps("seen", { age: a.ageSec })}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <h3>{tapps("refusHeading")}</h3>
            {!apps.refus?.length ? (
              <p className="sub">{tapps("refusNone")}</p>
            ) : (
              <dl className="kvListe">
                {apps.refus.map((r: any, i: number) => (
                  <div className="kv" key={`${r.from}-${r.motif}-${i}`}>
                    <dt className="k">{r.from}</dt>
                    <dd>
                      <Badge variant="arret">
                        {tapps.has(`motif_${r.motif}`) ? tapps(`motif_${r.motif}` as any) : r.motif}
                      </Badge>
                      {r.detail && <span className="sub">{r.detail}</span>}
                      {/* Le compte, jamais perdu : une ligne repliée sans lui se lit comme un
                          incident isolé là où il y en a eu une douzaine. Même règle que le journal. */}
                      {r.repetitions > 1 && <span className="sub">{tapps("repeats", { count: r.repetitions })}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
      </div>
      </section>

      <section id="alarmes" aria-labelledby="titre-alarmes">
      <h2 id="titre-alarmes">{t("alarms")}</h2>
      <div className="card">
        {!mon ? (
          <p className="sub">
            {t("alarmsUnread")}
          </p>
        ) : !mon.alarms?.length ? (
          <p className="sub">
            {t("noAlarms")}
          </p>
        ) : (
          /* **Les pannes portaient le seul traitement neutre de la page**, en lignes clé/valeur,
             pendant que les capteurs juste en dessous s'affichaient en pastilles vertes. La
             hiérarchie était inversée deux fois : ce qu'il faut traiter était gris, ce qui ne
             demande rien était en couleur de marche. Même forme que les capteurs — une rangée de
             pastilles — pour que les deux blocs se comparent, et le rouge sur celui qui le mérite. */
          <div className="row">
            {mon.alarms.map((a) =>
              a.name ? (
                <Badge variant="arret" key={a.bit}>
                  {ta.has(a.name) ? ta(a.name) : a.name}
                </Badge>
              ) : (
                <Badge variant="plaque" key={a.bit}>
                  {t("alarmIgnored")}
                </Badge>
              ),
            )}
          </div>
        )}
      </div>
      </section>

      <section aria-labelledby="titre-capteurs">
      <h2 id="titre-capteurs">{t("sensors")}</h2>
      <div className="card">
        {!mon?.switches?.length ? (
          <p className="sub">
            {/* La section Capteurs empruntait le message des alarmes : elle annonçait « l'état des
                alarmes est inconnu » sous le titre « Capteurs ». Un état vide doit nommer ce qui
                manque, pas ce qui manque ailleurs. */}
            {mon ? t("noSensors") : t("sensorsUnread")}
          </p>
        ) : (
          /* Voir `splitSensors` : « niveau d'eau bas » ne se peint pas de la même couleur que
             « carafe à lait ». Les deux étaient vertes. */
          <div className="row">
            {splitSensors(mon.switches).attention.map((sw) => (
              <Badge variant="arret" key={sw.name} title={tp("sensorsAttention")}>
                {sensorLabel(sw, tsens)}
              </Badge>
            ))}
            {splitSensors(mon.switches).presents.map((sw) => (
              <Badge variant="plaque" key={sw.name}>
                {sensorLabel(sw, tsens)}
              </Badge>
            ))}
          </div>
        )}
      </div>
      </section>

      {/* **La carte « Boissons » a été retirée.** Elle rejouait la grille de l'accueil — une
          deuxième liste de boutons qui font couler du café, sur une page dont le titre est
          « Pilotage local » et dont le reste décrit un état. Deux endroits pour le même geste, et
          celui-ci n'avait ni les noms lus sur la machine, ni les réglages du profil, ni l'éditeur
          de recette : il proposait la même action, moins bien. L'arrêt, lui, est resté — il est
          remonté dans « Commandes machine », voir plus haut. */}
      {/* Placé après les deux blocs qu'il gouverne — les commandes machine et les boissons — et non
          en tête de page : c'est un réglage de comportement, pas un état à surveiller. */}
      <section aria-labelledby="titre-confirmations">
      <h2 id="titre-confirmations">{tconf("heading")}</h2>
      <ConfirmSettings />
      </section>

      {/* Le journal des applications, en bloc autonome et jumeau de celui de la machine : même
          `pleine`, même `card log`, même rendu de ligne. Ce sont deux chronologies de même rang —
          ce que la cafetière a répondu d'un côté, ce que les téléphones ont demandé de l'autre —
          et les lire côte à côte est précisément ce qu'on fait quand une commande d'application
          n'aboutit pas. Sous-titre d'une carte, il se lisait comme une annexe de la liste ; il en
          est le pendant. Il précède celui de la machine parce que la conversation avec le
          téléphone est en amont : c'est elle qui déclenche ce que la machine finit par répondre.

          Rendu seulement quand le multiplexeur est ACTIF, contrairement au panneau au-dessus : ce
          dernier doit dire « nous ne regardons pas », ce qu'aucune ligne de journal ne peut dire.
          Une fois cette phrase écrite là-haut, un journal vide ne ferait que la répéter, en moins
          clair. */}
      {apps?.actif && (
        <section className="pleine" aria-labelledby="titre-journal-apps">
        <h2 id="titre-journal-apps">{tapps("journalHeading")}</h2>
        <div className="card log">
          {!apps.journal?.length ? (
            <p className="sub">{tapps("journalNone")}</p>
          ) : (
            apps.journal.map((e: any, i: number) => (
              <div key={e.n ?? i} className={e.dir}>
                [{new Date(e.t).toLocaleTimeString()}] {e.dir.toUpperCase()}
                {/* L'identifiant est une COLONNE, pas un préfixe de message : c'est ce qui permet
                    de suivre un téléphone parmi trois. Pour un refus, il n'y a pas encore d'entrée
                    au registre, et c'est l'adresse qui tient la place. */}
                {e.app ? ` · ${e.app}` : ""} · {e.msg}
                {/* Le serveur replie les lignes consécutives identiques (voir `LA()`), et une
                    rediffusion d'état se répète toutes les 1 à 3 s pendant une préparation : sans
                    ce compte, vingt envois se liraient comme un seul. */}
                {e.repetitions > 1 ? ` (×${e.repetitions})` : ""}
              </div>
            ))
          )}
        </div>
        </section>
      )}

      <section className="pleine" aria-labelledby="titre-journal">
      <h2 id="titre-journal">{t("journal")}</h2>
      <div className="card log">
        {status?.log?.map((e: any, i: number) => (
          <div key={e.n ?? i} className={e.dir}>
            [{new Date(e.t).toLocaleTimeString()}] {e.dir.toUpperCase()}
            {/* Le journal est unique, toutes machines confondues : sans cette étiquette, deux
                cafetières produiraient une chronologie indéchiffrable. Elle n'apparaît qu'à partir
                de deux machines, sinon elle se répéterait à chaque ligne pour rien. */}
            {(status?.machines?.length ?? 0) > 1 && e.m ? ` · ${e.m}` : ""} · {e.msg}
            {/* Le serveur replie les répétitions consécutives (voir `L()`) : sans ce compte, une
                ligne repliée ferait croire à un incident isolé là où il y en a eu vingt-quatre. */}
            {e.repetitions > 1 ? ` (×${e.repetitions})` : ""}
          </div>
        ))}
      </div>
      </section>
      </div>
      {dialogue}
    </>
  );
}
