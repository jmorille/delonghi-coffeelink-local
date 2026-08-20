import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import Nav from "./Nav";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return { title: t("title"), description: t("description") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const brand = (await getTranslations("app"))("brand");

  return (
    <html lang={locale}>
      <body>
        {/* Les pages sont des composants clients : le provider leur passe le catalogue. */}
        <NextIntlClientProvider locale={locale} messages={messages}>
          <header className="topbar">
            <span className="brand">{brand}</span>
            {/* Composant client : le menu se réduit quand la clé LAN est absente (voir Nav.tsx). */}
            <Nav />
          </header>
          <main className="container">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
