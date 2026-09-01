import type { CSSProperties } from "react";

/**
 * **Combien de crans imprimer sur la piste d'un curseur — la règle, à un seul endroit.**
 *
 * La graduation sérigraphiée autour d'une commande est ce qui rend ce monde visuel propre à ce
 * produit, et ses traits ne sont pas décoratifs : ce sont les valeurs que la MACHINE autorise pour
 * ce réglage. D'où la seule condition qui vaille — on ne gradue que des bornes qu'on tient d'une
 * source, jamais des bornes assemblées ici (c'est le cas d'une composition libre de `/recipes`,
 * `bounds.calculee`) ; l'appelant tranche cela avant d'appeler, parce que lui seul le sait.
 * Sans crans, la piste reste un creux nu, et ce creux dit « je ne connais pas les bornes ».
 *
 * Le plafond à 40 n'est pas une limite de dessin mais de lisibilité : au-delà, des traits d'un
 * pixel espacés de moins de trois se fondent en une bande grise, qui ne porte plus rien. On
 * retombe alors sur un cran tous les dix pas, ce qui reste vrai — c'est une graduation plus
 * grossière, pas une graduation inventée.
 *
 * ⚠️ **Cette fonction vivait dans `RecipeEditor`, non exportée, et `/reglages` en avait besoin.**
 * La recopier aurait fait deux barèmes pour une seule décision visuelle : le jour où l'un passe à
 * 50, les deux pages gradueraient différemment la même étendue, sans que rien ne le signale. C'est
 * la raison qui a déjà sorti `fmtAge` de `page.tsx` (voir `machineState.ts`).
 */
export function crans(min: number, max: number): number | null {
  const etendue = max - min;
  // Une étendue de 0 ou 1 n'a rien à graduer : deux positions, ce sont les deux bouts de la piste.
  if (etendue < 2) return null;
  return etendue <= 40 ? etendue : Math.max(Math.round(etendue / 10), 1);
}

/**
 * Le style à poser sur le conteneur d'un curseur, ou `undefined` quand il n'y a rien à graduer.
 *
 * Rendre l'objet de style plutôt que le nombre évite la faute qui guette au point d'appel : poser
 * `--crans: null` **imprimerait** une graduation, puisque la règle CSS se déclenche sur la PRÉSENCE
 * de la variable (`[style*="--crans"]`) et non sur sa valeur. `undefined` est la seule forme d'un
 * « pas de graduation » qui traverse React sans laisser l'attribut derrière elle.
 */
export function styleCrans(min: number, max: number): CSSProperties | undefined {
  const n = crans(min, max);
  return n === null ? undefined : ({ "--crans": n } as CSSProperties);
}
