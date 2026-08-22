// Serveur LAN mode autonome + journal VERBATIM de tout ce que la machine envoie.
// But diagnostique : voir la séquence exacte de requêtes après le key_exchange.
// Lance : node --env-file=.env.local debug-capture.mjs   (écoute sur 0.0.0.0:PORT, envoie local_reg à la machine)
import http from "node:http";
import crypto from "node:crypto";

// Secrets par l’environnement, jamais en dur : ce fichier est versionné, .env.local ne l’est pas.
const MACHINE_IP = process.env.MACHINE_IP ?? "";
const SERVER_IP = process.env.SERVER_IP ?? "";
const PORT = Number(process.env.DEBUG_PORT ?? 3005);
const LAN_KEY = Buffer.from(process.env.LANIP_KEY ?? "", "utf8"); // octets ASCII, PAS de décodage base64
const LAN_KEY_ID = Number(process.env.LANIP_KEY_ID ?? 0);
const DSN = process.env.MACHINE_DSN ?? "";
if (!LAN_KEY.length || !LAN_KEY_ID || !DSN || !MACHINE_IP || !SERVER_IP)
  throw new Error("MACHINE_IP / SERVER_IP / LANIP_KEY / LANIP_KEY_ID / MACHINE_DSN manquants — lance avec --env-file=.env.local");

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

// --- crypto (port de src/lib/crypto.ts) ---
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
// MODE=double : HMAC(K, HMAC(K,seed)||seed) (ce que montre le SDK décompilé)
// MODE=single : HMAC(K, seed)              (implémentations Ayla publiques)
const MODE = process.env.KDF || "single";
const derive = (K, seed) =>
  MODE === "double" ? hmac(K, Buffer.concat([hmac(K, seed), seed])) : hmac(K, seed);
const CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const token = (n) => { const b = crypto.randomBytes(n); let s = ""; for (let i = 0; i < n; i++) s += CH[b[i] % 62]; return s; };

let session = null;

function makeSession(kx, time2) {
  const R1 = Buffer.from(kx.random_1, "utf8"), R2 = Buffer.from(token(16), "utf8");
  const T1 = Buffer.from(String(kx.time_1), "utf8"), T2 = Buffer.from(time2, "utf8");
  const tag = (t) => Buffer.from([t]);
  const aSeed = (t) => Buffer.concat([R1, R2, T1, T2, tag(t)]);
  const dSeed = (t) => Buffer.concat([R2, R1, T2, T1, tag(t)]);
  const appSign = derive(LAN_KEY, aSeed(0x30)), appCrypto = derive(LAN_KEY, aSeed(0x31)), appIv = derive(LAN_KEY, aSeed(0x32)).subarray(0, 16);
  // `_devSign` : dérivée pour que le triplet reste lisible en face de son symétrique « app », mais
  // jamais utilisée — cet outil déchiffre ce que la machine envoie, il n'en vérifie pas la
  // signature. Le préfixe `_` dit que l'absence d'usage est voulue.
  const _devSign = derive(LAN_KEY, dSeed(0x30)), devCrypto = derive(LAN_KEY, dSeed(0x31)), devIv = derive(LAN_KEY, dSeed(0x32)).subarray(0, 16);
  const e = crypto.createCipheriv("aes-256-cbc", appCrypto, appIv); e.setAutoPadding(false);
  const d = crypto.createDecipheriv("aes-256-cbc", devCrypto, devIv); d.setAutoPadding(false);
  let seq = 0;
  return {
    random2: R2.toString("utf8"),
    encapsulate(dataJson) {
      const inner = `{"seq_no":${seq++},"data":${dataJson}}`;
      const ib = Buffer.from(inner, "utf8");
      const sign = crypto.createHmac("sha256", appSign).update(ib).digest("base64");
      let len = ib.length + 1; const r = len % 16; if (r) len += 16 - r;
      const pad = Buffer.alloc(len); ib.copy(pad, 0);
      return JSON.stringify({ enc: e.update(pad).toString("base64"), sign });
    },
    decapsulate(body) {
      const enc = Buffer.from(body.enc, "base64");
      let p = d.update(enc); let end = p.length; while (end > 0 && p[end - 1] === 0) end--;
      const s = p.subarray(0, end).toString("utf8");
      return s;
    },
  };
}

function crc16(b) { let c = 0x1d0f; for (let i = 0; i < b.length - 2; i++) { const a = (((c << 8) | (c >>> 8)) & 0xffff) ^ b[i]; const x = a ^ ((a & 0xff) >> 4); const y = x ^ ((x << 12) & 0xffff); c = y ^ (((y & 0xff) << 5) & 0xffff); } return c & 0xffff; }
function turnOnFrame() { const b = Buffer.from([0x0d, 0x07, 0x84, 0x0f, 0x02, 0x01, 0, 0]); const c = crc16(b); b[6] = (c >> 8) & 0xff; b[7] = c & 0xff; return b; }
function sendProfileFrame(id = 1) { const b = Buffer.from([0x0d, 0x06, 0xa9, 0xf0, id & 0xff, 0, 0]); const c = crc16(b); b[5] = (c >> 8) & 0xff; b[6] = c & 0xff; return b; }
function datapointValue(frame) { const t = Buffer.alloc(4); t.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0); return Buffer.concat([frame, t]).toString("base64"); }

const server = http.createServer((req, res) => {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    log(`◀ ${req.method} ${req.url}  hdrs=${JSON.stringify(req.headers)}  body(${body.length})=${body.toString("utf8").slice(0, 300)}`);
    try { handle(req, res, body); }
    catch (e) { log("‼ handler error:", e.message); res.writeHead(500); res.end("err"); }
  });
});

function send(res, obj, note) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
  log(`▶ 200 ${note ?? ""} : ${s.slice(0, 160)}`);
}

function handle(req, res, body) {
  const url = req.url;
  if (url === "/local_lan/key_exchange.json" && req.method === "POST") {
    const m = body.toString("utf8").match(/"time_1"\s*:\s*"?(-?\d+)"?/);
    const kx = JSON.parse(body.toString("utf8")).key_exchange;
    kx.time_1 = m ? m[1] : String(kx.time_1);
    if (kx.proto !== 1 || kx.ver !== 1) return send(res, { error: "ver" }, "kx-badver");
    if (Number(kx.key_id) !== LAN_KEY_ID) return send(res, { error: "keyid" }, "kx-badkey");
    const time2 = Date.now();
    session = makeSession(kx, String(time2));
    log(`✓ key_exchange OK random_1=${kx.random_1} time_1=${kx.time_1}`);
    return send(res, { random_2: session.random2, time_2: time2 }, "kx-resp");
  }
  if (url === "/local_lan/commands.json" && req.method === "GET") {
    if (!session) { res.writeHead(412); res.end("no session"); log("▶ 412 commands no-session"); return; }
    // Réplique de l'app : dc (device_connected frais) → turn-on → send-profile en boucle.
    const dcProp = (name, value) => ({ property: { base_type: "string", dsn: DSN, name, value, metadata: {} } });
    const dataProp = (value) => ({ property: { base_type: "string", dsn: DSN, name: "data_request", value, metadata: {}, id: crypto.randomBytes(4).toString("hex") } });
    let payload, what;
    if (seqIdx === 0) {
      payload = JSON.stringify({ properties: [dcProp("device_connected", String(Math.floor(Date.now() / 1000)))] });
      what = "device_connected";
    } else if (seqIdx === 1) {
      payload = JSON.stringify({ properties: [dataProp(datapointValue(turnOnFrame()))] });
      what = "TURN-ON";
    } else {
      // sustain : alterner send-profile et rafraîchir device_connected
      if (seqIdx % 4 === 0) { payload = JSON.stringify({ properties: [dcProp("device_connected", String(Math.floor(Date.now() / 1000)))] }); what = "device_connected(refresh)"; }
      else { payload = JSON.stringify({ properties: [dataProp(datapointValue(sendProfileFrame(1)))] }); what = "SEND_PROFILE"; }
    }
    seqIdx++;
    log(`▶ commands.json → ${what}`);
    return send(res, session.encapsulate(payload), "cmd");
  }
  if (url.includes("/property/datapoint") && req.method === "POST") {
    if (session) {
      try {
        const dec = session.decapsulate(JSON.parse(body.toString("utf8")));
        log("  ↳ datapoint déchiffré:", dec);
        // extraire name/value et décoder le monitor
        const mm = dec.match(/"name"\s*:\s*"([^"]+)".*?"value"\s*:\s*"([^"]*)"/s);
        if (mm && mm[1].startsWith("d302_monitor")) {
          const raw = Buffer.from(mm[2], "base64");
          const n = raw[1] + 1, e = raw.subarray(0, n);
          log(`  ★★★ MONITOR: état=0x${e[4].toString(16).padStart(2, "0")} (${e[4]})  hex=${e.toString("hex")}`);
        }
      } catch (e) { log("  ↳ decrypt fail:", e.message); }
    }
    return send(res, session ? session.encapsulate("{}") : "{}", "dp-resp");
  }
  // tout le reste
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
  log(`▶ 200 (autre) ${url}`);
}

// Phase 1 : servir "{}" (commande vide) pour tester si la machine déchiffre et
// nous renvoie ses datapoints (monitor). Phase 2 (après 35s) : servir le turn-on.
// Séquence de commandes servies (une par cycle commands.json) : lecture, allumage, puis lectures.
// Elle n'est pas décrite par une table — `servirCommande` la déroule sur `seqIdx`. Un tableau
// `SEQ` traînait ici, jamais lu : il prétendait décrire la séquence sans la piloter, donc il
// aurait menti dès la première modification du code d'à côté. Trouvé par ESLint.
let seqIdx = 0;

function postLocalReg(notify) {
  const b = Buffer.from(JSON.stringify({ local_reg: { ip: SERVER_IP, port: PORT, uri: "/local_lan", notify } }), "utf8");
  const r = http.request({ host: MACHINE_IP, port: 80, path: "/local_reg.json", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": b.length, Connection: "close" } }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => log(`→ local_reg(notify=${notify}) HTTP ${res.statusCode}`));
  });
  r.on("error", (e) => log("local_reg err", e.message));
  r.write(b); r.end();
}

server.listen(PORT, "0.0.0.0", () => {
  log(`capture server on :${PORT} — machine=${MACHINE_IP}`);
  postLocalReg(1);
  // keepalive : re-register toutes les 10s (comme startKeepalive du SDK), notify tant que pendingOn
  setInterval(() => postLocalReg(1), 2500);
});
