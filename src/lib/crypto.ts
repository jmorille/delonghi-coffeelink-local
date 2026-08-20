/**
 * Port exact de com.aylanetworks.aylasdk.localcontrol.lan.AylaEncryption.
 *
 * Rôles (nous jouons le "mobile" ; la cafetière est le "device") :
 *   - clés "app"  : chiffrent/signent NOS messages VERS la machine (commands.json)
 *   - clés "dev"  : déchiffrent/vérifient les messages VENANT de la machine (datapoints)
 *
 * Dérivation (HMAC-SHA256, tout en ASCII) :
 *   derive(K, seed) = HMAC(K, HMAC(K, seed) || seed)
 *   app*  : seed = R1 || R2 || T1 || T2 || tag
 *   dev*  : seed = R2 || R1 || T2 || T1 || tag       (opérandes inversés)
 *   tags  : '0' (0x30)=sign, '1' (0x31)=crypto, '2' (0x32)=iv (16 premiers octets)
 *
 * Enveloppe de message (les deux sens) :
 *   inner  = {"seq_no":N,"data":<data>}
 *   enc    = base64( AES-256-CBC.update( utf8(inner) + zéros jusqu'à multiple de 16 ) )
 *            ATTENTION : le chiffreur CBC est un FLUX PERSISTANT (update() sans reset).
 *   sign   = base64( HMAC-SHA256(signKey, utf8(inner)) )      // sur l'inner NON paddé
 *   wire   = {"enc":"<enc>","sign":"<sign>"}
 *
 * IMPORTANT : lanip_key est utilisée comme octets ASCII de la chaîne base64 telle quelle
 * (getBytes UTF-8), PAS décodée. Voir docs/secrets.md §1.
 */
import crypto from "node:crypto";

function hmac(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function derive(lanKey: Buffer, seed: Buffer): Buffer {
  // HMAC(K, HMAC(K, seed) || seed)
  const inner = hmac(lanKey, seed);
  return hmac(lanKey, Buffer.concat([inner, seed]));
}

const CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomToken(n: number): string {
  const b = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += CHARS[b[i] % 62];
  return s;
}

export interface KeyExchangeIn {
  ver: number;
  proto: number;
  key_id: number;
  random_1: string;
  time_1: number | string;
}

export class AylaSession {
  readonly random1: string;
  readonly random2: string;
  readonly time1: string;
  readonly time2: string;
  readonly keyId: number;

  private appSignKey: Buffer;
  private devSignKey: Buffer;
  private eCipher: crypto.Cipheriv; // app : chiffre nos messages
  private dDecipher: crypto.Decipheriv; // dev : déchiffre les leurs
  private seqNo = 0;

  createdAt = Date.now();

  /**
   * @param lanKeyAscii  octets ASCII de lanip_key (Buffer.from(str, "utf8"))
   * @param kx           key_exchange reçu de la machine
   * @param time2        entier (grand) que NOUS renvoyons comme time_2 ; doit être
   *                     identique dans la réponse KeyResponse et ici.
   */
  constructor(
    lanKeyAscii: Buffer,
    kx: KeyExchangeIn,
    readonly time2Value: string,
    random2?: string,
  ) {
    this.random1 = kx.random_1;
    this.random2 = random2 ?? randomToken(16);
    this.time1 = String(kx.time_1);
    this.time2 = time2Value;
    this.keyId = kx.key_id;

    const R1 = Buffer.from(this.random1, "utf8");
    const R2 = Buffer.from(this.random2, "utf8");
    const T1 = Buffer.from(this.time1, "utf8");
    const T2 = Buffer.from(this.time2, "utf8");
    const tag = (t: number) => Buffer.from([t]);

    // app : R1 R2 T1 T2 tag
    const appSeed = (t: number) => Buffer.concat([R1, R2, T1, T2, tag(t)]);
    // dev : R2 R1 T2 T1 tag
    const devSeed = (t: number) => Buffer.concat([R2, R1, T2, T1, tag(t)]);

    this.appSignKey = derive(lanKeyAscii, appSeed(0x30));
    const appCryptoKey = derive(lanKeyAscii, appSeed(0x31));
    const appIvSeed = derive(lanKeyAscii, appSeed(0x32)).subarray(0, 16);

    this.devSignKey = derive(lanKeyAscii, devSeed(0x30));
    const devCryptoKey = derive(lanKeyAscii, devSeed(0x31));
    const devIvSeed = derive(lanKeyAscii, devSeed(0x32)).subarray(0, 16);

    // Flux CBC persistants, sans padding auto (padding manuel par zéros).
    this.eCipher = crypto.createCipheriv("aes-256-cbc", appCryptoKey, appIvSeed);
    this.eCipher.setAutoPadding(false);
    this.dDecipher = crypto.createDecipheriv(
      "aes-256-cbc",
      devCryptoKey,
      devIvSeed,
    );
    this.dDecipher.setAutoPadding(false);
  }

  /** Construit {"enc","sign"} pour un message data (chaîne JSON) à envoyer à la machine. */
  encapsulate(dataJson: string): string {
    const inner = `{"seq_no":${this.seqNo++},"data":${dataJson}}`;
    const innerBytes = Buffer.from(inner, "utf8");

    const sign = crypto
      .createHmac("sha256", this.appSignKey)
      .update(innerBytes)
      .digest("base64");

    // longueur = innerBytes.length + 1, puis padding zéros jusqu'à multiple de 16.
    let len = innerBytes.length + 1;
    const rem = len % 16;
    if (rem > 0) len += 16 - rem;
    const padded = Buffer.alloc(len); // rempli de 0x00
    innerBytes.copy(padded, 0);

    const enc = this.eCipher.update(padded).toString("base64");
    return JSON.stringify({ enc, sign });
  }

  /**
   * Déchiffre/vérifie un message venant de la machine.
   * body = {"enc","sign"}. Retourne l'objet `data` (déjà parsé) ou lève.
   */
  decapsulate(body: { enc: string; sign: string }): { seq_no: number; data: any } {
    const encBytes = Buffer.from(body.enc, "base64");
    let plain = this.dDecipher.update(encBytes);
    // retirer les zéros de fin
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end--;
    const innerStr = plain.subarray(0, end).toString("utf8");

    const expected = crypto
      .createHmac("sha256", this.devSignKey)
      .update(Buffer.from(innerStr, "utf8"))
      .digest();
    const got = Buffer.from(body.sign, "base64");
    if (!crypto.timingSafeEqual(expected, got)) {
      throw new Error("LAN signature mismatch (devSignKey)");
    }
    const obj = JSON.parse(innerStr);
    // `data` peut être une chaîne JSON ou déjà un objet selon l'émetteur
    const data =
      typeof obj.data === "string" ? safeParse(obj.data) : obj.data;
    return { seq_no: obj.seq_no, data };
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
