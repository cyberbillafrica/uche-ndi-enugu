/**
 * POLITICORE — Auth link destinations (Auth Repair).
 *
 * Every Supabase auth email (confirmation, invite, recovery) lands on ONE
 * canonical callback route — /auth/callback — which performs the actual
 * session-establishing verification. This module centralizes:
 *
 *   * the internal destination allowlist used for post-callback routing
 *     (open-redirect defense: only validated internal paths pass), and
 *   * the emailRedirectTo values intended for the Supabase Dashboard
 *     (see docs/AUTH-REPAIR-REPORT.md — the Dashboard allowlist must
 *     acknowledge these exact origins).
 *
 * No token, code or OTP value is ever placed in a route or log here.
 */

/** The canonical email-link callback route. */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/** After recovery verification the user completes the password change. */
export const RESET_PASSWORD_PATH = "/reset-password";

/** After confirmation the user can resume an interrupted onboarding. */
export const ONBOARDING_RESUME_PATH = "/onboarding/resume";

/**
 * Internal destinations a callback may legally navigate to after a
 * verified outcome. Exact matches only — no wildcards, no external
 * origins. `/` (public home) is included for rejected links so an
 * invalid link cannot strand the user.
 */
export const AUTH_REDIRECT_ALLOWLIST = [
  "/",
  "/login",
  "/portal/dashboard",
  "/onboarding",
  "/onboarding/resume",
  "/onboarding/complete",
  "/reset-password",
  "/forgot-password",
] as const;

export type AuthRedirectPath = (typeof AUTH_REDIRECT_ALLOWLIST)[number];

/**
 * Validate a redirect destination from query params etc. Returns an
 * allowlisted internal path or null. Absolute URLs (://, scheme-relative
 * //), encoded bypass attempts, and anything not in the allowlist are
 * rejected. This is the ONLY path-validation helper for auth routing.
 */
export function safeInternalRedirect(
  raw: string | null | undefined,
  fallback: AuthRedirectPath = "/"
): AuthRedirectPath {
  if (typeof raw !== "string") return fallback;
  const candidate = raw.trim();
  if (!candidate) return fallback;

  // Decode once to unmask %2F-style bypass payloads, then re-check.
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    // malformed encoding → reject via the raw candidate below
  }
  for (const value of [candidate, decoded]) {
    // Reject control characters / backslashes (normalization escapes).
    if (/[\u0000-\u001f\u007f\\]/.test(value)) continue;
    // Protocol/scheme-relative and any embedded scheme → reject.
    if (value.includes("://") || value.startsWith("//")) continue;
    // Anything not starting with a single "/" is not an internal path.
    if (!value.startsWith("/")) continue;
    // Directory traversal → reject.
    const segments = value.split(/[?#]/)[0].split("/");
    if (segments.some((s) => s === "..")) continue;
    // Exact allowlist match on the pathname only.
    const match = AUTH_REDIRECT_ALLOWLIST.find(
      (allowed) => value.split(/[?#]/)[0] === allowed
    );
    if (match) return match;
  }
  return fallback;
}

/**
 * Build the canonical callback redirect for Supabase email templates:
 *   {origin}/auth/callback?next={validated-internal-path}
 * `next` is re-validated by the callback handler before use.
 */
export function authCallbackUrl(nextPath?: string): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    const base = `${window.location.origin}${AUTH_CALLBACK_PATH}`;
    return nextPath ? `${base}?next=${encodeURIComponent(safeInternalRedirect(nextPath))}` : base;
  }
  return nextPath
    ? `${AUTH_CALLBACK_PATH}?next=${encodeURIComponent(safeInternalRedirect(nextPath))}`
    : AUTH_CALLBACK_PATH;
}
