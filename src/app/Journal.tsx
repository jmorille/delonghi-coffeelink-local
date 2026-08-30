"use client";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Icone from "./icons";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import type { LigneJournal } from "./events";
import { argumentsTrame, hexCmd, octetsDeB64, opTrame } from "@/lib/ecam-args.mjs";

/**
 * **Le journal, en données structurées plutôt qu'en sortie de terminal.**
 *
 * Ce que ce bloc remplace : une ligne était une phrase française avec les octets noyés dedans
 * (`data_response: d0 12 75 0f 04 …`), rendue en chasse fixe dans un cadre de 260 px qui défile.
 * Trois défauts qui tenaient au même choix. Rien ne s'alignait, donc rien ne se parcourait du
 * regard. Les octets étaient présents mais illisibles et jamais décodés. Et le `Ctrl+F` du
 * navigateur, seul filtre disponible, ne servait à rien puisque le bloc se réécrit entièrement à
 * chaque évènement poussé.
 *
 * Donc : quatre colonnes fixes — heure, direction, sujet, résumé — plus le compteur de
 * répétitions cadré à droite. Le sujet est frappé par `L()` côté serveur, jamais déduit ici en
 * coupant au premier « : » : une convention devinée au rendu laisse une colonne vide sur le
 * premier message qui ne la suit pas, en silence. Les octets, eux, quittent la ligne et vivent
 * dans le tiroir.
 *
 * ⚠️ **Le décodage a lieu ICI, à l'ouverture du tiroir, et pas au serveur.** `ecam-args.mjs` est
 * pur et déjà importé par des composants client (`trame-boisson.mjs` dans `BeverageCard`) ; la
 * ligne ne transporte que la valeur base64 telle qu'elle a circulé. Décoder 400 lignes à chaque
 * poussée reviendrait à payer le tiroir sur les 399 qu'on n'ouvre pas — et surtout, le décodeur
 * reste unique : c'est la même table que celle que `server.mjs` lit pour construire les trames.
 *
 * ⚠️ **Les libellés de boisson et de réglage sont volontairement génériques dans le tiroir.**
 * `argumentsTrame` sait les nommer si on lui fournit le catalogue du modèle ; `/pilotage` ne le
 * charge pas, et l'y traîner pour habiller un tiroir coûterait plus que ce que ça rend. La
 * colonne « résumé » porte déjà le nom que le serveur, lui, connaît. Ce que le tiroir apporte,
 * c'est ce que le serveur n'écrit nulle part : les octets, leurs offsets, et l'opération.
 */

type Dir = LigneJournal["dir"];

/**
 * « Tous » a besoin d'une VALEUR : Radix réserve la chaîne vide pour « rien de sélectionné », et un
 * `SelectItem value=""` lève. Le sentinelle ne sort jamais du composant — il est retraduit en
 * chaîne vide dès `onValueChange`.
 */
const TOUS = "__tous__";

/**
 * ⚠️ **La taille et l'interligne d'une ligne sont des UTILITAIRES, pas une regle de `surfaces.css`.**
 *
 * `globals.css` pose `font: inherit; line-height: 1.2` sur tout `<button>` — dans la couche
 * `facade`, qui bat `surfaces` **quelle que soit la specificite**. Une ligne a trame est un
 * `<button>`, sa voisine sans trame un `<div>` : la premiere sortait donc en 16 px / 1,2 et la
 * seconde en 12 px / 1,35, dans la meme colonne, sans que rien ne leve. C'est la loi enoncee dans
 * `CLAUDE.md` — quand une couche superieure reprend la matiere, on la deplace sur le composant.
 * `utilities` est au-dessus de `facade`, donc ces deux classes gagnent, sur les deux faces.
 */
const CORPS_LIGNE = "text-legende leading-[1.35]";

/** Le glyphe de chaque direction. Voir `entrant` / `sortant` / `systeme` dans `icons.tsx`. */
const GLYPHE = { in: "entrant", out: "sortant", sys: "systeme" } as const;

function hex2(n: number) {
  return n.toString(16).padStart(2, "0");
}

/**
 * Le tiroir : les octets, leur lecture, et le contexte de la ligne.
 *
 * Monté **paresseusement** — il n'existe dans le DOM que déplié. Une grille de 400 lignes
 * porterait sinon 400 tiroirs fermés, chacun avec sa grille d'octets, pour n'en montrer qu'un.
 */
function Tiroir({ ligne, id }: { ligne: LigneJournal; id: string }) {
  const t = useTranslations("journal");
  // Les octets tels quels — aucun retrait, aucune interprétation, et pas de `Buffer` : ce
  // module s'exécute dans le navigateur. Voir `octetsDeB64` dans `ecam-args.mjs`.
  const octets = useMemo(() => [...octetsDeB64(String(ligne.trame ?? "").replace(/\s+/g, ""))], [ligne.trame]);
  const lu = useMemo(() => {
    try {
      const { cmd, op, trame, nonTrame } = opTrame(ligne.trame);
      if (nonTrame) return { nonTrame: true as const };
      let args: string | null = null;
      try {
        args = argumentsTrame(trame, {
          boisson: (b: number) => `boisson ${b}`,
          reglage: (a: number) => `réglage ${a}`,
          params: {},
        });
      } catch {
        /* un argument douteux ne doit pas emporter l'opération, qui est sûre */
      }
      return { nonTrame: false as const, cmd, op, args, utiles: trame.length };
    } catch {
      return null;
    }
  }, [ligne.trame]);

  // Les 4 derniers octets d'une trame sont l'horodatage ajouté à l'émission : ils sont montrés,
  // mais estompés. Les cacher ferait mentir la longueur ; les banaliser ferait chercher un
  // argument là où il n'y en a pas.
  const utiles = lu && !lu.nonTrame ? lu.utiles : octets.length;
  const rangs: number[][] = [];
  for (let i = 0; i < octets.length; i += 8) rangs.push(octets.slice(i, i + 8));

  return (
    <div className="journalTiroir" id={id} role="region">
      <div className="journalOctets">
        <p className="etiquetteGroupe">{t("octets")}</p>
        <div className="journalHexa">
          {rangs.map((rang, r) => (
            <div key={r} className="journalHexaRang">
              <span className="journalOffset">{hex2(r * 8)}</span>
              {rang.map((o, i) => (
                <span key={i} className={r * 8 + i >= utiles ? "journalOctetSuffixe" : undefined}>{hex2(o)}</span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="journalLecture">
        <p className="etiquetteGroupe">{t("lecture")}</p>
        {!lu ? (
          <p className="sub">{t("illisible")}</p>
        ) : lu.nonTrame ? (
          <p className="sub">{t("nonTrame")}</p>
        ) : (
          <dl className="kv">
            <dt className="k">{t("operation")}</dt>
            <dd>{lu.op ? `${lu.op.nature} · ${lu.op.nom}` : t("nonIdentifiee")}</dd>
            <dt className="k">{t("commande")}</dt>
            <dd className="mono">{hexCmd(lu.cmd)}</dd>
            {lu.args ? (
              <>
                <dt className="k">{t("arguments")}</dt>
                <dd>{lu.args}</dd>
              </>
            ) : null}
          </dl>
        )}
      </div>

      <div className="journalContexte">
        <p className="etiquetteGroupe">{t("contexte")}</p>
        <dl className="kv">
          <dt className="k">{t("horodatage")}</dt>
          <dd className="mono">{new Date(ligne.t).toLocaleTimeString(undefined, { hour12: false })}.{String(ligne.t % 1000).padStart(3, "0")}</dd>
          {ligne.m ? (
            <>
              <dt className="k">{t("machine")}</dt>
              <dd className="mono">{ligne.m}</dd>
            </>
          ) : null}
          {ligne.app ? (
            <>
              <dt className="k">{t("application")}</dt>
              <dd className="mono">{ligne.app}</dd>
            </>
          ) : null}
          <dt className="k">{t("ligne")}</dt>
          <dd className="mono">{ligne.id}</dd>
          {ligne.repetitions > 1 ? (
            <>
              <dt className="k">{t("repetitions")}</dt>
              <dd className="mono">{ligne.repetitions}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  );
}

export default function Journal({
  lignes,
  source,
  multiMachine = false,
}: {
  lignes: LigneJournal[];
  source: LigneJournal["source"];
  multiMachine?: boolean;
}) {
  const t = useTranslations("journal");
  /* Les deux blocs coexistent dans la même page : un `id` fixe en ferait deux, et un `htmlFor`
     pointerait alors sur le champ de l'autre journal. */
  const cle = `journal-${source}`;
  const [dirs, setDirs] = useState<Dir[]>([]);
  const [sujet, setSujet] = useState("");
  const [q, setQ] = useState("");
  const [ouvert, setOuvert] = useState<number | null>(null);

  const miennes = useMemo(() => lignes.filter((l) => l.source === source), [lignes, source]);

  /**
   * Les sujets réellement présents, pas une liste écrite d'avance. Un sujet est frappé par un
   * appel à `L()` : en énumérer une liste figée ici la ferait diverger au premier ajout, et
   * proposer un filtre qui ne rend jamais rien est pire que ne pas le proposer.
   */
  const sujets = useMemo(
    () => [...new Set(miennes.map((l) => l.sujet))].sort((a, b) => a.localeCompare(b, "fr")),
    [miennes],
  );

  const vues = useMemo(() => {
    const cherche = q.trim().toLocaleLowerCase("fr");
    return miennes.filter((l) => {
      if (dirs.length && !dirs.includes(l.dir)) return false;
      if (sujet && l.sujet !== sujet) return false;
      if (cherche && !`${l.sujet} ${l.resume}`.toLocaleLowerCase("fr").includes(cherche)) return false;
      return true;
    });
  }, [miennes, dirs, sujet, q]);

  const filtre = dirs.length > 0 || sujet !== "" || q.trim() !== "";
  const bascule = (d: Dir) => setDirs((v) => (v.includes(d) ? v.filter((x) => x !== d) : [...v, d]));

  return (
    <div className="journal">
      {/* La barre est HORS de la zone qui défile : un filtre qui disparaît quand on descend dans
          ses propres résultats ne se rappelle qu'en remontant.

          Et elle n'existe pas au-dessus d'un journal VIDE : trois bascules, un sélecteur et un
          champ pour filtrer rien, c'est promettre un tri sur une matière absente. Le test porte sur
          les lignes reçues, jamais sur les lignes filtrées — sinon un filtre trop serré ferait
          disparaître le moyen de le desserrer. */}
      {miennes.length > 0 && (
      <div className="journalFiltres" role="group" aria-label={t("filtres")}>
        <div className="journalDirs">
          {/* Trois appels littéraux plutôt qu'une boucle sur `t(`dir.${d}`)` : `verif-messages.mjs`
              ne voit que les clés écrites sur place, et c'est ce trou-là qui l'a fait naître. */}
          <button type="button" className="journalDir" data-dir="in" aria-pressed={dirs.includes("in")} onClick={() => bascule("in")}>
            <Icone nom="entrant" taille={14} />
            {t("dirIn")}
          </button>
          <button type="button" className="journalDir" data-dir="out" aria-pressed={dirs.includes("out")} onClick={() => bascule("out")}>
            <Icone nom="sortant" taille={14} />
            {t("dirOut")}
          </button>
          <button type="button" className="journalDir" data-dir="sys" aria-pressed={dirs.includes("sys")} onClick={() => bascule("sys")}>
            <Icone nom="systeme" taille={14} />
            {t("dirSys")}
          </button>
        </div>

        {/* ⚠️ **Les primitives, pas les balises nues.** Un `<select>` et un `<input>` bruts
            n'héritent de RIEN ici : le dépôt habille ses champs par les emplacements shadcn
            (`[data-slot]`), donc les deux sortaient sans fond, sans bordure et hauts de 44 px —
            du texte flottant au-dessus de la carte. C'est la même règle que la migration de 2026-08 :
            shadcn est la cible de toute surface, `<select>` compris.

            Le sujet est un `<Select>` Radix, donc un bouton : un `<label>` ne nomme pas un bouton.
            L'intitulé porte un `id` et le déclencheur le vise par `aria-labelledby`. */}
        <div className="journalChamp">
          <span id={`${cle}-sujet`}>{t("sujet")}</span>
          <Select value={sujet || TOUS} onValueChange={(v) => setSujet(v === TOUS ? "" : v)}>
            <SelectTrigger aria-labelledby={`${cle}-sujet`} className="h-auto min-h-8 tactile:min-h-10 w-40 bg-creux px-2 py-1 text-petit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOUS}>{t("sujetTous")}</SelectItem>
              {sujets.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <label className="journalChamp journalRecherche" htmlFor={`${cle}-q`}>
          <span>{t("recherche")}</span>
          <Input
            id={`${cle}-q`}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("recherchePlaceholder")}
            className="h-auto min-h-8 tactile:min-h-10 bg-creux px-2 py-1 text-petit"
          />
        </label>

        {/* Le compte est ce qui empêche un filtre trop serré de se lire comme une machine muette. */}
        <p className="journalCompte" aria-live="polite">
          {filtre ? t("compteFiltre", { n: vues.length, total: miennes.length }) : t("compte", { total: miennes.length })}
        </p>
      </div>
      )}

      <div className="journalGrille">
        {/* Décoratif : chaque ligne porte déjà son heure, sa direction et son sujet en toutes
            lettres dans son propre texte. Annoncer en plus quatre en-têtes ferait répéter la
            grille à chaque ligne pour rien. */}
        {miennes.length > 0 && (
        <div className="journalEntete" aria-hidden="true">
          <span>{t("colHeure")}</span>
          <span>{t("colDir")}</span>
          <span>{t("colSujet")}</span>
          <span>{t("colResume")}</span>
          <span />
        </div>
        )}

        {vues.length === 0 ? (
          <p className="sub journalVide">{filtre ? t("aucunResultat") : t("vide")}</p>
        ) : (
          <ul className="journalLignes">
            {vues.map((l) => {
              const deplie = ouvert === l.id;
              const idTiroir = `journal-${l.id}`;
              const corps = (
                <>
                  <span className="journalHeure">{new Date(l.t).toLocaleTimeString(undefined, { hour12: false })}</span>
                  <span className="journalDirCell" data-dir={l.dir}>
                    <Icone nom={GLYPHE[l.dir]} taille={14} />
                    <span className="sr-only">
                      {l.dir === "in" ? t("dirIn") : l.dir === "out" ? t("dirOut") : t("dirSys")}
                    </span>
                  </span>
                  <span className="journalSujet" title={l.sujet}>
                    {multiMachine && l.m ? <span className="journalMachine">{l.m}</span> : null}
                    {l.app ? <span className="journalMachine">{l.app}</span> : null}
                    {l.sujet}
                  </span>
                  <span className="journalResume">{l.resume}</span>
                  <span className="journalFin">
                    {l.repetitions > 1 ? <span className="journalRepet">{t("fois", { n: l.repetitions })}</span> : null}
                    {l.trame ? <span className="journalChevron" data-ouvert={deplie ? "" : undefined}><Icone nom="chevron" taille={14} /></span> : null}
                  </span>
                </>
              );
              return (
                <li key={l.id} className="journalLigne" data-dir={l.dir} data-ouvert={deplie ? "" : undefined}>
                  {l.trame ? (
                    <button
                      type="button"
                      className={`journalBascule ${CORPS_LIGNE}`}
                      aria-expanded={deplie}
                      aria-controls={idTiroir}
                      // Un seul tiroir ouvert à la fois : deux tiroirs dans un cadre de 260 px ne
                      // laissent plus rien à lire autour de celui qu'on regarde.
                      onClick={() => setOuvert(deplie ? null : l.id)}
                    >
                      {corps}
                    </button>
                  ) : (
                    <div className={`journalBascule journalFige ${CORPS_LIGNE}`}>{corps}</div>
                  )}
                  {deplie && l.trame ? <Tiroir ligne={l} id={idTiroir} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
