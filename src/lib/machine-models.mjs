/**
 * Identification du modèle de machine, en pur LAN.
 *
 * ## Pourquoi c'est possible sans le cloud
 *
 * L'app officielle ne demande PAS son modèle au cloud. `DeLonghiWifiConnectService.n1()`
 * (« getWifiMachines ») lit la propriété Ayla **`d270_serialnumber`**, en tire un nom, puis
 * appelle `DefaultsTable.getDefaultValuesForMachine(nom)` — table indexée par les **5 derniers
 * caractères du `product_code`** (vérifié dans le code décompilé : `product_code.substring(len-5)`).
 *
 * Autrement dit : les 5 chiffres qui déterminent le modèle sont **dans le numéro de série que la
 * machine publie elle-même**. Aucun jeton, aucun compte, aucune requête sortante.
 *
 * ## La dérivation, dépliée
 *
 * `l1()` fait, dans l'app :
 *
 *   hex = z.e(base64decode(valeur))     // z.e() écrit " XX" par octet → 3 caractères chacun
 *   nom = "D" + hex[23] + hex[26] + hex[29] + hex[32] + hex[35] + hex[71] + hex[74]
 *
 * L'octet n occupe les indices 3n+1 et 3n+2 ; les indices utilisés (23, 26, 29, 32, 35, 71, 74)
 * sont tous de la forme 3n+2, c'est-à-dire le **quartet bas** des octets 7, 8, 9, 10, 11, 23
 * et 24. Et `m1()`, juste en dessous, montre que le numéro de série est de l'**ASCII brut à
 * partir de l'octet 6**. Or pour un chiffre ASCII (0x30–0x39), le quartet bas EST le chiffre.
 *
 * D'où, très simplement :
 *
 *   série  = ASCII(octets 6…)
 *   nom    = "D" + série[1..5] + série[17] + série[18]      → « D1705596 »
 *   modèle = série[1..5]                                    → « 17055 » → 0132217055
 *
 * On lit donc l'ASCII directement, sans le détour hexadécimal de l'app : même résultat, et un
 * échec reste lisible.
 *
 * ⚠️ Dérivation établie sur le code décompilé, **pas encore confrontée à une trame réelle**.
 * `identify()` ne devine donc jamais : si la découpe ne donne pas 5 chiffres, elle renvoie une
 * raison ET la trame en hexadécimal — de quoi corriger les offsets en une passe.
 */
import { readFileSync } from "node:fs";

const TABLE = JSON.parse(readFileSync(new URL("./machine-models.json", import.meta.url), "utf8"));

/** La table d'identification, indexée par les 5 derniers caractères du `product_code`. */
export const MODELS = TABLE.models;
export const MODELS_TABLE_VERSION = TABLE.tableVersion;

/** Propriété Ayla qui porte le numéro de série. */
export const SERIAL_PROP = "d270_serialnumber";

/** Position du numéro de série dans la trame, et découpe du nom (voir l'en-tête). */
const SERIAL_OFFSET = 6;
const KEY_FROM = 1;
const KEY_TO = 6; // exclu → 5 caractères
const NAME_TAIL = [17, 18];

/** Un modèle de la table, ou `null` si la clé est inconnue. */
export function findModel(key) {
  return (key && MODELS[key]) || null;
}

/**
 * Décode `d270_serialnumber` et en déduit le modèle.
 *
 * @returns {{ok: boolean, reason?: string, serial?: string, machineName?: string,
 *            modelKey?: string, model?: object|null, hex: string}}
 */
export function identify(b64) {
  const buf = Buffer.from(String(b64 ?? ""), "base64");
  const hex = buf.toString("hex").replace(/(..)/g, "$1 ").trim();
  if (buf.length <= SERIAL_OFFSET) return { ok: false, reason: `trame trop courte (${buf.length} octets)`, hex };

  // ASCII imprimable à partir de l'octet 6, arrêté au premier octet non imprimable (le CRC, ou
  // un remplissage). `trim()` parce qu'un numéro plus court que le champ est complété d'espaces.
  let serial = "";
  for (let i = SERIAL_OFFSET; i < buf.length; i++) {
    const c = buf[i];
    if (c < 0x20 || c > 0x7e) break;
    serial += String.fromCharCode(c);
  }
  serial = serial.trim();
  if (serial.length < KEY_TO) return { ok: false, reason: `numéro de série illisible (« ${serial} »)`, serial, hex };

  const modelKey = serial.slice(KEY_FROM, KEY_TO);
  if (!/^\d{5}$/.test(modelKey)) {
    return { ok: false, reason: `les caractères ${KEY_FROM} à ${KEY_TO - 1} du numéro de série ne sont pas 5 chiffres (« ${modelKey} »)`, serial, hex };
  }

  // Le nom façon app : informatif, et c'est ce que montre le logcat (« Wifi Machine found »).
  const tail = NAME_TAIL.map((i) => serial[i] ?? "").join("");
  const machineName = "D" + modelKey + tail;

  return { ok: true, serial, machineName, modelKey, model: findModel(modelKey), hex };
}
