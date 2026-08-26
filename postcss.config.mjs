/**
 * Tailwind 4 n'a plus de `tailwind.config.js` : la configuration vit dans le CSS
 * (`@theme` dans `src/app/globals.css`), et le seul greffon nécessaire ici est celui qui exécute le
 * moteur. Le scan des classes est automatique — inutile de déclarer `content`.
 *
 * **Pourquoi ce fichier existe alors que `server.mjs` est le seul runtime.** Il ne sert qu'au
 * *build* : `next build` (et le HMR de `pnpm dev`) compile la feuille de style. `server.mjs`
 * n'appelle jamais PostCSS — il ne fait que servir les pages que Next a déjà compilées.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
