/**
 * POLITICORE — Supabase client configuration (Phase 1A foundation).
 *
 * The existing Firebase app is untouched; this is the new foundation the
 * application will adopt module-by-module after Phase 1B approval.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * The publishable (anon) key. Both standard names are accepted because
 * the project environment provisions NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 * (the current Supabase naming) while earlier foundation code referenced
 * NEXT_PUBLIC_SUPABASE_ANON_KEY.
 */
export function getSupabaseAnonKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)."
    );
  }
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}

/** True when Supabase env vars are present (foundation wired but app not migrated). */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && getSupabaseAnonKey()
  );
}
