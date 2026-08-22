/**
 * ESLint 10, configuration « plate » (la seule que cette version accepte).
 *
 * ## Pourquoi ce fichier existe
 *
 * `package.json` portait `"lint": "next lint"` depuis `create-next-app`, et **ce script n'a jamais
 * rien vérifié** : il n'y a jamais eu d'ESLint dans ce dépôt, donc sous Next 15 la commande serait
 * tombée dans son assistant interactif de configuration. Next 16 a supprimé `next lint` — et comme
 * `dev` est la commande par défaut et prend un `[directory]`, `next lint` s'y interprétait comme
 * `next dev ./lint`, d'où le message déroutant sur un « répertoire de projet invalide ».
 *
 * Rien n'avait donc régressé : rien ne lintait. Ce fichier remplace un script mort par une
 * vérification qui porte réellement sur quelque chose.
 *
 * ## Ce qui est linté, et surtout ce qui ne l'est PAS
 *
 * **Uniquement les `.mjs`** — et ce n'est pas un demi-travail, c'est là que se trouve le trou.
 * `tsconfig.json` n'inclut que les `.ts` et les `.tsx` : les 22 fichiers `.mjs` du dépôt, dont
 * `server.mjs` qui est *la seule chose qui tourne*, échappent entièrement à `tsc`. Leur unique
 * filet était `node --check`, qui ne voit que la syntaxe. Une variable inutilisée, une branche
 * inatteignable, une clé d'objet dupliquée, un `case` qui coule dans le suivant : rien de tout
 * cela n'était vu nulle part. Le côté `.tsx`, lui, est déjà couvert par `tsc --noEmit`.
 *
 * **`.ts` / `.tsx` sont exclus parce qu'ils sont IMPOSSIBLES à linter ici**, pas par choix de
 * confort. ESLint ne sait pas analyser TypeScript sans `@typescript-eslint/parser`, lequel appelle
 * l'API classique du compilateur. Or ce dépôt est sur **TypeScript 7.0.2** (le portage natif), dont
 * le paquet n'exporte plus que `version` et `versionMajorMinor` :
 *
 * ```
 * node -e 'const ts=require("typescript"); console.log(typeof ts.createSourceFile)'  // undefined
 * ```
 *
 * `createSourceFile`, `ScriptTarget`, `SyntaxKind`, `createProgram` — tout est absent, l'AST ayant
 * déménagé derrière `typescript/unstable/ast` avec une forme différente. Et `typescript-eslint`
 * déclare `typescript: ">=4.8.4 <6.1.0"` en pair, jusque dans sa version *canary* (8.67.1-alpha.25
 * au 2026-08-22). Ce n'est donc pas « ça marchera avec un avertissement » : c'est structurellement
 * impossible aujourd'hui.
 *
 * ⚠️ **Ne pas « réparer » cela en ajoutant `typescript-eslint`** : l'installation passera, et
 * l'analyse échouera à la première ligne de TSX. Quand typescript-eslint supportera TS 7, il
 * suffira d'ajouter un bloc `files` visant les `.ts`/`.tsx` — et `eslint-plugin-react-hooks`, qui vaut le
 * détour dans ce projet, deviendra utilisable du même coup.
 */
import js from "@eslint/js";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "data/**",
    "out/**",
    // Sorties extraites de l'APK : régénérées par `scripts/extract-*.mjs`, jamais éditées à la main.
    "src/lib/machine-catalogs.json",
    "src/lib/machine-models.json",
  ]),

  {
    // `.mjs` seulement : voir l'en-tête. Étendre à `.ts`/`.tsx` sans parseur ne produirait que des
    // erreurs d'analyse.
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        // `node:sqlite`, `fetch`, `crypto` global… : Node 26 les fournit, la liste `globals.node`
        // peut être en retard sur une version aussi récente.
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
    rules: {
      /**
       * **Le paramètre inutilisé est toléré, la variable inutilisée non.** Une signature de
       * rappel impose souvent des paramètres qu'on n'emploie pas ; une variable locale calculée
       * puis jamais lue, en revanche, est presque toujours un reste de refactor — exactement ce
       * qu'on veut voir. `caughtErrors: "none"` pour la même raison : `catch { }` sans lier
       * l'erreur est déjà la forme employée partout ici.
       */
      "no-unused-vars": ["error", {
        args: "none",
        caughtErrors: "none",
        varsIgnorePattern: "^_",
      }],
      /**
       * Promu en erreur : ce dépôt manipule des trames binaires et des tables de protocole, où
       * une clé dupliquée dans un objet littéral fait silencieusement disparaître la première.
       * C'est la classe de bogue la plus coûteuse ici, et la plus invisible en relecture.
       */
      "no-dupe-keys": "error",
      "no-fallthrough": "error",
      /**
       * **`catch {}` vide est l'idiome délibéré de ce dépôt**, pas un oubli : 13 occurrences, et
       * toutes disent la même chose — « au mieux ». Fermer une base à la sortie du process,
       * tenter un `ROLLBACK` sur un chemin déjà en erreur, analyser un corps HTTP qui peut être
       * tronqué, renommer un fichier déjà migré. Dans chacun de ces cas, échouer *bruyamment*
       * serait le vrai défaut. Le reste de `no-empty` (un `if` ou une boucle vide, qui sont de
       * vraies fautes) est conservé.
       */
      "no-empty": ["error", { allowEmptyCatch: true }],
      /**
       * Désactivée, et pas par confort. La règle vise `let x = null;` suivi d'une affectation sur
       * toutes les branches. Or ici ces variables finissent **sérialisées en JSON** (`i18n`,
       * `cleLibelle`), où `null` et `undefined` ne sont pas interchangeables : retirer
       * l'initialisateur changerait la réponse de l'API, et une branche ajoutée plus tard sans
       * affectation ferait disparaître la clé au lieu de la mettre à `null`. La règle a raison sur
       * le style et tort sur ce code.
       */
      "no-useless-assignment": "off",
      // `console` EST l'interface du serveur (voir `L()`), donc pas de règle contre lui.
      "no-console": "off",
      // Un `await` dans une boucle est parfois exactement ce qu'on veut : la machine ne prend
      // qu'une commande par visite. Aucune règle ne doit suggérer de « paralléliser » ça.
      "no-await-in-loop": "off",
    },
  },

  {
    // Les scripts de vérification s'arrêtent sur `process.exit` : rien à signaler là-dessus.
    files: ["scripts/**/*.mjs"],
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },
]);
