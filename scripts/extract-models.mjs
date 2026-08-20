/**
 * Extrait de MachinesModels.json la table d'IDENTIFICATION des modeles connectes.
 * Volontairement SANS les recettes : le catalogue actif reste machine-model.json, et deux
 * sources de verite pour les recettes seraient un piege.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Chemins relatifs au depot : la table source vient de l'APK decompile, qui n'est PAS versionne
// (droits De'Longhi). Passer un autre chemin en argument si le votre differe.
//   node scripts/extract-models.mjs [chemin/vers/MachinesModels.json]
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] ?? resolve(HERE, "../../decompiled/resources/assets/MachinesModels.json");
const OUT = resolve(HERE, "../src/lib/machine-models.json");

let src;
try {
  src = JSON.parse(readFileSync(SRC, "utf8"));
} catch {
  console.error(`source introuvable : ${SRC}
`
    + "L'APK decompile n'est pas versionne. Fournir le chemin de MachinesModels.json en argument.");
  process.exit(1);
}
const models = {};
for (const m of src.machines) {
  if (m.connectionType === "BT") continue; // pas de LAN mode possible
  const key = m.product_code.slice(-5);
  if (models[key]) throw new Error(`collision de cle ${key}`);
  models[key] = {
    productCode: m.product_code,
    type: m.type,
    name: m.name,
    appModelId: m.appModelId,
    connectionType: m.connectionType,
    protocolVersion: m.protocolVersion,
    protocolMinorVersion: m.protocol_minor_version,
    nProfiles: m.nProfiles,
    nStandardRecipes: m.nStandardRecipes,
    nCustomRecipes: m.nCustomRecipes,
    nGrinders: m.nGrinders,
    recipeCount: m.recipes.length,
    customizableProfiles: m.customizableProfiles,
    creationRecipes: m.creationRecipes,
    globalTemperature: m.globalTemperature,
    characterSet: m.characterSet,
    profileIconsSet: m.profile_icons_set,
  };
}

const out = {
  _source: `assets/MachinesModels.json de l'APK Coffee Link — table « ${src.name} » v${src.version}. Extraction automatique (scripts/extract-models.mjs) : ne pas editer a la main.`,
  _scope:
    "Uniquement les modeles dont connectionType n'est pas « BT » : un modele purement Bluetooth ne peut pas parler le LAN mode Ayla. 30 entrees sur les 117 de la table.",
  _keying:
    "Indexe par les 5 DERNIERS caracteres du product_code — c'est la cle que l'app utilise elle-meme (DefaultsTable.getDefaultValuesForMachine), et ce sont les 5 caracteres que la machine publie dans d270_serialnumber.",
  _noRecipes:
    "Pas de recettes ici volontairement : le catalogue actif est src/lib/machine-model.json (le seul modele reellement supporte). recipeCount dit combien la table en declare, ce qui suffit a signaler un ecart de modele sans dupliquer les recettes.",
  tableVersion: src.version,
  models,
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
const size = JSON.stringify(out).length;
console.log(`ok ${OUT} — ${Object.keys(models).length} modeles, ${size} octets`);
const fams = {};
for (const m of Object.values(models)) fams[m.appModelId] = (fams[m.appModelId] ?? 0) + 1;
console.log("familles :", fams);
