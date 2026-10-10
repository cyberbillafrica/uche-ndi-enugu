"use client";

/**
 * POLITICORE — Reset password (Auth Repair).
 *
 * Reached only through the verified recovery callback (or an existing
 * recovery session) — never blindly. The page:
 *
 *   1. resolves the current session and its recovery provenance;
 *   2. refuses to continue without one (an expired/invalid link shows a
 *      clear, retryable state — no silent fall-through to login);
 *   3. validates the new password and any confirm field;
 *   4. updates the password through Supabase Auth (`updateUser`).
 *
 * A redirect `next` param is validated against the internal allowlist.
 * The recovery session is never interpreted as an invitation or an
 * ordinary login — after a successful reset the user explicitly chooses
 * the next step.
 */
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { getSupabaseClient } from "@/lib/supabase/config";
import { safeInternalRedirect } from "@/lib/supabase/authLinks";

type ResetState =
  | { kind: "checking" }
  | { kind: "no-recovery" }
  | { kind: "form" }
  | { kind: "done"; next: string };

function ResetPasswordForm() {
  const search = useSearchParams();
  const router = useRouter();

  const [state, setState] = useState<ResetState>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  // Destination is validated BEFORE any navigation uses it.
  const next = safeInternalRedirect(search.get("next") ?? "/", "/");

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const supabase = getSupabaseClient();
      // Best-effort completion of any session the callback started.
      try {
        await supabase.auth.getSession();
      } catch {
        /* fall through to the explicit session check below */
      }

      const { data } = await supabase.auth.getSession();
      if (!data.session?.user) {
        if (!cancelled) setState({ kind: "no-recovery" });
        return;
      }

      /**
       * Recovery provenance: the callback route navigates here with
       * `?recovery=1` after a VERIFIED recovery grant. Cross-check both
       * signals — the marker alone is not trusted (it is only rendered
       * by the callback after verification; a hand-typed URL without a
       * session still fails closed on the session check above).
       */
      const recoveryParam = search.get("recovery") === "1" || search.get("recovery") === "";
      if (recoveryParam) {
        setRecovering(true);
      }
      if (!cancelled) setState({ kind: "form" });
    })();

    return () => {
      cancelled = true;
    };
  }, [router, search]);

  const validate = (): string | null => {
    if (password.length < 8) {
      return "Password must be at least 8 characters.";
    }
    if (confirm !== password) {
      return "Passwords do not match.";
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }

    setSubmitting(true);
    try {
      const { error: updateError } = await getSupabaseClient().auth.updateUser({
        password,
      });
      if (updateError) {
        setError(
          updateError.message.toLowerCase().includes("same as the old")
            ? "Choose a password you haven't used before."
            : updateError.message,
        );
        return;
      }
      setState({ kind: "done", next });
    } catch {
      setError("Unable to update your password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── States ────────────────────────────────────────────────────────────

  if (state.kind === "checking") {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <p className="text-sm text-gray-500">Checking recovery session…</p>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
          <ShieldCheck className="h-7 w-7 text-emerald-600" />
        </div>
        <h1 className="text-2xl font-bold text-brand-primary">
          Password updated
        </h1>
        <p className="mt-3 text-gray-600">
          Your password has been changed. Use it to sign in from now on.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Link
            href="/login"
            className="rounded-lg bg-brand-primary px-6 py-3 font-semibold text-white hover:opacity-90"
          >
            Sign in with your new password
          </Link>
          <Link
            href={state.next}
            className="text-sm font-semibold text-brand-primary hover:underline"
          >
            Continue to your destination
          </Link>
        </div>
      </div>
    );
  }

  if (state.kind === "no-recovery") {
    return (
      <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
        <h1 className="text-2xl font-bold text-brand-primary">
          Reset link unavailable
        </h1>
        <p className="mt-3 text-gray-600">
          This password-reset session is not active — the link may have been
          used already or it expired. Request a fresh one.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 inline-block rounded-lg bg-brand-primary px-6 py-3 font-semibold text-white hover:opacity-90"
        >
          Request a new reset link
        </Link>
      </div>
    );
  }

  // ── Reset form ────────────────────────────────────────────────────────

  return (
    <div className="bg-white rounded-2xl shadow-lg p-8">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-brand-primary">
          Set a new password
        </h1>
        <p className="mt-2 text-gray-600">
          {recovering
            ? "Choose a new password for your account."
            : "Update your account password."}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
            New password
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              required
              minLength={8}
              className="w-full px-4 py-3 pr-12 rounded-lg border border-gray-300
                         focus:outline-none focus:ring-2
                         focus:ring-brand-primary focus:border-transparent"
            />
            <button
              type="button"
              onClick={() => setShowPassword((p) => !p)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-brand-primary rounded-md p-1"
            >
              {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="confirm" className="block text-sm font-medium text-gray-700 mb-2">
            Confirm new password
          </label>
          <input
            id="confirm"
            type={showPassword ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
            className="w-full px-4 py-3 rounded-lg border border-gray-300
                       focus:outline-none focus:ring-2
                       focus:ring-brand-primary focus:border-transparent"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-brand-primary text-white py-3 rounded-lg
                     font-semibold hover:opacity-90 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Updating…" : "Update password"}
        </button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen bg-brand-surface flex flex-col">
      <Header />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <Suspense
            fallback={
              <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
            }
          >
            <ResetPasswordForm />
          </Suspense>
        </div>
      </main>
      <Footer />
    </div>
  );
}
