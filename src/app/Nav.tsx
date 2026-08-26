"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { MACHINE_EVENT, currentMachine, mfetch, setCurrentMachine } from "./machine";
import Icone from "./icons";
import { Button } from "@/ui/button";
import { cn } from "@/ui/cn";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";

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
 * **Deux présentations, une seule liste.** Au-dessus du seuil `rail` (1 200 px) les entrées sont une rangée dans
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
   * ⚠️ **Le piège de focus ne vient plus de la plateforme.** C'était `showModal()` qui l'apportait,
   * avec Échap et l'inertie du fond ; avec l'attribut `open` seul, la tabulation continuait derrière
   * le panneau et on pouvait déclencher une commande de la machine qu'on ne voit pas. Depuis le
   * passage à `Sheet` (Radix), les trois viennent du composant — donc du code, et
   * `scripts/verif-surfaces.mjs` les mesure au lieu de les supposer.
   *
   * L'état d'ouverture n'a plus qu'une source. Il en avait deux — l'attribut du `<dialog>` et
   * `ouvert` — tenues d'accord à la main par `ouvrir` / `fermer` ; `Sheet` étant contrôlé, la
   * question ne se pose plus.
   */
  const fermer = () => setOuvert(false);

  /**
   * ⚠️ **Ce sélecteur ÉTAIT un `<select>` natif, et le commentaire d'origine disait pourquoi :** sur
   * téléphone et tablette, le natif ouvre le sélecteur du système, qui se manipule au pouce, là où
   * une liste réécrite en JavaScript ne fait que l'imiter moins bien. C'est un recul réel, pris en
   * connaissance de cause lors du passage à shadcn — l'alternative était de garder le natif sous
   * `pointer: coarse`, donc DEUX listes à tenir d'accord pour un seul choix.
   *
   * Ce qui ne change pas est la matière : une plaque signalétique fraisée dans le rail, pas un
   * champ de formulaire. C'est elle qui portait l'intérêt du bloc, et elle survit au composant.
   */
  const selecteurMachine = (
    <Select value={courante ?? ""} onValueChange={change}>
      <SelectTrigger
        aria-label={t("machines")}
        className="creuset serigraphie h-auto min-h-9 tactile:min-h-11 max-w-40 truncate border-0 bg-creux px-2 py-1 text-encre
                   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ambre focus-visible:ring-0"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {machines.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  /**
   * **Une entrée de rail est une légende gravée surmontant sa lampe.** C'est la navigation d'un
   * panneau d'appareil : le nom est sérigraphié, et un témoin ambre dit lequel est engagé — l'ambre
   * étant, dans tout le produit, la couleur de ce qui est CHOISI. Un lien souligné en couleur
   * aurait été la version générique de la même information.
   *
   * `aria-current` porte l'état pour qui n'a pas la lampe : le témoin est `aria-hidden`, donc il
   * n'existe que pour l'œil, et l'annonce passe par l'attribut.
   */
  const liens = entries.map((e) => {
    const courant = chemin === e.href;
    return (
      <a
        href={e.href}
        key={e.href}
        aria-current={courant ? "page" : undefined}
        className="group flex min-h-9 tactile:min-h-11 flex-col items-center justify-center gap-1 px-2 py-1
                   rail:min-h-0 rounded-touche
                   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ambre"
      >
        {/* `text-encre` sans `!` : `.serigraphie` vit dans la couche `components` et les
            utilitaires dans `utilities`, qui vient après — l'encre pleine l'emporte par la
            cascade, pas par la force. C'est la règle que l'en-tête de `globals.css` pose. */}
        <span
          className={cn(
            "serigraphie transition-colors",
            courant ? "text-encre" : "group-hover:text-encre",
          )}
        >
          {t(e.key)}
        </span>
        <span
          aria-hidden
          className={cn(
            "h-0.5 w-full",
            courant
              ? "bg-ambre shadow-[0_0_6px_-1px_var(--color-ambre)]"
              : "bg-transparent group-hover:bg-arete-commande",
          )}
        />
      </a>
    );
  });

  return (
    <>
      {/* Le rail : à partir du seuil `rail`, les entrées sont une rangée de légendes gravées.
          **`flex` n'est pas cosmétique ici.** Le menu a été un enchaînement d'`<a>` : React les
          rend sans espace entre eux, donc l'inline formatting context n'offrait AUCUN point de
          coupure et la rangée ne pouvait pas se replier — mesuré, min-content 442 px dans une
          fenêtre de 356, soit 265 px de débordement latéral sur les huit pages. En flex, chaque
          lien est un élément, donc un point de coupure. */}
      {/* `min-w-0` est une ceinture : même si un jour une entrée s'allonge au-delà du seuil mesuré,
          le rail se comprime au lieu de pousser la page — un défilement latéral sur une surface de
          pilotage est le pire des deux maux. */}
      <nav className="hidden min-w-0 flex-1 items-center justify-end gap-1 rail:flex">
        {/* Le sélecteur n'apparaît qu'à partir de deux machines : avec une seule, il n'offre aucun
            choix et ne ferait que du bruit. */}
        {machines.length > 1 && selecteurMachine}
        {liens}
      </nav>

      {/* En dessous du seuil, les entrées vivent dans un panneau. Le bouton reste dans le rail —
          il porte l'état d'ouverture, donc il doit rester visible et au même endroit une fois
          ouvert. */}
      <div className="ml-auto flex items-center rail:hidden">
        <Button
          type="button"
          variant="neutre"
          size="commande"
          aria-label={t("openMenu")}
          aria-expanded={ouvert}
          onClick={() => setOuvert(true)}
        >
          <Icone nom="menu" taille={20} />
        </Button>
      </div>

      {/*
        **Le panneau est une TRANCHE de l'appareil qu'on ouvre**, pas une feuille blanche qui glisse :
        il porte le boîtier et la même grille perforée que le fond. C'est cette matière qui faisait
        l'intérêt du bloc, et elle survit intégralement au changement de composant.

        Ce qui change : `Sheet` remplace le `<dialog>`. Le mouvement authored — arrivée posée en
        240 ms, sortie en 160, courbe qui décélère fortement comme un panneau lourd qui vient en
        butée — est donc réécrit sur les états de Radix (`data-state`) plutôt que sur `[open]` et
        `@starting-style`. Il reste dans `surfaces.css` : c'est le seul mouvement que ce produit
        s'autorise, et il ne se dit pas en utilitaires.

        Le voile suit `--gravure`, la marque la plus sombre de CHAQUE finition, et non un noir écrit
        en dur qui posait une nuit sur l'aluminium clair.
      */}
      <Sheet open={ouvert} onOpenChange={setOuvert}>
        <SheetContent side="left" className="drawer grille" aria-label={t("menuLabel")} showCloseButton={false}>
          <SheetTitle className="sr-only">{t("menuLabel")}</SheetTitle>
        <div className="flex h-full flex-col">
          <div className="brosse flex items-center gap-2 border-b border-gravure bg-releve px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <Icone nom="machine" taille={18} />
            <span className="serigraphie flex-1 text-encre">{tApp("brand")}</span>
            <Button
              type="button"
              variant="neutre"
              size="coquille"
              aria-label={t("closeMenu")}
              onClick={fermer}
            >
              <Icone nom="fermer" taille={18} />
            </Button>
          </div>

          <nav aria-label={t("menuLabel")} className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
            {liens}
          </nav>

          {/* Le sélecteur de machine est un réglage, pas une destination : il reste séparé des
              liens, en bas, là où le pouce arrive sur un téléphone. Le pied ne se rend que s'il a
              quelque chose à porter. */}
          {machines.length > 1 && (
            <div className="border-t border-gravure p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              {selecteurMachine}
            </div>
          )}
        </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
