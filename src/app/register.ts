/**
 * Ce que la réponse d'une commande dit de **l'annonce**, et pourquoi il faut le lire.
 *
 * **Les rôles sont inversés : la machine est le client HTTP.** Poser une commande dans la file ne la
 * lui envoie pas — il faut d'abord lui annoncer notre adresse (`local_reg`), après quoi c'est ELLE
 * qui vient chercher la trame. Si l'annonce n'arrive pas, la commande reste dans la file et la
 * machine n'en sait rien.
 *
 * Or `POST /api/command` répond `{ program, register: { ok: false, error } }` dans ce cas, et les
 * deux pages qui envoient des commandes ne lisaient que `error` — jamais `register`. Elles
 * affichaient donc « Commande envoyée : Allumer » pendant que le journal enregistrait quarante
 * échecs d'annonce d'affilée et que la cafetière restait éteinte. C'est le défaut relevé sur la
 * machine réelle : le geste marchait, le serveur avait bien construit la trame, et rien à l'écran
 * ne disait que l'appareil n'avait jamais été joint.
 *
 * Le message technique (« socket hang up ») **reste au journal** : ce qui remonte ici est une cause,
 * pas une chaîne de protocole.
 */

/** La cause d'un échec d'annonce, ou `null` si l'annonce est passée (ou n'a rien à dire). */
export function echecAnnonce(r: unknown): string | null {
  const reg = (r as { register?: { ok?: boolean; error?: unknown } } | null)?.register;
  if (!reg || reg.ok !== false) return null;
  // Toute cause inconnue retombe sur « injoignable » : mieux vaut la phrase générique que le
  // silence, qui est précisément ce qu'on corrige.
  return typeof reg.error === "string" && reg.error ? reg.error : "unreachable";
}

/**
 * La clé de message correspondante, dans l'espace `common`.
 *
 * `machineIp` et `serverIp` sont normalement pré-empés par le garde 409 côté serveur — ils sont
 * traités quand même : un prérequis qui disparaît entre le garde et l'annonce ne doit pas produire
 * une phrase vide.
 */
export function cleAnnonce(cause: string): string {
  if (cause === "dns") return "regDns";
  if (cause === "machineIp") return "regNoAddress";
  if (cause === "serverIp") return "regServerIp";
  return "regUnreachable";
}
