/**
 * Une fausse application De'Longhi, pour prouver le multiplexeur de bout en bout sans téléphone.
 *
 * `verif-apps.mjs` prouve ce qui est pur ; ce script prouve le reste — l'enregistrement, l'échange
 * de clés dans le bon sens, la récupération des commandes et la réception des datapoints. Il joue
 * le rôle **client**, exactement comme le SDK Ayla d'Android, et parle au lan-server qui, lui, se
 * fait passer pour la machine.
 *
 * ```
 * PROXY_APPS=1 SERVER_PORT=80 node server.mjs        # dans un terminal
 * node scripts/faux-app.mjs --serveur 127.0.0.1:80   # dans un autre
 * node scripts/faux-app.mjs --serveur 127.0.0.1:80 --lire d302_monitor
 * ```
 *
 * ## Lecture seule, délibérément
 *
 * Ce script ne sait pas fabriquer de trame ECAM et n'en fabriquera pas. `--lire` demande une
 * propriété, c'est tout. La règle du projet — une commande atteint une vraie cafetière, on
 * confirme l'intention — vaut aussi pour un outil de test, et un outil de test qui peut lancer un
 * rinçage à l'eau chaude est un outil dangereux à laisser traîner.
 *
 * ## Ce que son succès démontre, et ce qu'il ne démontre pas
 *
 * Il démontre que **notre** moitié « appareil » est correcte : les clés sont orientées dans le bon
 * sens, les charges utiles ont la bonne forme, le dialogue tient. Il ne démontre PAS qu'une vraie
 * application De'Longhi acceptera de nous parler — elle peut vérifier des choses que ce script ne
 * vérifie pas. C'est l'inférence qui reste ouverte au tableau du §4 de la spécification, et aucun
 * test local ne peut la fermer.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { makeLanSession } from "../src/lib/lansession.mjs";
import { httpJson } from "../src/lib/appproxy.mjs";

// --- arguments ---
const arg = (nom, defaut = null) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};
const [srvIp, srvPort] = (arg("serveur", "127.0.0.1:80")).split(":");
const monPort = Number(arg("port", "8888"));
const monIp = arg("ip", "127.0.0.1");
const aLire = arg("lire", null);

/** La clé LAN vient de `.env.local` comme partout ailleurs : jamais en dur, jamais en argument. */
function cleLan() {
  const explicite = arg("cle", null) ?? process.env.LANIP_KEY;
  if (explicite) return Buffer.from(explicite, "utf8");
  try {
    for (const l of readFileSync(".env.local", "utf8").split("\n")) {
      const m = l.match(/^\s*LANIP_KEY\s*=\s*(.+?)\s*$/);
      if (m) return Buffer.from(m[1], "utf8");
    }
  } catch { /* pas de .env.local */ }
  return null;
}
const LAN_KEY = cleLan();
if (!LAN_KEY) {
  console.error("Clé LAN introuvable. Renseigner LANIP_KEY dans .env.local, ou passer --cle <valeur>.");
  process.exit(2);
}

let session = null;
let datapoints = 0;
/**
 * L'ouverture de session de la VRAIE application : elle écrit `device_connected` avec un `id`,
 * donc en demandant un accusé, avant de faire quoi que ce soit d'autre.
 *
 * Reproduit ici parce que c'est là que le serveur a échoué en conditions réelles : il ne relaie
 * pas cette propriété à la cafetière — à raison — et il en concluait qu'il n'avait rien à
 * répondre. Le téléphone attendait un accusé qui ne venait jamais et n'envoyait plus une seule
 * commande. Un banc qui n'ouvre pas sa session comme l'original ne peut pas voir ce défaut-là.
 */
const ID_PRESENCE = "faux-app-presence";
let accusePresence = false;

/**
 * L'identifiant de la commande de lecture que `--lire` met en file, et ce qu'on en a obtenu.
 *
 * ⚠️ **Une lecture ne se dénoue pas par la réponse HTTP à `commands.json`.** Le SDK garde la
 * commande dans `_commandsPendingResponses` et n'y rattache un datapoint que par le paramètre
 * d'URL `cmd_id` — `getCommand()` lit `session.getParms().get("cmd_id")` et rien d'autre. Sans
 * lui, la commande expire sur `defaultNetworkTimeoutMs` : `Timed out waiting for command
 * response: LanCmd[1]=property.json?name=d302_monitor`, relevé en direct sur la vraie
 * application. Le banc distingue donc les deux cas au lieu de compter un datapoint de plus.
 */
const ID_LECTURE = 1;
let lectureAppariee = false;
let lectureNonAppariee = false;

/**
 * La file que ce faux appareil sert, une commande par visite. `--lot N` en ajoute N de plus,
 * pour reproduire ce que fait l'application officielle : elle empile la commande demandée puis,
 * une milliseconde plus tard, tout un lot d'alarmes. C'est ce qui fait passer la PREMIÈRE en
 * 206 — donc c'est ce qu'il faut savoir reproduire.
 */
const file = [
  {
    quoi: "device_connected (accusé demandé)",
    charge: JSON.stringify({ properties: [{ property: {
      base_type: "integer", name: "device_connected", value: Math.floor(Date.now() / 1000), id: ID_PRESENCE,
    } }] }),
  },
  ...(aLire ? [{ quoi: `lecture ${aLire}`, charge: JSON.stringify({ cmds: [{ cmd: { cmd_id: 1, method: "GET", resource: `property.json?name=${aLire}`, data: "", uri: "/local_lan/property/datapoint.json" } }] }) }] : []),
  ...Array.from({ length: Number(arg("lot", "0")) }, (_, i) => ({
    quoi: `lot ${i + 1}`,
    charge: JSON.stringify({ properties: [{ property: { base_type: "integer", name: "device_connected", value: i + 1 } }] }),
  })),
];

/**
 * Le serveur HTTP que l'« appareil » va venir visiter. Les trois routes sont exactement celles
 * que lan-server sert à la vraie machine — le miroir est complet.
 */
const serveur = createServer(async (req, res) => {
  const url = (req.url ?? "").split("?")[0];
  const corps = await new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c).toString("utf8"))); });
  const repondre = (texte, code = 200) => {
    const b = Buffer.from(texte, "utf8");
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length });
    res.end(b);
  };

  if (url === "/local_lan/key_exchange.json" && req.method === "POST") {
    // `time_1` relu sur le corps BRUT : la même précaution que côté machine, contre la perte de
    // précision de JSON.parse sur un entier long.
    const brut = corps.match(/"time_1"\s*:\s*"?(-?\d+)"?/);
    const kx = JSON.parse(corps).key_exchange;
    const time1 = brut ? brut[1] : String(kx.time_1);
    const random2 = "FauxAppRandom02";
    const time2 = Math.floor(Date.now() / 1000);
    // Rôle CLIENT : c'est l'appareil qui nous a contactés, donc nous sommes l'autre bout.
    session = makeLanSession({ lanKey: LAN_KEY, random1: kx.random_1, random2, time1, time2: String(time2), role: "client" });
    console.log(`  ← échange de clés reçu (key_id ${kx.key_id}) — session ouverte`);
    return repondre(JSON.stringify({ random_2: random2, time_2: time2 }));
  }

  if (url === "/local_lan/commands.json" && req.method === "GET") {
    if (!session) return repondre("{}", 412);
    // ⚠️ **Une commande à la fois, et le statut annonce la SUITE.** C'est la règle du SDK, et
    // la reproduire est tout l'intérêt de ce banc :
    //
    //     getResponseCode() { return _pendingLanCommands.size() > 0 ? PARTIAL_CONTENT : OK; }
    //
    // Donc **206 tant qu'il reste quelque chose après celle qu'on vient de servir**, 200 sur la
    // dernière. Ce banc répondait 200 à tout coup : il ne pouvait donc pas attraper le défaut qui
    // a empêché l'application officielle d'allumer la machine — le serveur jetait les 206, et
    // avec eux la commande qu'ils transportaient. Une démonstration infidèle sur un point précis
    // ne prouve rien sur ce point-là, et c'est le pire service qu'elle puisse rendre.
    const suivante = file.shift();
    if (!suivante) return repondre(session.encapsulate("{}"));
    console.log(`  → commande servie : ${suivante.quoi}${file.length ? ` (206, il en reste ${file.length})` : " (200, dernière)"}`);
    return repondre(session.encapsulate(suivante.charge), file.length > 0 ? 206 : 200);
  }

  if (url.includes("/property/datapoint") && req.method === "POST") {
    if (!session) return repondre("{}", 412);
    // ⚠️ **C'est l'URI qui fait d'un POST un accusé, comme dans le vrai SDK** :
    // `PropertyUpdateHandler.post()` fait `endsWith("ack.json") ? handleDatapointAck(…) :
    // handlePropertyUpdateRequest(…)`. Accepter un accusé sur `datapoint.json` — ce que faisait
    // ce banc — rendait indétectable un serveur qui les postait au mauvais endroit : la vraie
    // application, elle, les lisait comme des écritures de propriété et déclarait la commande en
    // échec au bout de son `_ackTimeout`, alors que la machine l'avait bel et bien exécutée.
    const estAck = url.endsWith("ack.json");
    try {
      const clair = session.decapsulate(JSON.parse(corps));
      const j = JSON.parse(clair);
      const charge = j.data ?? j;
      if (estAck) {
        // `fromJson(payload.data, CreateDatapointAck.class)` lit l'objet NU. Une enveloppe
        // `{properties:[{property:…}]}` donnerait `id = null`, donc aucune commande appariée.
        datapoints++;
        const bon = charge.ack_status === 200;
        if (charge.id === ID_PRESENCE && bon) accusePresence = true;
        console.log(`  ← accusé ${charge.id ?? "SANS ID (enveloppé ?)"} statut ${charge.ack_status}` + (bon ? "" : " ⚠ le SDK lit tout sauf 200 comme un NAK"));
      } else {
        // ⚠️ **Un datapoint est un objet NU, lui aussi.** `handlePropertyUpdateRequest` fait
        // `new JSONObject(payload.data).getString("name")` : enveloppé dans
        // `{properties:[{property:…}]}`, il lève une `JSONException`, la propriété n'est jamais
        // appliquée et l'application répond 400 « Bad message JSON ». Ce banc acceptait les deux
        // formes et ne pouvait donc pas voir que le serveur poussait la mauvaise — c'est-à-dire
        // que le cœur du multiplexeur, une lecture réelle pour N destinataires, n'arrivait
        // lisible chez personne.
        const enveloppe = charge.properties !== undefined;
        const q = enveloppe ? (charge.properties[0]?.property ?? charge.properties[0] ?? {}) : charge;
        datapoints++;
        // `cmd_id` est un paramètre d'URL, jamais un champ de la charge.
        // ⚠️ `url` est privé de sa requête plus haut : c'est `req.url` qui la porte, et le
        // `cmd_id` n'existe que là. Le lire sur `url` rendait ce banc aveugle à l'appariement
        // même — il voyait le datapoint arriver et concluait « jamais appariée ».
        const cmd = new URL(req.url ?? "", "http://x").searchParams.get("cmd_id");
        if (q.ack_status !== undefined) console.log(`  ← accusé ${q.id} ⚠ POSTÉ SUR datapoint.json : le SDK le lira comme une écriture`);
        else if (enveloppe) console.log(`  ← datapoint ${q.name} ⚠ ENVELOPPÉ dans properties[] : le SDK lève JSONException et répond 400`);
        else console.log(`  ← datapoint ${q.name} = ${String(q.value).slice(0, 60)}${cmd === null ? "" : ` (réponse à la commande ${cmd})`}`);
        if (!enveloppe && q.ack_status === undefined && aLire && q.name === aLire) {
          if (Number(cmd) === ID_LECTURE) lectureAppariee = true;
          else lectureNonAppariee = true;
        }
      }
    } catch (e) {
      console.log(`  ← datapoint ILLISIBLE (${e.message}) — mauvais sens de clés ?`);
    }
    // ⚠️ **Corps VIDE, et surtout pas un `encapsulate("{}")`.** C'est ce que fait le vrai SDK :
    // `AylaLanModule.handlePropertyUpdateRequest` rend `newFixedLengthResponse(getResponseCode(),
    // MIME_JSON, "")`. Chiffrer une réponse ici avançait le flux AES sortant de la fausse app d'un
    // message que le serveur, lui, ne déchiffrait jamais — il jette le corps de son POST, comme le
    // protocole l'y autorise. Le flux entrant du serveur restait donc un message en arrière, et le
    // PREMIER bloc du prochain `commands.json` sortait en charabia, la suite parfaitement lisible :
    // en CBC, un chaînage faux ne salit que le bloc de tête, les suivants se recalent seuls sur le
    // chiffré qui les précède dans le même message. D'où cette signature très reconnaissable,
    // `…a":{}}` au bout d'octets illisibles — exactement celle qu'on avait vue avec la vraie
    // application, mais pour une TOUTE AUTRE cause (deux sondes concurrentes, corrigée depuis).
    // Une démonstration infidèle sur ce point précis fabriquait donc le symptôme qu'elle était
    // censée aider à débusquer : le pire service qu'un banc d'essai puisse rendre.
    return repondre("", 200);
  }
  repondre("{}", 404);
});

serveur.listen(monPort, "0.0.0.0", async () => {
  console.log(`\nFausse application : écoute sur ${monIp}:${monPort}, serveur visé ${srvIp}:${srvPort}`);

  // 1. Qui répond là-bas ? C'est ce que fait une application avant tout le reste.
  let dsn = null;
  try {
    const r = await httpJson({ ip: srvIp, port: Number(srvPort), path: "/regtoken.json", method: "GET" });
    dsn = JSON.parse(r.corps).host_symname;
    console.log(`  → regtoken : le serveur se présente comme ${dsn}`);
  } catch (e) {
    console.error(`  ✗ regtoken injoignable (${e.message}). Le multiplexeur est-il allumé (PROXY_APPS=1) et le port correct ?`);
    process.exit(1);
  }

  // 2. Je m'annonce. Le `?dsn=` est ce que le SDK ajoute au PREMIER enregistrement, et c'est ce
  //    qui permet au serveur de refuser une demande qui ne le concerne pas.
  const annonce = async (methode) => {
    const r = await httpJson({
      ip: srvIp, port: Number(srvPort),
      path: `/local_reg.json${methode === "POST" ? `?dsn=${encodeURIComponent(dsn)}` : ""}`,
      method: methode,
      body: JSON.stringify({ local_reg: { ip: monIp, port: monPort, uri: "/local_lan", notify: file.length ? 1 : 0 } }),
    });
    return r.status;
  };
  console.log(`  → local_reg POST : HTTP ${await annonce("POST")}`);

  // 3. Rafraîchissements, comme le fait l'application. Aucun ne doit relancer d'échange de clés.
  const battement = setInterval(() => { annonce("PUT").catch(() => {}); }, 5000);
  battement.unref?.();

  setTimeout(async () => {
    console.log(`\nBilan : session ${session ? "ÉTABLIE" : "JAMAIS OUVERTE"}, ${datapoints} datapoint(s) reçu(s).`);
    // Dit en toutes lettres, parce que c'est l'affirmation que ce banc sert à vérifier : sans cet
    // accusé, une vraie application se tait définitivement au lieu d'envoyer ses commandes.
    console.log(`  device_connected : accusé ${accusePresence ? "REÇU" : "JAMAIS REÇU — le serveur laisse l'application attendre"}.`);
    // La file VIDE est l'affirmation centrale quand on passe `--lot` : un serveur qui jette les
    // 206 laisse ici des commandes non servies, et les perd toutes sauf la dernière.
    console.log(`  file de commandes : ${file.length ? `${file.length} JAMAIS SERVIE(S) — le serveur jette-t-il les 206 ?` : "entièrement servie"}.`);
    // La lecture est l'autre moitié du protocole, et elle a un verdict à trois branches : servie
    // et appariée, servie sans `cmd_id` (le SDK la laisserait expirer quand même), ou rien.
    if (aLire) {
      console.log(`  lecture ${aLire} : ${
        lectureAppariee ? `RÉPONDUE et appariée (cmd_id ${ID_LECTURE})`
        : lectureNonAppariee ? "répondue SANS cmd_id — le SDK ne l'apparie pas et la laisse expirer"
        : "JAMAIS RÉPONDUE — le SDK expire en « Timed out waiting for command response »"
      }.`);
    }
    if (session) {
      // Fin de session propre : c'est `DeleteSessionCommand` du SDK, et le serveur doit retirer
      // l'entrée du registre plutôt que d'attendre l'expiration.
      await httpJson({ ip: srvIp, port: Number(srvPort), path: "/local_reg.json", method: "DELETE", body: "delete_session" }).catch(() => {});
      console.log("  → session fermée (DELETE local_reg.json)");
    }
    process.exit(session ? 0 : 1);
  }, Number(arg("duree", "20")) * 1000);
});
