"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "./machine";
import Icone from "./icons";
import { ImageCrema } from "./VignetteGrains";
import { type Ask } from "./confirm";
import { cn } from "@/ui/cn";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Progress } from "@/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/table";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « AFFINER VOS PARAMÈTRES DE GRAINS » — LE PARCOURS, DANS UN DIALOGUE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'assistant vivait en bas de `/beans` : trois champs sur une rangée, un bouton « Calculer », un
 * tableau. Tout était visible d'un coup, donc rien ne disait dans quel ORDRE s'y prendre — or
 * l'ordre est la moitié du sens. On ne répond pas à « quel goût ? » avant d'avoir tiré la tasse
 * dont on parle, et l'écoulement n'est pas une opinion qu'on saisit mais un relevé qu'on va
 * chercher. Une rangée de champs mettait les trois sur le même plan.
 *
 * ## Le parcours est celui de l'appareil, pas une invention
 *
 * `NewCreationBeanAdaptRefineFragment` porte un `ViewPager2` et une `StatusView`, et son index de
 * page (`f28084g`) ne prend que trois valeurs — 0, 1, 2 — avant de basculer sur l'écran de
 * résultat (`toCompleteRefineFragment`). Les quatre étapes ci-dessous sont donc les siennes :
 *
 *   0  la mesure   — l'écoulement relevé par la machine, et de quoi en refaire un
 *   1  la crema    — question 11 du questionnaire De'Longhi
 *   2  le goût     — question 12
 *   3  le résultat — ce que la règle propose, et la reprise dans le brouillon
 *
 * ## Ce dialogue REMPLACE l'assistant, il ne s'y ajoute pas
 *
 * C'est la leçon que cette page a déjà payée une fois : elle a porté pendant des mois deux
 * éditeurs du même objet — les cartes et un « Réglage manuel » en pleine largeur — avec la
 * conséquence habituelle, une amélioration qui atterrit sur l'un et pas sur l'autre. Il n'y a donc
 * qu'UNE implémentation du questionnaire, et deux portes vers elle : la commande de l'affiche du
 * grain actif, et un bouton dans le dos de n'importe quel emplacement.
 *
 * ⚠️ **Une confirmation s'ouvre PAR-DESSUS ce dialogue, et c'est voulu.** L'étape 0 peut lancer une
 * vraie préparation ; elle passe donc par `demander`, dont le `ConfirmDialog` est monté au niveau
 * de la page — hors de ce composant. Deux dialogues Radix se superposent alors, et c'est le second
 * qui prend le piège de focus. Cette superposition est vérifiée dans un vrai navigateur
 * (`scripts/verif-surfaces.mjs`) : c'est exactement le genre d'empilement qui compile, s'affiche,
 * et laisse le clavier dans la mauvaise couche.
 *
 * ⚠️ **Le contenu de l'étape est annoncé, pas seulement affiché.** Changer de page ne déplace rien
 * dans le DOM du point de vue d'un lecteur d'écran si le conteneur reste le même : le corps porte
 * donc `aria-live="polite"`, et le focus est posé sur le titre de l'étape à chaque changement. Sans
 * ça, « Suivant » ne produit aucune parole.
 */

/** Ce que le dialogue a besoin de savoir du grain qu'il règle. */
export interface GrainAffine {
  index: number;
  name: string | null;
  grinder: number;
  temperature: number;
  aroma: number;
  active: boolean | null;
}
/** Le relevé de la machine — voir `vueBeanSync` côté serveur. */
export interface MesureAffinage {
  at: number | null;
  ecoulementMs: number | null;
  ecoulementS: number | null;
  espressos: number | null;
  seuil: number;
  permis: boolean | null;
}
interface Simulation {
  grinder: number;
  temperature: number;
  aroma: number;
  deltas: { grinder: number; temperature: number; aroma: number };
  changed: boolean;
  notes: string[];
  error?: string;
}

const ETAPES = 4;
const fmtDelta = (d: number) => (d === 0 ? "—" : d > 0 ? `+${d}` : String(d));

export default function AffinageDialog({
  ouvert,
  onFermer,
  grain,
  mesure,
  profileId,
  demander,
  onAppliquer,
}: {
  ouvert: boolean;
  onFermer: () => void;
  grain: GrainAffine | null;
  mesure: MesureAffinage | null;
  /** Le profil actif — la trame de préparation en porte un, elle ne peut pas s'en passer. */
  profileId: number;
  demander: (a: Ask) => void;
  /** Reprend les valeurs proposées dans le brouillon de la carte. Rien ne part vers la machine. */
  onAppliquer: (v: { grinder: number; temperature: number; aroma: number }) => void;
}) {
  const t = useTranslations("beanAdapt");
  const tc = useTranslations("common");
  const [etape, setEtape] = useState(0);
  const [flowTime, setFlowTime] = useState(15);
  const [crema, setCrema] = useState(2);
  const [taste, setTaste] = useState(2);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const titreEtape = useRef<HTMLHeadingElement>(null);

  /**
   * **Chaque ouverture repart de l'étape 0 et de la mesure du moment.**
   *
   * Garder l'état d'une session précédente ferait rouvrir le dialogue sur un résultat calculé pour
   * une tasse qui n'existe plus. Et la mesure est relue ICI plutôt qu'à la première frappe : entre
   * deux ouvertures, la machine a pu pousser un nouveau `d260` — c'est même le cas nominal, puisque
   * l'étape 0 invite à refaire un café.
   */
  useEffect(() => {
    if (!ouvert) return;
    setEtape(0);
    setSim(null);
    setErreur(null);
    if (Number.isInteger(mesure?.ecoulementS)) setFlowTime(mesure!.ecoulementS!);
  }, [ouvert, mesure?.ecoulementS, mesure?.at]);

  /* Le focus suit l'étape. `preventScroll` : le dialogue est déjà à sa place, et un défilement
     supplémentaire ferait sauter le contenu sous les yeux de qui n'utilise pas le clavier. */
  useEffect(() => {
    if (!ouvert) return;
    titreEtape.current?.focus({ preventScroll: true });
  }, [etape, ouvert]);

  /** Rejoue la règle Bean Adapt côté serveur — aucune écriture, aucun appel au cloud. */
  const calculer = useCallback(async () => {
    if (!grain) return;
    setBusy(true);
    setErreur(null);
    try {
      const r: Simulation = await mfetch("/api/beanadapt/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: grain.name ?? "",
          grinder: grain.grinder,
          temperature: grain.temperature,
          aroma: grain.aroma,
          flowTime, crema, taste,
        }),
      }).then((x) => x.json());
      if (r.error) { setErreur(tc("error", { message: r.error })); return false; }
      setSim(r);
      return true;
    } finally {
      setBusy(false);
    }
  }, [grain, flowTime, crema, taste, tc]);

  /**
   * **Une vraie préparation, depuis un questionnaire.** C'est le geste le plus engageant de ce
   * dialogue, donc il passe par la garde partagée comme partout ailleurs. La commande est celle de
   * l'accueil — `dispense` d'un espresso (boisson 1) sur le profil actif — et rien n'est attendu en
   * retour ici : la nouvelle mesure arrivera par le flux, quand la machine aura fini de couler.
   */
  const preparer = () => {
    demander({
      question: t("refineBrewConfirm"),
      /* `warn` et non `detail` : c'est la conséquence physique, et ce dépôt lui donne sa propre
         place plutôt que la fin d'une phrase. `geste: "dispense"` parce que c'est exactement le
         même geste qu'ailleurs — préparer une boisson — et qu'il doit hériter du même réglage
         « ne plus me demander » ; en inventer un autre ici ferait redemander pour le même acte. */
      warn: t("refineBrewWarn"),
      geste: "dispense",
      onConfirm: async () => {
        setBusy(true);
        setErreur(null);
        try {
          const r = await mfetch("/api/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "dispense", beverageId: 1, profileId }),
          }).then((x) => x.json());
          if (r.error) setErreur(tc("error", { message: r.error }));
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const suivant = async () => {
    /* Le passage de la dernière question au résultat DÉCLENCHE le calcul : un « Calculer » séparé
       ferait une étape de plus dont la seule fonction serait d'être cliquée. Si le calcul échoue,
       on reste sur place — avancer vers un résultat vide serait annoncer une réponse qui n'existe
       pas. */
    if (etape === 2) {
      if (await calculer()) setEtape(3);
      return;
    }
    setEtape((n) => Math.min(ETAPES - 1, n + 1));
  };

  const appliquer = () => {
    if (!sim) return;
    onAppliquer({ grinder: sim.grinder, temperature: sim.temperature, aroma: sim.aroma });
    onFermer();
  };

  if (!grain) return null;
  const nom = grain.name ?? t("unnamed");
  const verrouille = mesure?.permis === false;

  return (
    <Dialog open={ouvert} onOpenChange={(o) => { if (!o) onFermer(); }}>
      <DialogContent className="max-w-[34rem]">
        <DialogHeader>
          <DialogTitle>{t("refineHeading", { name: nom })}</DialogTitle>
          <DialogDescription>{t("refineStep", { n: etape + 1, total: ETAPES })}</DialogDescription>
        </DialogHeader>

        {/* La barre est décorative : le compte est déjà dit en toutes lettres juste au-dessus, et
            l'annoncer deux fois ferait lire « étape 2 sur 4 » puis « 50 % » pour la même chose. */}
        <Progress value={((etape + 1) / ETAPES) * 100} aria-hidden="true" />

        <div className="blocSuite" aria-live="polite">
          {/* ── 0 · LA MESURE ──────────────────────────────────────────────────────────────── */}
          {etape === 0 && (
            <>
              <h3 tabIndex={-1} ref={titreEtape}>{t("refineStepMeasure")}</h3>
              {Number.isInteger(mesure?.ecoulementS) ? (
                <p className="sub">{t("flowMeasured", { s: mesure!.ecoulementS!, ms: mesure!.ecoulementMs! })}</p>
              ) : (
                <p className="warn">{t("refineNoMeasure")}</p>
              )}
              {Number.isInteger(mesure?.espressos) && (
                <p className="sub">{t("refineCounter", { espressos: mesure!.espressos!, seuil: mesure!.seuil })}</p>
              )}
              {verrouille && <p className="warn">{t("refineTooFew", { espressos: mesure?.espressos ?? 0, seuil: mesure?.seuil ?? 5 })}</p>}

              {/* L'écoulement reste modifiable ici, et seulement ici : c'est l'étape qui parle de
                  lui. Essayer « et si c'était 15 s ? » est un usage légitime d'une page de mise au
                  point, mais ça ne doit pas avoir l'air d'être la voie normale. */}
              <div className="row">
                <div>
                  <label htmlFor="ft">{t("flowTime")}</label>
                  <Input id="ft" className="w-[4.6rem] flex-none text-right" type="number" min={0} max={120}
                    value={flowTime} onChange={(e) => setFlowTime(Number(e.target.value))} />
                </div>
                {Number.isInteger(mesure?.ecoulementS) && flowTime !== mesure!.ecoulementS && (
                  <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy}
                    onClick={() => setFlowTime(mesure!.ecoulementS!)}>
                    <Icone nom="lire" taille={14} />
                    <span className="lbl">{t("flowMeasuredReuse")}</span>
                  </Button>
                )}
              </div>

              <p className="legende">{t("refineBrewHint")}</p>
              <div className="row note">
                <Button type="button" variant="marche" size="commande" className="iconBtn" disabled={busy} onClick={preparer}>
                  <Icone nom="preparer" />
                  <span className="lbl">{t("refineBrew")}</span>
                </Button>
              </div>
            </>
          )}

          {/* ── 1 · LA CREMA ───────────────────────────────────────────────────────────────── */}
          {etape === 1 && (
            <>
              <h3 tabIndex={-1} ref={titreEtape}>{t("crema")}</h3>
              {/* **Trois choix montrés côte à côte, plus une liste déroulante.** Ce sont les visuels
                  de l'app officielle (`question_1`), et le point d'une question sur la crema est
                  justement de COMPARER : une liste fermée n'en montre qu'un à la fois.
                  Écrits à la main, pas en boucle — `verif-messages.mjs` ne voit que les clés
                  littérales, et un `t(`crema${n}`)` lui échapperait. */}
              <ChoixVisuel nom="crema" valeur={crema} onChange={setCrema} options={[
                { v: 1, libelle: t("crema1"), image: <ImageCrema niveau={1} className="h-12 w-auto" /> },
                { v: 2, libelle: t("crema2"), image: <ImageCrema niveau={2} className="h-12 w-auto" /> },
                { v: 3, libelle: t("crema3"), image: <ImageCrema niveau={3} className="h-12 w-auto" /> },
              ]} />
            </>
          )}

          {/* ── 2 · LE GOÛT ────────────────────────────────────────────────────────────────── */}
          {etape === 2 && (
            <>
              <h3 tabIndex={-1} ref={titreEtape}>{t("taste")}</h3>
              <ChoixVisuel nom="taste" valeur={taste} onChange={setTaste} options={[
                { v: 1, libelle: t("taste1") },
                { v: 2, libelle: t("taste2") },
                { v: 3, libelle: t("taste3") },
              ]} />
              {/* La règle du barista, dite AU MOMENT où elle s'applique : hors fenêtre, la réponse
                  qu'on est en train de donner sera ignorée, et le taire ferait passer le résultat
                  pour une erreur de calcul. */}
              <p className="legende">{flowTime >= 10 && flowTime < 20 ? t("windowOk") : t("windowOut")}</p>
            </>
          )}

          {/* ── 3 · LE RÉSULTAT ────────────────────────────────────────────────────────────── */}
          {etape === 3 && sim && (
            <>
              <h3 tabIndex={-1} ref={titreEtape}>{t("refineStepResult")}</h3>
              <div className="tableWrap">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("setting")}</TableHead>
                      <TableHead>{t("current")}</TableHead>
                      <TableHead>{t("delta")}</TableHead>
                      <TableHead>{t("proposed")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>{t("grinder")}</TableCell>
                      <TableCell className="num">{grain.grinder}</TableCell>
                      <TableCell className="num">{fmtDelta(sim.deltas.grinder)}</TableCell>
                      <TableCell className="num">{sim.grinder}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>{t("temperature")}</TableCell>
                      <TableCell className="num">{grain.temperature}</TableCell>
                      <TableCell className="num">{fmtDelta(sim.deltas.temperature)}</TableCell>
                      <TableCell className="num">{sim.temperature}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>{t("aroma")}</TableCell>
                      <TableCell className="num">{grain.aroma}</TableCell>
                      <TableCell className="num">{fmtDelta(sim.deltas.aroma)}</TableCell>
                      <TableCell className="num">{sim.aroma}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              {sim.notes.map((n) => (
                <p className="legende" key={n}>{t.has(`note_${n}`) ? t(`note_${n}`) : n}</p>
              ))}
              {/* **Ce bouton n'écrit rien dans la machine**, et le dire ici évite la confusion que
                  sa place — dernière étape, variante « marche » — pourrait installer. L'écriture
                  reste au dos de la carte, derrière sa propre confirmation. */}
              <p className="legende">{t("refineApplyHint")}</p>
            </>
          )}

          {erreur && <p className="status err" role="status">{erreur}</p>}
        </div>

        {/* `data-nav` nomme les deux commandes du parcours. Ce n'est pas une commodité de test :
            `DialogContent` rend sa croix de fermeture APRÈS ses enfants, donc « le dernier bouton
            du dialogue » désigne la croix, pas « Suivant ». Un repère positionnel se serait
            trompé de bouton en silence — et c'est exactement ce qui est arrivé. */}
        <DialogFooter>
          <Button type="button" data-nav="retour" variant="neutre" disabled={etape === 0 || busy} onClick={() => setEtape((n) => Math.max(0, n - 1))}>
            {t("refineBack")}
          </Button>
          {etape < ETAPES - 1 ? (
            <Button type="button" data-nav="suivant" variant="marche" disabled={busy} onClick={suivant}>
              {etape === 2 ? t("simulate") : t("refineNext")}
            </Button>
          ) : (
            <Button type="button" data-nav="appliquer" variant="marche" disabled={busy || !sim?.changed} onClick={appliquer}>
              {sim?.changed ? t("applyToDraft") : t("nothingToChange")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Un choix parmi trois, montré en entier.
 *
 * ⚠️ **C'est un `radiogroup` écrit à la main, et il doit l'être en entier.** Des `<button>` posés
 * côte à côte n'annoncent ni le groupe, ni le nombre d'options, ni celle qui est choisie — ils se
 * lisent « bouton, bouton, bouton ». Le rôle, `aria-checked` et le nom du groupe sont donc portés
 * explicitement, et la navigation aux flèches est écrite : dans un groupe de boutons radio, seul
 * l'élément coché est dans l'ordre de tabulation (`tabIndex` roving), et les flèches déplacent le
 * choix. C'est ce que `<input type="radio">` donnait gratuitement, et ce qu'il faut redemander
 * dès qu'on veut une image dans l'étiquette.
 */
function ChoixVisuel({
  nom, valeur, onChange, options,
}: {
  nom: string;
  valeur: number;
  onChange: (v: number) => void;
  options: { v: number; libelle: string; image?: React.ReactNode }[];
}) {
  const t = useTranslations("beanAdapt");
  const clavier = (e: React.KeyboardEvent) => {
    const i = options.findIndex((o) => o.v === valeur);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); onChange(options[(i + 1) % options.length].v); }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); onChange(options[(i - 1 + options.length) % options.length].v); }
  };
  return (
    <div className="row" role="radiogroup" aria-label={t(nom === "crema" ? "crema" : "taste")} onKeyDown={clavier}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={valeur === o.v}
          tabIndex={valeur === o.v ? 0 : -1}
          data-choix={`${nom}-${o.v}`}
          /* ⚠️ **La matière est portée ici, en utilitaires, et ce n'est pas un raccourci.** Une
             classe dans `surfaces.css` perdrait deux fois en silence : `button:not([data-slot])`
             y est (0,1,1) et battrait `.choixVisuel` (0,1,0) sur le rembourrage, et la règle
             `button { font: inherit; line-height: 1.2 }` de la couche `facade` bat n'importe
             quelle spécificité de `surfaces` sur la taille du texte. `utilities` gagne sur les
             deux — c'est la loi énoncée dans CLAUDE.md, et elle a déjà coûté trois blocs. */
          className={cn(
            "flex flex-1 flex-col items-center gap-2 rounded-[var(--radius)] border p-3 text-center text-sm leading-tight",
            "cursor-pointer transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            /* **Ambre, et pas vert.** La loi des trois couleurs de ce produit : l'ambre dit
               « choisi », le vert dit « ça démarre sur l'appareil ». Cocher une réponse à un
               questionnaire ne démarre rien — c'est la même teinte que la variante `choisi`. */
            valeur === o.v
              ? "border-ambre bg-ambre-verre text-ambre"
              : "border-border bg-card text-encre-douce hover:border-encre/40",
          )}
          onClick={() => onChange(o.v)}
        >
          {o.image}
          <span>{o.libelle}</span>
        </button>
      ))}
    </div>
  );
}
