"use client";
import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Cropper, { type Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import Icone from "./icons";
import { AfficheGrain } from "./VignetteGrains";
import { FORMAT_IMAGE, RAPPORT_IMAGE } from "../lib/image-grains.mjs";
import { Slider } from "@/ui/slider";
import { Button } from "@/ui/button";

/**
 * La photo d'une configuration de grains : **choisir, cadrer, produire le format commun**.
 *
 * **La photo est son propre bouton.** Cliquer dessus ouvre le sélecteur ; il n'y a pas de bouton
 * « Ajouter une photo » à côté, qui ne ferait que nommer ce que l'image montre déjà. Même motif
 * que le choix de dessin sur `/`.
 *
 * ⚠️ **Ce bouton EST l'affiche de la carte, le même `AfficheGrain` que la face avant.** Il ne montre
 * donc plus une vignette de 6,5 rem mais le cadre entier, et il montre les TROIS états du visuel
 * dans leur ordre de précédence — photo, sinon dessin de torréfaction, sinon initiales gravées. Deux
 * conséquences voulues : le demi-tour ne déplace pas l'image (même rectangle, même place), et
 * choisir une torréfaction juste en dessous se voit immédiatement au-dessus. C'est pour cela que le
 * composant reçoit `nom` et `roast`, qu'il n'édite pas : il ne peut pas montrer le visuel réel sans
 * savoir ce qui vient APRÈS la photo dans la précédence.
 *
 * ⚠️ **Et c'est pour cela qu'il porte un sceau.** Une vignette bordée de 6,5 rem se lisait comme un
 * champ ; un poster de 20 rem se lit comme un poster. Le contour au survol ne suffit pas — un doigt
 * ne survole rien. Le glyphe d'appareil dans le coin est DANS le bouton, donc il n'ajoute ni pas de
 * tabulation ni nom accessible concurrent.
 *
 * **« Retirer la photo » est en surimpression, et il n'est PAS dans le bouton.** Un `<button>` dans
 * un `<button>` n'est pas du HTML valide et le navigateur défait l'imbrication à sa façon : le
 * retrait est un frère du poster, posé au-dessus en absolu. Il ne porte que la corbeille — le texte
 * sous l'image occupait une ligne pour nommer une action qui ne concerne QUE cette image, et qui la
 * désigne mieux en se posant dessus. Contrepartie obligatoire : `aria-label`, sinon la seule
 * commande destructrice du formulaire s'annonce « bouton ». Le rouge est opaque (`bg-rouge-verre`
 * est une couleur pleine, pas un voile) parce qu'il doit se lire sur un paquet de café quelconque.
 *
 * Un seul `<input type="file" accept="image/*">` couvre les deux gestes que l'utilisateur
 * distingue — prendre une photo et choisir un fichier. Sur téléphone, le sélecteur natif propose
 * l'appareil photo ET la galerie ; sur ordinateur, le sélecteur de fichiers. C'est le navigateur
 * qui tranche, pas nous, et cela évite un second chemin de code pour ce qui est la même donnée à
 * l'arrivée.
 *
 * ⚠️ **`capture="environment"` a été RETIRÉ, et l'attribut fait l'inverse de ce qu'on croit.** Il
 * ne veut pas dire « propose aussi l'appareil photo » : présent, il demande au navigateur d'ouvrir
 * **directement** le périphérique de capture, ce qui sur mobile **supprime l'accès aux fichiers**.
 * Il ne restait donc qu'un seul des deux gestes demandés — l'upload devenait impossible depuis un
 * téléphone. Sur ordinateur l'attribut est ignoré, d'où un défaut invisible là où il a été écrit.
 *
 * ⚠️ **Rien ne part au serveur ici.** Le composant rend une data URL à son hôte, qui l'enverra avec
 * le reste de la configuration : une photo cadrée puis abandonnée ne doit rien laisser derrière
 * elle, et l'enregistrement doit rester un seul geste.
 *
 * Le cadrage est manuel parce que la source est presque toujours une photo prise à la volée : un
 * recadrage automatique au centre ne rattrape pas un paquet pris de travers, qui est le cas normal.
 */

/** Charge une image depuis une URL locale. Rejette au lieu de rendre une image vide. */
function chargerImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image illisible"));
    img.src = src;
  });
}

/**
 * Découpe la zone choisie et la ramène au format commun, en une seule passe de `drawImage`.
 *
 * ⚠️ Si le navigateur ne sait pas encoder en WebP, `toDataURL` retombe **silencieusement** sur PNG.
 * Ce n'est pas rattrapé, c'est assumé : le serveur accepte les trois types, donc le pire cas est
 * une image plus lourde, jamais une image perdue.
 */
async function decouper(src: string, zone: Area): Promise<string> {
  const img = await chargerImage(src);
  const toile = document.createElement("canvas");
  toile.width = FORMAT_IMAGE.largeur;
  toile.height = FORMAT_IMAGE.hauteur;
  const ctx = toile.getContext("2d");
  if (!ctx) throw new Error("canvas indisponible");
  ctx.drawImage(img, zone.x, zone.y, zone.width, zone.height, 0, 0, toile.width, toile.height);
  return toile.toDataURL(FORMAT_IMAGE.mime, FORMAT_IMAGE.qualite);
}

export default function PhotoGrains({
  value,
  apercu,
  onChange,
  nom,
  roast = null,
  disabled = false,
}: {
  /**
   * L'état de la photo dans le brouillon en cours. **Trois valeurs, trois sens**, les mêmes que
   * ceux du serveur : `undefined` = on ne touche pas à celle qui est enregistrée, `null` = on la
   * retire, une data URL = on la remplace. Sans le troisième cas, rouvrir une fiche pour changer
   * le nom effacerait sa photo.
   */
  value: string | null | undefined;
  /** L'image déjà enregistrée côté serveur, s'il y en a une. C'est ce qu'on voit tant qu'on n'y touche pas. */
  apercu?: string | null;
  /** `null` veut dire « retirer l'image », et c'est distinct de « ne pas y toucher ». */
  onChange: (dataUrl: string | null) => void;
  /**
   * Le nom du grain et sa torréfaction : **lus, jamais écrits ici**.
   *
   * Ils ne servent qu'à rendre le cadre fidèle — sans eux l'aperçu montrerait un creux vide là où la
   * carte affichera un dessin de torréfaction ou des initiales, et l'utilisateur croirait avoir
   * perdu son visuel. Les deux appartiennent au brouillon de l'hôte, qui les édite ailleurs.
   */
  nom: string;
  roast?: number | null;
  disabled?: boolean;
}) {
  const t = useTranslations("beanAdapt");
  const fichier = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [zone, setZone] = useState<Area | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const surZone = useCallback((_: Area, pixels: Area) => setZone(pixels), []);

  const choisir = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    // Le champ est remis à zéro : sans cela, rechoisir LE MÊME fichier n'émet aucun évènement.
    e.target.value = "";
    if (!f) return;
    setErreur(null);
    setPosition({ x: 0, y: 0 });
    setZoom(1);
    setZone(null);
    setSource(URL.createObjectURL(f));
  };

  /**
   * Ouvre le sélecteur de fichiers.
   *
   * `fichier.current?.click()` s'écrivait en une ligne, mais l'optionnel **avalait l'échec** : si
   * la référence manquait, le clic ne produisait rien du tout — ni ouverture, ni message, ni trace.
   * « Rien ne se passe » est le pire retour qu'une interface puisse donner, parce qu'il ne
   * distingue pas un bouton mort d'une fenêtre qui s'est ouverte ailleurs.
   */
  const ouvrirSelecteur = () => {
    setErreur(null);
    const el = fichier.current;
    if (!el) {
      setErreur(t("photoNoPicker"));
      return;
    }
    el.click();
  };

  const fermer = () => {
    if (source) URL.revokeObjectURL(source);
    setSource(null);
  };

  const valider = async () => {
    if (!source || !zone) return;
    try {
      const dataUrl = await decouper(source, zone);
      onChange(dataUrl);
      fermer();
    } catch {
      setErreur(t("photoFailed"));
    }
  };

  // `undefined` veut dire « inchangée », donc on montre celle du serveur ; `null` veut dire
  // « retirée », donc on ne montre rien. Un `??` les confondrait et ferait réapparaître une photo
  // que l'utilisateur vient d'enlever.
  const visible = value === undefined ? (apercu ?? null) : value;

  return (
    <div className="photoGrains">
      {source ? (
        <div className="photoCadrage">
          {/* Hauteur imposée : `react-easy-crop` se positionne en absolu et s'effondrerait sinon. */}
          <div className="photoZone">
            <Cropper
              image={source}
              crop={position}
              zoom={zoom}
              aspect={RAPPORT_IMAGE}
              onCropChange={setPosition}
              onZoomChange={setZoom}
              onCropComplete={surZone}
              showGrid
            />
          </div>
          <label className="photoZoom">
            <span className="sub">{t("photoZoom")}</span>
            {/* Pas de `--crans` ici, et c'est juste : le zoom d'un recadrage est CONTINU, il ne
                vient d'aucune borne publiée par la machine. Une graduation dirait le contraire. */}
            <Slider
              min={1}
              max={4}
              step={0.01}
              value={[zoom]}
              onValueChange={([v]) => setZoom(v)}
              aria-label={t("photoZoom")}
            />
          </label>
          <div className="row">
            <Button type="button" variant="neutre" size="coquille" className="iconBtn" onClick={() => void valider()} disabled={!zone}>
              <Icone nom="choisir" taille={14} />
              <span className="lbl">{t("photoApply")}</span>
            </Button>
            <Button type="button" variant="neutre" size="coquille"  onClick={fermer}>{t("photoCancel")}</Button>
          </div>
        </div>
      ) : (
        <div className="photoApercu">
          {/* **L'image EST le bouton**, comme le choix de dessin sur `/` : la photo se désigne
              elle-même, un bouton à côté d'elle ne ferait que nommer ce qu'elle montre déjà. Le nom
              accessible est obligatoire : une image cliquable sans libellé ne s'annonce pas.

              Plus de `photoVide` ni de « Pas de photo » : le cadre n'est jamais vide. `AfficheGrain`
              y met le dessin de la torréfaction, sinon les initiales, sinon le fond brossé — et un
              creux brossé dit « il n'y a pas encore de paquet ici » là où un rectangle en pointillés
              disait « image manquante ». La phrase avait été écrite pour combler un trou qui
              n'existe plus. */}
          <button
            type="button"
            className="photoAffiche"
            disabled={disabled}
            onClick={ouvrirSelecteur}
            title={visible ? t("photoReplace") : t("photoAdd")}
            aria-label={visible ? t("photoReplace") : t("photoAdd")}
          >
            <AfficheGrain nom={nom} photo={visible} roast={roast} />
            <span className="photoSceau">
              <Icone nom="appareil" taille={15} />
            </span>
          </button>
          {visible && (
            <Button
              type="button"
              variant="arret"
              size="coquille"
              className="photoRetirer"
              disabled={disabled}
              title={t("photoRemove")}
              aria-label={t("photoRemove")}
              onClick={() => onChange(null)}
            >
              <Icone nom="corbeille" taille={14} />
            </Button>
          )}
          {/* Pas de `capture` : voir l'en-tête. L'attribut IMPOSE l'appareil photo sur mobile et
              retire l'accès aux fichiers, alors qu'on veut les deux. Sans lui, le sélecteur natif
              offre les deux.

              **`className` et non `hidden`** : `hidden` vaut `display: none`, et un champ retiré du
              rendu est le cas que les navigateurs traitent le moins uniformément quand on l'active
              par script. Le champ reste donc dans le flux, d'un pixel et transparent — invisible
              pour l'œil, ordinaire pour le navigateur. */}
          <input ref={fichier} type="file" accept="image/*" onChange={choisir} className="photoInput" />
        </div>
      )}
      {erreur && <p className="err">{erreur}</p>}
    </div>
  );
}
