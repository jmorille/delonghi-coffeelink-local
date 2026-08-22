/**
 * File de tâches machine — l'ordonnanceur, et rien d'autre.
 *
 * **Pourquoi ce module existe.** La machine ne récupère qu'UNE commande par visite de
 * `/local_lan/commands.json` : il n'y a jamais deux trames en vol, et c'est le seul mécanisme
 * d'exclusion qui soit structurel. Or `startProgram` et `startImport` écrivaient chacun dans un
 * emplacement unique (`m.program`, `m.import`) **sans regarder ce qui tournait déjà** : dernier
 * arrivé, dernier servi, le précédent disparaissait sans un mot — ni ligne de journal, ni échec, ni
 * refus. Les propriétés restantes d'un import écrasé étaient simplement perdues. Ouvrir une page
 * pendant un balayage suffisait à le décapiter.
 *
 * Ici, une seule file par machine. Ce module est **pur** : pas d'horloge implicite (l'instant est
 * toujours un paramètre), pas d'I/O, pas de journal. C'est ce qui le rend vérifiable sans machine —
 * et ce qui permet à `server.mjs`, déjà à 3 300 lignes, de ne garder que ce qui parle au réseau.
 *
 * ## Le vocabulaire
 *
 * Une **tâche** est une liste de **pas** plus une politique. Un pas est ce qu'on sert lors d'une
 * visite. Un import de 21 propriétés est UNE tâche de 21 pas ; « Allumer » est une tâche d'un pas ;
 * un balayage des grains est une tâche de 6 pas — là où c'étaient six programmes indépendants
 * cadencés par un `setTimeout(11000)` deviné, qui laissait deux secondes de vide entre chacun.
 *
 * Trois natures d'attente, parce que la machine ne répond pas de la même façon selon ce qu'on
 * demande :
 *
 * - `prop`    — lecture d'une propriété Ayla : on attend que la machine POSTe **cette** propriété.
 * - `reponse` — commande ECAM de lecture (`0x75`, `0xA2`, `0xA3`, `0xA6`, `0xB0`, `0xBA`) : on
 *               attend un `data_response`, quel qu'il soit.
 * - `fenetre` — commande ECAM qui AGIT (`0x84`, `0x83`, `0xA9`, `0xBB`, `0xB9`) : rien ne revient.
 *               `ms` n'est alors PAS un délai d'échec mais une **durée de présence soutenue** :
 *               l'atteindre est un succès. Confondre les deux ferait passer un allumage réussi pour
 *               une panne.
 */

/**
 * Les quatre rangs, et **une seule règle de préemption** : une tâche peut être suspendue à une
 * frontière de pas par une tâche de rang strictement supérieur (donc de numéro strictement
 * inférieur). Tout le reste en découle, y compris le fait qu'une commande n'en coupe jamais une
 * autre.
 *
 * **`LECTURE_BASSE` (le « READ_LOW ») est le rang du fond de file.** Les compteurs d'usage sont la
 * seule donnée de cette machine qui ne périme pas : un nombre de détartrages lu trente secondes
 * plus tard est le même nombre. Tout le reste — noms de profils, bornes d'une boisson, réglages de
 * grain — est ce qu'on regarde à l'écran pendant qu'on attend. Or un balayage complet, c'est huit
 * requêtes, soit huit allers-retours pendant lesquels la page qu'on vient d'ouvrir n'affiche rien.
 * Le rang inverse cet ordre sans rien annuler : les statistiques passent derrière, et reprennent
 * exactement où elles en étaient.
 */
export const RANG = { URGENT: 0, COMMANDE: 1, LECTURE: 2, LECTURE_BASSE: 3 };

/** Échéances par défaut. Volontairement courtes : une machine vivante répond en 2-3 s. */
export const DELAIS = {
  /** Lecture d'une propriété. */
  prop: 8000,
  /** Commande ECAM de lecture, un peu plus longue : la machine calcule parfois. */
  reponse: 12000,
  /**
   * **Le coupe-circuit.** Sans contact d'aucune sorte pendant ce temps, alors que la tâche est en
   * tête et que `local_reg` part toutes les 2,5 s, la machine est muette : éteinte, hors du réseau,
   * ou incapable de revenir vers nous. Une tâche jamais SERVIE n'a aucune échéance de pas — c'est
   * ce délai-là qui la rattrape, et c'est le cas réel le plus fréquent.
   */
  muet: 25000,
};

/** Nombre maximal de tâches en file. Au-delà, on refuse plutôt que de gonfler sans fin. */
export const MAX_FILE = 32;

/** Combien de tâches terminées on garde pour l'affichage. Assez pour voir ce qui vient d'échouer. */
const GARDE_FINIES = 5;

// --- construction -----------------------------------------------------------------------------

/**
 * Un pas de lecture de propriété Ayla.
 * `nom` sert à l'appariement ET à l'affichage : c'est le nom de la propriété.
 */
export function pasLecture(nom, ms = DELAIS.prop) {
  return { type: "prop", nom, prop: nom, ms, etat: "attente", servieA: null, repris: false };
}

/**
 * Un pas de commande ECAM.
 * `attente` vaut `reponse` (la machine répondra) ou `fenetre` (elle n'a rien à répondre) — le
 * choix se déduit de l'octet de commande côté `server.mjs`, qui possède déjà la table.
 */
export function pasTrame(nom, b64, { attente = "fenetre", ms = DELAIS.reponse, sustain = "monitor", cmd = null } = {}) {
  return { type: attente === "reponse" ? "reponse" : "fenetre", nom, trame: b64, sustain, ms, cmd, etat: "attente", servieA: null, repris: false };
}

/**
 * `cle` est ce qui permet de fusionner deux demandes identiques encore en attente — trois onglets
 * ouverts ne doivent pas produire trois présences. Null = jamais fusionnable (toute commande qui
 * agit : demander deux cafés n'est pas demander un café).
 */
export function tache({ label, rang = RANG.LECTURE, pas, cle = null, meta = null, genre = "lecture", i18n = null }) {
  return {
    id: null,
    label,
    /**
     * **La clé de traduction du libellé, et ses paramètres** — `{ k, p }`, `k` dans l'espace
     * `task` du catalogue. `label` reste : c'est le texte du journal du terminal, et le repli du
     * client quand la clé manque. Même règle que partout ailleurs ici — le serveur envoie un
     * identifiant, le client traduit, et un catalogue incomplet dégrade au lieu de casser.
     *
     * Ce champ existe parce que les libellés de tâches sont la derniere chose que le serveur
     * envoyait en français pour affichage direct : trois endroits du panneau « Activité » les
     * rendaient bruts.
     */
    i18n,
    rang,
    cle,
    /**
     * « lecture » ou « commande ». Ce n'est pas le rang : une écriture de recette est une commande
     * de rang COMMANDE, un balayage est une lecture de rang LECTURE, mais une demande de sommes de
     * contrôle est une lecture qu'on pourrait vouloir prioriser. Les pages qui affichent « lecture
     * en cours » ont besoin de la nature, pas de la priorité.
     */
    genre,
    meta,
    pas: [...pas],
    i: 0,
    etat: "attente",
    creeA: null,
    demarreA: null,
    finiA: null,
    /** Pas définitivement sans réponse, après leur reprise. C'est ce qui fait échouer une tâche. */
    nonLus: [],
    /** Pas menés à bien. */
    faits: 0,
    motif: null,
    /**
     * Combien de tâches de MÊME `cle` ce verdict résume. Voir `finir` : les terminées se replient
     * comme le journal replie ses lignes identiques, et le compte est ce qui empêche « réussie »
     * de faire oublier les quatre échecs qui l'ont précédée.
     */
    repetitions: 1,
  };
}

export function nouvelleFile() {
  return { seq: 0, liste: [], finies: [], dernierContact: 0 };
}

// --- lecture ----------------------------------------------------------------------------------

/** La tâche de tête : celle qui a le droit d'être servie. Rien d'autre ne l'est jamais. */
export function courante(file) {
  return file.liste[0] ?? null;
}

/** Le pas de la tâche de tête, s'il y en a un. */
export function pasCourant(file) {
  const t = courante(file);
  return t ? (t.pas[t.i] ?? null) : null;
}

export function vide(file) {
  return file.liste.length === 0;
}

/**
 * Vue destinée à l'API. Les tâches terminées sont incluses : le résultat d'une lecture qui vient
 * d'échouer est précisément ce qu'on cherche à voir, et il disparaissait avec elle.
 */
export function vue(file) {
  const dehors = (t) => ({
    id: t.id,
    label: t.label,
    rang: t.rang,
    genre: t.genre,
    etat: t.etat,
    total: t.pas.length,
    faits: t.faits,
    nonLus: t.nonLus.length,
    pasCourant: t.etat === "encours" ? (t.pas[t.i]?.nom ?? null) : null,
    repris: t.pas.filter((p) => p.repris).length,
    motif: t.motif,
    i18n: t.i18n ?? null,
    repetitions: t.repetitions ?? 1,
    creeA: t.creeA,
    demarreA: t.demarreA,
    finiA: t.finiA,
  });
  return {
    encours: file.liste[0] && file.liste[0].etat === "encours" ? dehors(file.liste[0]) : null,
    attente: file.liste.slice(file.liste[0]?.etat === "encours" ? 1 : 0).map(dehors),
    finies: file.finies.map(dehors),
    total: file.liste.length,
  };
}

// --- écriture ---------------------------------------------------------------------------------

/**
 * Insère une tâche à sa place, et c'est là que vit toute la politique de priorité.
 *
 * **Une seule règle d'insertion** : la tâche se place avant la première tâche de rang strictement
 * plus faible. Tout le comportement demandé en découle sans cas particulier —
 *
 * - un arrêt (rang 0) passe devant une préparation en cours (rang 1) : il la préempte ;
 * - une commande (rang 1) passe devant une lecture en cours (rang 2) : elle la suspend ;
 * - une commande n'en coupe jamais une autre : même rang, donc FIFO ;
 * - une lecture (rang 2) passe devant un balayage de statistiques (rang 3) : elle le suspend ;
 * - une lecture ne préempte jamais une commande.
 *
 * « Suspendue » et non « annulée » : la tâche évincée reste dans la liste avec ses pas restants et
 * **reprend** quand l'intruse a fini. C'est exactement ce que l'écrasement détruisait.
 *
 * @returns {{ok: true, tache}|{ok: true, fusion: true, tache}|{ok: false, raison: "pleine"}}
 */
export function enfiler(file, t, maintenant, { max = MAX_FILE } = {}) {
  // Fusion : une demande identique déjà en attente rend la nouvelle inutile. Jamais avec la tâche
  // en cours — celle-là a déjà servi une partie de ses pas, la fusionner perdrait le reste.
  if (t.cle) {
    const jumelle = file.liste.find((x) => x.cle === t.cle && x.etat === "attente");
    if (jumelle) return { ok: true, fusion: true, tache: jumelle };
  }
  if (file.liste.length >= max) return { ok: false, raison: "pleine" };

  t.id = `t${++file.seq}`;
  t.creeA = maintenant;
  let i = file.liste.findIndex((x) => x.rang > t.rang);
  if (i < 0) i = file.liste.length;
  file.liste.splice(i, 0, t);
  return { ok: true, tache: t };
}

/**
 * Ce qu'il faut servir maintenant, du point de vue de l'ordonnanceur seul.
 *
 * `server.mjs` ajoute par-dessus la chorégraphie de présence (`device_connected` d'abord, puis
 * rafraîchi périodiquement) : elle appartient au protocole, pas à la priorité des tâches.
 *
 * @returns {{quoi:"pas", pas, tache}|{quoi:"soutien", sustain, tache}|{quoi:"rien"}}
 */
export function aServir(file, maintenant) {
  const t = courante(file);
  if (!t) return { quoi: "rien" };
  if (t.etat === "attente") {
    t.etat = "encours";
    t.demarreA = maintenant;
  }
  const p = t.pas[t.i];
  if (!p) return { quoi: "rien" };
  if (p.etat === "attente") {
    p.etat = "servi";
    p.servieA = maintenant;
    return { quoi: "pas", pas: p, tache: t };
  }
  // Le pas est parti, on attend sa réponse : on tient la présence sans rien changer sur la machine.
  return { quoi: "soutien", sustain: p.sustain ?? "monitor", tache: t };
}

/**
 * Une réponse est arrivée. On l'apparie contre le pas courant de **n'importe quelle** tâche, pas
 * seulement celle de tête : une tâche suspendue par une préemption peut très bien recevoir la
 * réponse qu'elle attendait, et la jeter serait perdre une lecture déjà payée.
 *
 * `quoi.cmd` **restreint** l'appariement aux pas qui portent cette commande ECAM, et n'existe que
 * pour un cas : la réponse à une demande de monitor (`0x75`) n'arrive PAS en `data_response`, elle
 * arrive en poussée de propriété `d302_monitor` — mesuré, voir `doc/commandes-cafe.md`. Or ces
 * poussées sont aussi **spontanées** : pendant une préparation la machine en émet une toutes les 1
 * à 3 secondes. Les apparier largement validerait le pas d'une tâche qui attend tout autre chose —
 * une lecture de statistiques, par exemple — avec des compteurs jamais lus déclarés lus.
 *
 * Sans `cmd`, le comportement est inchangé : un `data_response` apparie le premier pas `reponse`
 * venu. C'est délibérément conservé, faute d'avoir vérifié la correspondance octet à octet pour
 * toutes les commandes ; restreindre à l'aveugle ferait échouer des lectures qui fonctionnent.
 *
 * @param quoi {{prop?: string, reponse?: boolean, cmd?: number}}
 * @returns la tâche appariée, ou null
 */
export function reponse(file, quoi, maintenant) {
  file.dernierContact = maintenant;
  for (const t of file.liste) {
    const p = t.pas[t.i];
    if (!p || p.etat !== "servi") continue;
    const colle = quoi.prop
      ? p.type === "prop" && p.prop === quoi.prop
      : p.type === "reponse" && (quoi.cmd === undefined || p.cmd === quoi.cmd);
    if (!colle) continue;
    p.etat = "fait";
    t.faits++;
    t.i++;
    return t;
  }
  return null;
}

/** Tout datapaquet reçu prouve que la machine est vivante, même s'il n'apparie rien. */
export function contact(file, maintenant) {
  file.dernierContact = maintenant;
}

/**
 * Fait avancer le temps : échéances, reprises, fins, coupe-circuit.
 *
 * Ne juge **que la tâche de tête** — une tâche suspendue a ses échéances gelées, sinon elle
 * mourrait d'une attente qu'on lui a imposée.
 *
 * @returns {Array<{type:string, ...}>} les évènements à journaliser, dans l'ordre
 */
export function tic(file, maintenant) {
  const ev = [];
  const t = courante(file);
  if (!t) return ev;
  /**
   * **Une tâche démarre en atteignant la tête, pas en étant servie.**
   *
   * `aServir` la promeut aussi, mais il n'est appelé que lorsque la machine VISITE — or le cas qui
   * nous intéresse le plus est justement celui où elle ne vient jamais. Sans cette promotion ici,
   * la tâche restait « en attente » pour toujours, le coupe-circuit ne se déclenchait pas, et la
   * file entière attendait indéfiniment une machine muette. C'est aussi la bonne définition :
   * l'horloge du coupe-circuit compte le temps passé EN TÊTE, pas le temps passé servi.
   */
  if (t.etat === "attente") { t.etat = "encours"; t.demarreA = maintenant; }
  if (t.etat !== "encours") return ev;

  /**
   * **Coupe-circuit.** Aucun contact depuis que cette tâche est en tête, alors que `local_reg` part
   * toutes les 2,5 s : la machine ne viendra pas. Rien ne sert d'attendre l'échéance de chacun des
   * vingt-et-un pas, ni de retenter — la reprise par propriété doublerait l'attente dans le seul
   * cas où elle ne peut rien rattraper. On déclare, on vide, on le dit une fois.
   */
  const depuis = Math.max(t.demarreA ?? 0, file.dernierContact);
  if (maintenant - depuis > DELAIS.muet) {
    const restantes = file.liste.length - 1;
    finir(file, t, "echouee", "muette", maintenant);
    ev.push({ type: "muette", tache: t, restantes });
    for (const autre of file.liste.slice()) {
      finir(file, autre, "annulee", "muette", maintenant);
      ev.push({ type: "annulee", tache: autre, cause: "muette", silencieux: true });
    }
    return ev;
  }

  const p = t.pas[t.i];
  if (!p) {
    ev.push(...conclure(file, t, maintenant));
    return ev;
  }
  if (p.etat !== "servi") return ev;
  if (maintenant - p.servieA <= p.ms) return ev;

  if (p.type === "fenetre") {
    // Échéance atteinte = présence tenue jusqu'au bout. C'est le succès de ce genre de pas.
    p.etat = "fait";
    t.faits++;
    t.i++;
  } else if (!p.repris) {
    /**
     * **Reprise, une fois, en fin de tâche.** La machine répond (sinon le coupe-circuit ci-dessus
     * aurait déjà tranché) mais ce pas-là est resté sans réponse : on le remet en queue plutôt que
     * de le perdre. En fin de tâche et non tout de suite, pour ne pas bloquer les vingt suivants
     * sur celui qui coince.
     */
    p.etat = "manque";
    t.i++;
    t.pas.push({ ...p, etat: "attente", servieA: null, repris: true });
    ev.push({ type: "repris", tache: t, pas: p });
  } else {
    p.etat = "manque";
    t.i++;
    t.nonLus.push(p.nom);
    ev.push({ type: "perdu", tache: t, pas: p });
  }
  if (!t.pas[t.i]) ev.push(...conclure(file, t, maintenant));
  return ev;
}

/** Fin normale d'une tâche : réussie si rien ne manque. */
function conclure(file, t, maintenant) {
  const etat = t.nonLus.length ? "echouee" : "faite";
  finir(file, t, etat, t.nonLus.length ? `${t.nonLus.length} sans réponse` : null, maintenant);
  return [{ type: etat, tache: t }];
}

function finir(file, t, etat, motif, maintenant) {
  t.etat = etat;
  t.motif = motif;
  t.finiA = maintenant;
  const i = file.liste.indexOf(t);
  if (i >= 0) file.liste.splice(i, 1);
  /**
   * **Les terminées se replient sur leur `cle`, et seul le dernier verdict reste.**
   *
   * Une même `cle` désigne déjà LA MÊME demande — c'est ce qui fusionne deux tâches encore en
   * attente. Le panneau « Activité » ne l'appliquait pas aux terminées, et le résultat était
   * trompeur dans le cas le plus fréquent : un coupe-circuit annule toute la file d'un coup, donc
   * cinq « Présence » échouées ou annulées ; la présence suivante réussit, mais elle n'occupe
   * qu'une des cinq lignes et les quatre verdicts périmés restent à l'écran. Ils décrivaient un
   * état de la machine qui n'existait plus.
   *
   * Le compte survit (`repetitions`), même règle que le repli du journal : une ligne repliée sans
   * son compte se lit comme un incident isolé là où il y en a eu cinq. Ici il dit « il a fallu s'y
   * reprendre », ce que le seul dernier verdict effacerait.
   *
   * **Sans `cle`, aucun repli** : c'est exactement la frontière que `cle` trace déjà — demander
   * deux cafés n'est pas demander un café, et deux préparations gardent deux lignes.
   */
  if (t.cle) {
    const j = file.finies.findIndex((x) => x.cle === t.cle);
    if (j >= 0) {
      t.repetitions = (file.finies[j].repetitions ?? 1) + 1;
      file.finies.splice(j, 1);
    }
  }
  file.finies.unshift(t);
  file.finies.length = Math.min(file.finies.length, GARDE_FINIES);
}

/**
 * Annule une tâche par son identifiant, ou toutes. Une tâche annulée rejoint les terminées avec son
 * motif : elle ne disparaît pas, sans quoi on retomberait dans le défaut d'origine — du travail qui
 * s'évapore sans laisser de trace.
 */
export function annuler(file, id, motif, maintenant) {
  const cibles = id ? file.liste.filter((t) => t.id === id) : file.liste.slice();
  for (const t of cibles) finir(file, t, "annulee", motif, maintenant);
  return cibles;
}
