/**
 * POLITICORE — Native session resolution (Core Identity/Auth Phase 1).
 *
 * Formerly the Firebase → Supabase token bridge (`signInWithIdToken`);
 * that exchange is OBSOLETE and was removed with the Core Identity/Auth
 * cutover. The module remains under its historical name-free contract
 * for its 23 locked-module consumers:
 *
 *   const bridge = await ensureSupabaseSession();
 *   if (!bridge.sessionReady) { ...denied... }
 *   const supabase = bridge.supabase ?? getSupabaseClient();
 *
 * The implementation resolves the NATIVE Supabase session (auto-refresh
 * keeps it alive; AuthContext creates the session at login). There is
 * no Firebase dependency, no token exchange, and no fallback — the
 * same fail-closed semantics on a missing session.
 */
import { getSupabaseClient, isSupabaseConfigured } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BridgeResult {
  supabase: SupabaseClient;
  /** True when a Supabase session exists. */
  sessionReady: boolean;
  /** Human-safe reason when sessionReady is false. */
  reason: "not_configured" | "no_session" | null;
}

/**
 * Ensure a Supabase session exists for the current user. Safe to call on
 * every render/effect: resolves the existing native session without
 * side effects (no exchange, no refresh beyond the client's own
 * auto-refresh). Fails CLOSED when unauthenticated — never falls back.
 */
export async function ensureSupabaseSession(): Promise<BridgeResult> {
  const notConfigured = (): BridgeResult => ({
    supabase: null as unknown as SupabaseClient,
    sessionReady: false,
    reason: "not_configured",
  });

  if (!isSupabaseConfigured()) return notConfigured();

  const supabase = getSupabaseClient();

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    return { supabase, sessionReady: true, reason: null };
  }

  // No native session — the user is not authenticated. Fail closed.
  return { supabase, sessionReady: false, reason: "no_session" };
}
