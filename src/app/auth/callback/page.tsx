"use client";

/**
 * POLITICORE — Auth email-link callback (Auth Repair).
 *
 * ONE canonical handler for every Supabase email-link flow:
 *
 *   confirm signup · invite acceptance · password recovery · PKCE code
 *   exchange · implicit/token-hash links
 *
 * The shared Supabase client keeps `detectSessionInUrl: false` for
 * ordinary navigation; verification here is EXPLICIT (verifyOtp on the
 * token-hash template links, exchangeCodeForSession for PKCE). A URL
 * merely containing parameters is never treated as a success.
 *
 * SECURITY: no token/hash/code value is logged or forwarded. Redirect
 * destinations pass safeInternalRedirect (exact allowlist). Invitation
 * membership resolves server-side from the established session — no
 * tenant/role/permission data is accepted from the URL.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { getSupabaseClient } from "@/lib/supabase/config";
import { logOut } from "@/lib/supabase/auth";
import { safeInternalRedirect, RESET_PASSWORD_PATH } from "@/lib/supabase/authLinks";

type CallbackState =
  | { kind: "working" }
  | { kind: "success"; next: string }
  | { kind: "recovery" }
  | { kind: "error"; title: string; message: string };

function CallbackHandler() {
  const search = useSearchParams();
  const router = useRouter();

  /** One attempt per mount, strict-mode safe. */
  const ran = useRef(false);
  const [state, setState] = useState<CallbackState>({ kind: "working" });

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    void (async () => {
      const supabase = getSupabaseClient();

      const tokenHash = search.get("token_hash");
      const type = search.get("type");
      const errorParam = search.get("error");
      const errorDescription = search.get("error_description");

      // 1. Provider-reported failures (expired / already-used links).
      if (errorParam) {
        setState({
          kind: "error",
          title: "Link invalid or expired",
          message:
            errorDescription ??
            "This email link is no longer valid. Request a new one and try again.",
        });
        return;
      }

      // 2. Token-hash verification (the configured template mechanism).
      if (tokenHash && type) {
        const validTypes = [
          "signup",
          "invite",
          "recovery",
          "magiclink",
          "email_change",
          "email",
        ] as const;
        if (!validTypes.includes(type as (typeof validTypes)[number])) {
          setState({
            kind: "error",
            title: "Unsupported verification type",
            message: "This link destination is not recognized.",
          });
          return;
        }

        // Recovery links may arrive while another session exists. The
        // recovery session must replace it — otherwise the recovery
        // context is lost and /reset-password would edit an unrelated
        // already-signed-in account.
        if (type === "recovery") {
          const { data: existing } = await supabase.auth.getSession();
          if (existing.session) {
            try {
              await logOut(supabase);
            } catch {
              /* verification below still proceeds on its own grant */
            }
          }
        }

        const { data, error } = await supabase.auth.verifyOtp({
          type: type as (typeof validTypes)[number],
          token_hash: tokenHash,
        });

        if (error || !data?.session) {
          setState({
            kind: "error",
            title: error?.message?.toLowerCase().includes("expired")
              ? "Link expired"
              : "Verification failed",
            message:
              error?.message ??
              "The link could not be verified. Request a new email and try again.",
          });
          return;
        }

        if (type === "recovery") {
          setState({ kind: "recovery" });
          return;
        }

        // Invite / signup: session established server-side. Destination
        // is the validated internal `next` (default portal dashboard for
        // invites). Profile/tenant context loads through AuthContext.
        const next = safeInternalRedirect(
          search.get("next") ?? "/portal/dashboard",
          "/portal/dashboard"
        );
        setState({ kind: "success", next });
        return;
      }

      // 3. PKCE authorization-code exchange (flow_type = pkce projects).
      const code = search.get("code");
      if (code) {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        if (error || !data?.session) {
          setState({
            kind: "error",
            title: "Link expired",
            message:
              error?.message ??
              "The authorization link could not be completed. Request a new email.",
          });
          return;
        }
        const next = safeInternalRedirect(search.get("next") ?? "/", "/");
        setState({ kind: "success", next });
        return;
      }

      // 4. Nothing verifiable in the URL — malformed/unknown callback.
      setState({
        kind: "error",
        title: "Invalid link",
        message:
          "This authentication link is malformed or incomplete. Start again from the application.",
      });
    })();
  }, [router, search]);

  // ── Verified outcomes navigate after render (no tokens in the URL) ──
  useEffect(() => {
    if (state.kind === "success") {
      router.replace(state.next);
    } else if (state.kind === "recovery") {
      router.replace(`${RESET_PASSWORD_PATH}?recovery=1`);
    }
  }, [state, router]);

  if (state.kind === "working") {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <p className="text-sm text-gray-500">Completing sign-in…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-lg">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
          <AlertCircle className="h-7 w-7 text-red-600" />
        </div>
        <h1 className="text-2xl font-bold text-brand-primary">{state.title}</h1>
        <p className="mt-3 text-gray-600">{state.message}</p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-lg bg-brand-primary px-6 py-3 font-semibold text-white hover:opacity-90"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-lg">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
        <CheckCircle2 className="h-7 w-7 text-emerald-600" />
      </div>
      <h1 className="text-2xl font-bold text-brand-primary">Signed in</h1>
      <p className="mt-3 text-gray-600">Taking you to your destination…</p>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <div className="flex min-h-screen flex-col bg-brand-surface">
      <Header />
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <Suspense
          fallback={
            <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
          }
        >
          <CallbackHandler />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
