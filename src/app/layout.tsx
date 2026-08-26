import type { Metadata, Viewport } from "next";
import { Archivo, Fragment_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import Nav from "./Nav";
import Icone from "./icons";
import ThemeToggle from "./ThemeToggle";
/* Une seule feuille : `globals.css` importe lui-même l'ancienne dans une couche `legacy`
   subordonnée (voir son en-tête). L'importer ici en plus la sortirait de cette couche et lui
   rendrait la priorité — c'est le défaut que la couche existe pour empêcher. */
import "./globals.css";

/**
 * **Les deux polices sont des objets, pas des goûts.**
 *
 * `Archivo` porte les légendes : c'est une néo-grotesque au squelette serré, qui tient les
 * capitales espacées d'une sérigraphie de boîtier sans devenir une police d'affichage. Elle est
 * variable, donc les graisses 400 → 700 ne coûtent qu'un fichier.
 *
 * `Fragment Mono` porte les mesures, les trames et le journal. Elle est **dérivée de l'Helvetica
 * monospacée** — donc exactement la filiation du lettrage de la façade, et pas une police de
 * terminal empruntée pour faire technique. C'est la distinction qui rend la monospace légitime
 * ici : elle sert une mesure et du code, jamais un costume.
 *
 * Les deux sont auto-hébergées par `next/font` : aucun appel sortant au chargement d'une page, ce
 * qui n'est pas une optimisation mais une exigence — ce produit tourne sur un LAN sans Internet.
 */
const policeLegende = Archivo({
  subsets: ["latin"],
  variable: "--font-legende",
  display: "swap",
});

const policeValeur = Fragment_Mono({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-valeur",
  display: "swap",
});

/**
 * Le contrat de direction, émis **dans le balisage** et non seulement en commentaire de source :
 * un commentaire JSX (`{/* … *\/}`) ne survit pas à la compilation, donc il ne serait auditable
 * nulle part après un `next build`. Celui-ci se retrouve par `grep 7353e42f` dans `.next`.
 */
const CONTRAT_DIRECTION = `<!--
THESIS: Le serveur n'affiche pas la machine : il en est une. Refuse la grille de tuiles arrondies du tableau de bord domotique.
OWN-WORLD: Deux boîtiers, jamais une inversion — graphite #26282a, aluminium #bcbcb7. Brossage, grille perforée, biseaux 1 px, rayons 2-3 px. Légendes sérigraphiées en capitales espacées (Archivo), mesures en Helvetica monospacée (Fragment Mono). Trois lampes encastrées : ambre = choisi, vert = marche, rouge = arrêt/défaut.
STORY: On reconnaît un appareil, pas une page ; on voit ce que la machine a poussé, ce qu'on a demandé, et ce qui n'est jamais arrivé ; on appuie.
FIRST VIEWPORT: Rail brossé, marque gravée, sélecteur de machine et lampe de session à droite. Dessous, le catalogue en touches encastrées sur grille perforée, légende sérigraphiée sous chaque touche, lampe ambre sur celle qu'on a ouverte. Aucune touche n'est verte au repos : le vert n'appartient qu'à ce que la machine rapporte en marche.
FORM: Façade d'appareil Braun/Rams, registre codé-fonction (ET66/TG60) ; candidat 6 de la liste classée ; clé 7353e42f.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->`;

/**
 * **`viewport-fit: cover` est ce qui débloque `env(safe-area-inset-*)`.** Sans lui, ces variables
 * valent zéro et le CSS qui les emploie ne fait rien : le rail passe sous l'encoche d'un téléphone
 * en paysage, et le dernier bouton d'une page se range derrière la barre d'accueil. Next pose déjà
 * `width=device-width, initial-scale=1` par défaut — les deux sont répétés ici parce que déclarer
 * `viewport` remplace ce défaut au lieu de le compléter.
 *
 * `themeColor` peint la zone de chrome du navigateur mobile dans la couleur du **boîtier**, pour
 * que la barre d'état soit la continuation de l'appareil et non une bande système au-dessus de
 * lui. **Limite connue et assumée :** la balise ne suit que la préférence de l'OS, pas le choix
 * explicite du sélecteur de thème — il n'existe pas d'équivalent scriptable fiable.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#bcbcb7" },
    { media: "(prefers-color-scheme: dark)", color: "#26282a" },
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
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${policeLegende.variable} ${policeValeur.variable}`}
    >
      <head>
        {/*
          La finition choisie est posée sur `<html>` AVANT la première peinture. Le faire dans un
          effet React aurait affiché un flash de boîtier clair à chaque chargement d'une tablette
          réglée en sombre — le défaut même que ce réglage supprime. C'est la seule raison d'un
          script en ligne ici : il doit être synchrone et précéder le rendu du corps.

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
      <body className="grille min-h-dvh bg-boitier text-encre">
        <div hidden dangerouslySetInnerHTML={{ __html: CONTRAT_DIRECTION }} />
        {/* Les pages sont des composants clients : le provider leur passe le catalogue. */}
        <NextIntlClientProvider locale={locale} messages={messages}>
          {/*
            **Le rail.** Ce n'est pas une barre de navigation posée sur un fond : c'est la barre
            d'aluminium brossé vissée en haut du boîtier. D'où sa composition — brossage
            directionnel, arête gravée en bas (et non une ombre portée), et le respect de
            l'encoche par `padding-top` plutôt que par une marge, pour que la matière remonte
            jusqu'au bord physique de l'écran au lieu de s'arrêter avant.
          */}
          <header
            className="brosse sticky top-0 z-30 border-b border-gravure bg-releve
                       pt-[env(safe-area-inset-top)]
                       shadow-[inset_0_1px_0_0_var(--color-arete-haute)]"
          >
            <div
              className="mx-auto flex w-full max-w-[1440px] items-center gap-3
                         px-[max(var(--s-3),env(safe-area-inset-left))] py-2"
            >
              {/*
                La marque est **gravée**, pas écrite : capitales espacées, encre faible, et le
                pictogramme au même trait que toutes les autres icônes. Elle portait un émoji ☕
                dans sa chaîne de traduction — un caractère colorié par le système, de graisse
                quelconque, indifférent à la couleur du texte, à 30 cm de trois icônes filaires.
              */}
              <span className="flex flex-none items-center gap-2 text-encre">
                <Icone nom="tasse" taille={18} />
                <span className="serigraphie text-encre">{brand}</span>
              </span>
              {/* Composant client : le menu se réduit quand la clé LAN est absente (voir Nav.tsx). */}
              <Nav />
              {/* Hors du <nav> : ce n'est pas une destination. Placé en fin de rail, il reste à
                  l'écart des commandes qui agissent sur la machine. */}
              <ThemeToggle />
            </div>
          </header>
          <main
            className="mx-auto w-full max-w-[1440px]
                       px-[max(var(--s-3),env(safe-area-inset-left))]
                       pb-[max(var(--s-6),env(safe-area-inset-bottom))] pt-4"
          >
            {children}
          </main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
