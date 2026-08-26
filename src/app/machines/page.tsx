"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { MachineSummary, currentMachine, forId, setCurrentMachine } from "../machine";
import { useMachineEvents } from "../events";
import { useConfirm } from "../confirm";
import Alerte from "../Alerte";
import Icone from "../icons";
import { Input } from "@/ui/input";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Card } from "@/ui/card";

/**
 * Machines : la page qui les liste, les nomme, les configure et les supprime.
 *
 * **Elle configure sur place.** Une version précédente renvoyait vers `/cle-lan` pour l'adresse et
 * la clé, c'est-à-dire pour la moitié de ce qu'on vient faire ici : ajouter une machine obligeait à
 * changer de page, et cette page-là ne savait travailler que sur la machine *sélectionnée* — donc
 * il fallait d'abord basculer dessus. Deux allers-retours pour un réglage. Tout est maintenant dans
 * la carte de la machine concernée, et chaque requête nomme sa machine (`forId`), ce qui permet de
 * configurer une cafetière sans quitter celle qu'on regarde.
 *
 * L'ordre à l'intérieur d'une carte suit la dépendance réelle, elle n'est pas décorative :
 *
 *   1. **l'adresse** — sans elle on ne peut ni s'annoncer (`local_reg`) ni obtenir le DSN ;
 *   2. **la clé LAN** — que le cloud Ayla range sous ce DSN, d'où la dépendance.
 *
 * Le bloc de configuration est **ouvert d'office sur une machine incomplète** et replié sur une
 * machine prête : c'est le réglage qui manque qu'il faut avoir sous les yeux, pas un formulaire de
 * plus sur une machine qui marche.
 *
 * Deux limites du multi-machines sont écrites en bas, parce qu'elles ne se devinent pas :
 *
 * - le **catalogue de boissons vient du modèle détecté** de chaque machine. Deux familles restent
 *   hors de portée, et la carte le dit : les modèles dont la table constructeur ne donne aucune
 *   recette, et les boissons « iced »/« mug » des Striker, qui passent par une autre nomenclature ;
 * - les **variables d'environnement ne décrivent que la première machine**.
 *
 * Invariants côté serveur, qui décident de ce que cette page peut montrer : le mot de passe n'est
 * ni journalisé, ni stocké, ni renvoyé, et **aucun endpoint ne renvoie jamais la clé**. On ne
 * dispose donc que de `lanKeySet`, `lanKeyId`, `lanKeySource` et `lanKeyCachedAt`.
 */

/**
 * Un compte rendu d'action : son texte et ce qu'il annonce. Le genre ne se devine pas depuis le
 * texte — c'est l'appelant qui sait si le serveur a refusé.
 */
interface Rapport {
  text: string;
  kind: "ok" | "err";
}

/**
 * La provenance d'une valeur — et seulement quand il y a une valeur.
 *
 * **Deux defauts, une seule ligne de rendu.** Les quatre lignes d'etat de la carte rendaient
 * « {valeur} ({source}) » sans condition :
 *
 * - quand la valeur manque, la source vaut « inconnu » elle aussi, et la ligne affichait
 *   « inconnu (inconnu) », « absente (inconnue) », « non configuree (inconnue) » — le meme mot
 *   deux fois, dont une entre parentheses, pour ne rien ajouter ;
 * - cinq sources portent DEJA des parentheses (« MACHINE_DSN (.env.local) », « cache local
 *   (decouverte du … ) », et les trois autres variables d'environnement), ce qui donnait
 *   « (MACHINE_DSN (.env.local)) ». Corriger chaque chaine une par une aurait laisse le piege
 *   ouvert pour la suivante : ce sont les parentheses EXTERIEURES qui sont fautives.
 *
 * Le point median est deja le separateur de cette page — la ligne du modele et le journal
 * l'emploient — et il n'imbrique rien.
 */
/**
 * **La provenance se TRACE.** Discipline retenue de la direction « tenségrité » : un filet part de
 * la valeur et rejoint sa source, au lieu de laisser une teinte le sous-entendre. C'est le
 * pendant du principe produit n° 2 — dire l'état réel, y compris l'ignorance : une adresse lue sur
 * l'appareil, une adresse reprise d'un cache et une adresse imposée par l'environnement se
 * ressemblaient à l'écran, et seule la lecture du texte les séparait.
 *
 * Le point médian disparaît : c'est le tracé de `.rappel` qui fait la liaison, et garder les deux
 * aurait doublé le même signe.
 */
function provenance(connu: boolean, source: string) {
  if (!connu) return null;
  return <span className="rappel sub">{source}</span>;
}

interface Payload {
  defaultId: string;
  machines: MachineSummary[];
  /** L'adresse que nous ANNONÇONS aux machines : globale, un seul serveur écoute. */
  server: { ip: string | null; port: number; problem: string | null };
  /** Ce qui manquerait pour interroger le cloud. Normalement vide. */
  discovery: { missingConfig: string[] };
}

/** Verdict de la sonde. `reachable` dit qu'un serveur a répondu ; `isMachine`, que c'est la bonne. */
interface Probe {
  reachable: boolean;
  isMachine: boolean;
  status: number | null;
  error: string | null;
}

const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("fr-FR") : null);

export default function Machines() {
  const t = useTranslations("machines");
  const tk = useTranslations("lankey");
  const tm = useTranslations("machine");
  const tc = useTranslations("common");

  const [d, setD] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * Compte rendu des actions de PAGE (ajout, suppression, sélection, session cloud).
   *
   * Il portait la classe `.warn` — le bandeau d'avertissement ambre — pour **tous** ses états :
   * « Machine sélectionnée » et « Session cloud oubliée » s'affichaient dans la même boîte
   * d'alerte qu'une erreur. `.status` distingue les deux (`ok` / `err`) et porte `role="status"`,
   * sans quoi rien de ce que fait cette page n'est annoncé à un lecteur d'écran.
   */
  const [msg, setMsg] = useState<Rapport | null>(null);
  const dire = (text: string) => setMsg({ text, kind: "ok" });
  const echouer = (text: string) => setMsg({ text, kind: "err" });
  const { demander, dialogue } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", ip: "" });
  /**
   * Session cloud : `refresh_token` mémorisé, qui évite de retaper le mot de passe.
   *
   * Décoché par défaut, et ça n'est pas une précaution de façade : c'est le seul secret de niveau
   * **compte** que ce serveur puisse écrire sur le disque. La clé LAN, elle, ne donne que le
   * pilotage local d'une cafetière — et encore faut-il être sur le réseau.
   */
  const [remember, setRemember] = useState(false);
  const [cloud, setCloud] = useState<{ set: boolean; at: number | null } | null>(null);

  // États par machine. Un enregistrement par identifiant plutôt qu'un état global : deux cartes
  // peuvent être en cours d'édition, et le message de l'une n'a rien à faire sous l'autre.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const [ip, setIp] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<Record<string, { email: string; password: string }>>({});
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<Record<string, Rapport | null>>({});

  const load = useCallback(async () => {
    try {
      // Pas `mfetch` : cet endpoint n'est rattaché à aucune machine, et c'est justement lui qui
      // répare le cas d'un identifiant courant devenu invalide.
      const [p, c] = (await Promise.all([
        fetch("/api/machines").then((r) => r.json()),
        fetch("/api/cloudsession").then((r) => r.json()),
      ])) as [Payload, { set: boolean; at: number | null }];
      setD(p);
      setCloud(c);
      // Le champ d'adresse est semé avec la valeur connue, sans jamais réécrire une saisie en cours.
      setIp((cur) => {
        const next = { ...cur };
        for (const m of p.machines) if (next[m.id] === undefined) next[m.id] = m.ip ?? "";
        return next;
      });
      // Ouvert d'office là où il manque un prérequis : c'est ce qu'on vient faire.
      setOpen((cur) => {
        const next = { ...cur };
        for (const m of p.machines) if (next[m.id] === undefined && !m.ready) next[m.id] = true;
        return next;
      });
    } catch (e) {
      echouer(tc("error", { message: String(e) }));
    }
  }, [tc]);

  /**
   * Applique un état poussé en **ne remplaçant que les machines qui ont changé**.
   *
   * C'est là que se joue la réactivité fine : une machine inchangée garde son identité d'objet,
   * donc React ne redessine pas sa carte. Sans ça, chaque évènement reconstruirait toutes les
   * cartes — ce qui ramènerait le défaut qu'on voulait corriger, en poussé au lieu de sondé.
   *
   * La comparaison est faite sur la sérialisation : les résumés sont petits et entièrement
   * sérialisables, et une comparaison champ par champ serait à re-écrire à chaque nouveau champ.
   */
  const applyPush = useCallback((p: { machines: MachineSummary[]; defaultId: string }) => {
    setD((cur) => {
      if (!cur) return { ...p, server: { ip: null, port: 0, problem: null }, discovery: { missingConfig: [] } };
      const machines = p.machines.map((m) => {
        const avant = cur.machines.find((x) => x.id === m.id);
        return avant && JSON.stringify(avant) === JSON.stringify(m) ? avant : m;
      });
      // `server` et `discovery` ne changent pas en cours de route : on garde ceux du chargement.
      return { ...cur, defaultId: p.defaultId, machines };
    });
  }, []);

  useEffect(() => {
    setSelected(currentMachine());
    load();
  }, [load]);

  /**
   * L'état arrive **poussé** par le serveur (`/api/events`). L'abonnement lui-même vit dans
   * `../events` : six pages en dépendent, et une deuxième copie aurait divergé au premier
   * correctif.
   *
   * Le repli n'est pas oublié : si le flux échoue (proxy qui ne le laisse pas passer, navigateur
   * sans EventSource), on retombe sur une scrutation, et seulement pendant qu'une lecture tourne.
   */
  const { live: flux } = useMachineEvents(applyPush);

  const enCours = d?.machines.some((m) => m.reading || m.running) ?? false;
  useEffect(() => {
    // Uniquement en repli, et uniquement tant qu'une lecture tourne. `reading` est borné côté
    // serveur par la fenêtre de l'import : la scrutation s'arrête donc d'elle-même.
    if (flux || !enCours) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [flux, enCours, load]);

  const cred = (id: string) => creds[id] ?? { email: "", password: "" };

  /**
   * Enveloppe commune : un seul verrou par machine, le message rangé sous sa carte, et la liste
   * rechargée. `lankey-changed` prévient la barre de navigation, qui masque les pages dépendant
   * des prérequis — sans quoi le menu ne reviendrait qu'au prochain rechargement complet.
   */
  /** Une erreur renvoyée par le serveur : c'est le seul endroit où le genre du compte rendu se sait. */
  const refus = (message: string): Rapport => ({ text: tc("error", { message }), kind: "err" });

  const run = async (id: string, action: () => Promise<string | Rapport | null>) => {
    setBusy(id);
    setNote((n) => ({ ...n, [id]: null }));
    try {
      const r = await action();
      if (r) setNote((n) => ({ ...n, [id]: typeof r === "string" ? { text: r, kind: "ok" } : r }));
      await load();
      window.dispatchEvent(new Event("lankey-changed"));
    } catch (e) {
      setNote((n) => ({ ...n, [id]: refus(String(e)) }));
    } finally {
      setBusy(null);
    }
  };

  /** Enregistre l'adresse puis la teste : une adresse muette doit être signalée tout de suite. */
  const saveIp = (m: MachineSummary) =>
    run(m.id, async () => {
      const r = await fetch(forId("/api/machine", m.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: ip[m.id] ?? "" }),
      }).then((x) => x.json());
      if (r.error) return refus(r.error);
      const suite = r.initialRead?.length ? " " + t("initialRead", { count: r.initialRead.length }) : "";
      const probe: Probe = r.probe;
      return (probe.isMachine
        ? tm("savedReachable", { ip: r.ip, dsn: r.dsn ?? tm("dsnNone") })
        : probe.reachable
          ? tm("savedNotAMachine", { ip: r.ip, status: String(probe.status ?? "?") })
          : tm("savedUnreachable", { ip: r.ip, reason: probe.error ?? String(probe.status ?? "?") })) + suite;
    });

  const forgetIp = (m: MachineSummary) =>
    demander({
      question: tm("forgetConfirm"),
      onConfirm: () => void run(m.id, async () => {
      const r = await fetch(forId("/api/machine", m.id), { method: "DELETE" }).then((x) => x.json());
        setIp((cur) => ({ ...cur, [m.id]: r.ip ?? "" }));
        return tm("forgotten", { state: r.ip ?? tm("none") });
      }),
    });

  /**
   * Le mot de passe part vers notre serveur, qui s'en sert le temps d'interroger Gigya puis Ayla et
   * ne le conserve pas. On l'efface du formulaire dès la réponse, quelle qu'elle soit, et le champ
   * repart masqué : laissé en clair d'une tentative à l'autre, il finirait par exposer la saisie
   * suivante sans qu'on l'ait demandé.
   */
  const discover = (m: MachineSummary) =>
    run(m.id, async () => {
      try {
        const r = await fetch(forId("/api/lankey", m.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...cred(m.id), remember }),
        }).then((x) => x.json());
        if (r.error) return refus(r.error);
        // La lecture qui suit est asynchrone : la machine doit se connecter et pousser les
        // propriétés. On l'annonce, sans faire attendre l'utilisateur devant un compteur.
        return (
          tk("found", { keyId: r.keyId, changed: r.changed ? tk("changed") : tk("confirmed") }) +
          (r.initialRead?.length ? " " + t("initialRead", { count: r.initialRead.length }) : "") +
          // Ayla ne renvoie pas toujours un refresh_token : une case cochée sans effet serait un
          // mensonge, donc on ne l'annonce que si le serveur confirme l'avoir mémorisée.
          (remember && r.cloudSession ? t("cloudSessionKept") : "")
        );
      } finally {
        setCreds((c) => ({ ...c, [m.id]: { email: cred(m.id).email, password: "" } }));
        setShowPassword((s) => ({ ...s, [m.id]: false }));
      }
    });

  /**
   * Vérifie si une mise à jour OTA est proposée pour cette machine.
   *
   * Côté cloud, obligatoirement : le module n'expose que `regtoken.json` hors mode point d'accès, et
   * les requêtes OTA qu'il nous adresse disent qu'il en veut une, pas qu'il en existe une.
   *
   * Les identifiants déjà saisis pour la clé servent ici aussi — c'est le même chemin
   * d'authentification. S'ils sont vides, le serveur se rabat sur AYLA_TOKEN. Le mot de passe est
   * effacé du formulaire comme pour la clé : il ne doit pas rester à l'écran d'une action à l'autre.
   */
  const checkOta = (m: MachineSummary) =>
    run(m.id, async () => {
      const c = cred(m.id);
      try {
        const r = await fetch(forId("/api/ota", m.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(c.email ? { ...c, remember } : {}),
        }).then((x) => x.json());
        if (r.error) return refus(r.error);
        return r.updateAvailable
          ? t("otaAvailable", { version: r.version ?? t("otaNoVersion") })
          : t("otaNone", { status: String(r.status) });
      } finally {
        setCreds((cur) => ({ ...cur, [m.id]: { email: c.email, password: "" } }));
        setShowPassword((s) => ({ ...s, [m.id]: false }));
      }
    });

  const forgetKey = (m: MachineSummary) =>
    demander({
      question: tk("forgetConfirm"),
      onConfirm: () => void run(m.id, async () => {
        const r = await fetch(forId("/api/lankey", m.id), { method: "DELETE" }).then((x) => x.json());
        return tk("forgotten", { state: r.set ? tk("stillSet") : tk("nowUnset") });
      }),
    });

  const add = async () => {
    setBusy("+");
    setMsg(null);
    try {
      const r = await fetch("/api/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: form.label || null, ip: form.ip || null }),
      }).then((x) => x.json());
      if (r.error) {
        echouer(tc("error", { message: r.error }));
      } else {
        const probe: Probe | null = r.probe;
        dire(
          !probe
            ? t("added", { name: r.machine.label })
            : probe.isMachine
              ? t("addedReachable", { name: r.machine.label, dsn: r.machine.dsn ?? "?" })
              : probe.reachable
                ? t("addedNotAMachine", { name: r.machine.label, status: String(probe.status ?? "?") })
                : t("addedUnreachable", { name: r.machine.label, reason: probe.error ?? String(probe.status ?? "?") }),
        );
        setForm({ label: "", ip: "" });
        await load();
        window.dispatchEvent(new Event("lankey-changed"));
      }
    } catch (e) {
      echouer(tc("error", { message: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const patch = (m: MachineSummary, body: Record<string, unknown>, done: (r: { machine: MachineSummary }) => string) =>
    run(m.id, async () => {
      const r = await fetch(`/api/machines/${encodeURIComponent(m.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      return r.error ? refus(r.error) : done(r);
    });

  /**
   * Suppression — ou **remise à zéro** s'il ne reste qu'une machine : elle ne peut pas quitter le
   * registre, alors le serveur efface tout son contenu et garde l'entrée vide. Les deux cas
   * emportent le même contenu, donc les deux confirmations nomment ce qui part ; seul le sort de
   * l'entrée elle-même diffère, et le libellé du bouton le dit d'avance.
   */
  const remove = (m: MachineSummary) => {
    const derniere = (d?.machines.length ?? 0) <= 1;
    const params = { name: m.label, props: m.counts.props, stats: m.counts.stats };
    demander({
      question: derniere ? t("resetConfirm", params) : t("deleteConfirm", params),
      onConfirm: () => void supprimer(m),
    });
  };

  const supprimer = async (m: MachineSummary) => {
    setBusy(m.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/machines/${encodeURIComponent(m.id)}`, { method: "DELETE" }).then((x) => x.json());
      if (r.error) {
        echouer(tc("error", { message: r.error }));
      } else if (r.reset) {
        // L'environnement reprend la main sur ce qu'il force : sans le dire, la remise à zéro
        // aurait l'air de n'avoir rien fait.
        dire(
          t("resetDone", { name: m.label, props: r.cleared.props, stats: r.cleared.stats }) +
            (r.envRestored?.length ? " " + t("resetEnv", { vars: r.envRestored.join(", ") }) : ""),
        );
        // Plus aucun prérequis : le bloc de configuration doit être sous les yeux.
        setOpen((o) => ({ ...o, [m.id]: true }));
      } else {
        dire(t("deleted", { name: m.label }));
        // Si c'était la machine affichée, on repasse sur celle par défaut du serveur.
        if (currentMachine() === m.id) {
          setCurrentMachine(null);
          setSelected(null);
        }
      }
      await load();
      window.dispatchEvent(new Event("lankey-changed"));
    } catch (e) {
      echouer(tc("error", { message: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Renomme. Un libellé vide n'est pas une erreur : il rend son nom **dérivé** à la machine
   * (modèle lu, puis DSN, puis identifiant), ce qui est le comportement par défaut.
   */
  const rename = (m: MachineSummary) =>
    patch(m, { label: renaming[m.id] ?? "" }, (r) => {
      setRenaming((cur) => {
        const next = { ...cur };
        delete next[m.id];
        return next;
      });
      return t("renamed", { name: r.machine.label });
    });

  /**
   * Demande le modèle à la machine (`d270_serialnumber`). Une **lecture** : rien n'est préparé ni
   * écrit sur l'appareil.
   *
   * La réponse n'arrive pas dans le corps du POST — c'est la machine qui doit se connecter à nous
   * et pousser la propriété, en deux à quatre secondes d'après les relevés. On scrute donc la
   * liste, borné dans le temps : sans borne, une machine éteinte laisserait la page tourner.
   */
  const readModel = (m: MachineSummary) =>
    run(m.id, async () => {
      const r = await fetch(forId("/api/model", m.id), { method: "POST" }).then((x) => x.json());
      if (r.error) return refus(r.error);
      for (let i = 0; i < 10; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const p: Payload = await fetch("/api/machines").then((x) => x.json());
        setD(p);
        const lu = p.machines.find((x) => x.id === m.id)?.model;
        if (lu?.key) {
          return lu.matchesCatalog === false
            ? t("modelReadMismatch", { key: lu.key })
            : t("modelReadOk", { key: lu.key, name: lu.machineName ?? lu.key });
        }
      }
      return t("modelReadTimeout");
    });

  /** Oublie le `refresh_token` mémorisé. Le mot de passe redeviendra nécessaire. */
  const forgetCloud = () =>
    demander({ question: t("cloudSessionForgetConfirm"), onConfirm: () => void oublierCloud() });

  const oublierCloud = async () => {
    setBusy("cloud");
    try {
      await fetch("/api/cloudsession", { method: "DELETE" });
      dire(t("cloudSessionForgotten"));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const select = (id: string) => {
    setCurrentMachine(id);
    setSelected(id);
    dire(t("selected", { name: d?.machines.find((x) => x.id === id)?.label ?? id }));
  };

  const courante = selected ?? d?.defaultId ?? null;

  return (
    <>
      <h1>{t("title")}</h1>
      <p className="sub">{t("intro")}</p>

      {/* Permanent, jamais monté à la demande : un conteneur inséré en même temps que son texte
          n'est pas annoncé. Vide, `.status:empty` le masque. */}
      <p className={"status " + (msg?.kind === "err" ? "err" : "ok")} role="status">
        {msg?.text ?? ""}
      </p>

      {/* Le repli fonctionne, mais il vaut mieux le dire : sans ça, une page qui met deux secondes
          à se mettre à jour au lieu d'être instantanée passerait pour une lenteur. */}
      {!flux && enCours && <p className="sub">{t("liveOff")}</p>}

      {d?.machines.map((m) => {
        const occupe = busy === m.id;
        const ouvert = open[m.id] ?? false;
        const c = cred(m.id);
        // Le champ non touché reflète le libellé enregistré ; vidé, il rend son nom dérivé.
        const nom = renaming[m.id] ?? m.custom ?? "";
        return (
          <Card key={m.id}>
            <div className="cardHead chapeau">
              <div className="row">
                {/* L'accueil donne un `<h3>` à chacune de ses 28 cartes de boisson ; ici la carte
                    porte un appareil qu'on peut piloter, effacer et renommer, et son nom était un
                    `<strong>`. Un lecteur d'écran ne pouvait donc pas parcourir la liste.
                    `h2` et non `h3` : chaque machine est une section de premier rang de la page —
                    « Ajouter une machine » en est déjà une — et ses blocs de configuration internes
                    portent des `h3` (`.titreBloc`). Le niveau vient de la structure, l'apparence de
                    `.cardTitle` : le titre ne grossit pas. */}
                <h2 className="cardTitle">{m.label}</h2>
                {/* L'identifiant technique — celui du journal et du parametre `?machine=`. Il
                    disparait quand le titre le repete deja : en fin de chaine de repli, le nom
                    derive EST l'identifiant, et la carte affichait « m1 m1 ». */}
                {m.id !== m.label && <span className="mono sub">{m.id}</span>}
                {/* **« affichée » est un CHOIX, pas une marche.** C'est la machine que ce
                    navigateur regarde — donc de l'ambre, qui veut dire « choisi ou configuré », et
                    non du vert, qui est réservé à ce que l'appareil fait. Un témoin vert ici
                    diluait la seule couleur qui doit se lire d'un coup d'œil. */}
                {m.id === courante && <Badge variant="choisi">{t("current")}</Badge>}
                {m.id === d.defaultId && <Badge variant="plaque">{t("isDefault")}</Badge>}
                {/* « pilotable » est une CAPACITÉ : ni une marche, ni un défaut. Elle n'allume donc
                    aucun témoin quand elle est acquise. Son absence, en revanche, bloque tout geste
                    sur l'appareil — c'est à ce titre qu'elle prend le rouge. */}
                <span className={`pill ${m.ready ? "" : "off"}`}>{m.ready ? t("ready") : t("notReady")}</span>
                {m.sessionActive && <Badge variant="marche">{t("session")}</Badge>}
                {m.reading && (
                  <Badge variant="marche">{t("readingNow", { remaining: m.reading.remaining })}</Badge>
                )}
                {m.running && <Badge variant="marche">{m.running}</Badge>}
              </div>
              {/* **Boutons à icônes, comme le reste du site.** PRODUCT.md pose l'icône comme canal
                  principal de l'affordance ; cette page était la seule surface de configuration à
                  n'en avoir aucune. Le libellé reste — `.iconBtn` le replie par *container query*
                  quand la carte se resserre, et chaque bouton garde son nom accessible même replié.
                  Le verrou est `!!busy` PARTOUT et non `occupe` : `run()` n'a qu'un seul créneau
                  (`setBusy(id)` puis `setBusy(null)`), donc lancer une action sur une machine
                  pendant qu'une autre travaille libérerait le verrou de la première en avance. */}
              <div className="row">
                {m.id !== courante && (
                  <Button type="button" variant="neutre" size="commande" className="iconBtn" onClick={() => select(m.id)} disabled={!!busy} aria-label={t("select")}>
                    <Icone nom="machine" />
                    <span className="lbl">{t("select")}</span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="neutre"
                  size="commande"
                  className="iconBtn"
                  onClick={() => setOpen({ ...open, [m.id]: !ouvert })}
                  aria-expanded={ouvert}
                  aria-label={ouvert ? t("configureHide") : t("configure")}
                >
                  <Icone nom="chevron" />
                  <span className="lbl">{ouvert ? t("configureHide") : t("configure")}</span>
                </Button>
                {m.id !== d.defaultId && (
                  <Button type="button" variant="neutre" size="coquille"
                    className="iconBtn"
                    onClick={() => patch(m, { makeDefault: true }, (r) => t("defaultSet", { name: r.machine.label }))}
                    disabled={!!busy}
                    aria-label={t("makeDefault")}>
                    <Icone nom="etoile" taille={14} />
                    <span className="lbl">{t("makeDefault")}</span>
                  </Button>
                )}
                <Button type="button" variant="discret-arret" size="commande"
                  className="iconBtn"
                  onClick={() => remove(m)}
                  disabled={!!busy}
                  aria-label={d.machines.length <= 1 ? t("reset") : t("delete")}>
                  <Icone nom="corbeille" />
                  <span className="lbl">{d.machines.length <= 1 ? t("reset") : t("delete")}</span>
                </Button>
              </div>
            </div>

            {/* Deux entrees pour un seul appareil : une seule recevra la session, l'autre
                restera muette. C'est l'erreur naturelle (nom court puis nom complet), et rien
                d'autre ne la signalerait. */}
            {m.duplicates.length > 0 && (
              <Alerte className="chapeau">
                {t("duplicate", {
                  names: m.duplicates.map((x) => x.label).join(", "),
                  reason: m.duplicates.some((x) => x.reason === "dsn") ? t("duplicateDsn") : t("duplicateAddress"),
                })}
              </Alerte>
            )}

            {m.model.matchesCatalog === false && (
              <Alerte className="chapeau">
                {t("modelMismatch", { detected: m.model.key ?? "?", catalog: m.model.catalogType })}
              </Alerte>
            )}

            <div className="kv">
              <span className="k">{t("name")}</span>
              <span>{m.custom ?? <span className="sub">{t("nameDerived")}</span>}</span>
            </div>
            <div className="kv">
              <span className="k">{tm("address")}</span>
              <span>
                {m.ip ? <span className="mono">{m.ip}</span> : t("noAddress")}
                {provenance(!!m.ip, m.ipSource)}
                {m.envForced.ip && <Badge variant="plaque"> {t("envForced")}</Badge>}
              </span>
            </div>
            <div className="kv">
              <span className="k">{tk("heading")}</span>
              <span>
                {m.lanKeySet ? t("lanKeyPresent", { keyId: String(m.lanKeyId ?? "?") }) : t("lanKeyAbsent")}
                {provenance(m.lanKeySet, m.lanKeySource)}
              </span>
            </div>
            <div className="kv">
              <span className="k">DSN</span>
              <span>
                {m.dsn ? <span className="mono">{m.dsn}</span> : t("unknown")}
                {provenance(!!m.dsn, m.dsnSource)}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("model")}</span>
              <span className="row">
                <span>
                  {m.model.key ? `${m.model.key}${m.model.machineName ? ` · ${m.model.machineName}` : ""}` : t("unknown")}
                  {provenance(!!m.model.key, m.model.source)}
                  {/* Le catalogue en service est un fait independant du modele detecte : il reste
                      annonce meme quand le modele est inconnu, puisque c'est lui qui decide des
                      boissons affichees sur l'accueil. */}
                  <span className="sub"> · {t("catalogOf", { type: m.model.catalogType, count: m.model.catalogBeverages })}</span>
                </span>
                {/* Le modèle est demandé automatiquement dès que les deux prérequis sont réunis
                    (voir maybeReadModel côté serveur). Ce bouton couvre le reste : machine déjà
                    configurée avant que ça n'existe, lecture qui a expiré, ou simple vérification.
                    C'est une LECTURE — rien n'est préparé ni écrit. */}
                {m.ready && (
                  <Button type="button" variant="neutre" size="coquille"
                    className="iconBtn"
                    onClick={() => readModel(m)}
                    disabled={!!busy}
                    aria-label={m.model.key ? t("modelReread") : t("modelRead")}>
                    <Icone nom="lire" taille={14} />
                    <span className="lbl">{m.model.key ? t("modelReread") : t("modelRead")}</span>
                  </Button>
                )}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t("read")}</span>
              <span>
                {t("counts", {
                  props: m.counts.props,
                  stats: m.counts.stats,
                  beans: m.counts.beanSystems,
                  recipes: m.counts.recipes,
                })}
                {m.importedAt && <span className="sub"> · {date(m.importedAt)}</span>}
              </span>
            </div>

            {/* ------------------------------------------------ configuration, sur place */}
            {ouvert && (
              <div className="blocSuite">
                {/* 0. le nom — purement décoratif, donc en premier : c'est le réglage sans
                       conséquence, et celui qu'on vient changer le plus souvent. */}
                {/* **Le titre du bloc EST le nom du champ.** Un seul champ sous ce titre, donc
                    `aria-labelledby` plutôt qu'une étiquette visible qui répéterait mot pour mot le
                    `h3` situé six pixels au-dessus. Avant : aucun `id`, aucun `for`, aucun
                    `aria-label` — le nom accessible retombait sur le `placeholder`, qui vaut ici le
                    numéro de série de la machine. Le lecteur d'écran annonçait donc le champ de
                    renommage « AC000W0XXXXXXXX, édition ». */}
                <h3 className="titreBloc" id={`nom-t-${m.id}`}>{t("nameHeading")}</h3>
                <div className="row">
                  <Input
                    id={`nom-${m.id}`}
                    aria-labelledby={`nom-t-${m.id}`}
                    aria-describedby={`nom-n-${m.id}`}
                    value={nom}
                    placeholder={m.label}
                    onChange={(e) => setRenaming({ ...renaming, [m.id]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy && nom !== (m.custom ?? "")) rename(m);
                    }}
                    className="champ"
                  />
                  <Button type="button" variant="neutre" size="commande"
                    className="iconBtn"
                    onClick={() => rename(m)}
                    disabled={!!busy || nom === (m.custom ?? "")}
                    aria-label={t("rename")}>
                    <Icone nom="ecrire" />
                    <span className="lbl">{t("rename")}</span>
                  </Button>
                  {m.custom && (
                    <Button type="button" variant="neutre" size="coquille"
                      className="iconBtn"
                      onClick={() => setRenaming({ ...renaming, [m.id]: "" })}
                      disabled={!!busy}
                      aria-label={t("nameClear")}>
                      <Icone nom="corbeille" taille={14} />
                      <span className="lbl">{t("nameClear")}</span>
                    </Button>
                  )}
                </div>
                {/* **La note sort de la rangee.** `.row` veut dire « ces commandes tiennent sur une
                    ligne, avec une gouttiere et un alignement centre ». On y avait pose trois
                    natures de chose comme trois freres : un champ, ses commandes, et une phrase.
                    Mesure a 390 px sur les six rangees de configuration, hauteur de la rangee
                    contre celle de son plus grand enfant : 134/44, 211/44, 317/69, 206/69, 147/87,
                    99/44 — soit de 2 a 4,6 fois. Et `align-items: center` centrait la phrase sur la
                    hauteur des boutons, donc sa premiere ligne n'etait alignee sur rien.
                    Une note qui decrit la rangee entiere se met SOUS elle : c'est ce que
                    `.legende` dit deja — « collee a la ligne juste au-dessus, c'est SA legende ». */}
                <p className="legende" id={`nom-n-${m.id}`}>{t("nameNote")}</p>

                {/* 1. l'adresse — elle conditionne la clé, d'où cet ordre. */}
                <h3 className="titreBloc" id={`adr-t-${m.id}`}>{tm("heading")}</h3>
                {m.envForced.ip && <p className="sub">{tm("envForced")}</p>}
                <div className="row">
                  <Input
                    id={`adr-${m.id}`}
                    aria-labelledby={`adr-t-${m.id}`}
                    aria-describedby={`adr-n-${m.id}`}
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={tm("placeholder")}
                    value={ip[m.id] ?? ""}
                    onChange={(e) => setIp({ ...ip, [m.id]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (ip[m.id] ?? "").trim() && !busy) saveIp(m);
                    }}
                    className="champ"
                  />
                  <Button type="button" variant="neutre" size="commande"
                    className="iconBtn"
                    onClick={() => saveIp(m)}
                    disabled={!!busy || !(ip[m.id] ?? "").trim()}
                    aria-busy={occupe || undefined}
                    aria-label={occupe ? tm("testing") : tm("save")}>
                    <Icone nom="ecrire" />
                    <span className="lbl">{occupe ? tm("testing") : tm("save")}</span>
                  </Button>
                  {m.ipCachedAt && (
                    <Button type="button" variant="neutre" size="coquille"
                      className="iconBtn"
                      onClick={() => forgetIp(m)}
                      disabled={!!busy}
                      aria-label={tm("forget")}>
                      <Icone nom="corbeille" taille={14} />
                      <span className="lbl">{tm("forget")}</span>
                    </Button>
                  )}
                </div>
                <p className="legende" id={`adr-n-${m.id}`}>{tm("setNote")}</p>

                {/* 2. la clé — rangée chez Ayla sous le DSN, donc dépendante de ce qui précède. */}
                <h3 className="titreBloc">{tk("heading")}</h3>
                {/* **Deux causes, deux consignes.** Ce bandeau disait « renseignez d'abord
                    l'adresse » dans les deux cas — y compris quand l'adresse ÉTAIT enregistrée et
                    que c'est la machine qui n'avait pas répondu. Il envoyait alors refaire ce qui
                    venait d'être fait, et la vraie cause — appareil hors tension ou hors réseau —
                    n'était nulle part. Relevé sur l'installation réelle. */}
                {!m.dsn && (
                  <Alerte className="chapeau">
                    {m.ip ? tk("needsDsnMute", { ip: m.ip }) : tk("needsDsn")}
                  </Alerte>
                )}
                {d.discovery.missingConfig.length ? (
                  <p className="sub">{tk("missingConfig", { vars: d.discovery.missingConfig.join(", ") })}</p>
                ) : (
                  <>
                    {/* **Deux champs sous un seul titre**, donc deux étiquettes propres : le `h3`
                        « Clé LAN » ne peut pas nommer à la fois l'adresse e-mail et le mot de passe.
                        Elles sont visibles, au-dessus du champ, comme le formulaire d'ajout en bas
                        de page le faisait déjà — et cette fois reliées, ce qui rend aussi le clic
                        sur l'étiquette utile. */}
                    <div className="row">
                      <span className="champBloc">
                        <label htmlFor={"mail-" + m.id}>{tk("emailLabel")}</label>
                        <Input
                          id={"mail-" + m.id}
                          type="email"
                          inputMode="email"
                          autoComplete="off"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          /* Pas de `placeholder` : l'étiquette juste au-dessus dit déjà « E-mail du
                             compte De'Longhi », et le répéter en gris dans la boîte n'ajoutait rien
                             — sinon la disparition de l'indication dès la première frappe. */
                          value={c.email}
                          onChange={(e) => setCreds({ ...creds, [m.id]: { ...c, email: e.target.value } })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && c.email && c.password && !busy && m.dsn) discover(m);
                          }}
                          className="champ"
                        />
                      </span>
                      <span className="champBloc">
                        <label htmlFor={"mdp-" + m.id}>{tk("passwordLabel")}</label>
                        {/* En clair, le champ redevient un champ texte ordinaire : sans
                            autoCapitalize / autoCorrect / spellCheck, le clavier mobile met une
                            majuscule au premier caractère et le correcteur s'en mêle. */}
                        <span className="champMdp">
                          <Input
                            id={"mdp-" + m.id}
                            type={showPassword[m.id] ? "text" : "password"}
                            autoComplete="off"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            value={c.password}
                            onChange={(e) => setCreds({ ...creds, [m.id]: { ...c, password: e.target.value } })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && c.email && c.password && !busy && m.dsn) discover(m);
                            }}
                            className="champ"
                          />
                          {/* **Dans le champ, plus à côté.** Voir `.champMdp` : posée en absolu, elle
                              ne peut plus se replier sous lui — mesuré à 48 px en dessous, à 1 024
                              comme à 1 921 px.

                              `title` ne répète plus `aria-label` : nom et description identiques
                              faisaient annoncer deux fois la même phrase. Il porte maintenant la
                              conséquence — sur une tablette fixée au mur, un mot de passe de compte
                              affiché en clair se lit de loin, et c'est ce qu'il faut savoir avant
                              d'appuyer. */}
                          <button
                            type="button"
                            className="oeil"
                            aria-pressed={!!showPassword[m.id]}
                            aria-controls={"mdp-" + m.id}
                            aria-label={showPassword[m.id] ? tk("hidePassword") : tk("showPassword")}
                            title={showPassword[m.id] ? tk("hideHint") : tk("showHint")}
                            onClick={() => setShowPassword({ ...showPassword, [m.id]: !showPassword[m.id] })}
                          >
                            <Icone nom={showPassword[m.id] ? "oeilBarre" : "oeil"} taille={18} />
                          </button>
                        </span>
                      </span>
                      <Button type="button" variant="neutre" size="commande"
                        className="iconBtn"
                        onClick={() => discover(m)}
                        disabled={!!busy || !c.email || !c.password || !m.dsn}
                        aria-busy={occupe || undefined}
                        aria-label={occupe ? tk("working") : tk("fetch")}>
                        <Icone nom="cle" />
                        <span className="lbl">{occupe ? tk("working") : tk("fetch")}</span>
                      </Button>
                      {m.lanKeyCachedAt && (
                        <Button type="button" variant="neutre" size="coquille"
                          className="iconBtn"
                          onClick={() => forgetKey(m)}
                          disabled={!!busy}
                          aria-label={tk("forget")}>
                          <Icone nom="corbeille" taille={14} />
                          <span className="lbl">{tk("forget")}</span>
                        </Button>
                      )}
                    </div>
                    <p className="legende">{tk("privacy")}</p>
                    {/* **Le nom accessible faisait 130 caractères** : le `<label>` enveloppait le
                        libellé ET sa note, et sa zone cliquable mesurait 317 × 99 px sur téléphone
                        — pour une case qui écrit un jeton de compte sur le disque. Le libellé seul
                        nomme, la note décrit, et seul le libellé bascule au clic. */}
                    <div className="row note">
                      {/* `aria-labelledby` et non `htmlFor` : la case de Radix est un bouton, qu'un
                          `<label>` ne nomme pas. Le libellé visible reste la seule source du nom. */}
                      <span className="caseLibelle">
                        <Checkbox
                          id={"mem-" + m.id}
                          checked={remember}
                          aria-labelledby={"mem-l-" + m.id}
                          aria-describedby={"mem-n-" + m.id}
                          onCheckedChange={(v) => setRemember(v === true)}
                        />
                        <span id={"mem-l-" + m.id}>{t("remember")}</span>
                      </span>
                    </div>
                    <p className="legende" id={"mem-n-" + m.id}>{t("rememberNote")}</p>
                    {/* Même authentification, donc même endroit : le jeton Ayla que la
                        récupération de clé obtient ouvre aussi la fiche OTA. */}
                    <div className="row note">
                      <Button type="button" variant="neutre" size="commande"
                        className="iconBtn"
                        onClick={() => checkOta(m)}
                        disabled={!!busy || !m.dsn}
                        aria-busy={occupe || undefined}
                        aria-label={t("otaCheck")}>
                        {/* Le nuage ne sert qu'ici, dans tout le produit : c'est la seule action qui
                            quitte le réseau local. Le glyphe est autant un avertissement qu'une
                            étiquette. */}
                        <Icone nom="nuage" />
                        <span className="lbl">{t("otaCheck")}</span>
                      </Button>
                    </div>
                    <p className="legende">{t("otaNote")}</p>
                  </>
                )}
              </div>
            )}

            {/* La suite d'une action sur CETTE machine — adresse enregistrée, clé récupérée, OTA
                interrogée. C'était un `<p className="note">` : du texte gris secondaire, jamais
                annoncé, pour la réponse d'un serveur qui vient peut-être de refuser. */}
            <p className={"status " + (note[m.id]?.kind === "err" ? "err" : "ok")} role="status">
              {note[m.id]?.text ?? ""}
            </p>
          </Card>
        );
      })}

      <Card>
        <h2>{t("addTitle")}</h2>
        {/* **Les deux étiquettes existaient déjà — sans `for`, et sans envelopper leur champ.**
            Elles s'affichaient donc, ne nommaient rien, et cliquer dessus ne donnait pas le focus.
            Le nom accessible retombait sur le `placeholder` : le lecteur d'écran annonçait « Cuisine »
            et « 192.168.1.42 », deux exemples, comme s'il s'agissait de valeurs déjà saisies. */}
        <div className="row">
          <span className="champBloc">
            <label htmlFor="ajout-nom">{t("nameOptional")}</label>
            <Input
              id="ajout-nom"
              className="champ"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) add();
              }}
              placeholder={t("namePlaceholder")}
            />
          </span>
          <span className="champBloc">
            <label htmlFor="ajout-adresse">{t("addressOptional")}</label>
            <Input
              id="ajout-adresse"
              className="champ"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={form.ip}
              onChange={(e) => setForm({ ...form, ip: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) add();
              }}
              placeholder={t("addressPlaceholder")}
            />
          </span>
          <Button type="button" variant="neutre" size="commande" className="iconBtn" onClick={add} disabled={!!busy} aria-label={t("add")}>
            <Icone nom="ajouter" />
            <span className="lbl">{t("add")}</span>
          </Button>
        </div>
      </Card>

      {/* Ce qui limite le multi-machines, en trois lignes. Le détail — protocole, réseau,
          conteneur — vit dans doc/ et DOCKER.md, pas dans un écran de saisie. */}
      <Card>
        <div className="kv">
          <span className="k">{tm("ourServer")}</span>
          <span className={d?.server.problem ? "mono alerte" : "mono"}>
            {d?.server.ip ? `${d.server.ip}:${d.server.port}` : tc("dash")}
            {d?.server.problem && <Icone nom="alerte" taille={15} />}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("cloudSession")}</span>
          <span className="row">
            {cloud?.set ? (
              <>
                <span>{t("cloudSessionSince", { date: new Date(cloud.at ?? 0).toLocaleString("fr-FR") })}</span>
                <Button type="button" variant="neutre" size="coquille"
                  className="iconBtn"
                  onClick={forgetCloud}
                  disabled={!!busy}
                  aria-label={t("cloudSessionForget")}>
                  <Icone nom="corbeille" taille={14} />
                  <span className="lbl">{t("cloudSessionForget")}</span>
                </Button>
              </>
            ) : (
              <span className="sub">{t("cloudSessionNone")}</span>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="k">{t("limitsTitle")}</span>
          {/* Trois énoncés indépendants, donc une liste. En `<br>` ils n'étaient ni comptés ni
              navigables : l'arbre d'accessibilité rendait « LineBreak » entre eux, et un lecteur
              d'écran ne pouvait pas savoir qu'il y en avait trois. */}
          <ul className="sub listeLimites">
            <li>{t("limitsCatalog")}</li>
            <li>{t("limitsEnv")}</li>
            <li>{t("limitsRouting")}</li>
          </ul>
        </div>
      </Card>
      {dialogue}
    </>
  );
}
