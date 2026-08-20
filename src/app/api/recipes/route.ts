/** GET/POST/DELETE /api/recipes — CRUD des recettes stockées. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { listRecipes, upsertRecipe, deleteRecipe, Recipe } from "@/lib/recipes";

export async function GET() {
  return NextResponse.json({ recipes: await listRecipes() });
}

export async function POST(req: NextRequest) {
  const r = (await req.json()) as Recipe;
  if (!r?.id || !r?.name || !r?.beverageId) {
    return NextResponse.json({ error: "champs requis: id, name, beverageId" }, { status: 400 });
  }
  const list = await upsertRecipe({
    id: r.id,
    name: r.name,
    beverageId: Number(r.beverageId),
    profileId: Number(r.profileId ?? 1),
    params: r.params ?? [],
    updatedAt: Date.now(),
  });
  return NextResponse.json({ recipes: list });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
  return NextResponse.json({ recipes: await deleteRecipe(id) });
}
