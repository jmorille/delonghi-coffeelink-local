import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import Nav from "./Nav";
import Icone from "./icons";
import ThemeToggle from "./ThemeToggle";
import "./globals.css";

/**
 * **`viewport-fit: cover` est ce qui débloque `env(safe-area-inset-*)`.** Sans lui, ces variables
 * valent zéro et le CSS qui les emploie ne fait rien : la barre haute passe sous l'encoche d'un
 * téléphone en paysage, et le dernier bouton d'une page se range derrière la barre d'accueil.
 * Next pose déjà `width=device-width, initial-scale=1` par défaut — les deux sont répétés ici
 * parce que déclarer `viewport` remplace ce défaut au lieu de le compléter.
 *
 * `themeColor` peint la zone de chrome du navigateur mobile (barre d'état, encoche) dans la
 * couleur de fond de la page, au lieu du blanc système qui coupait l'écran en deux au-dessus de
 * l'interface sombre. **Limite connue et assumée :** il ne suit que la préférence de l'OS, pas le
 * choix explicite du sélecteur de thème — la balise n'a pas d'équivalent scriptable fiable. Un
 * thème sombre demandé sur un OS clair garde donc une barre d'état claire ; c'est un cran mieux
 * que le blanc dans les deux cas, qui était l'état précédent.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e9e7dd" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0f12" },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return { title: t("title"), description: t("description") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const brand = (await getTranslations("app"))("brand");

  return (
    /* `suppressHydrationWarning` : le script en ligne ci-dessous pose `data-theme` AVANT
       l'hydratation, donc l'attribut existe côté client et pas côté serveur. React le signalait
       comme une divergence — elle est voulue, et c'est le seul moyen d'éviter le flash de thème.
       La portée est limitée aux attributs de cet élément : rien d'autre n'est dispensé du
       contrôle. */
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/*
          Le thème choisi est posé sur `<html>` AVANT la première peinture. Le faire dans un effet
          React aurait affiché un flash de thème clair à chaque chargement d'une tablette réglée en
          sombre — le défaut même que ce réglage supprime. C'est la seule raison d'un script en
          ligne ici : il doit être synchrone et précéder le rendu du corps.

          La clé doit rester identique à `CLE_THEME` dans `theme.ts`. En « auto », aucun attribut
          n'est posé : c'est l'absence d'attribut que la media query du CSS interprète comme
          « suivre le système ».
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('delonghi.theme');" +
              "if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}",
          }}
        />
      </head>
      <body>
        {/* Les pages sont des composants clients : le provider leur passe le catalogue. */}
        <NextIntlClientProvider locale={locale} messages={messages}>
          <header className="topbar">
            {/* La marque portait un ☕ dans sa chaîne de traduction : un émoji, donc colorié par le
                système, de graisse quelconque et indifférent à la couleur du texte — à 30 cm des
                trois icônes filaires du sélecteur de thème, dans la même barre. Le panneau replié
                dessinait déjà sa marque (`Nav.tsx`, en-tête du tiroir) ; la barre fait pareil. */}
            <span className="brand">
              <Icone nom="tasse" taille={19} />
              <span>{brand}</span>
            </span>
            {/* Composant client : le menu se réduit quand la clé LAN est absente (voir Nav.tsx). */}
            <Nav />
            {/* Hors du <nav> : ce n'est pas une destination. Placé en fin de barre, il reste à
                l'écart des commandes qui agissent sur la machine. */}
            <ThemeToggle />
          </header>
          <main className="container">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
