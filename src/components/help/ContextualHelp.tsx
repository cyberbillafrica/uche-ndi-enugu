"use client";

import { useState } from "react";
import { HelpCircle, X, BookOpen, ShieldCheck, Vote, Users, CheckSquare, Banknote } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

export default function ContextualHelp() {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);

  if (!profile) return null;

  const role = profile.access_role;

  return (
    <>
      {/* Floating Help Button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 left-5 z-40 bg-apc-primary text-white p-3 rounded-full shadow-xl hover:bg-apc-dark transition-transform hover:scale-105 flex items-center gap-2 text-xs font-bold"
        title="Portal Guidance & Help"
      >
        <HelpCircle className="h-5 w-5" />
        <span className="hidden sm:inline">Portal Guidance</span>
      </button>

      {/* Help Modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2 text-apc-primary">
                <BookOpen className="h-5 w-5" />
                <h3 className="text-lg font-bold text-gray-900">
                  {role === "admin"
                    ? "Administrator System Guidance"
                    : role === "election_officer"
                    ? "Election Officer Operations Help"
                    : "Campaign Member Guidance"}
                </h3>
              </div>
              <button onClick={() => setOpen(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            <div className="space-y-4 text-xs text-gray-700">
              {/* Role-Specific Guidance */}
              {role === "admin" && (
                <div className="p-3 bg-blue-50 rounded-xl border border-blue-200 space-y-2">
                  <p className="font-bold text-blue-900 flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4" /> Administrative Responsibilities
                  </p>
                  <p>
                    As an admin, you have access to campaign settings, task management, candidate donation ledger, member lifecycle status updates, and election configuration.
                  </p>
                </div>
              )}

              {role === "election_officer" && (
                <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 space-y-2">
                  <p className="font-bold text-amber-900 flex items-center gap-1.5">
                    <Vote className="h-4 w-4" /> Officer Operations Desk
                  </p>
                  <p>
                    Verify submitted Form EC8 polling unit results against uploaded photo evidence. You can approve, reject, or request clarification on submitted results.
                  </p>
                </div>
              )}

              {/* Core Feature Modules Guidance */}
              <div className="space-y-3 pt-2">
                <div className="p-3 bg-gray-50 rounded-xl border space-y-1">
                  <p className="font-bold text-gray-900 flex items-center gap-1">
                    <CheckSquare className="h-4 w-4 text-apc-primary" /> Tasks & Point System
                  </p>
                  <p>
                    Complete active social tasks (likes, shares, comments), submit your proof URL when required, and earn social points for campaign rank.
                  </p>
                </div>

                <div className="p-3 bg-gray-50 rounded-xl border space-y-1">
                  <p className="font-bold text-gray-900 flex items-center gap-1">
                    <Vote className="h-4 w-4 text-emerald-600" /> Election Result Upload
                  </p>
                  <p>
                    Submit polling unit results for your registered location. Ensure you attach a clear Form EC8 photo. Results are verified by Election Officers before affecting official totals.
                  </p>
                </div>

                <div className="p-3 bg-gray-50 rounded-xl border space-y-1">
                  <p className="font-bold text-gray-900 flex items-center gap-1">
                    <Banknote className="h-4 w-4 text-emerald-700" /> Candidate Donation Ledger
                  </p>
                  <p>
                    Private administrative record-keeping for externally received contributions and pledges. Money is NOT collected through this application.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t pt-3 flex justify-end">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 bg-apc-primary text-white font-bold rounded-lg text-xs hover:bg-apc-dark"
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
