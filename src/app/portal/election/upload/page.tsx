"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  submitElectionResultWithEvidence,
  getElectionCycles,
  getContestsByCycle,
  getPoliticalParties,
  getElectionSettings,
} from "@/lib/firebase/election";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { getAllLGAs } from "@/lib/constants";
import type {
  LGA,
  ElectionCycle,
  ElectionContest,
  PoliticalParty,
} from "@/types";
import {
  Upload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
  Vote,
  ShieldAlert,
} from "lucide-react";

export default function ElectionUploadPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;

    if (!profile) {
      router.replace("/portal/auth/login");
      return;
    }

    const isSocialOnly =
      profile?.membership_types?.includes("social_member") &&
      !profile?.membership_types?.includes("campaign_member") &&
      profile.access_role !== "election_officer" &&
      profile.access_role !== "admin" &&
      profile.access_role !== "tenant_super_admin" &&
      profile.access_role !== "platform_super_admin";

    if (isSocialOnly) {
      router.replace("/portal/dashboard");
    }
  }, [profile, authLoading, router]);

  const isAdminOrElectionOfficer =
    profile?.access_role === "admin" ||
    profile?.access_role === "tenant_super_admin" ||
    profile?.access_role === "platform_super_admin" ||
    profile?.access_role === "election_officer";

  const [lgas, setLgas] = useState<LGA[]>([]);
  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [allParties, setAllParties] = useState<PoliticalParty[]>([]);

  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [selectedContestId, setSelectedContestId] = useState<string>("");

  const [form, setForm] = useState({
    lga_id: profile?.lga_id ?? "nkanu-west",
    ward_id: isAdminOrElectionOfficer ? "" : (profile?.ward_id ?? ""),
    polling_unit_id: isAdminOrElectionOfficer
      ? ""
      : (profile?.polling_unit_id ?? ""),
  });

  // Dynamic party vote entries based on active contest configuration
  const [partyVotes, setPartyVotes] = useState<Record<string, number>>({});

  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // Load LGAs, Cycles, Contests, Parties & Active Settings
  useEffect(() => {
    async function initData() {
      try {
        const lgaData = await getAllLGAs();
        setLgas(lgaData);

        const loadedSettings = await getElectionSettings();
        const loadedCycles = await getElectionCycles();
        setCycles(loadedCycles);

        const defaultCycleId =
          loadedSettings?.active_election_cycle_id ||
          loadedCycles[0]?.id ||
          "general-election-2027";
        setSelectedCycleId(defaultCycleId);

        const loadedContests = await getContestsByCycle(defaultCycleId);
        setContests(loadedContests);

        const activeContestId =
          loadedSettings?.active_contest_id || loadedContests[0]?.id || "";
        setSelectedContestId(activeContestId);

        const loadedParties = await getPoliticalParties();
        setAllParties(loadedParties);
      } catch (err) {
        console.error("Failed to load upload configuration:", err);
      } finally {
        setLoadingConfig(false);
      }
    }
    initData();
  }, []);

  // Update contests when cycle changes
  useEffect(() => {
    if (!selectedCycleId) return;
    getContestsByCycle(selectedCycleId).then((cList) => {
      setContests(cList);
      if (cList.length > 0 && !cList.some((c) => c.id === selectedContestId)) {
        setSelectedContestId(cList[0].id);
      }
    });
  }, [selectedCycleId]);

  // Selected Contest Details & Tracked Parties
  const currentContest = contests.find((c) => c.id === selectedContestId);
  const currentCycle = cycles.find((c) => c.id === selectedCycleId);

  const trackedPartiesList = currentContest?.tracked_parties ?? [];

  const trackedPartyObjects = trackedPartiesList.map((pid) => {
    const pObj = allParties.find(
      (p) => p.id === pid.toLowerCase() || p.acronym.toLowerCase() === pid.toLowerCase()
    );
    return (
      pObj || {
        id: pid,
        acronym: pid.toUpperCase(),
        name: pid.toUpperCase(),
        inec_registered: true,
        status: "active" as const,
      }
    );
  });

  // Reset/Initialize party vote object when contest changes
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!currentContest) return;
    const initialVotes: Record<string, number> = {};
    for (const p of trackedPartyObjects) {
      initialVotes[p.id] = 0;
    }
    setPartyVotes(initialVotes);
  }, [selectedContestId, currentContest, trackedPartyObjects]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectedLga = lgas.find((lga) => lga.id === form.lga_id);
  const wards = selectedLga?.wards ?? [];

  const selectedWard = wards.find((ward) => ward.id === form.ward_id);
  const pollingUnits = selectedWard?.pollingUnits ?? [];

  // Resolved names for member reporting area
  const memberLga = lgas.find((lga) => lga.id === (profile?.lga_id ?? "nkanu-west"));
  const memberWard = memberLga?.wards.find((w) => w.id === profile?.ward_id);
  const memberPollingUnit = memberWard?.pollingUnits.find(
    (pu) => pu.id === profile?.polling_unit_id,
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
    setError("");
    setMessage("");

    if (!selectedContestId || !currentContest) {
      setError("Active Election Contest is required.");
      return;
    }

    if (!form.ward_id || !form.polling_unit_id) {
      setError("Ward and polling unit are required.");
      return;
    }

    if (!evidenceFile) {
      setError("Form EC8 / official result sheet photo evidence is required.");
      return;
    }

    // Non-privileged users can only submit for their own registered ward/PU
    if (!isAdminOrElectionOfficer) {
      if (
        form.ward_id !== profile?.ward_id ||
        form.polling_unit_id !== profile?.polling_unit_id
      ) {
        setError(
          "You can only submit results for your registered ward and polling unit.",
        );
        return;
      }
    }

    // Validate polling unit belongs to contest scope
    const parentLgaId = form.lga_id;
    if ((currentContest.scope_type as string) === "lga") {
      if (
        parentLgaId &&
        currentContest.scope_id &&
        parentLgaId.toLowerCase() !== currentContest.scope_id.toLowerCase()
      ) {
        setError("This polling unit is not within the scope of the selected contest.");
        return;
      }
    } else if (
      currentContest.scope_type === "federal_constituency" ||
      currentContest.scope_type === "state_constituency"
    ) {
      if (
        currentContest.lga_ids &&
        currentContest.lga_ids.length > 0 &&
        parentLgaId &&
        !currentContest.lga_ids.some(
          (id) => id.toLowerCase() === parentLgaId.toLowerCase()
        )
      ) {
        setError("This polling unit is not within the scope of the selected contest.");
        return;
      }
    }

    // Format party vote payload
    const formattedResults = Object.entries(partyVotes)
      .map(([party, votes]) => ({ party, votes: Number(votes) || 0 }))
      .filter((r) => r.votes > 0);

    if (formattedResults.length === 0) {
      setError("Please enter at least one valid non-zero party vote count.");
      return;
    }

    setSubmitting(true);
    try {
      // 1. Upload Form EC8 image to Cloudinary (folder: "ifeanyi-2027/election-results")
      let cloudinaryUrl: string | null = null;
      try {
        cloudinaryUrl = await uploadToCloudinary(
          evidenceFile,
          "ifeanyi-2027/election-results"
        );
      } catch (uploadErr: unknown) {
        const err = uploadErr as Error;
        console.error("Cloudinary upload error:", uploadErr);
        throw new Error(err.message || "Failed to upload Form EC8 image.");
      }

      if (!cloudinaryUrl) {
        throw new Error("Form EC8 photo upload failed. Please try again.");
      }

      // 2. Submit contest-aware result + evidence metadata to Firestore
      await submitElectionResultWithEvidence({
        electionCycleId: selectedCycleId,
        contestId: selectedContestId,
        contestType: currentContest.contest_type,
        contestScope: {
          scope_type: currentContest.scope_type,
          scope_id: currentContest.scope_id,
        },
        lgaId: form.lga_id,
        wardId: form.ward_id,
        pollingUnitId: form.polling_unit_id,
        stateId: currentContest.state_id || "enugu-state",
        senatorialZoneId: currentContest.senatorial_zone_id || null,
        results: formattedResults,
        userId: profile?.id || "unknown",
        cloudinaryUrl,
      });

      setMessage(
        `Results for ${currentContest.name} & Form EC8 evidence submitted successfully! They enter the Election Officer review queue.`
      );
      setEvidenceFile(null);
      setEvidencePreview(null);
    } catch (err: unknown) {
      const errorObj = err as Error;
      console.error("Submission failed:", err);
      setError(errorObj.message || "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingConfig) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-3">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <p className="text-sm text-gray-500">Loading Election Configuration...</p>
      </div>
    );
  }

  if (contests.length === 0) {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">No Open Contests Active</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          No open election contests are currently active for result collation. Please check back later or contact your Campaign Administrator.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <div>
        <div className="flex items-center gap-2 text-apc-primary font-semibold text-xs tracking-wide uppercase mb-1">
          <Vote className="w-4 h-4" />
          <span>ELECTION OPERATIONS DESK</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">
          Upload Polling Unit Result & Form EC8 Evidence
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Submit official polling-unit result sheets for active election contests.
        </p>
      </div>

      {/* Prominent Election & Contest Header Specs (Sec 20 Requirement) */}
      <div className="bg-slate-900 text-white p-5 rounded-2xl shadow-md space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700 pb-3">
          <div>
            <span className="text-xs uppercase text-slate-400 block">
              Election Cycle
            </span>
            <span className="font-bold text-base text-white">
              {currentCycle?.name || "2027 General Election"}
            </span>
          </div>

          <div>
            <span className="text-xs uppercase text-slate-400 block">
              Active Contest
            </span>
            <span className="font-bold text-base text-apc-light">
              {currentContest?.name || "Select Contest"}
            </span>
          </div>

          <div>
            <span className="text-xs uppercase text-slate-400 block">
              Scope / Constituency
            </span>
            <span className="font-mono text-xs bg-slate-800 px-2.5 py-1 rounded text-emerald-400">
              {currentContest?.scope_type}: {currentContest?.scope_id}
            </span>
          </div>
        </div>

        {/* Contest Switchers */}
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
            <label className="text-slate-300 block mb-1">
              Select Open Contest:
            </label>
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

      {!isAdminOrElectionOfficer && (
        <div className="p-4 bg-apc-light text-apc-primary rounded-xl border border-apc-primary/20 text-xs space-y-1">
          <p className="font-bold text-sm">Your Registered Polling Unit Scope</p>
          <p>
            <span className="font-semibold">LGA:</span>{" "}
            {memberLga ? memberLga.name : "Not set"} |{" "}
            <span className="font-semibold">Ward:</span>{" "}
            {memberWard ? `${memberWard.code} — ${memberWard.name}` : "Not set"} |{" "}
            <span className="font-semibold">Polling Unit:</span>{" "}
            {memberPollingUnit
              ? `${memberPollingUnit.code} — ${memberPollingUnit.name}`
              : "Not set"}
          </p>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 sm:p-8 space-y-6"
      >
        {/* Geographic Location Selection */}
        {isAdminOrElectionOfficer ? (
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                LGA *
              </label>
              <select
                value={form.lga_id}
                onChange={(e) =>
                  setForm({
                    ...form,
                    lga_id: e.target.value,
                    ward_id: "",
                    polling_unit_id: "",
                  })
                }
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary text-xs"
                required
              >
                <option value="">Select LGA</option>
                {lgas.map((lga) => (
                  <option key={lga.id} value={lga.id}>
                    {lga.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                Ward *
              </label>
              <select
                value={form.ward_id}
                onChange={(e) =>
                  setForm({
                    ...form,
                    ward_id: e.target.value,
                    polling_unit_id: "",
                  })
                }
                disabled={!form.lga_id}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary disabled:bg-gray-100 text-xs"
                required
              >
                <option value="">
                  {form.lga_id ? "Select ward" : "Select an LGA first"}
                </option>
                {wards.map((ward) => (
                  <option key={ward.id} value={ward.id}>
                    {ward.code} — {ward.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                Polling Unit *
              </label>
              <select
                value={form.polling_unit_id}
                onChange={(e) =>
                  setForm({ ...form, polling_unit_id: e.target.value })
                }
                disabled={!form.ward_id}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary disabled:bg-gray-100 text-xs"
                required
              >
                <option value="">
                  {form.ward_id ? "Select polling unit" : "Select a ward first"}
                </option>
                {pollingUnits.map((pu) => (
                  <option key={pu.id} value={pu.id}>
                    {pu.code} — {pu.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Ward
              </label>
              <input
                type="text"
                readOnly
                value={memberWard ? `${memberWard.code} — ${memberWard.name}` : form.ward_id}
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
                value={memberPollingUnit ? `${memberPollingUnit.code} — ${memberPollingUnit.name}` : form.polling_unit_id}
                className="w-full px-3 py-2 border bg-gray-50 rounded-lg text-xs font-medium"
              />
            </div>
          </div>
        )}

        {/* Form EC8 Evidence Photo Upload */}
        <div className="border-t pt-6">
          <label className="block text-sm font-semibold text-gray-900 mb-1">
            Official Form EC8 Result Sheet Evidence Photo *
          </label>
          <p className="text-xs text-gray-500 mb-3">
            Upload a clear photo of the signed Form EC8 result document for this polling unit.
          </p>

          <div className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-xl p-6 bg-gray-50 hover:bg-gray-100/50 transition-colors">
            {evidencePreview ? (
              <div className="relative w-full aspect-video rounded-lg overflow-hidden border mb-3 bg-slate-900">
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
              accept="image/jpeg,image/png,image/webp"
              onChange={handleImageChange}
              required={!evidenceFile}
              className="text-xs text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-apc-primary file:text-white hover:file:bg-apc-dark cursor-pointer"
            />
          </div>
        </div>

        {/* Dynamic Party Vote Inputs (Spec Section 21) */}
        <div className="border-t pt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold text-apc-primary">
              Party Vote Input Fields ({trackedPartyObjects.length} Tracked Parties)
            </h3>
            <span className="text-xs text-gray-500">
              Dynamically loaded from Contest Config
            </span>
          </div>

          {trackedPartyObjects.length === 0 ? (
            <div className="p-4 bg-amber-50 text-amber-900 border border-amber-200 rounded-xl text-xs font-semibold">
              No tracked parties configured for this contest. Contact the election administrator.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {trackedPartyObjects.map((party) => (
                <div key={party.id} className="p-3 bg-gray-50 rounded-xl border border-gray-200">
                  <label className="block text-xs font-bold text-gray-800 uppercase mb-1">
                    {party.acronym} — {party.name}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={partyVotes[party.id] ?? 0}
                    onChange={(e) =>
                      setPartyVotes({
                        ...partyVotes,
                        [party.id]: parseInt(e.target.value) || 0,
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary text-sm font-mono font-bold"
                    placeholder="0"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 p-4 bg-red-50 text-red-700 rounded-lg border border-red-200 text-xs font-medium">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {message && (
          <div className="flex items-center gap-2 p-4 bg-green-50 text-green-700 rounded-lg border border-green-200 text-xs font-medium">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || trackedPartyObjects.length === 0}
          className="w-full bg-apc-primary text-white py-3 rounded-xl font-bold hover:bg-apc-dark transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
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
