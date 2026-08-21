"use client";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import { useMachineEvents } from "../events";
import { useConfirm } from "../confirm";
import ConfirmSettings from "../ConfirmSettings";
import { cleAnnonce, echecAnnonce } from "../register";
import { splitSensors, stateLabel, stateTone } from "../machineState";
import Alerte from "../Alerte";
import Icone from "../icons";

/** Partie du monitor qu'on exploite ici — le reste de `/api/status` reste souple. */
interface Monitor {
  at: number;
  stateByte: number;
  switches: { name: string; label: string }[];
  alarmBits: number;
  alarms: { bit: number; name: string | null; ignored: boolean }[];
}

interface Recipe {
  id: string;
  name: string;
  beverageId: number;
  profileId: number;
}

/** Le panneau qui a envoyé la commande : c'est là que son compte rendu s'affiche, pas en haut. */
type Scope = "liaison" | "power" | "boissons";

export default function Dashboard() {
  const t = useTranslations("dashboard");
  const tp = useTranslations("power");
  const tc = useTranslations("common");
  const ta = useTranslations("alarm");
  // La question de préparation est celle de l'accueil : même geste, même phrase, un seul endroit.
  const tb = useTranslations("beverages");
  const tconf = useTranslations("confirmations");
  const [status, setStatus] = useState<any>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
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
  /**
   * La boisson que **cet onglet** a lancée, s'il en a lancé une.
   *
   * La trame d'arrêt porte un identifiant de boisson. Le code envoyait `beverageId: 1, profileId: 1`
   * en dur — un espresso du profil 1, quelle que soit la boisson qui coule — et le bouton n'était
   * jamais désactivé. Arrêter une boisson devinée alors que rien ne coule n'est pas un arrêt, c'est
   * une commande au hasard : l'accueil le disait déjà, et refusait de deviner.
   */
  const [lance, setLance] = useState<Recipe | null>(null);
  const { demander, dialogue } = useConfirm();

  const refresh = useCallback(async () => {
    const s = await mfetch("/api/status").then((r) => r.json());
    setStatus(s);
  }, []);

  useEffect(() => {
    refresh();
    mfetch("/api/recipes")
      .then((r) => r.json())
      .then((d) => setRecipes(d.recipes));
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

  /** Préparer coule la boisson. Même question que sur l'accueil, mot pour mot : c'est le même geste. */
  const dispense = (r: Recipe) => {
    demander({
      question: tb("confirmPrepare", { beverage: r.name, profile: tc("profileFallback", { id: r.profileId }) }),
      warn: tb("confirmPrepareWarning"),
      geste: "dispense",
      onConfirm: async () => {
        setLance(r);
        await send("boissons", { action: "dispense", recipeId: r.id });
      },
    });
  };

  const stop = () => {
    if (!lance) return;
    demander({
      question: tp("confirmStop", { beverage: ` (${lance.name})` }),
      onConfirm: () =>
        send(
          "boissons",
          { action: "stop", beverageId: lance.beverageId, profileId: lance.profileId },
          () => tp("stopSent"),
        ),
    });
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
   * `role="status"` permanent, jamais monté à la demande : un conteneur inséré en même temps que
   * son texte n'est pas annoncé par les lecteurs d'écran. Vide, `.status:empty` le masque, donc la
   * carte ne porte pas une boîte creuse en attendant.
   */
  const Statut = ({ scope }: { scope: Scope }) => (
    <p className={"status " + (report?.scope === scope && report.kind === "err" ? "err" : "ok")} role="status">
      {report?.scope === scope ? report.text : ""}
    </p>
  );

  const cfg = status?.config;
  const sess = status?.session;
  const mon: Monitor | null = status?.lastMonitor ?? null;

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
      <section>
      {/* Six sections sur sept portaient un titre ; celle-ci n'en avait pas, et les deux colonnes
          démarraient donc à des hauteurs différentes. Un panneau se nomme. */}
      <h2>{t("connection")}</h2>
      <div className="card">
        {/* Le bouton était à droite d'un `space-between`, donc à 700 px des lignes qu'il concerne
            dans une carte pleine largeur. On lit l'état, puis on agit : il passe dessous. */}
        <div>
            <div className="kv">
              <span className="k">{t("lanSession")}</span>
              <span className={"pill " + (sess?.active ? "on" : "off")}>
                {sess?.active ? t("sessionEstablished") : t("sessionWaiting")}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("machineAddress")}</span>
              <span className="mono">{cfg?.machineIp} · {cfg?.dsn}</span>
            </div>
            <div className="kv">
              <span className="k">{t("server")}</span>
              {/* La ligne fautive porte le pictogramme du bandeau, pas un émoji : c'est le même
                  avertissement, et il doit se reconnaître au même dessin. */}
              <span className={cfg?.serverIpProblem ? "mono alerte" : "mono"}>
                {cfg?.serverIpProblem && <Icone nom="alerte" taille={15} />}
                <span>
                  {cfg?.serverIp ?? tc("none")}:{cfg?.serverPort}
                </span>
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("machineStateMonitor")}</span>
              <span>
                {/* Même pastille que la ligne « Session LAN » quatre lignes plus haut, et même
                    fonction de libellé que l'accueil (`machineState.ts`). Avant : trois émojis
                    (⚪ 🟢 🟠) et une cascade de ternaires recopiée — le même état de la même
                    machine avait deux apparences selon la page. */}
                {mon ? (
                  <span className={("pill " + stateTone(mon.stateByte)).trim()}>{stateLabel(mon.stateByte, tp)}</span>
                ) : (
                  tc("dash")
                )}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("runningProgram")}</span>
              <span>
                {/* Le libellé interne du programme (« Paramètres 100+9 ») est du diagnostic, et il
                    vit dans le journal, en bas de cette page. La ligne s'appelle déjà « Programme en
                    cours » : y répondre par une phrase qui la répète ne dirait rien de plus. */}
                {status?.program?.active ? tc("yes") : tc("dash")}
              </span>
            </div>
        </div>
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
        <Statut scope="liaison" />
      </div>
      </section>

      <section>
      <h2>{t("machineCommands")}</h2>
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
        </div>
        <Statut scope="power" />
      </div>
      </section>

      {/* `id` : la pastille « alarme signalée » de l'accueil mène ici. C'était la seule route vers
          « quelle alarme ? », et elle vivait dans un attribut `title` — donc nulle part au doigt. */}
      <section id="alarmes">
      <h2>{t("alarms")}</h2>
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
                <span className="pill off" key={a.bit}>
                  {ta.has(a.name) ? ta(a.name) : a.name}
                </span>
              ) : (
                <span className="pill" key={a.bit}>
                  {t("alarmIgnored")}
                </span>
              ),
            )}
          </div>
        )}
      </div>
      </section>

      <section>
      <h2>{t("sensors")}</h2>
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
              <span className="pill off" key={sw.name} title={tp("sensorsAttention")}>
                {sw.label}
              </span>
            ))}
            {splitSensors(mon.switches).presents.map((sw) => (
              <span className="pill" key={sw.name}>
                {sw.label}
              </span>
            ))}
          </div>
        )}
      </div>
      </section>

      <section>
      <h2>{t("beverages")}</h2>
      <div className="card">
        {recipes.length === 0 && <p className="sub">{t("noRecipes")}</p>}
        <div className="grid">
          {recipes.map((r) => (
            <button
              key={r.id}
              /* `multi` : le libellé est un NOM tapé sur la machine, pas un verbe du catalogue.
                 `.iconBtn` interdit le retour a la ligne — juste, pour une commande — mais ici
                 la grille fait des cellules de 150 px et « Recette perso 1 » plus la tasse
                 demandent 168 px : sans cette exception le bouton deborderait sa cellule. */
              className="primary iconBtn multi"
              disabled={busy}
              onClick={() => dispense(r)}
              // L'identifiant de boisson et le profil étaient écrits ici en français, en dur, hors
              // du catalogue — et affichés à tout le monde alors que c'est du détail protocolaire.
              title={t("dispenseTitle")}
            >
              <Icone nom="preparer" />
              <span className="lbl">{r.name}</span>
            </button>
          ))}
        </div>
        {/* **Arrêter est destructif et se voyait moins que préparer.** Deux boutons ambre pleins au
            dessus, un bouton gris en dessous : l'action qui interrompt une préparation en cours
            avait exactement le poids d'un lien secondaire. Le rouge en contour est le traitement
            que le reste du produit donne à ce rôle.
            Il est désactivé quand cet onglet n'a rien lancé : sans boisson connue, la trame partait
            avec un espresso deviné. */}
        <div className="row note">
          <button
            className="danger discret iconBtn"
            disabled={busy || !lance}
            onClick={stop}
            title={!lance ? tp("stopUnavailable") : tp("stopTitle")}
          >
            <Icone nom="arreter" />
            <span className="lbl">{t("stopPreparation")}</span>
          </button>
        </div>
        <Statut scope="boissons" />
      </div>
      </section>

      {/* Placé après les deux blocs qu'il gouverne — les commandes machine et les boissons — et non
          en tête de page : c'est un réglage de comportement, pas un état à surveiller. */}
      <section>
      <h2>{tconf("heading")}</h2>
      <ConfirmSettings />
      </section>

      <section>
      <h2>{t("commandQueue")}</h2>
      <div className="card">
        {status?.queue?.length ? (
          <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>{t("queueCommand")}</th>
                <th>{t("queueAck")}</th>
              </tr>
            </thead>
            <tbody>
              {status.queue.map((c: any) => (
                <tr key={c.id || c.queuedAt}>
                  <td>{c.label}</td>
                  <td>{c.needsAck ? tc("yes") : tc("no")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <p className="sub">{t("queueEmpty")}</p>
        )}
      </div>
      </section>

      <section className="pleine">
      <h2>{t("journal")}</h2>
      <div className="card log">
        {status?.log?.map((e: any, i: number) => (
          <div key={e.n ?? i} className={e.dir}>
            [{new Date(e.t).toLocaleTimeString()}] {e.dir.toUpperCase()}
            {/* Le journal est unique, toutes machines confondues : sans cette étiquette, deux
                cafetières produiraient une chronologie indéchiffrable. Elle n'apparaît qu'à partir
                de deux machines, sinon elle se répéterait à chaque ligne pour rien. */}
            {(status?.machines?.length ?? 0) > 1 && e.m ? ` · ${e.m}` : ""} · {e.msg}
          </div>
        ))}
      </div>
      </section>
      </div>
      {dialogue}
    </>
  );
}
