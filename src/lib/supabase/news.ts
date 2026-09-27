/**
 * POLITICORE — Canonical News service (Phase 4).
 *
 * News is PUBLIC published content with a full admin lifecycle
 * (draft/published/scheduled/archived) over politicore.news_articles.
 * RLS: anonymous visitors read published rows only; tenant admins manage
 * their tenant's articles. Slugs are unique per tenant among published
 * rows (partial unique index) and unique per tenant overall.
 */

import { getSupabaseClient } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

export type NewsStatus = "draft" | "published" | "scheduled" | "archived";

export interface NewsArticle {
  id: string;
  tenant_id: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  featured_image: string | null;
  category: string | null;
  status: NewsStatus;
  published_at: string | null;
  scheduled_at: string | null;
  author: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewsInput {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  featuredImage: string | null;
  category: string | null;
  status: NewsStatus;
  scheduledAt: string | null;
  author: string | null;
}

/** Public published news (newest first). */
export async function listPublishedNews(
  limitCount = 20,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<NewsArticle[]> {
  const { data, error } = await supabase
    .from("news_articles")
    .select("*")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(limitCount);
  if (error) throw new Error(`news: listPublishedNews failed: ${error.message}`);
  return (data ?? []) as NewsArticle[];
}

/** Full tenant list for management. */
export async function listNews(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<NewsArticle[]> {
  const { data, error } = await supabase
    .from("news_articles")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`news: listNews failed: ${error.message}`);
  return (data ?? []) as NewsArticle[];
}

/** Public slug lookup — published rows only (RLS enforces for non-admins). */
export async function getNewsBySlug(
  slug: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<NewsArticle | null> {
  const { data, error } = await supabase
    .from("news_articles")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .limit(1);
  if (error) throw new Error(`news: getNewsBySlug failed: ${error.message}`);
  return (data?.[0] as NewsArticle) ?? null;
}

export async function createNews(
  input: NewsInput,
  createdBy: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<NewsArticle> {
  const { data, error } = await supabase
    .from("news_articles")
    .insert({
      title: input.title,
      slug: input.slug,
      excerpt: input.excerpt,
      content: input.content,
      featured_image: input.featuredImage,
      category: input.category,
      status: input.status,
      scheduled_at: input.scheduledAt,
      author: input.author,
      published_at: input.status === "published" ? new Date().toISOString() : null,
      created_by: createdBy,
    })
    .select()
    .single();
  if (error) throw new Error(`news: createNews failed: ${error.message}`);
  return data as NewsArticle;
}

export async function updateNews(
  id: string,
  patch: Partial<NewsInput>,
  updatedBy: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const update: Record<string, unknown> = { updated_by: updatedBy };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.slug !== undefined) update.slug = patch.slug;
  if (patch.excerpt !== undefined) update.excerpt = patch.excerpt;
  if (patch.content !== undefined) update.content = patch.content;
  if (patch.featuredImage !== undefined) update.featured_image = patch.featuredImage;
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.scheduledAt !== undefined) update.scheduled_at = patch.scheduledAt;
  if (patch.author !== undefined) update.author = patch.author;
  if (patch.status !== undefined) {
    update.status = patch.status;
    if (patch.status === "published") {
      update.published_at = new Date().toISOString();
    } else if (patch.status === "draft" || patch.status === "archived") {
      update.published_at = null;
    }
  }
  const { error } = await supabase.from("news_articles").update(update).eq("id", id);
  if (error) throw new Error(`news: updateNews failed: ${error.message}`);
}

export async function deleteNews(
  id: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { error } = await supabase.from("news_articles").delete().eq("id", id);
  if (error) throw new Error(`news: deleteNews failed: ${error.message}`);
}

/** Slug generator (preserves the legacy generateSlug contract). */
export function generateNewsSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
