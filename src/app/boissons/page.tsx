// La page des boissons est passée à la racine ; on garde /boissons vivant pour les liens
// et onglets déjà ouverts.
import { redirect } from "next/navigation";

export default function BoissonsRedirect(): never {
  redirect("/");
}
