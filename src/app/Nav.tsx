"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Barre de navigation. Le pilotage a deux prérequis — l'adresse de la machine et la clé LAN — et il
 * manque l'un ou l'autre, les pages qui en dépendent ne peuvent rien faire : on ne les propose pas.
 *
 * Deux entrées restent toujours là, et c'est délibéré :
 * - `/cle-lan`, qui règle les DEUX prérequis — l'adresse de la machine puis la clé, dans cet
 *   ordre, puisque la clé est rangée sous le DSN que seule la machine fournit. La masquer
 *   couperait le seul chemin de réparation ;
 * - `/systeme`, qui ne dépend d'aucun des deux (fiche appareil figée, protocole, stockage).
 *
 * Les pages masquées restent **servies** : une URL saisie à la main continue d'afficher le cache
 * de la dernière lecture, avec la bannière d'avertissement. On retire l'invitation, pas l'accès.
 */
const ENTRIES = [
  { href: "/", key: "beverages", needsMachine: true },
  { href: "/bean-adapt", key: "beanAdapt", needsMachine: true },
  { href: "/profils", key: "profiles", needsMachine: true },
  { href: "/pilotage", key: "dashboard", needsMachine: true },
  { href: "/recipes", key: "recipes", needsMachine: true },
  { href: "/statistiques", key: "stats", needsMachine: true },
  { href: "/cle-lan", key: "lanKey", needsMachine: false },
  { href: "/systeme", key: "system", needsMachine: false },
] as const;

export default function Nav() {
  const t = useTranslations("nav");
  /**
   * `null` = état encore inconnu, et on affiche alors TOUT. Masquer par défaut ferait clignoter le
   * menu à chaque chargement dans le cas normal — tout configuré — qui est le cas courant.
   */
  const [ready, setReady] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await fetch("/api/status").then((r) => r.json());
      const c = d?.config;
      setReady(!!c?.machineIp && c?.lanKeySet === true);
    } catch {
      /* en cas d'échec on laisse le menu complet : mieux vaut trop offrir que bloquer */
    }
  }, []);

  useEffect(() => {
    refresh();
    // La navigation se fait par liens classiques (rechargement complet), donc le menu se
    // reconstruit à chaque page. Le seul cas où l'état change sans navigation est la page
    // /cle-lan : elle émet cet événement après avoir modifié un prérequis.
    const onChange = () => refresh();
    window.addEventListener("lankey-changed", onChange);
    return () => window.removeEventListener("lankey-changed", onChange);
  }, [refresh]);

  const entries = ready === false ? ENTRIES.filter((e) => !e.needsMachine) : ENTRIES;

  return (
    <nav>
      {entries.map((e) => (
        <a href={e.href} key={e.href}>
          {t(e.key)}
        </a>
      ))}
    </nav>
  );
}
