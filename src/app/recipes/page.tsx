"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";
import { mfetch } from "../machine";
import { useConfirm } from "../confirm";
import Icone from "../icons";
import RecipeEditor from "../RecipeEditor";
import { VignetteBoisson } from "../BeverageImage";
import type { Beverage, RecipeParam } from "../beverage";

/**
 * Bibliothèque de recettes locales, **avec l'éditeur du produit et pas un second**.
 *
 * Cette page tenait sa propre édition : un tableau Paramètre / Min / Max / Défaut machine /
 * Profil / Valeur, des curseurs nus, et trois boutons. Même geste que sur `/`, même trame `0x83`,
 * deux interfaces — et celle-ci n'avait ni les interrupteurs pour les paramètres booléens, ni les
 * ingrédients à cocher d'un emplacement perso, ni le retour aux défauts du modèle, ni le pli des
 * réglages avancés. Ce qui s'y corrigeait n'atteignait qu'une page sur deux, et un utilisateur
 * qui avait appris l'une devait réapprendre l'autre.
 *
 * Ne reste ici que ce qui lui appartient vraiment : **choisir** la boisson et le profil, nommer la
 * recette, l'enregistrer localement, la rouvrir, la supprimer. Les valeurs sont l'affaire de
 * `RecipeEditor`.
 *
 * Deux boutons ont disparu sans rien perdre : « Reprendre du profil » est le « ↺ réinitialiser »
 * de l'éditeur, et « ⟲ valeurs par défaut » lui ajoute les défauts du modèle, que cette page
 * n'offrait pas. Le refus « hors bornes » aussi : l'éditeur borne chaque champ à la saisie, une
 * valeur hors bornes n'y est plus atteignable.
 */

interface Param {
  id: number;
  value: number;
}
interface Recipe {
  id: string;
  name: string;
  beverageId: number;
  profileId: number;
  params: Param[];
  updatedAt?: number;
}

/**
 * Le brouillon avant que le catalogue soit là. `beverageId: 1` n'est qu'un point de départ
 * provisoire : dès que le catalogue arrive, `poserDefaut` le remplace par un emplacement perso,
 * qui est le seul endroit où une recette se COMPOSE.
 */
const empty = (): Recipe => ({ id: "", name: "", beverageId: 1, profileId: 1, params: [] });

export default function Recipes() {
  const t = useTranslations("recipes");
  const tc = useTranslations("common");
  const bevLabel = useBeverageLabel();
  const paramLabel = useParamLabel();
  const unitLabel = useUnitLabel();
  const [list, setList] = useState<Recipe[]>([]);
  const [beverages, setBeverages] = useState<Beverage[]>([]);
  const [draft, setDraft] = useState<Recipe>(empty());
  /**
   * Compte rendu et refus de validation.
   *
   * C'était un `<span className="sub">` posé au bout de la rangée de boutons : un refus qui
   * empêche l'écriture s'affichait en petit texte gris, du même poids qu'une légende, et n'était
   * annoncé à personne.
   */
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const dire = (text: string) => setMsg({ text, kind: "ok" });
  const refuser = (text: string) => setMsg({ text, kind: "err" });
  const { demander, dialogue } = useConfirm();

  const load = useCallback(
    () => mfetch("/api/recipes").then((r) => r.json()).then((d) => setList(d.recipes)),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Les bornes sont communes aux profils, mais les VALEURS enregistrées sont propres à chacun :
  // on recharge donc le catalogue quand le profil du brouillon change.
  useEffect(() => {
    // ⚠️ `mfetch`, JAMAIS `fetch` nu : un appel nu vise la machine PAR DÉFAUT, pas celle qui est
    // sélectionnée. Ici le prix n'était pas cosmétique — cette page lisait le catalogue, les
    // bornes et les valeurs de profil d'une machine, puis écrivait sur une autre, puisque
    // « Écrire dans le profil » passe, lui, par `mfetch`.
    mfetch(`/api/beverages?profile=${draft.profileId}`)
      .then((r) => r.json())
      .then((d) => setBeverages(d.beverages ?? []))
      .catch(() => {});
  }, [draft.profileId]);

  const bev = beverages.find((b) => b.id === draft.beverageId) ?? null;
  const persos = beverages.filter((b) => b.customSlot !== null);
  const catalogue = beverages.filter((b) => b.customSlot === null);

  /**
   * **La page s'ouvre sur un emplacement perso, pas sur « Espresso ».**
   *
   * Elle démarrait sur la boisson 1 — une boisson du catalogue, donc celle où il n'y a
   * précisément rien à composer : ses ingrédients sont fixés par le modèle, les cases à cocher
   * n'y existent pas. Sur une page dont le geste est « créer une recette », c'était le seul
   * point de départ qui ne mène nulle part.
   *
   * Une seule fois, à l'arrivée du catalogue : `poseDefaut` est une réf et non un état pour que
   * le rechargement déclenché par un changement de profil ne vienne pas écraser la boisson que
   * l'utilisateur vient de choisir.
   */
  const poseDefaut = useRef(false);
  useEffect(() => {
    if (poseDefaut.current || !beverages.length) return;
    poseDefaut.current = true;
    // Aucun emplacement perso sur ce modèle : on garde ce que le catalogue offre en premier
    // plutôt que d'insister sur un identifiant qui n'y est peut-être pas.
    const cible = persos[0] ?? beverages[0];
    setDraft((d) => (d.beverageId === cible.id ? d : { ...d, beverageId: cible.id, params: [] }));
  }, [beverages]);

  // En changeant de boisson, on repart de zéro : garder les valeurs de la précédente produirait
  // des réglages hors bornes, voire inapplicables. L'éditeur repart alors de ce que le profil a
  // enregistré sur la machine.
  const pickBeverage = (id: number) => setDraft({ ...draft, beverageId: id, params: [] });

  const save = async (params: RecipeParam[]) => {
    if (!draft.id || !draft.name) {
      refuser(t("idAndNameRequired"));
      return;
    }
    await mfetch("/api/recipes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft, params }),
    });
    dire(t("saved"));
    setDraft(empty());
    load();
  };

  /**
   * Écrit la recette DANS le profil sur la machine (0x83, mode DONTCARE, action SAVE_BEVERAGE).
   * C'est une modification persistante de l'appareil : elle remplace la recette enregistrée du
   * profil, exactement comme si on l'avait reprogrammée sur l'écran de la machine.
   *
   * **Part au clic, sans dialogue** — c'est le MÊME geste que « Écrire dans le profil » sur `/`,
   * même trame, même endpoint, et deux comportements pour un seul acte selon la page seraient
   * pires que l'un ou l'autre. L'avertissement vit dans l'infobulle du bouton de l'éditeur : ce
   * qu'on retire est l'interruption, pas le fait.
   */
  const ecrireDansProfil = async (params: RecipeParam[]) => {
    if (!bev) return;
    setMsg(null);
    const r = await mfetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "saveToProfile", beverageId: bev.id, profileId: draft.profileId, params }),
    }).then((x) => x.json());
    if (r.error) refuser(tc("error", { message: r.error }));
    else dire(t("writeSent", { checksum: r.checksumBefore != null ? "0x" + r.checksumBefore.toString(16) : tc("unknown") }));
  };

  /**
   * Supprimer une recette enregistrée. Elle est locale — la machine n'est pas touchée — mais elle
   * partait **sans aucune confirmation**, alors que `/beans` en demande une pour oublier une
   * configuration mémorisée, qui est exactement le même genre d'objet.
   */
  const del = (id: string, nom: string) =>
    demander({ question: t("deleteConfirm", { name: nom }), onConfirm: () => void supprimer(id) });

  const supprimer = async (id: string) => {
    await mfetch("/api/recipes?id=" + encodeURIComponent(id), { method: "DELETE" });
    load();
  };

  const editing = draft.id && list.some((r) => r.id === draft.id);

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro", { count: 5 })}</p>

      <h2>{editing ? t("edit") : t("create")}</h2>
      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="rid">{t("id")}</label>
            <input id="rid" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} placeholder="mon-espresso" />
          </div>
          <div>
            <label htmlFor="rname">{t("name")}</label>
            <input id="rname" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Mon espresso" />
          </div>
          <div>
            <label htmlFor="rbev">{t("beverage")}</label>
            {/* Les deux familles sont séparées, et les emplacements perso viennent EN PREMIER :
                ce sont les seuls où une recette se compose, donc ceux que cette page sert. Une
                liste à plat de 28 entrées ne disait pas que la différence existait. */}
            <select id="rbev" value={draft.beverageId} onChange={(e) => pickBeverage(Number(e.target.value))}>
              {persos.length > 0 && (
                <optgroup label={t("groupCustom")}>
                  {persos.map((b) => (
                    <option key={b.id} value={b.id}>
                      {bevLabel(b)} ({b.id})
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label={t("groupCatalog")}>
                {catalogue.map((b) => (
                  <option key={b.id} value={b.id}>
                    {bevLabel(b)} ({b.id})
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <div>
            <label htmlFor="rprof">{t("profile")}</label>
            <input id="rprof" type="number" min={1} max={5} value={draft.profileId} onChange={(e) => setDraft({ ...draft, profileId: clamp(Number(e.target.value), 1, 5) })} />
          </div>
        </div>

        {!bev ? (
          <p className="sub">{tc("loading")}</p>
        ) : (
          <>
            {/* Le titre nomme la boisson en cours d'édition : sans lui la page sautait du `h2` au
                `h4` de l'éditeur, et rien au-dessus des réglages ne disait à quoi ils
                s'appliquent une fois la liste déroulante refermée. */}
            <h3>{bevLabel(bev)}</h3>
            {/* Une boisson du catalogue n'a pas de cases à cocher, et le silence là-dessus se lit
                comme une panne. La phrase dit le fait — les ingrédients sont fixés par le modèle
                — et où aller pour en composer une. */}
            {bev.customSlot === null && persos.length > 0 && (
              <p className="sub">{t("catalogFixed", { beverage: bevLabel(bev) })}</p>
            )}
            <RecipeEditor
              /* Remonté à chaque changement de boisson, de profil ou de recette rouverte : son
                 état repart ainsi des bonnes valeurs sans logique de réinitialisation à écrire —
                 le même procédé que la carte de `/`, qui ne le monte qu'à l'ouverture. */
              key={`${bev.id}:${draft.profileId}:${draft.id}`}
              bev={bev}
              profile={draft.profileId}
              profileName={null}
              busy={false}
              working={false}
              initial={draft.params.length ? draft.params : null}
              /* Pas de « Préparer » ici : cette page enregistre des recettes, elle ne commande pas
                 l'appareil. */
              onWrite={(params) => void ecrireDansProfil(params)}
              actions={(params) => (
                <button className="primary iconBtn" onClick={() => void save(params)}>
                  <Icone nom="ecrire" />
                  <span className="lbl">{t("saveLocal")}</span>
                </button>
              )}
            />
          </>
        )}

        {draft.id && (
          <div className="row note">
            <button className="iconBtn" onClick={() => setDraft(empty())}>
              <Icone nom="ajouter" />
              <span className="lbl">{tc("new")}</span>
            </button>
          </div>
        )}
        {/* Permanent, jamais monté à la demande : un conteneur inséré en même temps que son texte
            n'est pas annoncé. Vide, `.status:empty` le masque. */}
        <p className={"status " + (msg?.kind === "err" ? "err" : "ok")} role="status">
          {msg?.text ?? ""}
        </p>
      </div>

      <h2>{t("savedListHeading")}</h2>
      <div className="card">
        {!list.length ? (
          <p className="sub">
            {t("emptyList")}
          </p>
        ) : (
          // Une carte par recette, comme les boissons de `/` et comme la bibliothèque de
          // `/beans` : ce sont trois fois le même objet — quelque chose qu'on a mis de côté et
          // qu'on reprendra. Le tableau qui était là listait « Nom · Boisson · Profil » puis
          // vidait tous les réglages dans une seule cellule, techniques compris
          // (« Programmable 1 · Visible 1 · Index de calibre 1 »), sans le dessin de la boisson
          // qu'on reconnaît d'un coup d'œil ailleurs.
          <div className="cards dense">
            {list.map((r) => {
              const b = beverages.find((x) => x.id === r.beverageId) ?? null;
              const { reglages, techniques } = detailler(r, b, paramLabel, unitLabel);
              return (
                <div className="card" key={r.id}>
                  <div className="cardHead">
                    {/* `.titreLigne` comme sur `/` : sans elle, la vignette devenait le premier
                        enfant de `.cardHead` et prenait son `flex: 1 1 12rem`, poussant le titre
                        au bord droit de la carte. Le dessin vient de la BOISSON, pas de la
                        recette — une recette locale n'a pas d'icône à elle sur la machine, elle
                        nomme une boisson qui en a une. */}
                    <div className="titreLigne">
                      {b && <VignetteBoisson id={b.id} icon={b.icon} />}
                      <h3 className="cardTitle">{r.name}</h3>
                    </div>
                  </div>
                  <p className="sub">
                    {t("cardFor", { beverage: b ? bevLabel(b) : String(r.beverageId), profile: r.profileId })}
                  </p>
                  <div className="chapeau">
                    {reglages.map((x) => (
                      <div className="kv" key={x.id}>
                        <span className="k">{x.nom}</span>
                        <span className="num">{x.valeur}</span>
                      </div>
                    ))}
                    {/* Les réglages techniques sont COMPTÉS, pas énumérés : même partage que le
                        pli « Réglages avancés » de l'éditeur, et la même règle — ils ne quittent
                        pas la trame, ils quittent l'aperçu. */}
                    {techniques > 0 && <p className="sub">{t("technicalCount", { count: techniques })}</p>}
                    {!reglages.length && !techniques && <p className="sub">{t("noSetting")}</p>}
                  </div>
                  <div className="row note">
                    <button className="mini iconBtn" onClick={() => setDraft(structuredClone(r))}>
                      <Icone nom="modifier" taille={14} />
                      <span className="lbl">{tc("edit")}</span>
                    </button>
                    <button className="mini danger iconBtn" onClick={() => del(r.id, r.name)}>
                      <Icone nom="corbeille" taille={14} />
                      <span className="lbl">{tc("delete")}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {dialogue}
    </>
  );
}

const clamp = (v: number, min: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min);

/**
 * Les réglages d'une recette enregistrée, séparés en deux.
 *
 * `describe` les concaténait tous dans une chaîne unique, techniques compris. Le partage
 * `user` / le reste est celui de l'éditeur — `kind` est notre propre regroupement, il décide
 * de l'APERÇU et jamais de ce qui part dans la trame.
 *
 * Une boisson inconnue (catalogue pas encore chargé, modèle changé) ne fait pas disparaître la
 * carte : le paramètre garde son numéro, ce qui reste lisible et vrai.
 */
function detailler(
  r: Recipe,
  bev: Beverage | null,
  paramLabel: (p: { name?: string; label?: string; id?: number }) => string,
  unitLabel: (u: string) => string,
): { reglages: { id: number; nom: string; valeur: string }[]; techniques: number } {
  const reglages: { id: number; nom: string; valeur: string }[] = [];
  let techniques = 0;
  for (const p of r.params) {
    const info = bev?.bounds?.params.find((x) => x.id === p.id) ?? null;
    if (info && info.kind !== "user") {
      techniques++;
      continue;
    }
    reglages.push({
      id: p.id,
      nom: info ? paramLabel(info) : "#" + p.id,
      valeur: info?.unit ? `${p.value} ${unitLabel(info.unit)}` : String(p.value),
    });
  }
  return { reglages, techniques };
}
