/**
 * ⚠️ **Ce fichier ne tourne pas.** `server.mjs` sert lui-même `/local_lan/*` et `/api/*` en
 * HTTP brut, dans tous les modes : ces routes et ces modules sont shadowés et ne sont gardés
 * que comme référence. En cas de divergence, `server.mjs` fait foi.
 *
 * ⚠️ **Et le stockage décrit ici n'existe plus.** La persistance est passée à SQLite
 * (`src/lib/store.mjs`, table `recipes`) ; `data/recipes.json` a été renommé `.migrated` et
 * n'est plus relu par personne. Ce module écrirait donc un fichier que rien ne lit — ne pas
 * s'en servir, et ne pas le prendre pour la couche de persistance du projet.
 */
/**
 * Recettes personnalisées : stockage fichier (data/recipes.json) + presets d'usine.
 * Une recette = boisson + liste de paramètres (id ECAM → valeur).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { BEVERAGES, PARAM, RecipeParam } from "./ecam";

export interface Recipe {
  id: string; // identifiant local (uuid court)
  name: string; // nom donné par l'utilisateur
  beverageId: number; // clé de BEVERAGES
  profileId: number; // 1..5
  params: RecipeParam[];
  updatedAt: number;
}

const FILE = path.join(process.cwd(), "data", "recipes.json");

async function ensure(): Promise<void> {
  try {
    await fs.access(FILE);
  } catch {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify({ recipes: seed() }, null, 2));
  }
}

export async function listRecipes(): Promise<Recipe[]> {
  await ensure();
  const txt = await fs.readFile(FILE, "utf8");
  return JSON.parse(txt).recipes as Recipe[];
}

export async function saveRecipes(recipes: Recipe[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ recipes }, null, 2));
}

export async function upsertRecipe(r: Recipe): Promise<Recipe[]> {
  const list = await listRecipes();
  const i = list.findIndex((x) => x.id === r.id);
  r.updatedAt = Date.now();
  if (i >= 0) list[i] = r;
  else list.push(r);
  await saveRecipes(list);
  return list;
}

export async function deleteRecipe(id: string): Promise<Recipe[]> {
  const list = (await listRecipes()).filter((x) => x.id !== id);
  await saveRecipes(list);
  return list;
}

/** Quelques presets de départ (valeurs à ajuster après vérification sur machine). */
function seed(): Recipe[] {
  return [
    {
      id: "espresso",
      name: "Espresso",
      beverageId: 1,
      profileId: 1,
      params: [
        { id: PARAM.COFFEE, value: 40 },
        { id: PARAM.TASTE, value: 2 },
        { id: PARAM.TEMP, value: 1 },
      ],
      updatedAt: Date.now(),
    },
    {
      id: "cappuccino",
      name: "Cappuccino",
      beverageId: 7,
      profileId: 1,
      params: [
        { id: PARAM.COFFEE, value: 40 },
        { id: PARAM.MILK, value: 120 },
        { id: PARAM.TASTE, value: 2 },
      ],
      updatedAt: Date.now(),
    },
  ];
}

export { BEVERAGES, PARAM };
