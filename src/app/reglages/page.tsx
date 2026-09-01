"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import { useMachinePush } from "../events";
import { useConfirm } from "../confirm";
import Icone from "../icons";
import { styleCrans } from "../crans";
import { Input } from "@/ui/input";
import { Slider } from "@/ui/slider";
import { Switch } from "@/ui/switch";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

/**
 * Un réglage de la machine, tel que le serveur le publie (`vueReglages`).
 *
 * `value` est la valeur BRUTE de l'adresse. Pour l'adresse 63 elle n'a pas de sens seule : c'est
 * `bits` qui porte les cinq interrupteurs, dont `autoStart` est inversé côté protocole (bit à 1 =
 * désactivé). Le serveur a déjà défait cette inversion — ici `value: true` veut dire « activé ».
 */
interface Bit {
  cle: string;
  bit: number;
  value: boolean | null;
  inverse: boolean;
  supporte: boolean;
}
interface Reglage {
  addr: number;
  cle: string;
  value: number | null;
  at: number | null;
  source: string | null;
  min: number;
  max: number;
  supporte: boolean;
  prop: string | null;
  bits?: Bit[];
}
interface Payload {
  reglages: Reglage[];
  model: string | null;
  modelName: string | null;
  lecture: { active: boolean; remaining: number; ok: number; fail: number; pending: string | null } | null;
}

export default function Reglages() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const [d, setD] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  /** Valeurs en cours d'édition, par clé. Rien ne part avant « Écrire ». */
  const [brouillon, setBrouillon] = useState<Record<string, string>>({});
  const { demander, dialogue } = useConfirm();

  const refresh = useCallback(async () => {
    setD(await mfetch("/api/settings").then((r) => r.json()));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Les valeurs arrivent quand la machine répond : on est prévenu, on ne scrute pas. */
  const { live, busy: pending } = useMachinePush(refresh);

  const rendre = (r: { error?: string }, ok: string) =>
    setMsg(r.error ? { text: tc("error", { message: r.error }), kind: "err" } : { text: ok, kind: "ok" });

  const lire = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((x) => x.json());
      rendre(r, t("readQueued", { count: r.count ?? 0 }));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const ecrire = async (corps: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mfetch("/api/settings/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      }).then((x) => x.json());
      rendre(r, ok);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const nom = (cle: string) => (t.has(`label_${cle}`) ? t(`label_${cle}`) : cle);

  /**
   * **La dureté de l'eau et la température sont des échelles, pas des nombres.** La machine range
   * quatre duretés et quatre températures sous 0..3 ou 1..4 ; afficher « 2 » n'apprend rien. Quand
   * le catalogue de messages a un libellé pour la valeur, on le montre à côté du nombre — jamais à
   * la place : c'est le nombre qui part dans la trame, et c'est lui qu'on relira.
   */
  const echelle = (cle: string, v: number | null) => {
    if (v == null) return null;
    const k = `value_${cle}_${v}`;
    return t.has(k) ? t(k) : null;
  };

  /**
   * **La valeur que les deux commandes d'une ligne partagent** — le curseur et le champ éditent le
   * MÊME brouillon, sinon on obtient deux vérités sur une seule ligne.
   *
   * Le brouillon reste stocké en CHAÎNE : le champ numérique doit pouvoir être vidé le temps d'une
   * frappe (`""` n'est pas `0`), ce qu'un nombre ne sait pas représenter. Le curseur, lui, exige un
   * nombre, et il n'a aucune position qui veuille dire « rien » — d'où le repli en cascade :
   * brouillon, sinon valeur lue, sinon le plancher du réglage.
   *
   * ⚠️ **Le curseur posé sur son plancher n'affirme donc PAS que la machine y est.** Sur un réglage
   * jamais lu il n'y a pas de valeur, et c'est la ligne du dessus qui le dit — un tiret et la puce
   * « non lu ». Le curseur est une commande d'écriture, pas un afficheur : le confondre avec une
   * lecture serait exactement ce que cette page passe son temps à éviter, et c'est pourquoi la
   * valeur lue garde son propre affichage au lieu d'être déduite de la position du patin.
   */
  const enCours = (r: Reglage) => {
    const brut = brouillon[r.cle];
    const n = brut === undefined || brut === "" ? r.value : Number(brut);
    return Number.isFinite(n) ? Math.min(Math.max(n as number, r.min), r.max) : r.min;
  };

  const reglages = d?.reglages ?? [];
  const dispo = reglages.filter((r) => r.supporte || r.bits?.some((b) => b.supporte));
  const absents = reglages.filter((r) => !r.supporte && !r.bits?.some((b) => b.supporte));

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      {pending && <p className="sub">{t("pushWaiting")}</p>}
      {!live && <p className="sub">{tc("pushOff")}</p>}

      {/* **La mise en garde d'abord, parce qu'elle porte sur tout ce qui suit.** Ces écritures
          modifient la configuration de l'appareil, pas un cache : elles survivent à l'extinction. */}
      <Card className="warn">
        <div className="legende">{t("warning")}</div>
      </Card>

      <div className="row barreActions">
        <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={busy} onClick={lire} title={t("readTitle")}>
          <Icone nom="lire" />
          <span className="lbl">{t("read")}</span>
        </Button>
        {d?.modelName && <span className="sub">{t("model", { name: d.modelName })}</span>}
      </div>
      {msg && <p className={"status " + (msg.kind === "err" ? "err" : "ok")} role="status">{msg.text}</p>}

      {!d ? (
        <p className="sub">{tc("loading")}</p>
      ) : (
        <>
          <div className="cards">
            {dispo.map((r) => (
              <Card key={r.addr}>
                <div className="titreLigne">
                  <h3 className="cardTitle">{nom(r.cle)}</h3>
                  {/* L'adresse est du protocole : chasse fixe, comme partout ici. */}
                  <span className="sub mono">{t("address", { addr: r.addr })}</span>
                </div>

                {r.bits ? (
                  /* Le champ de bits : cinq interrupteurs indépendants sur une seule adresse.
                     Chacun est écrit en relisant l'octet courant et en ne changeant QUE son bit —
                     c'est le serveur qui le fait, et il refuse s'il n'a pas lu l'octet. */
                  <dl className="kvListe">
                    {r.bits.filter((b) => b.supporte).map((b) => (
                      <div className="kv" key={b.cle}>
                        <dt className="k">{nom(b.cle)}</dt>
                        <dd className="titreLigne">
                          {/* `inconnu` plutôt que « décoché » quand la valeur n'a pas été lue : un
                              réglage jamais lu n'est pas un réglage éteint, et l'afficher comme tel
                              inviterait à l'allumer alors qu'il l'est peut-être déjà. */}
                          <Switch
                            size="sm"
                            checked={b.value === true}
                            inconnu={b.value == null}
                            disabled={busy || b.value == null}
                            aria-label={nom(b.cle)}
                            onCheckedChange={(vise) => {
                              demander({
                                question: t("confirmToggle", { name: nom(b.cle), etat: vise ? t("on") : t("off") }),
                                detail: t("confirmDetail"),
                                onConfirm: () => void ecrire({ cle: b.cle, on: vise }, t("writeSent", { name: nom(b.cle) })),
                              });
                            }}
                          />
                          {b.value == null && <Badge variant="arret">{t("notRead")}</Badge>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <>
                    <div className="titreLigne">
                      <span className="valeur">{r.value ?? tc("dash")}</span>
                      {echelle(r.cle, r.value) && <span className="sub">{echelle(r.cle, r.value)}</span>}
                      {r.value == null && <Badge variant="arret">{t("notRead")}</Badge>}
                    </div>
                    {/* **Un curseur, parce que ces réglages sont des ÉCHELLES et non des nombres
                        libres.** Quatre duretés d'eau, quatre températures, vingt-quatre heures :
                        le champ numérique demandait de connaître la borne avant de pouvoir viser,
                        là où une piste graduée la montre. Même motif qu'ailleurs dans ce dépôt —
                        `paramRow` + `ctl`, curseur puis champ — parce que celui qui a appris les
                        réglages d'un grain ou d'une recette ne doit rien réapprendre ici.

                        Le champ RESTE, et ce n'est pas un doublon : `autoOff` va jusqu'à 255 et les
                        minutes jusqu'à 59, étendues sur lesquelles un patin ne vise pas la valeur
                        exacte. Le curseur donne le geste, le champ donne le chiffre. */}
                    <div className="paramRow">
                      <label className="nom" htmlFor={`v-${r.addr}`}>
                        {t("newValue", { min: r.min, max: r.max })}
                      </label>
                      <div className="ctl" style={styleCrans(r.min, r.max)}>
                        <span className="sub mono">{r.min}</span>
                        {/* La valeur est un tableau : Radix accepte plusieurs poignées, celui-ci
                            n'en a qu'une. Le libellé va sur la POIGNÉE (voir `src/ui/slider.tsx`),
                            et il nomme le réglage — « curseur » tout seul ne dit rien sur une page
                            qui en aligne cinq. */}
                        <Slider
                          min={r.min}
                          max={r.max}
                          value={[enCours(r)]}
                          disabled={busy}
                          aria-label={`${nom(r.cle)} (${r.min}–${r.max})`}
                          onValueChange={([v]) => setBrouillon({ ...brouillon, [r.cle]: String(v) })}
                        />
                        <span className="sub mono">{r.max}</span>
                        <Input
                          id={`v-${r.addr}`}
                          className="w-[4.6rem] flex-none text-right"
                          type="number"
                          min={r.min}
                          max={r.max}
                          value={brouillon[r.cle] ?? (r.value ?? "")}
                          disabled={busy}
                          onChange={(e) => setBrouillon({ ...brouillon, [r.cle]: e.target.value })}
                        />
                      </div>
                    </div>
                    {/* Ce que la valeur en cours VEUT DIRE, quand le catalogue le sait : « dure »
                        plutôt que « 3 ». Sous la commande et non à côté de la valeur lue, parce
                        qu'elle suit le patin — c'est ce qui rend un glissement lisible sur une
                        échelle dont les quatre positions n'ont aucun nom écrit sur la piste. */}
                    {echelle(r.cle, enCours(r)) && (
                      <p className="legende">
                        {t("willWrite", { value: enCours(r), label: echelle(r.cle, enCours(r)) as string })}
                      </p>
                    )}
                    <div className="row">
                      <Button type="button" variant="neutre" size="commande"
                        className="iconBtn"
                        disabled={busy || brouillon[r.cle] === undefined || brouillon[r.cle] === ""}
                        onClick={() =>
                          demander({
                            question: t("confirmWrite", { name: nom(r.cle), value: brouillon[r.cle] }),
                            detail: t("confirmDetail"),
                            onConfirm: () => void ecrire({ cle: r.cle, value: Number(brouillon[r.cle]) }, t("writeSent", { name: nom(r.cle) })),
                          })
                        }>
                        <Icone nom="ecrire" />
                        <span className="lbl">{t("write")}</span>
                      </Button>
                    </div>
                  </>
                )}

                {/* D'où vient la valeur affichée. « écrit (non relu) » est le cas qui compte : la
                    machine n'accuse pas une écriture de réglage, donc tant qu'on n'a pas relu, ce
                    qui est à l'écran est ce que NOUS avons envoyé, pas ce qu'elle a retenu. */}
                <p className="legende">
                  {r.source ? t("source", { source: r.source }) : t("sourceNone")}
                  {r.prop ? ` · ${r.prop}` : ""}
                </p>
              </Card>
            ))}
          </div>

          {absents.length > 0 && (
            <>
              <h2>{t("unsupportedHeading")}</h2>
              <Card>
                <p className="chapeau">{t("unsupportedNote")}</p>
                <ul>
                  {absents.map((r) => (
                    <li key={r.addr}>
                      {nom(r.cle)} <span className="sub mono">{t("address", { addr: r.addr })}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </>
      )}
      {dialogue}
    </>
  );
}
