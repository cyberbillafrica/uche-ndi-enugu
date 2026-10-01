"use client";

import { useState } from "react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { Search, Loader2 } from "lucide-react";
import {
  trackPublicRequest,
  PublicIntakeError,
  type PublicTrackedRequest,
} from "@/lib/supabase";

/**
 * POLITICORE — PUBLIC CASE TRACKING (Phase 10, first slice).
 *
 * Reference + tracking-secret lookup through the narrow SECURITY DEFINER
 * RPC (0037). No reference-only lookup exists anywhere — the reference is
 * an identifier, the secret is the credential. The projection shows the
 * high-level status and PUBLIC lifecycle events only; internal events,
 * staff responses, assignments, and staff identity are structurally
 * unreachable (gate §E).
 */
export default function PublicTrackPage() {
  const [reference, setReference] = useState("");
  const [secret, setSecret] = useState("");
  const [result, setResult] = useState<PublicTrackedRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTrack = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      setResult(await trackPublicRequest(reference, secret));
    } catch (err) {
      setError(
        err instanceof PublicIntakeError
          ? err.message
          : "We couldn't look up that case. Check the reference and tracking secret."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-between">
      <div>
        <Header />
        <main className="max-w-2xl mx-auto px-4 py-16">
          <div className="flex items-center gap-3 mb-2">
            <Search className="h-8 w-8 text-brand-primary" />
            <h1 className="text-4xl font-bold text-brand-primary">
              Track a Request
            </h1>
          </div>
          <p className="text-gray-600 mb-8">
            Enter your reference number and the tracking secret you received
            when you filed your request.
          </p>

          <form
            onSubmit={handleTrack}
            className="bg-white rounded-xl shadow-sm p-6 space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reference number *
              </label>
              <input
                type="text"
                required
                placeholder="GR-2026-XXXXXXXX"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tracking secret *
              </label>
              <input
                type="password"
                required
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-primary"
              />
            </div>
            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center justify-center rounded-lg bg-brand-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary transition-colors disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Track Request"
              )}
            </button>
          </form>

          {result && (
            <div className="bg-white rounded-xl shadow-sm p-6 mt-8 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xl font-mono font-bold text-gray-900">
                  {result.referenceCode}
                </p>
                <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-800">
                  {result.status.replace(/_/g, " ")}
                </span>
              </div>
              <p className="text-sm text-gray-500">
                Filed {new Date(result.createdAt).toLocaleDateString()}
              </p>

              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">
                  Progress
                </h3>
                <ol className="space-y-3">
                  {result.events.map((ev, i) => (
                    <li key={i} className="flex gap-3 text-sm">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-green-500" />
                      <div>
                        <p className="font-medium text-gray-900">
                          {ev.kind.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-gray-500">
                          {new Date(ev.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </main>
      </div>
      <Footer />
    </div>
  );
}
