import { getRequestConfig } from "next-intl/server";
import { defaultLocale } from "./config";

/**
 * Une seule langue active : on renvoie toujours le français. Le point d'extension pour la
 * négociation de langue est ici (cookie ou en-tête `Accept-Language`), sans toucher aux pages.
 */
export default getRequestConfig(async () => ({
  locale: defaultLocale,
  messages: (await import(`../../messages/${defaultLocale}.json`)).default,
}));
