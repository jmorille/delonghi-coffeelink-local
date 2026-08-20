// Les deux réglages de cette page — l'adresse de la machine et la clé LAN — vivent maintenant dans
// la carte de chaque machine, sur /machines. Y renvoyer plutôt que supprimer : des liens et des
// onglets pointent encore ici, et la page était nommée dans plusieurs messages du serveur.
//
// Elle traitait la machine *sélectionnée*, ce qui obligeait à basculer dessus avant de pouvoir la
// configurer — exactement l'aller-retour que la fusion supprime.
import { redirect } from "next/navigation";

export default function CleLanRedirect(): never {
  redirect("/machines");
}
