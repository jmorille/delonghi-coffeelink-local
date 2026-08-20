"use client";
import { useTranslations } from "next-intl";

/**
 * Traduction des libellés qui viennent du serveur.
 *
 * Le serveur envoie des **identifiants stables du protocole** — `slug` pour une boisson
 * (`espresso`, `capp_reverse`…), `name` pour un paramètre (l'énum ECAM : `COFFEE`, `TASTE`…) —
 * et un libellé de secours. C'est le client qui traduit, à partir de ces identifiants : rien
 * de traduisible ne traverse l'API.
 *
 * ⚠️ Un nom saisi sur la machine (`machineName` : « Mon latte », « Grain A ») n'est **jamais**
 * traduit : c'est une donnée utilisateur, pas une chaîne d'interface.
 */
export function useBeverageLabel() {
  const t = useTranslations("beverage");
  return (bev: { slug: string; machineName?: string | null; factoryName?: string; label?: string }) =>
    bev.machineName ?? (t.has(bev.slug) ? t(bev.slug) : (bev.label ?? bev.factoryName ?? bev.slug));
}

export function useParamLabel() {
  const t = useTranslations("param");
  return (p: { name?: string; label?: string; id?: number }) =>
    p.name && t.has(p.name) ? t(p.name) : (p.label ?? p.name ?? `#${p.id ?? "?"}`);
}

export function useUnitLabel() {
  const t = useTranslations("unit");
  return (unit: string) => (unit && t.has(unit) ? t(unit) : unit);
}

export function useCategoryLabel() {
  const t = useTranslations("category");
  return (key: string, fallback: string) => (t.has(key) ? t(key) : fallback);
}
