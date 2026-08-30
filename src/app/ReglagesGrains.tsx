"use client";
import { useTranslations } from "next-intl";
import PhotoGrains from "./PhotoGrains";
import { ChoixTorrefaction } from "./VignetteGrains";
import { Slider } from "@/ui/slider";
import { Input } from "@/ui/input";

/**
 * Le formulaire d'une **configuration de grains** : la photo, le nom, la torréfaction, les trois
 * réglages.
 *
 * **Un seul formulaire, TROIS hôtes** — le dos d'un emplacement de la machine, le dos d'une fiche
 * mémorisée, et la carte « + Nouvelle configuration ». C'est la même règle que `RecipeEditor` et
 * `BeverageCard` ailleurs dans ce dépôt, et pour la même raison : deux copies d'un même formulaire
 * font atterrir une amélioration d'ergonomie sur une carte et pas sur l'autre, et celui qui a appris
 * l'une doit réapprendre l'autre. Les quatre choses qu'il édite — nom, trois réglages, torréfaction,
 * photo — sont exactement l'ensemble modifiable des deux objets, ce qui n'est pas un hasard : un
 * emplacement de la machine et une fiche mémorisée décrivent le même café.
 *
 * ## L'ordre : la photo, le nom, le grain, les réglages
 *
 * **La photo ouvre le formulaire, et ce n'est pas une question de goût.** Deux de ses trois hôtes
 * sont le DOS d'une carte dont la face avant est cette même image, dans ce même cadre : la faire
 * commencer ailleurs aurait fait sauter le visuel d'un demi-écran au moment de la rotation. Elle
 * remonte donc à la place que la rotation lui laisse — et, comme c'est un `AfficheGrain`, ce qu'on y
 * voit est exactement ce que la carte montrera.
 *
 * **Deux groupes nommés, et ils remplacent deux paragraphes.** « Le grain » (la torréfaction) et
 * « Réglages » (mouture, température, arôme) ne vont pas au même endroit : le premier reste chez
 * nous, le second part dans l'appareil en trame `0xBB`. C'était écrit en deux légendes de trois
 * lignes sous les commandes ; c'est désormais dit par la STRUCTURE, en deux mots — même information,
 * six lignes de moins dans une colonne de 20 rem. Ce sont de vrais `role="group"` nommés par leur
 * étiquette : un titre visuel qui ne nomme rien pour un lecteur d'écran aurait échangé une
 * information contre une mise en page.
 *
 * ⚠️ **Ce formulaire n'envoie RIEN par lui-même, et ses trois hôtes n'écrivent pas au même endroit.**
 * Les commandes vivent chez l'hôte, sous le formulaire : une fiche mémorisée s'enregistre en local,
 * un emplacement de la machine se sépare en deux gestes — le visuel (torréfaction + photo) reste
 * ici, les trois réglages partent en trame `0xBB`. Un seul bouton pour les deux ferait d'un
 * changement de photo une écriture persistante sur l'appareil.
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
  /**
   * Le niveau de torréfaction déclaré, 1 (clair) à 4 (foncé), `null` s'il n'est pas précisé.
   *
   * ⚠️ **Il n'a PAS les trois états de `image`, et ce n'est pas un oubli.** Une photo pèse des
   * kilo-octets et vit dans sa propre table : la renvoyer à chaque enregistrement pour dire
   * « inchangée » serait la retransmettre pour rien, d'où le cas « absent ». Un niveau est un
   * entier rangé dans la fiche elle-même — il part avec elle, toujours, et `null` veut dire
   * « aucun » sans ambiguïté à lever.
   */
  roast: number | null;
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
      {/* L'affiche, cliquable. Elle reçoit `nom` et `roast` parce qu'elle montre le visuel RÉEL et
          non la seule photo : sans eux, retirer une photo laisserait un creux vide là où la carte
          affichera le dessin de la torréfaction. Voir l'en-tête de `PhotoGrains`. */}
      <PhotoGrains
        value={valeur.image}
        apercu={apercu}
        nom={valeur.name}
        roast={valeur.roast}
        disabled={disabled}
        onChange={(img) => onChange({ ...valeur, image: img })}
      />

      {/* La limite de 20 caractères est celle de la machine, et `maxLength` la FAIT déjà : la phrase
          qui la répétait sous le champ ne servait qu'à l'annoncer. Elle passe en infobulle, où elle
          répond à qui se demande pourquoi la frappe s'arrête. */}
      <div className="row">
        {/* `grow` + `w-full` : seul dans sa rangée, entre une affiche pleine largeur et trois
            curseurs pleine largeur, un champ arrêté à la largeur par défaut d'un `<input>` se lisait
            comme un alignement manqué. */}
        <div className="grow">
          <label htmlFor={`${prefixe}-nom`}>{t("name")}</label>
          <Input
            id={`${prefixe}-nom`}
            className="w-full"
            value={valeur.name}
            maxLength={20}
            title={t("nameHint")}
            disabled={disabled}
            onChange={(e) => onChange({ ...valeur, name: e.target.value })}
          />
        </div>
      </div>

      {/* **« Le grain » : ce que le café EST, et que la machine ne retient pas.** L'étiquette porte en
          infobulle ce que disait la légende — la torréfaction sert de visuel faute de photo et ne
          part dans aucune trame. Le groupe est nommé par elle : `aria-labelledby` et non un simple
          intertitre, sinon le rail de torréfaction se retrouverait dans une section anonyme. */}
      <div role="group" aria-labelledby={`${prefixe}-g-grain`}>
        <p className="etiquetteGroupe" id={`${prefixe}-g-grain`} title={t("roastHint")}>
          {t("sectionBean")}
        </p>
        <ChoixTorrefaction
          value={valeur.roast}
          prefixe={prefixe}
          disabled={disabled}
          onChange={(r) => onChange({ ...valeur, roast: r })}
        />
      </div>

      {/* **« Réglages » : ce que la machine FAIT du café.** Les trois sont **bornés par ce que le
          serveur publie** et jamais par des valeurs écrites ici : ce sont les plages du Bean System,
          et une deuxième déclaration finirait par autoriser une valeur que la machine refuse. */}
      <div role="group" aria-labelledby={`${prefixe}-g-reglages`}>
        <p className="etiquetteGroupe" id={`${prefixe}-g-reglages`}>
          {t("sectionSettings")}
        </p>
        {(
          [
            ["grinder", bounds?.grinder],
            ["temperature", bounds?.temperature],
            ["aroma", bounds?.aroma],
          ] as const
        ).map(([cle, borne]) => (
          <div className="paramRow" key={cle}>
            {/* **La plage est dans le LIBELLÉ, plus aux deux bouts du curseur — et c'est une mesure,
                pas un goût.** `surfaces.css` le dit noir sur blanc à propos de `.open` : « un curseur,
                ses bornes, un champ et une puce de défaut ne tiennent pas dans 19 rem ». Ce formulaire
                vit désormais au DOS d'une carte de la grille, donc dans une colonne, et la carte ne
                s'élargit plus en s'ouvrant : un demi-tour qui triplerait la largeur ne serait plus un
                demi-tour. Deux chiffres flottant de part et d'autre du rail coûtaient 90 px de la
                course du curseur ; collés au nom ils n'en coûtent aucun, et ils se lisent mieux —
                « Mouture (1–7) » est une phrase, « 1 [rail] 7 » est une devinette.

                ⚠️ **« (bornes non vérifiées) » ne se lit plus, mais il s'ENTEND encore.** Écrit en
                clair, il faisait passer « Température » à la ligne dans une colonne de 20 rem — trois
                mots de mise en garde qui coûtaient une ligne à chaque ouverture. Il devient donc un
                soulignement pointillé sur la plage, l'infobulle qui l'explique, et le même texte en
                `sr-only` : retirer le mot de l'œil est une compaction, le retirer de l'oreille aurait
                été une perte d'information. */}
            <span className="nom">
              {t(cle)}{" "}
              <span
                className={"sub num" + (borne && !borne.verified ? " borneIncertaine" : "")}
                title={borne && !borne.verified ? t("unverifiedHint") : undefined}
              >
                ({borne?.min ?? 0}&#8211;{borne?.max ?? 1})
                {borne && !borne.verified && <span className="sr-only"> {t("unverified")}</span>}
              </span>
            </span>
            <div className="ctl">
              <Slider
                min={borne?.min ?? 0}
                max={borne?.max ?? 1}
                value={[valeur[cle]]}
                disabled={disabled}
                aria-label={`${t(cle)} (${borne?.min ?? 0}–${borne?.max ?? 1})`}
                onValueChange={([v]) => onChange({ ...valeur, [cle]: v })}
              />
              <Input
                className="w-[4.6rem] flex-none text-right"
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
      </div>
    </>
  );
}
