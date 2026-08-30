import { readFileSync } from "node:fs";
import createNextIntlPlugin from "next-intl/plugin";

/* L'empreinte du jeu d'images, lue à la source. Elle est écrite par `scripts/extract-images.mjs`
   et posée sur chaque URL par `BeverageImage.tsx` : la recopier ici en dur ferait une troisième
   déclaration, celle qu'on oublierait. */
const { version: VERSION_IMAGES } = JSON.parse(
  readFileSync(new URL("./src/lib/beverage-images.json", import.meta.url), "utf8"),
);

/* Idem pour les visuels de grains, écrits par `scripts/import-bean-images.mjs` et posés par
   `VignetteGrains.tsx`. Deux jeux, deux empreintes : ils sont régénérés séparément, et une
   empreinte commune ferait invalider les 58 dessins de boisson parce qu'un grain a changé. */
const { version: VERSION_GRAINS } = JSON.parse(
  readFileSync(new URL("./src/lib/bean-images.json", import.meta.url), "utf8"),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // La machine parle en HTTP 1.1 simple et attend des chemins littéraux type
  // /local_lan/key_exchange.json — gérés par des route handlers Node.
  reactStrictMode: false,
  // Rien d'externe : tout est local (crypto Node native, fetch vers la machine).

  /**
   * **Le cache des visuels de boissons.**
   *
   * Next sert `public/` en `Cache-Control: public, max-age=0` : le 304 épargne les octets, pas
   * l'ALLER-RETOUR. Et ces images arrivent en rafale — la liste des boissons vient de
   * `/api/beverages`, donc aucune n'est dans le HTML servi et les vingt et une `<img>` de
   * l'accueil sont créées d'un coup après hydratation. `loading="lazy"` est bien posé et n'y
   * défère rien : le clavier fait ~560 px de haut sur un écran de 1 280, tout est dans la
   * fenêtre. Mesuré avant : vingt et une requêtes conditionnelles à chaque navigation, sur un
   * serveur en HTTP/1.1 brut — six connexions par origine, donc quatre vagues d'aller-retour.
   *
   * `immutable` ne se déclare que si c'est vrai, et ça ne l'est PAS d'un nom de fichier : une
   * image redessinée dans un APK suivant garderait le sien. C'est vrai de l'URL versionnée. D'où
   * le `value` — et non la simple présence de `v` : l'empreinte doit être celle du jeu PRÉSENT.
   * Promettre un an à une valeur qu'on ne reconnaît pas serait promettre pour un dessin qu'on n'a
   * pas. Toute autre forme de l'URL garde la politique revalidante de Next.
   *
   * ⚠️ Cette règle est figée dans `.next/routes-manifest.json` au BUILD. Changer l'empreinte
   * sans reconstruire laisse le manifeste sur l'ancienne valeur, et plus rien n'est mis en cache
   * — ce qui est le bon sens de la panne, mais explique un « ça ne cache plus » sans cause
   * visible. `scripts/extract-images.mjs` et `pnpm build` vont ensemble.
   */
  async headers() {
    return [
      {
        source: "/boissons/:fichier*",
        has: [{ type: "query", key: "v", value: VERSION_IMAGES }],
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      /* Les visuels de grains, même règle et mêmes raisons. Ils sont moins nombreux — sept — mais
         arrivent dans les mêmes conditions : `/api/beanadapt` livre la liste, donc aucune `<img>`
         n'est dans le HTML servi, et le rail de torréfaction en crée quatre d'un coup par carte
         ouverte. Le `?v=` compare ici encore la VALEUR : promettre un an à une empreinte qu'on ne
         reconnaît pas serait promettre pour un visuel qu'on n'a pas. */
      {
        source: "/grains/:fichier*",
        has: [{ type: "query", key: "v", value: VERSION_GRAINS }],
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

// Le plugin injecte la configuration i18n (src/i18n/request.ts) dans le build.
export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
