"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";
import { mfetch } from "../machine";
import { useConfirm } from "../confirm";
import Icone from "../icons";
import RecipeEditor from "../RecipeEditor";
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
            <select id="rbev" value={draft.beverageId} onChange={(e) => pickBeverage(Number(e.target.value))}>
              {beverages.map((b) => (
                <option key={b.id} value={b.id}>
                  {bevLabel(b)} ({b.id})
                </option>
              ))}
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
          <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("beverage")}</th>
                <th>{t("profile")}</th>
                <th>{t("colParam")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{(() => { const b = beverages.find((x) => x.id === r.beverageId); return b ? bevLabel(b) : r.beverageId; })()}</td>
                  <td>{r.profileId}</td>
                  <td>{describe(r, beverages, paramLabel, unitLabel)}</td>
                  <td className="row">
                    <button className="iconBtn" onClick={() => setDraft(structuredClone(r))}>
                      <Icone nom="modifier" taille={15} />
                      <span className="lbl">{tc("edit")}</span>
                    </button>
                    <button className="danger discret iconBtn" onClick={() => del(r.id, r.name)}>
                      <Icone nom="corbeille" taille={15} />
                      <span className="lbl">{tc("delete")}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
      {dialogue}
    </>
  );
}

const clamp = (v: number, min: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min);

function describe(
  r: Recipe,
  beverages: Beverage[],
  paramLabel: (p: { name?: string; label?: string; id?: number }) => string,
  unitLabel: (u: string) => string,
): string {
  const bev = beverages.find((b) => b.id === r.beverageId);
  return r.params
    .map((p) => {
      const info = bev?.bounds?.params.find((x) => x.id === p.id);
      return info ? `${paramLabel(info)} ${p.value}${info.unit ? " " + unitLabel(info.unit) : ""}` : `#${p.id}=${p.value}`;
    })
    .join(" · ");
}
