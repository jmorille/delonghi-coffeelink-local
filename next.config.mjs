import createNextIntlPlugin from "next-intl/plugin";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // La machine parle en HTTP 1.1 simple et attend des chemins littéraux type
  // /local_lan/key_exchange.json — gérés par des route handlers Node.
  reactStrictMode: false,
  // Rien d'externe : tout est local (crypto Node native, fetch vers la machine).
};

// Le plugin injecte la configuration i18n (src/i18n/request.ts) dans le build.
export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
