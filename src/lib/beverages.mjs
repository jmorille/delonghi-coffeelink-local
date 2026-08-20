/**
 * Catalogue des boissons de la machine — ECAM 610.75.MB (« Primadonna Soul », PD_SOUL).
 *
 * Deux sources, toutes deux vérifiées :
 *
 * 1. `machine-model.json` — extrait de `assets/MachinesModels.json` de l'APK (table
 *    « Machine Template » v1.510), entrée `product_code` 0132217055. C'est l'app elle-même
 *    qui décide de la liste des boissons à partir de cette table : la machine n'est JAMAIS
 *    interrogée sur « quelles boissons sais-tu faire ». Elle fournit id, nom d'usine et la
 *    liste des ingrédients (paramètres) de chaque boisson.
 * 2. `docs/capture-reveil-app.txt` — logcat de l'app parlant à CETTE machine
 *    (`loadEspressoSoul` / `getClassicBeverages`), qui donne la correspondance
 *    boisson → propriété Ayla.
 *
 * ⚠️ Les identifiants ne sont pas contigus : capp_reverse = 15, tea = 22, coffee_pot = 23,
 * cortado = 24, long_black = 25, mug_to_go = 26, brew_over_ice = 27. (La 1re version de
 * docs/commandes-cafe.md supposait 16..21 — faux pour ce modèle : envoyer 21 pour un
 * « brew over ice » viserait la mauvaise boisson.)
 *
 * Fichier en .mjs volontairement : partagé tel quel entre `server.mjs` (HTTP brut, JS) et
 * l'API qui alimente l'UI, sans duplication de la table.
 */
import { readFileSync } from "node:fs";

export const MODEL = JSON.parse(readFileSync(new URL("./machine-model.json", import.meta.url), "utf8"));

/** Libellés FR + classement, par id de boisson. `slug` = suffixe de la propriété Ayla. */
const LABELS = {
  1: { label: "Espresso", slug: "espresso", category: "cafe" },
  2: { label: "Café", slug: "regular", category: "cafe" },
  3: { label: "Café long", slug: "long_coffee", category: "cafe" },
  4: { label: "Espresso ×2", slug: "2x_espresso", category: "cafe" },
  5: { label: "Doppio+", slug: "doppio", category: "cafe" },
  6: { label: "Americano", slug: "americano", category: "cafe" },
  7: { label: "Cappuccino", slug: "cappuccino", category: "lait" },
  8: { label: "Latte macchiato", slug: "latte_macchiato", category: "lait" },
  9: { label: "Caffelatte", slug: "caffelatte", category: "lait" },
  10: { label: "Flat white", slug: "flat_white", category: "lait" },
  11: { label: "Espresso macchiato", slug: "espr_macchiato", category: "lait" },
  12: { label: "Lait chaud", slug: "hot_milk", category: "lait" },
  13: { label: "Cappuccino doppio+", slug: "capp_doppio", category: "lait" },
  15: { label: "Cappuccino inversé", slug: "capp_reverse", category: "lait" },
  16: { label: "Eau chaude", slug: "hot_water", category: "autre" },
  22: { label: "Thé", slug: "tea", category: "autre" },
  23: { label: "Verseuse", slug: "coffee_pot", category: "cafe" },
  24: { label: "Cortado", slug: "cortado", category: "lait" },
  25: { label: "Long black", slug: "long_black", category: "cafe" },
  26: { label: "Mug de voyage", slug: "mug_to_go", category: "froid" },
  27: { label: "Brew over ice", slug: "brew_over_ice", category: "froid" },
  // Boisson préparée avec la configuration de grains active (Bean System). Son nom d'usine
  // dans la table constructeur est « Espresso BS 1 » — BS pour Bean System. Ce n'est PAS le nom
  // du grain : celui-là est un attribut, voir `activeBeanSystem` côté serveur.
  200: { label: "Espresso Bean Adapt", slug: "bs_recipe_01", category: "perso" },
  230: { label: "Recette perso 1", slug: "cstm_recipe_01", category: "perso" },
  231: { label: "Recette perso 2", slug: "cstm_recipe_02", category: "perso" },
  232: { label: "Recette perso 3", slug: "cstm_recipe_03", category: "perso" },
  233: { label: "Recette perso 4", slug: "cstm_recipe_04", category: "perso" },
  234: { label: "Recette perso 5", slug: "cstm_recipe_05", category: "perso" },
  235: { label: "Recette perso 6", slug: "cstm_recipe_06", category: "perso" },
};

/**
 * Propriétés Ayla portant les bornes min/défaut/max (`loadMinMaxFromDefault`) : d001..d021
 * pour les 21 standard, d028..d033 pour les perso, d022 pour le Bean System.
 */
const BOUNDS_PROP = {
  ...Object.fromEntries(
    // d001..d021 dans l'ordre du catalogue standard
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 22, 23, 24, 25, 26, 27].map((id, i) => [
      id,
      `d${String(i + 1).padStart(3, "0")}_rec_${LABELS[id].slug}`,
    ]),
  ),
  200: "d022_beansystem_1",
  230: "d028_rec_custom_1",
  231: "d029_rec_custom_2",
  232: "d030_rec_custom_3",
  233: "d031_rec_custom_4",
  234: "d032_rec_custom_5",
  235: "d033_rec_custom_6",
};

/**
 * Index de la propriété « recette enregistrée du profil » (`loadRecipeFromProfile`).
 * Formule relevée dans `p258z7/z.java` (`v(profileId, template)`) :
 *   numéro = offsetBase + (profileId − 1) × 21
 * avec offsetBase = 39 pour l'espresso, puis +1 par boisson dans l'ordre du catalogue.
 * Vérifié sur le profil 1 dans le logcat : d039_1_rec_espresso … d059_1_rec_brew_over_ice.
 */
const PROFILE_BASE = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 22, 23, 24, 25, 26, 27].map((id, i) => [id, 39 + i]),
);
// Perso : d200_1_cstm_recipe_01 … d205_1_cstm_recipe_06 ; Bean System : d160_1_bs_recipe_01.
// (Relevé pour le profil 1 ; l'incrément par profil suit la même logique — à confirmer
// pour les profils 2..5 lors d'un import réel.)
const PROFILE_BASE_CUSTOM = { 200: 160, 230: 200, 231: 201, 232: 202, 233: 203, 234: 204, 235: 205 };

/** Le catalogue : une entrée par boisson que CETTE machine sait préparer. */
export const ALL_BEVERAGES = MODEL.recipes.map((r) => {
  const meta = LABELS[r.id] ?? { label: r.name, slug: `id_${r.id}`, category: "perso" };
  return {
    id: r.id,
    factoryName: r.name, // nom d'usine de la table (anglais)
    label: meta.label,
    slug: meta.slug,
    category: meta.category,
    ingredients: r.ingredients, // ids des paramètres que cette boisson accepte
    milk: r.ingredients.includes(9),
    bounds: BOUNDS_PROP[r.id] ?? null,
  };
});

export const BEVERAGES = ALL_BEVERAGES.filter((b) => b.id < 200);
export const CATEGORIES = {
  cafe: "Cafés",
  lait: "Boissons lactées",
  autre: "Eau chaude & thé",
  froid: "Froid / to-go",
  perso: "Personnalisées",
};

export const byId = (id) => ALL_BEVERAGES.find((b) => b.id === Number(id));

/** Nom de la propriété Ayla portant la recette enregistrée d'un profil (1..5). */
export function profileProp(bev, profileId = 1) {
  const p = Number(profileId);
  if (PROFILE_BASE[bev.id] !== undefined) {
    const n = PROFILE_BASE[bev.id] + (p - 1) * 21;
    return `d${String(n).padStart(3, "0")}_${p}_rec_${bev.slug}`;
  }
  const base = PROFILE_BASE_CUSTOM[bev.id];
  if (base === undefined) return null;
  return `d${String(base).padStart(3, "0")}_${p}_${bev.slug}`;
}

// --- Paramètres de recette (enum p127m6/i) --------------------------------

/**
 * id → { name, label, unit, kind }
 *
 * `kind` sert uniquement à **grouper** l'affichage, pas à filtrer : rien ne doit être masqué.
 *   "user"     = ingrédient de la recette (quantités, arôme, température, 2 tasses, accessoire…)
 *   "advanced" = réglage qui touche le comportement machine plus que le goût (visibilité de la
 *                boisson à l'écran, programmabilité, index de longueur) — présenté à part, parce
 *                que le modifier change l'interface de la machine, pas la tasse
 *   "maint"    = maintenance (détartrage, rinçage, nettoyage)
 *
 * ⚠️ Cette classification est la NÔTRE, elle n'existe pas dans le protocole. Une première version
 * s'en servait pour n'afficher que "user", ce qui masquait des options réellement réglables
 * (« 2 tasses », « accessoire »). Ne pas refaire : filtrer sur `max > min`, grouper sur `kind`.
 */
export const PARAMS = {
  0: { name: "TEMP", label: "Température café", unit: "niveau", kind: "user" },
  1: { name: "COFFEE", label: "Café", unit: "ml", kind: "user" },
  2: { name: "TASTE", label: "Arôme", unit: "niveau", kind: "user" },
  3: { name: "GRANULOMETRY", label: "Mouture", unit: "niveau", kind: "user" },
  4: { name: "BLEND", label: "Mélange", unit: "", kind: "advanced" },
  5: { name: "INFUSION_SPEED", label: "Vitesse d'infusion", unit: "", kind: "user" },
  6: { name: "PREINFUSIONE", label: "Pré-infusion", unit: "", kind: "user" },
  7: { name: "CREMA", label: "Crema", unit: "", kind: "user" },
  8: { name: "DUExPER", label: "2 tasses", unit: "", kind: "user" },
  9: { name: "MILK", label: "Lait", unit: "ml", kind: "user" },
  10: { name: "MILK_TEMP", label: "Température lait", unit: "niveau", kind: "user" },
  11: { name: "MILK_FROTH", label: "Mousse de lait", unit: "niveau", kind: "user" },
  12: { name: "INVERSION", label: "Ordre lait/café", unit: "", kind: "user" },
  13: { name: "THE_TEMP", label: "Température thé", unit: "niveau", kind: "user" },
  14: { name: "THE_PROFILE", label: "Profil thé", unit: "", kind: "user" },
  15: { name: "HOT_WATER", label: "Eau chaude", unit: "ml", kind: "user" },
  16: { name: "MIX_VELOCITY", label: "Vitesse de mélange", unit: "", kind: "user" },
  17: { name: "MIX_DURATION", label: "Durée de mélange", unit: "", kind: "user" },
  18: { name: "DENSITY_MULTI_BEVERAGE", label: "Densité multi-boisson", unit: "", kind: "advanced" },
  19: { name: "TEMP_MULTI_BEVERAGE", label: "Température multi-boisson", unit: "", kind: "advanced" },
  20: { name: "DECALC_TYPE", label: "Type de détartrage", unit: "", kind: "maint" },
  21: { name: "TEMP_RISCIACQUO", label: "Température de rinçage", unit: "", kind: "maint" },
  22: { name: "WATER_RISCIACQUO", label: "Eau de rinçage", unit: "", kind: "maint" },
  23: { name: "CLEAN_TYPE", label: "Type de nettoyage", unit: "", kind: "maint" },
  24: { name: "PROGRAMABLE", label: "Programmable", unit: "", kind: "advanced" },
  25: { name: "VISIBLE", label: "Visible", unit: "", kind: "advanced" },
  26: { name: "VISIBLE_IN_PROGRAMMING", label: "Visible en programmation", unit: "", kind: "advanced" },
  27: { name: "INDEX_LENGTH", label: "Index de longueur", unit: "", kind: "advanced" },
  28: { name: "ACCESSORIO", label: "Accessoire", unit: "", kind: "user" },
  30: { name: "PROG_TIME", label: "Programmation horaire", unit: "", kind: "advanced" },
  31: { name: "ICED", label: "Glacé", unit: "", kind: "user" },
  32: { name: "MUG_SIZE", label: "Taille du mug", unit: "", kind: "user" },
  33: { name: "MUG_ADJUST", label: "Ajustement mug", unit: "", kind: "advanced" },
  37: { name: "NUM_ICE_CUBES", label: "Glaçons", unit: "", kind: "user" },
  38: { name: "INTENSITY", label: "Intensité", unit: "niveau", kind: "user" },
  39: { name: "RINSE", label: "Rinçage", unit: "", kind: "maint" },
};

export const paramInfo = (id) => PARAMS[id] ?? { name: String(id), label: `Paramètre ${id}`, unit: "", kind: "advanced" };

/**
 * Paramètres dont la valeur tient sur 2 octets.
 * L'app lit cette longueur dans une table téléchargée du backend (`getCommonData.sr`
 * → `z.Z(id)` : `length > 1`). Sur cette famille ce sont les quantités liquides ;
 * confirmé par le décodage exact de `d001_rec_espresso` (parcours tombant sur le CRC).
 */
export const TWO_BYTE = new Set([1, 9, 15]);

/**
 * Décode une propriété de bornes (trame ECAM `0xB0`) — port de `p097j6.d.X()`.
 *
 *   0      0xD0
 *   1      len = taille totale − 1
 *   2      0xB0
 *   3      0xF0
 *   4      beverageId
 *   5..    quadruplets : id (1 o) puis min, défaut, max — 1 o chacun,
 *          ou 2 o big-endian si le paramètre est dans TWO_BYTE
 *   −2..   CRC16
 *
 * `exact: false` signale un désalignement (typiquement un paramètre 2 octets absent de
 * TWO_BYTE) : les valeurs sont alors à considérer comme douteuses.
 */
export function decodeRecipeBounds(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 7) throw new Error("trame trop courte");
  const len = buf[1] + 1;
  const end = len - 2; // début du CRC
  const out = { beverageId: buf[4], cmd: buf[2], params: [], exact: false, hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim() };
  let i = 5;
  while (i < end) {
    const id = buf[i];
    const w = TWO_BYTE.has(id) ? 2 : 1;
    if (i + 1 + 3 * w > end) break; // désalignement : on s'arrête proprement
    const read = (o) => (w === 2 ? (buf[o] << 8) | buf[o + 1] : buf[o]);
    const info = paramInfo(id);
    out.params.push({ id, name: info.name, label: info.label, unit: info.unit, kind: info.kind, min: read(i + 1), def: read(i + 1 + w), max: read(i + 1 + 2 * w) });
    i += 1 + 3 * w;
  }
  out.exact = i === end;
  return out;
}

/**
 * Décode une propriété « recette du profil » (trame ECAM `0xA6`) — port de `p097j6.d.u0()`.
 * Ici pas de bornes : offset 4 = profil, 5 = boisson, puis des paires (id, valeur).
 */
export function decodeRecipeValues(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) throw new Error("trame trop courte");
  const len = buf[1] + 1;
  const end = len - 2;
  const out = { profileId: buf[4], beverageId: buf[5], cmd: buf[2], params: [], exact: false, hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim() };
  let i = 6;
  while (i < end) {
    const id = buf[i];
    const w = TWO_BYTE.has(id) ? 2 : 1;
    if (i + 1 + w > end) break;
    const info = paramInfo(id);
    out.params.push({ id, name: info.name, label: info.label, unit: info.unit, kind: info.kind, value: w === 2 ? (buf[i + 1] << 8) | buf[i + 2] : buf[i + 1] });
    i += 1 + w;
  }
  out.exact = i === end;
  return out;
}

/** Aiguille le décodage selon la commande portée par la trame (0xB0 bornes / 0xA6 valeurs). */
export function decodeRecipeProperty(b64) {
  const cmd = Buffer.from(b64, "base64")[2];
  return cmd === 0xa6 ? { kind: "values", ...decodeRecipeValues(b64) } : { kind: "bounds", ...decodeRecipeBounds(b64) };
}
