"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "../machine";
import { useMachinePush } from "../events";
import { useConfirm } from "../confirm";
import Icone from "../icons";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
import { Badge } from "@/ui/badge";

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
      <div className="card warn">
        <div className="legende">{t("warning")}</div>
      </div>

      <div className="row barreActions">
        <button className="iconBtn" disabled={busy} onClick={lire} title={t("readTitle")}>
          <Icone nom="lire" />
          <span className="lbl">{t("read")}</span>
        </button>
        {d?.modelName && <span className="sub">{t("model", { name: d.modelName })}</span>}
      </div>
      {msg && <p className={"status " + (msg.kind === "err" ? "err" : "ok")} role="status">{msg.text}</p>}

      {!d ? (
        <p className="sub">{tc("loading")}</p>
      ) : (
        <>
          <div className="cards">
            {dispo.map((r) => (
              <div className="card" key={r.addr}>
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
                    <div className="row">
                      <div className="champBloc">
                        <label htmlFor={`v-${r.addr}`}>{t("newValue", { min: r.min, max: r.max })}</label>
                        <Input
                          id={`v-${r.addr}`}
                          className="champ"
                          type="number"
                          min={r.min}
                          max={r.max}
                          value={brouillon[r.cle] ?? (r.value ?? "")}
                          onChange={(e) => setBrouillon({ ...brouillon, [r.cle]: e.target.value })}
                        />
                      </div>
                      <button
                        className="iconBtn"
                        disabled={busy || !brouillon[r.cle]}
                        onClick={() =>
                          demander({
                            question: t("confirmWrite", { name: nom(r.cle), value: brouillon[r.cle] }),
                            detail: t("confirmDetail"),
                            onConfirm: () => void ecrire({ cle: r.cle, value: Number(brouillon[r.cle]) }, t("writeSent", { name: nom(r.cle) })),
                          })
                        }
                      >
                        <Icone nom="ecrire" />
                        <span className="lbl">{t("write")}</span>
                      </button>
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
              </div>
            ))}
          </div>

          {absents.length > 0 && (
            <>
              <h2>{t("unsupportedHeading")}</h2>
              <div className="card">
                <p className="chapeau">{t("unsupportedNote")}</p>
                <ul>
                  {absents.map((r) => (
                    <li key={r.addr}>
                      {nom(r.cle)} <span className="sub mono">{t("address", { addr: r.addr })}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </>
      )}
      {dialogue}
    </>
  );
}
