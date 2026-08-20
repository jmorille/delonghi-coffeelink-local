/**
 * Configuration i18n — une seule langue pour l'instant (français).
 *
 * Pas de préfixe de locale dans l'URL, volontairement : `server.mjs` intercepte `/api/*` et
 * `/local_lan/*` avant Next, et introduire un segment `[locale]` déplacerait toutes les pages
 * (`/fr/profils`…) pour aucun bénéfice tant qu'il n'y a qu'une langue. Quand une deuxième
 * langue arrivera, deux options resteront ouvertes : négociation par en-tête `Accept-Language`
 * (sans changer les URL) ou passage au routage par locale de next-intl.
 */
export const locales = ["fr"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "fr";

export const isLocale = (v: string): v is Locale => (locales as readonly string[]).includes(v);
