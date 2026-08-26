// Vérification du décodage de `d260_beansystem_sync_par` — le grain sélectionné en une lecture.
//
// Les trames ci-dessous sont RÉELLES, capturées sur la machine le 2026-08-26 de part et d'autre
// d'un changement de grain fait à la main sur son écran. C'est ce contraste qui a établi que le
// mot 4 est l'index du grain sélectionné, et c'est lui que ce script rejoue : un décalage d'un mot
// ne lève rien, il rend un index plausible et faux.
import { decodeBeanSync, BEAN_SYNC_PARAM, BEAN_SYNC_PROP } from "../src/lib/profiles.mjs";

let ko = 0;
const test = (nom, fn) => { try { fn(); console.log("  ok   ", nom); } catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); } };
const eq = (a, b, quoi) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`); };
const leve = (fn, motif, quoi) => {
  try { fn(); } catch (e) { if (!String(e.message).includes(motif)) throw new Error(`${quoi}: « ${e.message} » ne contient pas « ${motif} »`, { cause: e }); return; }
  throw new Error(`${quoi}: aucune erreur levée`);
};
const b64 = (hex) => Buffer.from(hex.replace(/ /g, ""), "hex").toString("base64");

// Relevé à 08:27:43, grain 3 « Borbone » sélectionné.
const GRAIN_3 = b64("d0 2f a1 0f 01 f4 00 00 00 2c 00 00 18 db 00 00 23 62 00 00 24 54 00 00 00 03 00 00 00 07"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1f f7");
// Relevé à 08:40:20, après avoir activé le grain 2 « Sakura » sur l'écran de la machine.
const GRAIN_2 = b64("d0 2f a1 0f 01 f4 00 00 00 2c 00 00 18 db 00 00 23 62 00 00 24 54 00 00 00 02 00 00 00 00"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 b8 af");
// Relevé à 07:11 le même jour, grain 3 déjà sélectionné mais compteurs différents : il sert à
// montrer que le mot 4 ne bouge pas quand seuls les compteurs bougent.
const MATIN_GRAIN_3 = b64("d0 2f a1 0f 01 f4 00 00 00 2a 00 00 19 71 00 00 24 60 00 00 24 54 00 00 00 03 00 00 00 06"
  + " 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1e 17");
// Le numéro de série : même commande `0xA1 0x0F`, autre paramètre (205). Il ne doit PAS passer.
const SERIE = b64("d0 1b a1 0f 00 cd 32 31 37 30 35 35 44 55 32 31 30 33 31 37 34 30 32 39 36 00 c3 6f");

console.log("\n— le mot 4 est le grain sélectionné, établi par contraste —");

test("grain 3 « Borbone »", () => {
  const r = decodeBeanSync(GRAIN_3);
  eq(r.param, BEAN_SYNC_PARAM, "paramètre");
  eq(r.selected, 3, "grain sélectionné");
  eq(r.mots, [44, 6363, 9058, 9300, 3, 7, 0, 0, 0, 0], "les dix mots");
});

test("grain 2 « Sakura », après changement sur la machine", () => {
  const r = decodeBeanSync(GRAIN_2);
  eq(r.selected, 2, "grain sélectionné");
  eq(r.mots, [44, 6363, 9058, 9300, 2, 0, 0, 0, 0, 0], "les dix mots");
});

test("SEULS les mots 4 et 5 changent avec la sélection", () => {
  // C'est l'observation qui fonde le décodage : si un autre mot avait bougé, « mot 4 = grain »
  // ne serait qu'une corrélation parmi plusieurs et ne vaudrait rien.
  const a = decodeBeanSync(GRAIN_3).mots, b = decodeBeanSync(GRAIN_2).mots;
  eq(a.map((v, i) => (v === b[i] ? null : i)).filter((i) => i !== null), [4, 5], "rangs des mots ayant bougé");
});

test("les compteurs bougent sans toucher au grain", () => {
  // Entre 07:11 et 08:27, deux tasses tirées et aucun changement de grain.
  const a = decodeBeanSync(MATIN_GRAIN_3), b = decodeBeanSync(GRAIN_3);
  eq(a.selected, b.selected, "grain identique");
  eq(a.mots[0] !== b.mots[0], true, "le mot 0 a bien bougé");
});

console.log("\n— ce que le décodeur refuse —");

test("le numéro de série porte la même commande et doit être refusé", () => {
  // Les deux sont des `0xA1 0x0F`. Sans le contrôle du paramètre, la chaîne « 217055DU… » se
  // relisait en mots de 32 bits et rendait un `selected` fabriqué de toutes pièces.
  leve(() => decodeBeanSync(SERIE), "paramètre 205", "paramètre étranger");
});

test("une autre commande est refusée", () => {
  leve(() => decodeBeanSync(b64("d0 34 ba f0 01 00 4d 00 61 00 6c 00 6f 00 6e 00 67 00 6f")), "commande inattendue", "0xBA");
});

test("une trame tronquée AVANT le mot du grain est refusée, pas devinée", () => {
  // Le cas dangereux : sans ce contrôle, `mots[4]` vaut `undefined` et un grain « sélectionné »
  // qu'aucun index ne porte traverse l'interface sans un mot.
  leve(() => decodeBeanSync(b64("d0 13 a1 0f 01 f4 00 00 00 2c 00 00 18 db 00 00 23 62 00 00 00 00")),
    "charge utile trop courte", "tronquée");
});

test("une charge utile non multiple de 4 est refusée", () => {
  // 22 octets de charge utile : assez longue pour couvrir le mot du grain, mais désalignée. Le
  // contrôle de longueur ne la rattrape donc pas, et sans celui d'alignement le dernier mot serait
  // lu à cheval sur le CRC.
  leve(() => decodeBeanSync(b64("d0 1d a1 0f 01 f4 00 00 00 2c 00 00 18 db 00 00 23 62 00 00 24 54 00 00 00 03 00 00 00 00")),
    "non multiple de 4", "alignement");
});

test("le nom de propriété est celui qu'attend le serveur", () => {
  eq(BEAN_SYNC_PROP, "d260_beansystem_sync_par", "nom de propriété");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
