/**
 * Extrait de `MachinesModels.json` le CATALOGUE DE BOISSONS de chaque modèle connecté.
 *
 * Complète `extract-models.mjs`, qui n'en tire que la table d'identification. Ici on prend la
 * liste des recettes — c'est elle qui change d'un modèle à l'autre, et c'est tout ce qui change :
 * la numérotation des propriétés Ayla, elle, est un espace de noms De'Longhi **figé** (voir
 * `beverages.mjs`, tables SLOT / BS / CUSTOM, relevées dans `p258z7/z.java`).
 *
 * Chaque modèle reçoit un verdict de `support`, parce que la table ne permet pas la même chose
 * partout :
 *
 *   "classic"  — toutes ses recettes tiennent dans l'espace de noms vérifié (ids ≤ 27, 200,
 *                230-235). C'est le cas des PD_SOUL et PD_SOUL_BETTER. Pilotable.
 *   "extended" — le modèle a en plus les familles « iced » (50-56) et « mug » (80-86, 100-107),
 *                qui passent par l'AUTRE nomenclature (`d%s_rec_%s_…`, pas de profil × 43). Elle
 *                n'est pas implémentée, et surtout pas vérifiable sans une machine de ce type :
 *                on livre le catalogue, en disant qu'il n'est pas adressable.
 *   "norecipes"— la table ne contient AUCUNE recette pour ce modèle (les 13 STRIKER_GOOD). L'app
 *                les obtient d'ailleurs, probablement de son backend. Rien à extraire.
 *
 * Régénérer avec :  node scripts/extract-catalogs.mjs [chemin/vers/MachinesModels.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] ?? resolve(HERE, "../../decompiled/resources/assets/MachinesModels.json");
const OUT = resolve(HERE, "../src/lib/machine-catalogs.json");

/**
 * Espace de noms vérifié : les 21 recettes standard, le Bean System et les 6 recettes perso.
 * Un id hors de cette liste n'a pas de propriété Ayla connue de notre côté.
 */
const CLASSIC_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 22, 23, 24, 25, 26, 27, 200, 230, 231, 232, 233, 234, 235]);

let src;
try {
  src = JSON.parse(readFileSync(SRC, "utf8"));
} catch {
  console.error(
    `source introuvable : ${SRC}\n` +
      "L'APK decompile n'est pas versionne (droits De'Longhi). Fournir le chemin de MachinesModels.json en argument.",
  );
  process.exit(1);
}

const catalogs = {};
const compte = { classic: 0, extended: 0, norecipes: 0 };

for (const m of src.machines) {
  if (m.connectionType === "BT") continue; // pas de LAN mode possible
  const key = m.product_code.slice(-5);
  if (catalogs[key]) throw new Error(`collision de cle ${key}`);

  const recipes = (m.recipes ?? []).map((r) => ({
    id: Number(r.id),
    name: r.name,
    // Ids des paramètres que cette boisson accepte. Conservés en nombres : la table source les
    // donne en chaînes, et une comparaison `"9" === 9` échoue en silence.
    ingredients: (r.ingredients ?? []).map(Number),
  }));
  const hors = recipes.map((r) => r.id).filter((id) => !CLASSIC_IDS.has(id));
  const support = recipes.length === 0 ? "norecipes" : hors.length ? "extended" : "classic";
  compte[support]++;

  catalogs[key] = {
    productCode: m.product_code,
    type: m.type,
    name: m.name,
    appModelId: m.appModelId,
    // Lu par /systeme : sans lui la fiche affichait une ligne vide.
    connectionType: m.connectionType,
    protocolVersion: m.protocolVersion,
    protocolMinorVersion: m.protocol_minor_version,
    nProfiles: m.nProfiles,
    nStandardRecipes: m.nStandardRecipes,
    nCustomRecipes: m.nCustomRecipes,
    customizableProfiles: m.customizableProfiles,
    creationRecipes: m.creationRecipes,
    globalTemperature: m.globalTemperature,
    characterSet: m.characterSet,
    profileIconsSet: m.profile_icons_set,
    profileNamesCustomizable: m.profile_names_customizable,
    profileIconsCustomizable: m.profile_icons_customizable,
    /**
     * **Les réglages machine que CE modèle expose.** Repris tels quels, nom compris : ce sont les
     * drapeaux que `REGLAGES` (server.mjs) interroge avant de proposer — puis d'écrire — un
     * réglage. Recopiés sous un autre nom, ils auraient formé une deuxième table à tenir à jour ;
     * or celle-ci vient de l'APK et la nôtre est écrite à la main, donc c'est celle-ci qui doit
     * gagner. Un modèle absent de la source laisse le drapeau `undefined`, ce que le serveur lit
     * « non déclaré, donc on ne propose pas » — jamais « supporté par défaut ».
     */
    water_hardness_settings: m.water_hardness_settings,
    auto_off_settings: m.auto_off_settings,
    auto_start_settings: m.auto_start_settings,
    buzzer_settings: m.buzzer_settings,
    cup_light_settings: m.cup_light_settings,
    cup_warmer_settings: m.cup_warmer_settings,
    energy_saving_settings: m.energy_saving_settings,
    filter_settings: m.filter_settings,
    time_settings: m.time_settings,
    pin_settings: m.pin_settings,
    support,
    // Les ids qui sortent de l'espace de noms vérifié, nommés : c'est ce qui justifie le verdict.
    unsupportedIds: hors,
    recipes,
  };
}

const out = {
  _source: `assets/MachinesModels.json de l'APK Coffee Link, table « ${src.name ?? "Machine Template"} » v${src.version ?? "?"}.`,
  _nature:
    "Catalogue de boissons par modèle. Ce qui change d'un modèle à l'autre est la LISTE des recettes ; " +
    "la numérotation des propriétés Ayla est un espace de noms De'Longhi figé, tenu dans beverages.mjs.",
  _support:
    "classic = toutes les recettes sont adressables ; extended = familles iced/mug qui passent par l'autre " +
    "nomenclature (non implémentée, non vérifiable sans une machine de ce type) ; norecipes = la table n'en " +
    "contient aucune pour ce modèle.",
  tableVersion: String(src.version ?? ""),
  models: catalogs,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");

console.log(`${Object.keys(catalogs).length} modeles connectes -> ${OUT}`);
console.log(`  classic   : ${compte.classic}`);
console.log(`  extended  : ${compte.extended}`);
console.log(`  norecipes : ${compte.norecipes}`);
