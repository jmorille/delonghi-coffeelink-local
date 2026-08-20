"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { MACHINE_EVENT, currentMachine, mfetch, setCurrentMachine } from "./machine";

/**
 * Barre de navigation. Le pilotage a deux prérequis — l'adresse de la machine et la clé LAN — et il
 * manque l'un ou l'autre, les pages qui en dépendent ne peuvent rien faire : on ne les propose pas.
 *
 * Ces prérequis sont ceux de la machine **sélectionnée**, pas d'une machine quelconque : c'est
 * pour ça que la lecture d'état passe par `mfetch`. Avec deux cafetières dont une seule est
 * configurée, le menu doit suivre celle qu'on regarde.
 *
 * Deux entrées restent toujours là, et c'est délibéré :
 * - `/machines`, qui règle les DEUX prérequis pour chaque machine — l'adresse puis la clé, dans
 *   cet ordre, puisque la clé est rangée sous le DSN que seule la machine fournit — et qui permet
 *   aussi de basculer sur une autre. La masquer couperait le seul chemin de réparation et
 *   enfermerait dans une machine mal configurée ;
 * - `/systeme`, qui ne dépend d'aucun des deux (fiche appareil figée, protocole, stockage).
 *
 * `/cle-lan` n'y figure plus : ses deux réglages sont dans la carte de chaque machine, sur
 * `/machines`. L'URL redirige, pour les liens et onglets déjà ouverts.
 *
 * Les pages masquées restent **servies** : une URL saisie à la main continue d'afficher le cache
 * de la dernière lecture, avec la bannière d'avertissement. On retire l'invitation, pas l'accès.
 */
const ENTRIES = [
  { href: "/", key: "beverages", needsMachine: true },
  { href: "/beans", key: "beanAdapt", needsMachine: true },
  { href: "/profils", key: "profiles", needsMachine: true },
  { href: "/pilotage", key: "dashboard", needsMachine: true },
  { href: "/recipes", key: "recipes", needsMachine: true },
  { href: "/statistiques", key: "stats", needsMachine: true },
  { href: "/machines", key: "machines", needsMachine: false },
  { href: "/systeme", key: "system", needsMachine: false },
] as const;

interface Entree {
  id: string;
  label: string;
  current: boolean;
}

export default function Nav() {
  const t = useTranslations("nav");
  /**
   * `null` = état encore inconnu, et on affiche alors TOUT. Masquer par défaut ferait clignoter le
   * menu à chaque chargement dans le cas normal — tout configuré — qui est le cas courant.
   */
  const [ready, setReady] = useState<boolean | null>(null);
  const [machines, setMachines] = useState<Entree[]>([]);
  const [courante, setCourante] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await mfetch("/api/status").then((r) => r.json());
      const c = d?.config;
      setReady(!!c?.machineIp && c?.lanKeySet === true);
      // La liste vient de /api/status, déjà interrogé par toutes les pages : le sélecteur ne
      // coûte donc aucune requête supplémentaire.
      setMachines(Array.isArray(d?.machines) ? d.machines : []);
      setCourante(d?.machine?.id ?? null);
    } catch {
      /* en cas d'échec on laisse le menu complet : mieux vaut trop offrir que bloquer */
    }
  }, []);

  useEffect(() => {
    setCourante(currentMachine());
    refresh();
    // La navigation se fait par liens classiques (rechargement complet), donc le menu se
    // reconstruit à chaque page. Le seul cas où l'état change sans navigation est la page
    // /machines, qui règle les prérequis et la sélection : elle émet ces deux événements.
    const onChange = () => refresh();
    window.addEventListener("lankey-changed", onChange);
    window.addEventListener(MACHINE_EVENT, onChange);
    return () => {
      window.removeEventListener("lankey-changed", onChange);
      window.removeEventListener(MACHINE_EVENT, onChange);
    };
  }, [refresh]);

  const entries = ready === false ? ENTRIES.filter((e) => !e.needsMachine) : ENTRIES;

  /**
   * Changer de machine recharge la page. Les données affichées appartiennent toutes à la machine
   * précédente : les garder à l'écran le temps que chaque composant se rafraîchisse afficherait
   * l'état d'une cafetière sous le nom d'une autre.
   */
  const change = (id: string) => {
    setCurrentMachine(id);
    window.location.reload();
  };

  return (
    <nav>
      {/* Le sélecteur n'apparaît qu'à partir de deux machines : avec une seule, il n'offre aucun
          choix et ne ferait que du bruit. */}
      {machines.length > 1 && (
        <select value={courante ?? ""} onChange={(e) => change(e.target.value)} aria-label={t("machines")}>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      )}
      {entries.map((e) => (
        <a href={e.href} key={e.href}>
          {t(e.key)}
        </a>
      ))}
    </nav>
  );
}
