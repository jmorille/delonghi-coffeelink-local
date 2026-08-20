// La page est passée à /beans ; on garde /bean-adapt vivant pour les liens et onglets déjà ouverts,
// et parce que plusieurs messages du serveur ont nommé cette adresse.
import { redirect } from "next/navigation";

export default function BeanAdaptRedirect(): never {
  redirect("/beans");
}
