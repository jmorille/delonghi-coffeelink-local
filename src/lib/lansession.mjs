/**
 * Session chiffrée du mode LAN Ayla — **les deux rôles, une seule implémentation.**
 *
 * ⚠️ Ce module TOURNE. Ce n'est pas une des copies `.ts` shadowées : `server.mjs` l'importe.
 *
 * ## Pourquoi ce fichier existe
 *
 * Jusqu'ici lan-server ne jouait qu'un rôle : le **client** auquel la machine se connecte. Le
 * multiplexeur (voir `doc/spec-proxy-multi-app.md`) demande l'autre moitié — se faire passer pour
 * l'appareil auprès des applications officielles. Or ce n'est pas un second protocole : c'est le
 * **même**, avec les opérandes échangés.
 *
 * L'échange de clés produit quatre valeurs — deux aléas et deux instants — et la dérivation en tire
 * deux jeux de clés indépendants, un par sens de circulation :
 *
 * ```
 * jeu « app »  ← seed  R1 ‖ R2 ‖ T1 ‖ T2 ‖ tag     chiffre  client  → appareil
 * jeu « dev »  ← seed  R2 ‖ R1 ‖ T2 ‖ T1 ‖ tag     chiffre  appareil → client
 * ```
 *
 * Les deux extrémités calculent **les mêmes quatre clés** ; ce qui les distingue est seulement
 * laquelle chacune utilise pour émettre. D'où le paramètre `role`, et d'où le fait qu'écrire ce
 * fichier une seconde fois pour le proxy aurait été la faute la plus prévisible du projet : deux
 * copies d'une dérivation cryptographique divergent au premier correctif.
 *
 * ## Ce qui n'est pas négociable, et qui a coûté cher
 *
 * - **`lanKey` est utilisée comme les octets ASCII de la chaîne base64.** On ne la décode PAS.
 * - **Le flux AES-256-CBC est persistant** : `cipher.update()` n'est jamais réinitialisé, chaque
 *   bloc dépend de tous les précédents. Une désynchronisation force un nouvel échange de clés.
 *   C'est aussi ce qui rend un proxy « passe-plat » impossible — deux sessions ne partagent aucun
 *   flux, il faut déchiffrer puis rechiffrer.
 * - **Le remplissage se fait à zéro, sur un octet de plus au minimum** (`len = ib.length + 1`
 *   arrondi au multiple de 16), et le déchiffrement retire les zéros de fin.
 * - **La signature porte sur le clair**, HMAC-SHA256 avec la clé de signature du sens d'émission.
 *
 * Tout cela est un port validé en production contre la vraie machine ; ne pas « simplifier ».
 */
import crypto from "node:crypto";

const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
/** Double HMAC : `HMAC(K, HMAC(K, seed) ‖ seed)`. C'est la dérivation d'`AylaEncryption`. */
export const derive = (K, seed) => hmac(K, Buffer.concat([hmac(K, seed), seed]));

const CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Aléa alphanumérique, comme l'app : le protocole transporte ces valeurs en TEXTE, pas en octets. */
export const token = (n) => {
  const b = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += CH[b[i] % 62];
  return s;
};

/**
 * Construit une session à partir des quatre valeurs de l'échange de clés.
 *
 * @param {object} o
 * @param {Buffer} o.lanKey  octets ASCII de la chaîne base64 — **jamais décodée**
 * @param {string} o.random1 aléa émis par l'APPAREIL
 * @param {string} o.random2 aléa émis par le CLIENT
 * @param {string} o.time1   instant émis par l'appareil
 * @param {string} o.time2   instant émis par le client
 * @param {"client"|"device"} o.role  le rôle que NOUS tenons dans cette session
 *
 * `role` ne change pas les clés — il choisit laquelle sert à émettre. Un client chiffre en « app »
 * et déchiffre en « dev » ; un appareil fait l'inverse. Se tromper de sens ne lève aucune erreur :
 * on obtient du déchiffrement qui produit des octets plausibles et illisibles, et le symptôme est
 * une session qui « ne répond plus » — d'où `scripts/verif-lansession.mjs`, qui fait dialoguer les
 * deux rôles et l'aurait vu.
 */
export function makeLanSession({ lanKey, random1, random2, time1, time2, role }) {
  if (role !== "client" && role !== "device") throw new Error(`rôle inconnu : ${role}`);
  const R1 = Buffer.from(random1, "utf8");
  const R2 = Buffer.from(random2, "utf8");
  const T1 = Buffer.from(String(time1), "utf8");
  const T2 = Buffer.from(String(time2), "utf8");
  const tag = (t) => Buffer.from([t]);
  const graineApp = (t) => Buffer.concat([R1, R2, T1, T2, tag(t)]);
  const graineDev = (t) => Buffer.concat([R2, R1, T2, T1, tag(t)]);

  const app = {
    sign: derive(lanKey, graineApp(0x30)),
    crypto: derive(lanKey, graineApp(0x31)),
    iv: derive(lanKey, graineApp(0x32)).subarray(0, 16),
  };
  const dev = {
    sign: derive(lanKey, graineDev(0x30)),
    crypto: derive(lanKey, graineDev(0x31)),
    iv: derive(lanKey, graineDev(0x32)).subarray(0, 16),
  };

  // Le sens d'émission dépend du rôle ; le sens de réception est l'autre. C'est tout ce que `role`
  // décide, et c'est pour cela qu'un seul fichier suffit aux deux moitiés du multiplexeur.
  const sortant = role === "client" ? app : dev;
  const entrant = role === "client" ? dev : app;

  const e = crypto.createCipheriv("aes-256-cbc", sortant.crypto, sortant.iv);
  e.setAutoPadding(false);
  const d = crypto.createDecipheriv("aes-256-cbc", entrant.crypto, entrant.iv);
  d.setAutoPadding(false);

  let seq = 0;
  return {
    role,
    random1,
    random2,
    /** Chiffre un JSON déjà sérialisé et renvoie le corps `{enc, sign}` à poster. */
    encapsulate(dataJson) {
      const inner = `{"seq_no":${seq++},"data":${dataJson}}`;
      const ib = Buffer.from(inner, "utf8");
      const sign = crypto.createHmac("sha256", sortant.sign).update(ib).digest("base64");
      let len = ib.length + 1;
      const r = len % 16;
      if (r) len += 16 - r;
      const pad = Buffer.alloc(len);
      ib.copy(pad, 0);
      return JSON.stringify({ enc: e.update(pad).toString("base64"), sign });
    },
    /** Déchiffre un corps `{enc, sign}` et rend le JSON intérieur, remplissage retiré. */
    decapsulate(body) {
      const p = d.update(Buffer.from(body.enc, "base64"));
      let end = p.length;
      while (end > 0 && p[end - 1] === 0) end--;
      return p.subarray(0, end).toString("utf8");
    },
  };
}
