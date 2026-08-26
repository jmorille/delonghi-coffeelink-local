"use client";
import { useTranslations } from "next-intl";
import PhotoGrains from "./PhotoGrains";
import { Slider } from "@/ui/slider";
import { Input } from "@/ui/input";

/**
 * Le formulaire d'une **configuration de grains** : nom, les trois réglages, la photo.
 *
 * **Un seul formulaire, deux hôtes** — la carte « + Nouvelle configuration » et une carte existante
 * ouverte en édition. C'est la même règle que `RecipeEditor` et `BeverageCard` ailleurs dans ce
 * dépôt, et pour la même raison : deux copies d'un même formulaire font atterrir une amélioration
 * d'ergonomie sur une carte et pas sur l'autre, et celui qui a appris l'une doit réapprendre
 * l'autre.
 *
 * **Rien ne part vers la machine ici.** Ce formulaire ne décrit qu'une fiche locale ; c'est la
 * carte fermée qui porte les puces « écrire dans #n », et elles sont masquées pendant l'édition
 * pour qu'on ne propose pas d'écrire des valeurs qui ne sont pas encore enregistrées.
 */

/** Une borne publiée par le serveur. `verified: false` = plage déduite, pas lue sur la machine. */
export interface Bound {
  min: number;
  max: number;
  verified: boolean;
}

/**
 * Le brouillon en cours d'édition.
 *
 * ⚠️ **`image` a trois états et ils ne se confondent pas** : absent, la photo enregistrée ne bouge
 * pas ; `null`, on la retire ; une data URL, on la remplace. Sans le premier, rouvrir une fiche
 * pour corriger son nom effacerait sa photo.
 */
export interface Brouillon {
  name: string;
  grinder: number;
  temperature: number;
  aroma: number;
  image?: string | null;
}

export default function ReglagesGrains({
  valeur,
  onChange,
  bounds,
  apercu = null,
  disabled = false,
  prefixe,
}: {
  valeur: Brouillon;
  onChange: (v: Brouillon) => void;
  /** Les plages du serveur. Absentes tant que la première réponse n'est pas arrivée. */
  bounds?: { grinder: Bound; aroma: Bound; temperature: Bound };
  /** L'URL de la photo déjà enregistrée, pour une fiche qu'on rouvre. */
  apercu?: string | null;
  disabled?: boolean;
  /** Préfixe des identifiants de champ : plusieurs cartes peuvent être ouvertes sur la page. */
  prefixe: string;
}) {
  const t = useTranslations("beanAdapt");

  return (
    <>
      <div className="row">
        <div>
          <label htmlFor={`${prefixe}-nom`}>{t("name")}</label>
          <Input
            id={`${prefixe}-nom`}
            value={valeur.name}
            maxLength={20}
            disabled={disabled}
            onChange={(e) => onChange({ ...valeur, name: e.target.value })}
          />
        </div>
      </div>
      <p className="legende">{t("nameHint")}</p>

      {/* Les trois réglages, **bornés par ce que le serveur publie** et jamais par des valeurs
          écrites ici : ce sont les plages du Bean System, et une deuxième déclaration finirait par
          autoriser une valeur que la machine refuse. La température est marquée « non vérifiée »
          parce que sa borne haute est notre prudence, pas une mesure. */}
      {(
        [
          ["grinder", bounds?.grinder],
          ["temperature", bounds?.temperature],
          ["aroma", bounds?.aroma],
        ] as const
      ).map(([cle, borne]) => (
        <div className="paramRow" key={cle}>
          <span className="nom">
            {t(cle)}
            {borne && !borne.verified && (
              <span className="sub" title={t("unverifiedHint")}>
                {" "}
                ({t("unverified")})
              </span>
            )}
          </span>
          <div className="ctl">
            <span className="sub num">{borne?.min ?? 0}</span>
            <Slider
              min={borne?.min ?? 0}
              max={borne?.max ?? 1}
              value={[valeur[cle]]}
              disabled={disabled}
              aria-label={`${t(cle)} (${borne?.min ?? 0}–${borne?.max ?? 1})`}
              onValueChange={([v]) => onChange({ ...valeur, [cle]: v })}
            />
            <span className="sub num">{borne?.max ?? 1}</span>
            <Input
              className="numField"
              type="number"
              min={borne?.min ?? 0}
              max={borne?.max ?? 1}
              value={valeur[cle]}
              disabled={disabled}
              onChange={(e) => onChange({ ...valeur, [cle]: Number(e.target.value) })}
            />
          </div>
        </div>
      ))}

      <PhotoGrains
        value={valeur.image}
        apercu={apercu}
        disabled={disabled}
        onChange={(img) => onChange({ ...valeur, image: img })}
      />
    </>
  );
}
