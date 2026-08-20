/**
 * Bean Adapt — réimplémentation **locale** de la règle d'ajustement.
 *
 * Dans l'app officielle, le questionnaire part vers le backend De'Longhi
 * (`getBeanSystemAdv.sr`), qui renvoie les trois réglages à écrire dans la machine. La règle a été
 * dérivée empiriquement par balayage de cette API (voir `docs/bean-adapt.md` §4) et elle est
 * simple : on la rejoue ici, donc **aucun appel au cloud**.
 *
 *   grinder_out     = clamp(grinder_in + Δg(flowTime), 1, 7)
 *   temperature_out = temperature_in + Δt(crema)
 *   aroma_out       = clamp(aroma_in + Δa(taste, flowTime), 1, 5)
 *
 * Deux différences assumées avec le backend, en notre faveur :
 *   - il **échoue** sur `flowTime ∈ [10,19]` avec `taste = 2` (le cas « ne change rien »,
 *     pourtant nominal) ; ici ce cas renvoie simplement les valeurs inchangées ;
 *   - il ne borne **pas** la température vers le haut ; on plafonne à 5 par prudence, sans
 *     toucher au plancher (0), pour rester conforme à la matrice de référence.
 */

/** Bornes confirmées par le comportement du backend (0 et 8 en grinder le font échouer). */
export const GRINDER_MIN = 1;
export const GRINDER_MAX = 7;
export const AROMA_MIN = 1;
export const AROMA_MAX = 5;

/**
 * Bornes de température **non vérifiées**. Le backend n'en impose aucune : le doc relève
 * `temperature_in = 0` + « pas de crema » → `0`. On garde donc **0 comme plancher**, pour
 * reproduire exactement la matrice de référence (§4.4) plutôt que d'inventer une contrainte ; le
 * plafond à 5, lui, est une prudence de notre part. Valeur relevée sur la machine : 3. L'UI le dit.
 */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Δ mouture : l'écoulement est le symptôme, la mouture le correctif. */
function grinderDelta(flowTime) {
  if (flowTime < 10) return -1; // trop rapide → mouture trop grossière → affiner
  if (flowTime >= 20) return +1; // trop lent → mouture trop fine → élargir
  return 0; // fenêtre acceptable
}

/** Δ température, piloté par l'aspect de la crema. Toujours appliqué. */
function temperatureDelta(crema) {
  if (crema === 1) return +1; // crema claire
  if (crema === 3) return -1; // pas de crema
  return 0; // crema foncée
}

/**
 * Δ arôme, piloté par le goût — mais **seulement** dans la fenêtre d'écoulement acceptable.
 * Hors de cette fenêtre le backend ignore la réponse de goût : le problème est mécanique, pas
 * gustatif, et il faut d'abord corriger la mouture.
 */
function aromaDelta(taste, flowTime) {
  if (flowTime < 10 || flowTime >= 20) return 0;
  if (taste === 1) return +1;
  if (taste === 3) return -1;
  return 0;
}

/**
 * @param {{grinder:number,temperature:number,aroma:number}} current réglages actuels du profil
 * @param {{flowTime:number,crema:1|2|3,taste:1|2|3}} answers réponses au questionnaire
 */
export function computeBeanAdapt(current, answers) {
  const flowTime = Number(answers.flowTime);
  const crema = Number(answers.crema);
  const taste = Number(answers.taste);
  const dg = grinderDelta(flowTime);
  const dt = temperatureDelta(crema);
  const da = aromaDelta(taste, flowTime);

  const grinder = clamp(Number(current.grinder) + dg, GRINDER_MIN, GRINDER_MAX);
  const temperature = clamp(Number(current.temperature) + dt, TEMPERATURE_MIN, TEMPERATURE_MAX);
  const aroma = clamp(Number(current.aroma) + da, AROMA_MIN, AROMA_MAX);

  const notes = [];
  if (dg !== 0) notes.push(flowTime < 10 ? "grinderFiner" : "grinderCoarser");
  if (da === 0 && taste !== 2) notes.push("tasteIgnored");
  if (grinder !== Number(current.grinder) + dg) notes.push("grinderClamped");
  if (aroma !== Number(current.aroma) + da) notes.push("aromaClamped");
  if (temperature !== Number(current.temperature) + dt) notes.push("temperatureClamped");
  if (flowTime >= 10 && flowTime < 20 && taste === 2) notes.push("backendWouldFail");

  return {
    grinder,
    temperature,
    aroma,
    deltas: { grinder: dg, temperature: dt, aroma: da },
    changed: grinder !== Number(current.grinder) || temperature !== Number(current.temperature) || aroma !== Number(current.aroma),
    notes,
  };
}

/**
 * Encode un nom de Bean System — port de `p258z7/z.f0()` : exactement 20 caractères, chacun sur
 * 2 octets **poids fort d'abord** (UTF-16 big-endian), zéros au-delà, tronqué à 20 caractères.
 */
export function encodeBeanName(name) {
  const out = Buffer.alloc(40);
  const chars = String(name ?? "").slice(0, 20);
  for (let i = 0; i < chars.length; i++) {
    const c = chars.charCodeAt(i);
    out[i * 2] = (c >> 8) & 0xff;
    out[i * 2 + 1] = c & 0xff;
  }
  return out;
}
