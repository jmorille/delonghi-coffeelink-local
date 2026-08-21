"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useBeverageLabel, useParamLabel, useUnitLabel } from "@/i18n/labels";
import { mfetch } from "../machine";
import { useConfirm } from "../confirm";
import Alerte from "../Alerte";

/**
 * Édition des recettes locales, **sous les contraintes du modèle**.
 *
 * Les bornes min/défaut/max (propriétés `d001_rec_espresso`…, trame `0xB0`) sont des
 * caractéristiques de la machine, partagées par les 5 profils : un profil ne peut que choisir
 * une valeur *dans* ces bornes. Cette page les affiche et les impose — elle ne redéfinit donc
 * plus sa propre table de boissons, elle lit le catalogue réel via `/api/beverages`.
 * (L'ancienne version avait sa propre liste, avec des identifiants faux : thé=16, cortado=18…)
 */

interface Bound {
  id: number;
  name: string;
  label: string;
  unit: string;
  kind: "user" | "meta" | "maint";
  min: number;
  def: number;
  max: number;
}
interface Beverage {
  id: number;
  label: string;
  factoryName: string;
  /** Identifiant stable du protocole : c'est lui qui sert de clé de traduction. */
  slug: string;
  /** Nom saisi sur la machine (« Mon latte », « Grain A ») — jamais traduit. */
  machineName: string | null;
  ingredients: number[];
  bounds: { params: Bound[]; exact: boolean } | null;
  boundsProp: string | null;
  /** Recette réellement enregistrée pour le profil demandé, si elle a été lue. */
  values: { params: { id: number; value: number }[] } | null;
  valuesProp: string | null;
}
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
   * C'était un `<span className="sub">` posé au bout de la rangée de boutons : « Corrigez les
   * valeurs hors bornes » — un refus qui empêche l'écriture — s'affichait en petit texte gris, du
   * même poids qu'une légende, et n'était annoncé à personne. Un refus de validation et une
   * confirmation d'écriture partageaient ce même traitement.
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
    fetch(`/api/beverages?profile=${draft.profileId}`)
      .then((r) => r.json())
      .then((d) => setBeverages(d.beverages ?? []))
      .catch(() => {});
  }, [draft.profileId]);

  const bev = beverages.find((b) => b.id === draft.beverageId) ?? null;

  /**
   * Paramètres réglables pour cette boisson : ceux que le modèle déclare (`ingredients`) et
   * dont on connaît les bornes. On écarte les métadonnées (visibilité, programmabilité…) et la
   * maintenance : ce ne sont pas des réglages de recette.
   */
  const editable = useMemo<Bound[]>(() => {
    if (!bev?.bounds) return [];
    return bev.ingredients
      .map((id) => bev.bounds!.params.find((p) => p.id === id))
      .filter((p): p is Bound => !!p && p.max > p.min);
  }, [bev]);

  /**
   * Paramètres imposés par le modèle (min == max) : non réglables, mais ils doivent figurer dans
   * la trame. C'est le cas de l'ordre lait/café d'un flat white, qui vaut toujours 1 et qui
   * détermine l'action PREPARE_BEVERAGE_INVERSION. Les omettre produirait une recette incomplète.
   */
  const fixedParams = useMemo<Bound[]>(() => {
    if (!bev?.bounds) return [];
    return bev.ingredients
      .map((id) => bev.bounds!.params.find((p) => p.id === id))
      .filter((p): p is Bound => !!p && p.max === p.min);
  }, [bev]);

  /** Ce qui part réellement à la machine : les réglages + les paramètres imposés. */
  const payload = (): Param[] => [...draft.params, ...fixedParams.map((b) => ({ id: b.id, value: b.def }))];

  // En changeant de boisson, on repart des valeurs par défaut de la machine : garder les
  // paramètres de la boisson précédente produirait des valeurs hors bornes, voire inapplicables.
  const pickBeverage = (id: number) => {
    const target = beverages.find((b) => b.id === id);
    const params =
      target?.bounds?.params
        .filter((p) => target.ingredients.includes(p.id) && p.max > p.min)
        .map((p) => ({ id: p.id, value: seedValue(target, p) })) ?? [];
    setDraft({ ...draft, beverageId: id, params });
  };

  // Le brouillon démarre vide (avant le chargement du catalogue on ne connaît pas les bornes) :
  // dès qu'on les a, on le pré-remplit aux défauts machine. Sans ça la page s'affichait avec des
  // curseurs positionnés mais un brouillon vide, donc l'écriture dans le profil était désactivée.
  useEffect(() => {
    if (!editable.length || draft.params.length) return;
    setDraft((d) => ({ ...d, params: editable.map((b) => ({ id: b.id, value: bev ? seedValue(bev, b) : b.def })) }));
  }, [editable, draft.params.length]);

  const valueOf = (id: number) => draft.params.find((p) => p.id === id)?.value;

  const setValue = (id: number, raw: number) => {
    const b = editable.find((p) => p.id === id);
    const value = b ? clamp(raw, b.min, b.max) : raw;
    const params = draft.params.some((p) => p.id === id)
      ? draft.params.map((p) => (p.id === id ? { ...p, value } : p))
      : [...draft.params, { id, value }];
    setDraft({ ...draft, params });
  };

  const outOfRange = editable.filter((b) => {
    const v = valueOf(b.id);
    return v !== undefined && (v < b.min || v > b.max);
  });

  const save = async () => {
    if (!draft.id || !draft.name) {
      refuser(t("idAndNameRequired"));
      return;
    }
    if (outOfRange.length) {
      refuser(t("outOfRange", { list: outOfRange.map((b) => paramLabel(b)).join(", ") }));
      return;
    }
    await mfetch("/api/recipes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    dire(t("saved"));
    setDraft(empty());
    load();
  };

  /** Valeur actuellement enregistrée sur la machine pour ce profil, si elle a été lue. */
  const machineValue = (id: number) => bev?.values?.params.find((p) => p.id === id)?.value;

  /** Recopie dans le brouillon ce que la machine a enregistré pour ce profil. */
  const loadFromMachine = () => {
    if (!bev?.values) return;
    const params = editable
      .map((b) => {
        const v = machineValue(b.id);
        return v === undefined ? null : { id: b.id, value: clamp(v, b.min, b.max) };
      })
      .filter((p): p is Param => !!p);
    if (!params.length) {
      refuser(t("nothingUsable"));
      return;
    }
    setDraft({ ...draft, params });
    dire(t("takenFromProfile", { count: params.length, profile: draft.profileId }));
  };

  /**
   * Écrit la recette DANS le profil sur la machine (0x83, mode DONTCARE, action SAVE_BEVERAGE).
   * C'est une modification persistante de l'appareil : elle remplace la recette enregistrée du
   * profil, exactement comme si on l'avait reprogrammée sur l'écran de la machine.
   */
  const writeToMachine = async () => {
    if (!bev || !draft.params.length) return;
    if (outOfRange.length) {
      refuser(t("fixOutOfRange"));
      return;
    }
    const detail = draft.params
      .map((p) => `${paramLabel(editable.find((b) => b.id === p.id) ?? { id: p.id })} = ${p.value}`)
      .join(`
`);
    // La question, les valeurs et la mise en garde étaient une seule chaîne, assemblée avec des
    // retours à la ligne parce que `window.confirm()` n'a qu'un champ. Le dialogue en a trois, et
    // c'est exactement ce que cette confirmation demandait : ce qu'on fait, sur quoi, et le prix.
    demander({
      question: t("writeToProfileConfirm", { beverage: bevLabel(bev), profile: draft.profileId }),
      detail,
      warn: t("writeToProfileWarning"),
      onConfirm: () => void ecrireDansProfil(),
    });
  };

  const ecrireDansProfil = async () => {
    if (!bev) return;
    setMsg(null);
    const r = await mfetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "saveToProfile", beverageId: bev.id, profileId: draft.profileId, params: payload() }),
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

        <h2>{t("paramsHeading")}</h2>
        {!bev ? (
          <p className="sub">{tc("loading")}</p>
        ) : !bev.bounds ? (
          <Alerte>{t("boundsMissing", { beverage: bevLabel(bev) })}</Alerte>
        ) : !editable.length ? (
          <p className="sub">
            {t("noParams")}
          </p>
        ) : (
          <>
            <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>{t("colParam")}</th>
                  <th>{t("colMin")}</th>
                  <th>{t("colMax")}</th>
                  <th>{t("colDefault")}</th>
                  <th>Profil {draft.profileId}</th>
                  <th>{t("colValue")}</th>
                </tr>
              </thead>
              <tbody>
                {editable.map((b) => {
                  const v = valueOf(b.id);
                  const bad = v !== undefined && (v < b.min || v > b.max);
                  return (
                    <tr key={b.id}>
                      <td>
                        {paramLabel(b)}
                        {b.unit ? ` (${unitLabel(b.unit)})` : ""}{" "}
                        <span className="sub mono">
                          {b.id}
                        </span>
                      </td>
                      <td className="num">{b.min}</td>
                      <td className="num">{b.max}</td>
                      <td className="num">{b.def}</td>
                      <td className="num">{machineValue(b.id) ?? <span className="sub">non lu</span>}</td>
                      <td>
                        <div className="ctl">
                          <input
                            type="range"
                            min={b.min}
                            max={b.max}
                            value={v ?? b.def}
                            aria-label={`${paramLabel(b)} (${b.min}–${b.max})`}
                            onChange={(e) => setValue(b.id, Number(e.target.value))}
                          />
                          <input
                            className="numField"
                            type="number"
                            min={b.min}
                            max={b.max}
                            value={v ?? b.def}
                            onChange={(e) => setValue(b.id, Number(e.target.value))}
                            style={{ borderColor: bad ? "var(--danger-edge)" : undefined }}
                          />
                          {v !== undefined && v !== b.def && (
                            <button onClick={() => setValue(b.id, b.def)} title={t("useDefaultTitle")}>
                              {t("useDefault")}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            {!bev.bounds.exact && (
              <Alerte className="note">{t("misalignedWarning")}</Alerte>
            )}
          </>
        )}

        <div className="row note">
          <button className="primary" onClick={save} disabled={!!outOfRange.length}>
            {t("saveLocal")}
          </button>
          <button onClick={loadFromMachine} disabled={!bev?.values} title={
              !bev?.values
                ? t("takeFromProfileUnavailable")
                : t("takeFromProfileTitle")
            }>
            {t("takeFromProfile")}
          </button>
          <button className="good" onClick={writeToMachine} disabled={!!outOfRange.length || !draft.params.length}>
            {t("writeToProfile", { profile: draft.profileId })}
          </button>
          {draft.id && <button onClick={() => setDraft(empty())}>{tc("new")}</button>}
        </div>
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
                    <button onClick={() => setDraft(structuredClone(r))}>{tc("edit")}</button>
                    <button className="danger discret" onClick={() => del(r.id, r.name)}>
                      {tc("delete")}
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

/**
 * Une borne n'est exploitable que si elle délimite un intervalle et que le défaut y tombe. La
 * machine renvoie 0 ou 255 (0xFF) pour un paramètre non configuré — constaté sur les recettes
 * perso vierges et le mug de voyage.
 */
/**
 * Valeur de départ d'un paramètre : ce que la machine a enregistré pour ce profil si c'est dans
 * les bornes, sinon le défaut du modèle s'il l'est, sinon le minimum. La machine renvoie 0 ou 255
 * pour un paramètre jamais configuré (mug de voyage, recettes perso vierges) — retomber sur `min`
 * permet de le régler, là où une version précédente masquait la ligne entière.
 */
function seedValue(bev: Beverage, b: Bound): number {
  const stored = bev.values?.params.find((p) => p.id === b.id)?.value;
  if (stored !== undefined && stored >= b.min && stored <= b.max) return stored;
  if (b.def >= b.min && b.def <= b.max) return b.def;
  return b.min;
}

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
