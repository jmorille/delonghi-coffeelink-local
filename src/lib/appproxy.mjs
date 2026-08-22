/**
 * Le côté « appareil » du multiplexeur : ce que lan-server dit et fait vers une APPLICATION qui
 * le prend pour la machine.
 *
 * ⚠️ Ce module TOURNE. Ce n'est pas une des copies `.ts` shadowées.
 *
 * Il ne contient **que** le transport et l'analyse des charges utiles ; la décision de servir ou
 * de refuser appartient à `server.mjs`, et l'état des applications à `appregistry.mjs`. La
 * fonction pure de ce fichier — `analyserCommandes()` — est celle qui compte : c'est elle qui
 * traduit ce qu'une application demande en intentions que notre file peut exécuter, et c'est la
 * seule partie vérifiable sans téléphone (`scripts/verif-apps.mjs`).
 *
 * ## Les deux formes qu'une application sert dans `commands.json`
 *
 * Relevées dans le SDK décompilé, pas devinées :
 *
 * ```
 * AylaLanCommand.getPayload()          {"cmds":[{"cmd":{cmd_id, method, resource, data, uri}}]}
 * CreateDatapointCommand.getPayload()  {"properties":[{"property":{name, value, dsn, base_type, id}}]}
 * ```
 *
 * La première est une **lecture** (`GET property.json?name=X`) ou la fin de session
 * (`DELETE local_reg.json`, data `delete_session`). La seconde est une **écriture** de datapoint,
 * et c'est celle qui porte les trames ECAM que l'application veut faire exécuter.
 *
 * Ce sont exactement les deux formes que notre propre `prochainePaquet()` sert à la machine — ce
 * qui est normal : dans les deux cas c'est le client qui parle à l'appareil. Le multiplexeur est
 * cette symétrie prise au mot.
 *
 * ## Pourquoi ce n'est pas un tuyau
 *
 * On ne peut pas relayer les octets tels quels. Chaque session a son **propre** flux AES-CBC
 * persistant (voir `lansession.mjs`) : le chiffré destiné à l'application n'a de sens que dans le
 * flux de l'application. Tout ce qui traverse est donc déchiffré d'un côté et rechiffré de
 * l'autre, et c'est ce qui rend le multiplexage possible — N flux indépendants au lieu d'un.
 */
import http from "node:http";

/** Le port sur lequel une application cherche l'appareil : le SDK construit `http://<ip>/…`. */
export const PORT_ATTENDU_PAR_APP = 80;

/**
 * Requête JSON vers une application, en `node:http` avec `Content-Length` explicite.
 *
 * Le même choix que pour `local_reg` vers la machine, et pour une raison de plus ici : le serveur
 * HTTP embarqué du SDK Android (NanoHTTPD) est aussi économe que celui de l'ESP32. `fetch`/undici
 * ajoute un `transfer-encoding` et des en-têtes que rien n'oblige ces serveurs à accepter.
 */
/**
 * Les codes réseau qui PROUVENT qu'il n'y a plus personne à l'écoute. `ETIMEDOUT` n'en est pas.
 *
 * La distinction est la justification même de l'éviction rapide : un port fermé répond non, et
 * c'est un fait sur l'application ; un silence ne dit rien, le téléphone peut être verrouillé. Les
 * confondre — ce que faisait le code, faute de code d'erreur porté jusqu'à l'appelant — évinçait en
 * une douzaine de secondes une application qui s'était seulement tue. Mesuré sur la vraie
 * application : sortie du registre en 16 s, revenue 9 s plus tard sur le MÊME port d'écoute.
 */
export const REFUS_RESEAU = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

/** Pur, donc prouvable sans réseau : cette erreur est-elle un refus, ou seulement un silence ? */
export const estRefus = (err) => REFUS_RESEAU.has(err?.code);

export function httpJson({ ip, port, path, method = "POST", body = null, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const buf = body == null ? null : Buffer.from(body, "utf8");
    const req = http.request(
      {
        host: ip,
        port,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(buf ? { "Content-Type": "application/json", "Content-Length": buf.length } : {}),
        },
        timeout,
      },
      (res) => {
        const morceaux = [];
        res.on("data", (c) => morceaux.push(c));
        res.on("end", () => resolve({ status: res.statusCode, corps: Buffer.concat(morceaux).toString("utf8") }));
      },
    );
    // Le code d'erreur est PORTÉ, pas seulement le message : un délai dépassé et un refus de
    // connexion n'ont pas la même valeur de preuve. Un port fermé répond non — c'est un fait sur
    // l'application. Un silence ne dit rien : le téléphone peut être verrouillé. Sans ce code,
    // l'appelant ne peut que les confondre, et l'éviction rapide conçue pour les refus frappait
    // aussi les silences (constaté : une application déclarée injoignable en 16 s, revenue sur le
    // MÊME port 9 s plus tard — elle n'était jamais partie).
    req.on("timeout", () => {
      const e = new Error("délai dépassé");
      e.code = "ETIMEDOUT";
      req.destroy(e);
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

/**
 * Ouvre une session vers une application, dans le rôle de l'appareil.
 *
 * C'est le miroir exact de ce que la machine nous fait : **c'est l'appareil qui initie**. Nous
 * postons `random_1` / `time_1` / `key_id`, l'application répond `random_2` / `time_2`.
 *
 * `time_1` part en **nombre**, et `time_2` est relu sur le corps BRUT par expression régulière —
 * les deux précautions viennent du côté machine, où un `time_2` en chaîne faisait échouer
 * l'échange et où `JSON.parse` perdait de la précision sur des entiers longs. Rien ne garantit
 * que l'implémentation d'en face soit plus tolérante que celle-ci.
 */
export async function echangeClesVersApp({ ip, port, uri, keyId, random1, time1, timeout = 5000 }) {
  const corps = JSON.stringify({
    key_exchange: { ver: 1, proto: 1, key_id: Number(keyId), random_1: random1, time_1: Number(time1) },
  });
  const rep = await httpJson({ ip, port, path: `${uri}/key_exchange.json`, method: "POST", body: corps, timeout });
  if (rep.status !== 200) throw new Error(`échange de clés refusé (HTTP ${rep.status})`);
  const brut = rep.corps.match(/"time_2"\s*:\s*"?(-?\d+)"?/);
  const j = JSON.parse(rep.corps);
  const random2 = j.random_2 ?? j.key_exchange?.random_2;
  if (!random2 || !brut) throw new Error("réponse d'échange de clés incomplète");
  return { random2, time2: brut[1] };
}

/**
 * Analyse une charge utile déchiffrée reçue d'une application, et rend des **intentions**.
 *
 * Fonction pure — c'est délibéré, et c'est ce qui rend `verif-apps.mjs` possible. Elle ne décide
 * rien : elle nomme. Ce qui n'est pas reconnu ressort en `{type:"inconnu"}` **avec sa charge**,
 * plutôt que d'être ignoré : une application qui nous demande quelque chose que nous ne savons pas
 * faire doit apparaître dans le journal, pas disparaître.
 *
 * @returns {Array<{type:string, ...}>}
 */
export function analyserCommandes(clair) {
  let j;
  try {
    j = JSON.parse(clair);
  } catch {
    return [{ type: "illisible", brut: clair.slice(0, 200) }];
  }
  // La charge chiffrée est enveloppée dans `{seq_no, data}` par `encapsulate`. Selon l'appelant on
  // reçoit l'enveloppe ou déjà son contenu ; accepter les deux évite un dépliage en double.
  const d = j && typeof j.data === "object" && j.data !== null ? j.data : j;
  const out = [];

  for (const e of d?.cmds ?? []) {
    const c = e?.cmd ?? e;
    if (!c) continue;
    if (c.method === "DELETE" && String(c.resource).startsWith("local_reg")) {
      out.push({ type: "finSession", cmdId: c.cmd_id ?? c.cmdId ?? 0 });
      continue;
    }
    const nom = String(c.resource ?? "").match(/name=([^&]+)/);
    if (c.method === "GET" && nom) {
      out.push({ type: "lecture", cmdId: c.cmd_id ?? c.cmdId ?? 0, nom: decodeURIComponent(nom[1]), uri: c.uri ?? null });
      continue;
    }
    out.push({ type: "inconnu", charge: c });
  }

  for (const e of d?.properties ?? []) {
    const p = e?.property ?? e;
    if (!p || typeof p.name !== "string") {
      out.push({ type: "inconnu", charge: e });
      continue;
    }
    out.push({
      type: "ecriture",
      nom: p.name,
      valeur: p.value,
      // `id` n'est présent que si la propriété demande un accusé ; sa présence EST la demande.
      // Le renvoyer tel quel est ce que l'application attend pour dénouer son attente.
      ackId: p.id ?? null,
      dsn: p.dsn ?? null,
    });
  }

  if (!out.length) out.push({ type: "vide" });
  return out;
}

/** Le paquet `{properties:[…]}` qu'un appareil pousse vers une application. */
export function paquetDatapoint(dsn, name, value) {
  return JSON.stringify({ properties: [{ property: { base_type: "string", name, value, dsn } }] });
}

/** L'accusé qu'une application attend quand sa propriété portait un `id`. */
export function paquetAck(dsn, id, status = 0) {
  return JSON.stringify({ properties: [{ property: { dsn, id, ack_status: status, ack_message: 0 } }] });
}
