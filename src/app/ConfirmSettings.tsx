"use client";
import { useTranslations } from "next-intl";
import { GESTES, useConfirmPrefs } from "./confirmPrefs";
import Alerte from "./Alerte";
import { Switch } from "@/ui/switch";
import { Card } from "@/ui/card";

/**
 * L'écran où l'on rend les confirmations, et où on les reprend.
 *
 * **Pourquoi il est ici et pas dans la barre.** La case « ne plus demander » du dialogue est
 * rencontrée là où la friction se produit, ce qui est le bon endroit pour renoncer — mais une
 * garde qu'on peut baisser sans savoir où la relever est un piège. C'est ce bloc qui est la porte
 * de sortie, et le dialogue le nomme. Il vit sur `/pilotage`, la page dont le métier est la
 * commande : c'est là qu'on va quand on veut savoir ce que l'interface fera avant de l'envoyer.
 *
 * **Les deux gestes sont indépendants.** Vouloir préparer un café d'un geste ne dit rien de
 * l'envie d'allumer sans être questionné — l'un ne coule que la boisson demandée, l'autre déclenche
 * un rinçage à l'eau chaude par la buse, machine peut-être sans bac dessous.
 *
 * L'avertissement final n'est pas décoratif : ce serveur commande un appareil réel, et un réglage
 * qui retire un garde-fou doit dire ce qu'il retire, dans le vocabulaire de la conséquence.
 */
export default function ConfirmSettings() {
  const t = useTranslations("confirmations");
  const [prefs, changer] = useConfirmPrefs();
  const desactive = GESTES.filter((g) => !prefs[g]);

  return (
    <Card>
      <p className="chapeau">{t("intro")}</p>
      {GESTES.map((g) => (
        /* **Une div, plus `aria-labelledby` — et pas un `<label>`.** L'interrupteur de Radix est un
           `<button role="switch">`, et un `<label>` ne nomme pas un bouton : l'envelopper aurait
           produit une commande sans nom, en silence, là où l'`<input type="checkbox">` d'avant en
           recevait un. On pointe donc le libellé visible, ce qui garde la propriété qui comptait —
           un seul texte, impossible à faire diverger d'un `aria-label` recopié à côté. */
        <div className="ligneReglage" key={g}>
          <Switch
            size="sm"
            checked={prefs[g]}
            aria-labelledby={"conf-" + g}
            onCheckedChange={(v) => changer(g, v === true)}
          />
          <span className="texteReglage">
            <strong id={"conf-" + g}>{t(g)}</strong>
            {/* Ce que le réglage change concrètement, dans les deux sens : sans ça, un
                interrupteur intitulé « Préparer une boisson » se lit comme s'il autorisait ou
                interdisait de préparer, et non comme s'il posait une question avant. */}
            <span className="sub">{prefs[g] ? t(g + "On") : t(g + "Off")}</span>
          </span>
        </div>
      ))}
      {/* Rien n'est affiché tant que tout est confirmé : un avertissement permanent sur l'état par
          défaut serait du bruit, et le bruit finit par se lire comme du décor.

          **Il ne nomme QUE les gestes réellement désarmés.** Une première version décrivait le
          rinçage à l'eau chaude alors que seule la préparation était concernée — l'interrupteur
          demandait encore. Un avertissement qui décrit une conséquence qui n'aura pas lieu apprend
          au lecteur à ne plus le lire. */}
      {desactive.length > 0 && (
        <Alerte>
          {t("warningLead", { count: desactive.length })}{" "}
          {desactive.map((g) => t("warning" + g[0].toUpperCase() + g.slice(1))).join(" ")}{" "}
          {t("warningCheck")}
        </Alerte>
      )}
      <p className="note">{t("scope")}</p>
    </Card>
  );
}
