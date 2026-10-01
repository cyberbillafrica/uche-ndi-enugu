"use client";

/**
 * POLITICORE — Result Submission (Phase 2 cutover: PostgreSQL/Supabase).
 *
 * The §9 flow end-to-end:
 *   1. active cycle + contest from election_settings (§8, no fallback);
 *   2. PU identified via the relational geography services (§18 — the
 *      server re-derives all geography from the PU id);
 *   3. the contest BALLOT is the candidate list (§6 — party_id identity);
 *   4. vote counts validated client-side for usability only (the RPC is
 *      the security boundary);
 *   5. evidence uploaded through the Media Service route (R2, §10);
 *   6. submit_election_result RPC; the authoritative resulting state is
 *      displayed (resubmission rules enforced by the database, §11).
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { HelpLink } from "@/components/help/HelpLink";
import {
  electionErrorMessage,
  getSupabaseClient,
  ensureSupabaseSession,
  resolveElectionAccess,
  getActiveElection,
  getElectionCycles,
  getContestsByCycle,
  getCandidatesByContest,
  getPoliticalParties,
  submitElectionResult,
  uploadElectionEvidence,
} from "@/lib/supabase";
import { listWards, listPollingUnits, listLgas } from "@/lib/supabase/geography";
import {
  Upload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
  Vote,
  ShieldAlert,
} from "lucide-react";
import type {
  ElectionCandidate,
  ElectionContest,
  ElectionCycle,
  PoliticalParty,
} from "@/types";

interface BallotEntry {
  party_id: string;
  acronym: string;
  name: string;
  votes: number;
}

interface GeoOption {
  id: string;
  name: string;
  code?: string;
}

export default function ElectionUploadPage() {
  const router = useRouter();
  const toast = useToast();

  const [gate, setGate] = useState<"loading" | "denied" | "no_session" | "ready">("loading");
  const [tenantWide, setTenantWide] = useState(false);
  const [registered, setRegistered] = useState<{ wardId: string | null; puId: string | null }>({
    wardId: null,
    puId: null,
  });

  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [parties, setParties] = useState<PoliticalParty[]>([]);
  const [candidates, setCandidates] = useState<ElectionCandidate[]>([]);

  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [selectedContestId, setSelectedContestId] = useState<string>("");

  // Geography cascade (relational geography, §18)
  const [lgaChoices, setLgaChoices] = useState<GeoOption[]>([]);
  const [lgaId, setLgaId] = useState<string>("");
  const [wards, setWards] = useState<GeoOption[]>([]);
  const [wardId, setWardId] = useState<string>("");
  const [pollingUnits, setPollingUnits] = useState<GeoOption[]>([]);
  const [pollingUnitId, setPollingUnitId] = useState<string>("");

  const [ballot, setBallot] = useState<BallotEntry[]>([]);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [submittedState, setSubmittedState] = useState<string | null>(null);

  // ── access gate ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bridge = await ensureSupabaseSession();
      if (cancelled) return;
      if (!bridge.sessionReady) {
        setGate(bridge.reason === "no_session" ? "no_session" : "denied");
        setLoadingConfig(false);
        return;
      }
      const supabase = bridge.supabase ?? getSupabaseClient();
      // Upload requires Election authority (officer/admin/scope/registered member).
      const access = await resolveElectionAccess(supabase, { requireAuthority: true });
      if (cancelled) return;
      if (!access.allowed) {
        setGate("denied");
        setLoadingConfig(false);
        return;
      }
      setTenantWide(access.tenantWide);
      setRegistered({ wardId: access.wardId, puId: access.pollingUnitId });
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ── active election + parties (§8) ─────────────────────────────────
  useEffect(() => {
    if (gate !== "ready") return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      try {
        const [active, partyList] = await Promise.all([
          getActiveElection(supabase),
          getPoliticalParties(supabase),
        ]);
        if (cancelled) return;
        setParties(partyList);
        if (!active.cycle || !active.contest) {
          setLoadingConfig(false);
          return;
        }
        const cycs = await getElectionCycles(supabase);
        if (cancelled) return;
        setCycles(cycs);
        setSelectedCycleId(active.cycle.id);
        const cList = await getContestsByCycle(active.cycle.id, supabase);
        if (cancelled) return;
        setContests(cList);
        setSelectedContestId(active.contest.id);
      } catch (err) {
        console.error("Failed to load upload configuration:", err);
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  // ── cycle switch: reload contests ──────────────────────────────────
  useEffect(() => {
    if (gate !== "ready" || !selectedCycleId) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      const cList = await getContestsByCycle(selectedCycleId, supabase).catch(() => []);
      if (cancelled) return;
      setContests(cList);
      if (cList.length > 0 && !cList.some((c) => c.id === selectedContestId)) {
        setSelectedContestId(cList[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCycleId, gate]);

  // ── contest switch: load the contest BALLOT (§6/§9 step 4) ─────────
  const currentContest = contests.find((c) => c.id === selectedContestId) ?? null;
  const currentCycle = cycles.find((c) => c.id === selectedCycleId) ?? null;

  useEffect(() => {
    if (gate !== "ready" || !selectedContestId) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      const cands = await getCandidatesByContest(selectedContestId, supabase).catch(() => []);
      if (cancelled) return;
      setCandidates(cands);
      // Ballot = contest candidates (party_id authoritative; acronym/name display only).
      const byParty = new Map<string, ElectionCandidate>();
      for (const c of cands) if (!byParty.has(c.party_id)) byParty.set(c.party_id, c);
      setBallot(
        Array.from(byParty.values()).map((c) => {
          const p = parties.find((pp) => pp.id === c.party_id);
          return {
            party_id: c.party_id,
            acronym: p?.acronym ?? c.candidate_name,
            name: p?.name ?? c.candidate_name,
            votes: 0,
          };
        })
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedContestId, gate, parties]);

  // ── LGA choices for tenant-wide submitters (UX hint only — the RPC
  //    re-validates PU ∈ contest.scope authoritatively, §19) ──────────
  useEffect(() => {
    if (gate !== "ready" || !tenantWide) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      const all = await listLgas({}, supabase).catch(() => []);
      if (cancelled) return;
      const scopeLgas: string[] =
        (currentContest as unknown as { lga_ids?: string[] } | null)?.lga_ids ?? [];
      setLgaChoices(scopeLgas.length > 0 ? all.filter((l) => scopeLgas.includes(l.id)) : all);
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, tenantWide, currentContest]);

  // Wards of the selected LGA (the empty-reset lives in the LGA
  // onChange handler, not here, so no synchronous setState in effect)
  useEffect(() => {
    if (!tenantWide || !lgaId) return;
    let cancelled = false;
    (async () => {
      const w = await listWards(lgaId, getSupabaseClient()).catch(() => []);
      if (!cancelled) setWards(w);
    })();
    return () => {
      cancelled = true;
    };
  }, [lgaId, tenantWide]);

  // PUs of the selected ward
  useEffect(() => {
    if (!tenantWide || !wardId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a dependent list when its parent selection empties is synchronous by design
      setPollingUnits([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const pus = await listPollingUnits(wardId, getSupabaseClient()).catch(() => []);
      if (!cancelled) setPollingUnits(pus);
    })();
    return () => {
      cancelled = true;
    };
  }, [wardId, tenantWide]);

  const totalVotes = useMemo(
    () => ballot.reduce((sum, b) => sum + (b.votes || 0), 0),
    [ballot]
  );

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setEvidenceFile(file);
      setEvidencePreview(URL.createObjectURL(file));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentContest) {
      toast.warning("Please select the active election contest first.");
      return;
    }
    if (currentContest.status !== "OPEN") {
      toast.warning(
        `Contest "${currentContest.name}" is ${currentContest.status} and not open for submissions.`
      );
      return;
    }
    if (!pollingUnitId) {
      toast.warning("Please select your polling unit.");
      return;
    }
    if (!evidenceFile) {
      toast.warning(
        "Please attach a clear photo of the Form EC8 / official result sheet — this evidence is required."
      );
      return;
    }
    if (ballot.length === 0) {
      toast.warning("This contest has no candidate ballot configured.");
      return;
    }
    // Usability-only validation; the database is the authority (§9 step 6).
    if (totalVotes === 0) {
      toast.warning("Please enter at least one non-zero party vote count.");
      return;
    }
    if (ballot.some((b) => b.votes < 0)) {
      toast.error("Vote counts must be zero or positive.");
      return;
    }

    setSubmitting(true);
    try {
      // 1. Evidence through the Media Service (R2) — never Cloudinary (§10).
      const { assetId } = await uploadElectionEvidence(evidenceFile);

      // 2. Authoritative submission through the RPC; the DB validates the
      //    ballot, scope, state guard, and returns the resulting state.
      const outcome = await submitElectionResult(getSupabaseClient(), {
        contestId: selectedContestId,
        pollingUnitId,
        votes: ballot.map((b) => ({ party_id: b.party_id, votes: b.votes })),
        evidenceAssetId: assetId,
      });

      setSubmittedState(outcome.status);
      toast.success(
        `Result submitted for ${currentContest.name} — status: ${outcome.status}. It now awaits Election Officer verification.`
      );
      setEvidenceFile(null);
      setEvidencePreview(null);
      setBallot((prev) => prev.map((b) => ({ ...b, votes: 0 })));
    } catch (err) {
      console.error("Submission failed:", err);
      toast.error(
        electionErrorMessage(err, "We couldn't submit the result. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ── render states ──────────────────────────────────────────────────
  if (gate === "loading" || loadingConfig) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-3">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <p className="text-sm text-gray-500">Loading Election Configuration...</p>
      </div>
    );
  }

  if (gate === "no_session") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <AlertCircle className="w-10 h-10 text-amber-500 mx-auto" />
        <h2 className="text-lg font-bold text-gray-900">Sign in required</h2>
        <button
          onClick={() => router.replace("/portal/auth/login")}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-primary text-white"
        >
          Go to sign in
        </button>
      </div>
    );
  }

  if (gate === "denied") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center text-red-600">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">Submission not authorized</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Your account cannot submit election results — you need an Election
          authority (an explicit grant, an organizational scope, or a registered
          polling unit). The database enforces this regardless of the URL.
        </p>
      </div>
    );
  }

  if (contests.length === 0 || !currentContest) {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">No Open Contests Active</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          No open election contests are currently active for result collation.
          Please check back later or contact your administrator.
        </p>
      </div>
    );
  }

  if (submittedState) {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="text-lg font-bold text-gray-900">Result Submitted</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Status: <strong>{submittedState}</strong>. You can resubmit corrections
          while the result is not yet approved; an approved result must be
          reopened by a verifier or corrected by an administrator first.
        </p>
        <button
          onClick={() => setSubmittedState(null)}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-primary text-white"
        >
          Submit another result
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <div>
        <div className="flex items-center gap-2 text-brand-primary font-semibold text-xs tracking-wide uppercase mb-1">
          <Vote className="w-4 h-4" />
          <span>ELECTION OPERATIONS DESK</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-gray-900">
            Upload Polling Unit Result & Form EC8 Evidence
          </h1>
          <HelpLink article="result-upload" label="How to submit" />
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Submit official polling-unit result sheets for active election contests.
        </p>
      </div>

      {/* Active Cycle + Contest header (§7) */}
      <div className="bg-slate-900 text-white p-5 rounded-2xl shadow-md space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700 pb-3">
          <div>
            <span className="text-xs uppercase text-slate-400 block">Election Cycle</span>
            <span className="font-bold text-base text-white">
              {currentCycle?.name || "—"}
            </span>
          </div>
          <div>
            <span className="text-xs uppercase text-slate-400 block">Active Contest</span>
            <span className="font-bold text-base text-brand-surface">
              {currentContest?.name || "Select Contest"}
            </span>
          </div>
          <div>
            <span className="text-xs uppercase text-slate-400 block">
              Scope / Constituency
            </span>
            <span className="font-mono text-xs bg-slate-800 px-2.5 py-1 rounded text-emerald-400">
              {currentContest?.scope_type}: {currentContest?.scope_id || "state-wide"}
            </span>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4 text-xs pt-1">
          <div>
            <label className="text-slate-300 block mb-1">Select Election Cycle:</label>
            <select
              value={selectedCycleId}
              onChange={(e) => setSelectedCycleId(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-white font-medium"
            >
              {cycles.map((cy) => (
                <option key={cy.id} value={cy.id}>
                  {cy.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-slate-300 block mb-1">Select Open Contest:</label>
            <select
              value={selectedContestId}
              onChange={(e) => setSelectedContestId(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-white font-medium"
            >
              {contests.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.contest_type}) — [{c.status}]
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {!tenantWide && (
        <div className="p-4 bg-brand-surface text-brand-primary rounded-xl border border-brand-primary/20 text-xs space-y-1">
          <p className="font-bold text-sm">Your Registered Polling Unit Scope</p>
          <p>
            <span className="font-semibold">Ward:</span> {registered.wardId ?? "Not set"} |{" "}
            <span className="font-semibold">Polling Unit:</span>{" "}
            {registered.puId ?? "Not set"}
          </p>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 sm:p-8 space-y-6"
      >
        {/* Geographic Location Selection (relational geography, §18) */}
        {tenantWide ? (
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">LGA *</label>
              <select
                value={lgaId}
                onChange={(e) => {
                  setLgaId(e.target.value);
                  setWardId("");
                  setWards([]);
                  setPollingUnitId("");
                }}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary text-xs"
                required
              >
                <option value="">Select LGA</option>
                {lgaChoices.map((lga) => (
                  <option key={lga.id} value={lga.id}>
                    {lga.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">Ward *</label>
              <select
                value={wardId}
                onChange={(e) => {
                  setWardId(e.target.value);
                  setPollingUnitId("");
                }}
                disabled={!lgaId}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary disabled:bg-gray-100 text-xs"
                required
              >
                <option value="">{lgaId ? "Select ward" : "Select an LGA first"}</option>
                {wards.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code ? `${w.code} — ${w.name}` : w.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                Polling Unit *
              </label>
              <select
                value={pollingUnitId}
                onChange={(e) => setPollingUnitId(e.target.value)}
                disabled={!wardId}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary disabled:bg-gray-100 text-xs"
                required
              >
                <option value="">{wardId ? "Select polling unit" : "Select a ward first"}</option>
                {pollingUnits.map((pu) => (
                  <option key={pu.id} value={pu.id}>
                    {pu.code ? `${pu.code} — ${pu.name}` : pu.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Ward</label>
              <input
                type="text"
                readOnly
                value={registered.wardId ?? ""}
                className="w-full px-3 py-2 border bg-gray-50 rounded-lg text-xs font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Polling Unit
              </label>
              <input
                type="text"
                readOnly
                value={registered.puId ?? ""}
                className="w-full px-3 py-2 border bg-gray-50 rounded-lg text-xs font-medium"
              />
            </div>
          </div>
        )}

        {/* Form EC8 Evidence Photo Upload — via Media Service (§10) */}
        <div className="border-t pt-6">
          <label className="block text-sm font-semibold text-gray-900 mb-1">
            Official Form EC8 Result Sheet Evidence Photo *
          </label>
          <p className="text-xs text-gray-500 mb-3">
            Upload a clear photo of the signed Form EC8 result document for this
            polling unit. Stored privately; access is via signed URLs only.
          </p>

          <div className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-xl p-6 bg-gray-50 hover:bg-gray-100/50 transition-colors">
            {evidencePreview ? (
              <div className="relative w-full aspect-video rounded-lg overflow-hidden border mb-3 bg-slate-900">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={evidencePreview}
                  alt="Form EC8 Result Sheet"
                  className="w-full h-full object-contain"
                />
              </div>
            ) : (
              <Upload className="h-10 w-10 text-gray-400 mb-2" />
            )}

            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={handleImageChange}
              required={!evidenceFile}
              className="text-xs text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-brand-primary file:text-white hover:file:bg-brand-primary cursor-pointer"
            />
          </div>
        </div>

        {/* Party Vote Inputs — the contest BALLOT (candidates, party_id identity §6) */}
        <div className="border-t pt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold text-brand-primary">
              Party Vote Input Fields ({ballot.length} Contest Candidates)
            </h3>
            <span className="text-xs text-gray-500">Loaded from the contest ballot</span>
          </div>

          {ballot.length === 0 ? (
            <div className="p-4 bg-amber-50 text-amber-900 border border-amber-200 rounded-xl text-xs font-semibold">
              No candidates are registered on this contest&apos;s ballot. Only
              ballot parties can receive votes — contact the election
              administrator.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {ballot.map((entry) => (
                <div
                  key={entry.party_id}
                  className="p-3 bg-gray-50 rounded-xl border border-gray-200"
                >
                  <label className="block text-xs font-bold text-gray-800 uppercase mb-1">
                    {entry.acronym} — {entry.name}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={entry.votes}
                    onChange={(e) =>
                      setBallot((prev) =>
                        prev.map((b) =>
                          b.party_id === entry.party_id
                            ? { ...b, votes: Math.max(0, parseInt(e.target.value) || 0) }
                            : b
                        )
                      )
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary text-sm font-mono font-bold"
                    placeholder="0"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting || ballot.length === 0}
          className="w-full bg-brand-primary text-white py-3 rounded-xl font-bold hover:bg-brand-primary transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Uploading Form EC8 & Registering Submission...</span>
            </>
          ) : (
            <>
              <FileText className="h-4 w-4" />
              <span>Submit Contest Polling Unit Result</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
