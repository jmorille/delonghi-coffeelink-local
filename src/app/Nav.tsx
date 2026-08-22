"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { MACHINE_EVENT, currentMachine, mfetch, setCurrentMachine } from "./machine";
import Icone from "./icons";

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
 *
 * **Deux présentations, une seule liste.** Au-dessus de 1 080 px les entrées sont une rangée dans
 * la barre ; en dessous, elles vivent dans un panneau qui s'ouvre par la gauche. Le seuil est
 * mesuré, pas choisi : c'est la largeur à laquelle marque + huit entrées + sélecteur de
 * thème tiennent sur une ligne — à 900 px, où je l'avais d'abord posé, la barre passe à deux rangs
 * de 107 px. Le CSS n'en affiche qu'une des deux (`display: none`, qui la retire
 * aussi de l'arbre d'accessibilité — donc pas de liens annoncés en double), et c'est bien la même
 * `ENTRIES` qui alimente les deux : une divergence entre le menu du téléphone et celui du desktop
 * serait exactement le défaut que ce produit ne peut pas se permettre, puisque les pages qu'on
 * cherche en dernier recours sont celles qui réparent une machine muette.
 */
const ENTRIES = [
  { href: "/", key: "beverages", needsMachine: true },
  { href: "/beans", key: "beans", needsMachine: true },
  { href: "/profils", key: "profiles", needsMachine: true },
  { href: "/pilotage", key: "dashboard", needsMachine: true },
  { href: "/recipes", key: "recipes", needsMachine: true },
  { href: "/statistiques", key: "stats", needsMachine: true },
  // Les réglages de l'APPAREIL (dureté de l'eau, arrêt auto, bip…), à ne pas confondre avec la
  // configuration du serveur, qui vit dans /machines. Ils exigent une session chiffrée, donc les
  // deux prérequis.
  { href: "/reglages", key: "settings", needsMachine: true },
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
  const tApp = useTranslations("app");
  const chemin = usePathname();
  /**
   * `null` = état encore inconnu, et on affiche alors TOUT. Masquer par défaut ferait clignoter le
   * menu à chaque chargement dans le cas normal — tout configuré — qui est le cas courant.
   */
  const [ready, setReady] = useState<boolean | null>(null);
  const [machines, setMachines] = useState<Entree[]>([]);
  const [courante, setCourante] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const panneau = useRef<HTMLDialogElement>(null);

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

  /**
   * `showModal()` et non l'attribut `open` : c'est lui qui apporte le piège de focus, la touche
   * Échap et l'inertie du fond. Avec `open` seul, la tabulation continue derrière le panneau et
   * on peut déclencher une commande de la machine qu'on ne voit pas.
   */
  const ouvrir = () => {
    panneau.current?.showModal();
    setOuvert(true);
  };
  const fermer = () => {
    panneau.current?.close();
  };

  const selecteurMachine = (
    <select value={courante ?? ""} onChange={(e) => change(e.target.value)} aria-label={t("machines")}>
      {machines.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );

  const liens = entries.map((e) => {
    const courant = chemin === e.href;
    return (
      <a href={e.href} key={e.href} aria-current={courant ? "page" : undefined} className={courant ? "actif" : undefined}>
        {t(e.key)}
      </a>
    );
  });

  return (
    <>
      {/* Présentation « barre » : à partir de 1 080 px. */}
      <nav className="barNav">
        {/* Le sélecteur n'apparaît qu'à partir de deux machines : avec une seule, il n'offre aucun
            choix et ne ferait que du bruit. */}
        {machines.length > 1 && selecteurMachine}
        {/* `aria-current` marque la page courante. Le type `Entree` le déclarait depuis toujours sans
            que rien ne l'utilise : les huit liens étaient rigoureusement identiques, et sur une barre
            de huit entrées on ne savait pas où l'on se trouvait. La navigation se fait par liens
            classiques, donc `usePathname` suffit — pas d'état à synchroniser. */}
        {liens}
      </nav>

      {/* Présentation « panneau » : en dessous de 1 080 px. Le bouton reste dans la barre — il porte
          l'état d'ouverture, donc il doit rester visible et au même endroit une fois ouvert. */}
      <button type="button" className="menuBtn" aria-label={t("openMenu")} aria-expanded={ouvert} onClick={ouvrir}>
        <Icone nom="menu" taille={20} />
      </button>

      <dialog
        className="drawer"
        ref={panneau}
        aria-label={t("menuLabel")}
        onClose={() => setOuvert(false)}
        /* Clic sur le fond : la cible est le `<dialog>` lui-même, jamais un de ses enfants — c'est
           ce qui distingue « à côté du panneau » de « dans le panneau ». */
        onClick={(e) => {
          if (e.target === panneau.current) fermer();
        }}
      >
        <div className="tete">
          <Icone nom="machine" taille={20} />
          <strong>{tApp("brand")}</strong>
          <button type="button" className="menuBtn" aria-label={t("closeMenu")} onClick={fermer}>
            <Icone nom="fermer" taille={20} />
          </button>
        </div>
        <nav aria-label={t("menuLabel")}>{liens}</nav>
        {/* Le sélecteur de machine est un réglage, pas une destination : il reste séparé des
            liens, en bas, là où le pouce arrive sur un téléphone. Le pied ne se rend que s'il a
            quelque chose à porter : avec une seule machine et le mode banc retiré, il n'aurait
            plus été qu'un filet et douze pixels de rembourrage sous le dernier lien. */}
        {machines.length > 1 && <div className="pied">{selecteurMachine}</div>}
      </dialog>
    </>
  );
}
