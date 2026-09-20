"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getAllDonations,
  getAllDonors,
  createDonation,
  updateDonation,
  getDonationAuditLogs,
} from "@/lib/firebase/donations";
import { getAllLGAs } from "@/lib/constants";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import { HelpLink } from "@/components/help/HelpLink";
import type {
  DonationRecord,
  DonorRecord,
  DonationAuditLog,
  DonationStatus,
  DonationSourceMethod,
  LGA,
} from "@/types";
import {
  Plus,
  Search,
  Filter,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
  History,
  Pencil,
  Banknote,
  Users,
  Calendar,
  Layers,
  FileSpreadsheet,
} from "lucide-react";

export default function AdminDonationsPage() {
  const { profile } = useAuth();
  const toast = useToast();
  const [donations, setDonations] = useState<DonationRecord[]>([]);
  const [donors, setDonors] = useState<DonorRecord[]>([]);
  const [lgas, setLgas] = useState<LGA[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [lgaFilter, setLgaFilter] = useState<string>("all");
  const [wardFilter, setWardFilter] = useState<string>("all");

  // Record Modal
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingDonation, setEditingDonation] = useState<DonationRecord | null>(null);
  const [saving, setSaving] = useState(false);

  // Form State
  const [form, setForm] = useState({
    donor_name: "",
    donor_phone: "",
    donor_email: "",
    donor_reference: "",
    amount: "",
    currency: "NGN",
    date_received: new Date().toISOString().split("T")[0],
    payment_method: "bank_transfer" as DonationSourceMethod,
    category: "campaign_fund",
    status: "received" as DonationStatus,
    external_reference: "",
    notes: "",
    lga_id: "",
    ward_id: "",
  });

  // Audit Logs Modal
  const [selectedDonationForAudit, setSelectedDonationForAudit] = useState<DonationRecord | null>(null);
  const [auditLogs, setAuditLogs] = useState<DonationAuditLog[]>([]);
  const [loadingAudits, setLoadingAudits] = useState(false);

  useEffect(() => {
    async function init() {
      setLoading(true);
      try {
        const [dList, donorList, lgaData] = await Promise.all([
          getAllDonations(),
          getAllDonors(),
          getAllLGAs(),
        ]);
        setDonations(dList);
        setDonors(donorList);
        setLgas(lgaData);
      } catch (err) {
        console.error("Failed to load donations ledger:", err);
        toast.error("We couldn't load the donation records. Please refresh the page.");
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // Filtered List
  const filteredDonations = useMemo(() => {
    return donations.filter((d) => {
      const matchSearch =
        d.donor_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (d.external_reference && d.external_reference.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (d.notes && d.notes.toLowerCase().includes(searchTerm.toLowerCase()));

      const matchStatus = statusFilter === "all" || d.status === statusFilter;
      const matchSource = sourceFilter === "all" || d.payment_method === sourceFilter;
      const matchLga = lgaFilter === "all" || d.lga_id === lgaFilter;
      const matchWard = wardFilter === "all" || d.ward_id === wardFilter;

      return matchSearch && matchStatus && matchSource && matchLga && matchWard;
    });
  }, [donations, searchTerm, statusFilter, sourceFilter, lgaFilter, wardFilter]);

  // Analytics Snapshot
  const analytics = useMemo(() => {
    const receivedList = donations.filter((d) => d.status === "received");
    const pledgedList = donations.filter((d) => d.status === "pledged");

    const totalReceived = receivedList.reduce((acc, d) => acc + (Number(d.amount) || 0), 0);
    const totalPledged = pledgedList.reduce((acc, d) => acc + (Number(d.amount) || 0), 0);
    const receivedCount = receivedList.length;
    const uniqueDonorsCount = new Set(receivedList.map((d) => d.donor_name.toLowerCase().trim())).size;
    const avgContribution = receivedCount > 0 ? totalReceived / receivedCount : 0;
    const largestContribution = receivedList.reduce((max, d) => Math.max(max, Number(d.amount) || 0), 0);

    return {
      totalReceived,
      totalPledged,
      receivedCount,
      uniqueDonorsCount,
      avgContribution,
      largestContribution,
    };
  }, [donations]);

  const handleOpenCreate = () => {
    setEditingDonation(null);
    setForm({
      donor_name: "",
      donor_phone: "",
      donor_email: "",
      donor_reference: "",
      amount: "",
      currency: "NGN",
      date_received: new Date().toISOString().split("T")[0],
      payment_method: "bank_transfer",
      category: "campaign_fund",
      status: "received",
      external_reference: "",
      notes: "",
      lga_id: "",
      ward_id: "",
    });
    setShowFormModal(true);
  };

  const handleOpenEdit = (d: DonationRecord) => {
    setEditingDonation(d);
    setForm({
      donor_name: d.donor_name,
      donor_phone: d.donor_phone || "",
      donor_email: d.donor_email || "",
      donor_reference: d.donor_reference || "",
      amount: String(d.amount),
      currency: d.currency || "NGN",
      date_received: d.date_received,
      payment_method: d.payment_method,
      category: d.category,
      status: d.status,
      external_reference: d.external_reference || "",
      notes: d.notes || "",
      lga_id: d.lga_id || "",
      ward_id: d.ward_id || "",
    });
    setShowFormModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.donor_name.trim()) {
      toast.warning("Please enter the donor's name.");
      return;
    }
    const numAmount = Number(form.amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      toast.warning("Please enter a valid positive donation amount.");
      return;
    }

    setSaving(true);

    try {
      if (editingDonation) {
        await updateDonation(
          editingDonation.id,
          {
            donor_name: form.donor_name.trim(),
            donor_phone: form.donor_phone || null,
            donor_email: form.donor_email || null,
            donor_reference: form.donor_reference || null,
            amount: numAmount,
            currency: form.currency,
            date_received: form.date_received,
            payment_method: form.payment_method,
            category: form.category,
            status: form.status,
            external_reference: form.external_reference || null,
            notes: form.notes || null,
            lga_id: form.lga_id || null,
            ward_id: form.ward_id || null,
          },
          profile?.id || "admin",
          profile?.full_name || "Admin User"
        );
        toast.success("Donation record updated successfully.");
      } else {
        await createDonation({
          donor_name: form.donor_name.trim(),
          donor_phone: form.donor_phone || null,
          donor_email: form.donor_email || null,
          donor_reference: form.donor_reference || null,
          amount: numAmount,
          currency: form.currency,
          date_received: form.date_received,
          payment_method: form.payment_method,
          category: form.category,
          status: form.status,
          external_reference: form.external_reference || null,
          notes: form.notes || null,
          lga_id: form.lga_id || null,
          ward_id: form.ward_id || null,
          created_by: profile?.id || "admin",
          created_by_name: profile?.full_name || "Admin User",
        });
        toast.success("Donation recorded in the private ledger.");
      }

      setShowFormModal(false);
      const [updatedDonations, updatedDonors] = await Promise.all([
        getAllDonations(),
        getAllDonors(),
      ]);
      setDonations(updatedDonations);
      setDonors(updatedDonors);
    } catch (err: unknown) {
      console.error("Failed to save donation record:", err);
      toast.error(getErrorMessage(err, "We couldn't save the donation record. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenAuditModal = async (d: DonationRecord) => {
    setSelectedDonationForAudit(d);
    setLoadingAudits(true);
    try {
      const logs = await getDonationAuditLogs(d.id);
      setAuditLogs(logs);
    } catch (err) {
      console.error("Failed to load audit logs:", err);
    } finally {
      setLoadingAudits(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading donation ledger...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-apc-primary mb-1">
            <Banknote className="h-4 w-4" />
            <span>Candidate Contribution Ledger</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
              Donation & Contribution Ledger
            </h1>
            <HelpLink article="donation-ledger" label="Ledger guide" />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Private administrative record-keeping, audit trail, and analytics for candidate campaign contributions.
          </p>
        </div>

        <button
          onClick={handleOpenCreate}
          className="inline-flex items-center gap-2 bg-apc-primary text-white px-4 py-2.5 rounded-xl font-bold text-sm hover:bg-apc-dark transition-colors shadow-sm"
        >
          <Plus className="h-4 w-4" />
          <span>Record Contribution</span>
        </button>
      </div>

      {/* Analytics Snapshot Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-emerald-50/60 border-emerald-200">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">
                  Total Confirmed Received
                </p>
                <p className="text-2xl font-bold font-mono text-emerald-900 mt-1">
                  ₦{analytics.totalReceived.toLocaleString()}
                </p>
                <p className="text-xs text-emerald-700 mt-1 font-medium">
                  From {analytics.receivedCount} received transactions
                </p>
              </div>
              <Banknote className="h-8 w-8 text-emerald-600 shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  Unique Donors
                </p>
                <p className="text-2xl font-bold text-gray-900 mt-1">
                  {analytics.uniqueDonorsCount}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Avg: ₦{Math.round(analytics.avgContribution).toLocaleString()} / donor
                </p>
              </div>
              <Users className="h-8 w-8 text-apc-primary shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-amber-800">
                  Pending Pledges
                </p>
                <p className="text-2xl font-bold font-mono text-amber-900 mt-1">
                  ₦{analytics.totalPledged.toLocaleString()}
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  Not counted in total received income
                </p>
              </div>
              <Calendar className="h-8 w-8 text-amber-600 shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  Largest Single Contribution
                </p>
                <p className="text-2xl font-bold font-mono text-gray-900 mt-1">
                  ₦{analytics.largestContribution.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500 mt-1">Verified record</p>
              </div>
              <Layers className="h-8 w-8 text-slate-600 shrink-0" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filter & Search Toolbar */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            {/* Search */}
            <div className="relative w-full md:w-80">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search donor, reference, or notes..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 border rounded-xl text-xs"
              />
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-600">
                <Filter className="h-3.5 w-3.5" /> Filter:
              </div>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-2.5 py-1.5 border rounded-lg text-xs font-semibold bg-gray-50"
              >
                <option value="all">All Statuses</option>
                <option value="received">Received</option>
                <option value="pledged">Pledged</option>
                <option value="cancelled">Cancelled</option>
              </select>

              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="px-2.5 py-1.5 border rounded-lg text-xs font-semibold bg-gray-50"
              >
                <option value="all">All Payment Sources</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cash">Cash</option>
                <option value="pos">POS</option>
                <option value="cheque">Cheque</option>
                <option value="other">Other</option>
              </select>

              <select
                value={lgaFilter}
                onChange={(e) => {
                  setLgaFilter(e.target.value);
                  setWardFilter("all");
                }}
                className="px-2.5 py-1.5 border rounded-lg text-xs font-semibold bg-gray-50 max-w-[140px] truncate"
              >
                <option value="all">All LGAs</option>
                {lgas.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Ledger Table */}
      <Card>
        <CardHeader>
          <CardTitle>Donation Records Ledger ({filteredDonations.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            {filteredDonations.length === 0 ? (
              <p className="text-center py-8 text-sm text-gray-500">
                No contribution records found matching your current search/filter.
              </p>
            ) : (
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b bg-gray-50 font-semibold uppercase text-gray-500">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Donor Name</th>
                    <th className="py-3 px-4">Amount</th>
                    <th className="py-3 px-4">Payment Method</th>
                    <th className="py-3 px-4">Category</th>
                    <th className="py-3 px-4 text-center">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredDonations.map((d) => (
                    <tr key={d.id} className="hover:bg-gray-50">
                      <td className="py-3 px-4 font-semibold text-gray-700 whitespace-nowrap">
                        {d.date_received}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-bold text-gray-900">{d.donor_name}</p>
                        {d.donor_phone && <p className="text-[11px] text-gray-500">{d.donor_phone}</p>}
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-gray-900">
                        ₦{Number(d.amount).toLocaleString()}
                      </td>
                      <td className="py-3 px-4 capitalize text-gray-700">
                        {d.payment_method.replace("_", " ")}
                      </td>
                      <td className="py-3 px-4 capitalize text-gray-700">
                        {d.category.replace("_", " ")}
                      </td>
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold capitalize ${
                            d.status === "received"
                              ? "bg-emerald-100 text-emerald-800"
                              : d.status === "pledged"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-red-100 text-red-800"
                          }`}
                        >
                          {d.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleOpenAuditModal(d)}
                            title="View audit trail"
                            className="p-1.5 text-gray-400 hover:text-apc-primary rounded"
                          >
                            <History className="h-4 w-4" />
                          </button>

                          <button
                            onClick={() => handleOpenEdit(d)}
                            className="px-2.5 py-1 border rounded text-xs font-bold text-gray-700 hover:bg-gray-50 flex items-center gap-1"
                          >
                            <Pencil className="h-3 w-3" /> Edit
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* CREATE / EDIT MODAL */}
      {showFormModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-lg font-bold text-gray-900">
                {editingDonation ? "Edit Contribution Record" : "Record Contribution"}
              </h3>
              <button onClick={() => setShowFormModal(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block font-semibold text-gray-700 mb-1">Donor Name *</label>
                  <input
                    type="text"
                    required
                    value={form.donor_name}
                    onChange={(e) => setForm({ ...form, donor_name: e.target.value })}
                    placeholder="e.g. Chief Chinedu Okafor"
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Donor Phone</label>
                  <input
                    type="tel"
                    value={form.donor_phone}
                    onChange={(e) => setForm({ ...form, donor_phone: e.target.value })}
                    placeholder="080..."
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Amount (₦) *</label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    placeholder="e.g. 500000"
                    className="w-full px-3 py-2 border rounded-lg text-xs font-mono font-bold"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Date Received *</label>
                  <input
                    type="date"
                    required
                    value={form.date_received}
                    onChange={(e) => setForm({ ...form, date_received: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Payment Method</label>
                  <select
                    value={form.payment_method}
                    onChange={(e) => setForm({ ...form, payment_method: e.target.value as DonationSourceMethod })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  >
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="cash">Cash</option>
                    <option value="pos">POS</option>
                    <option value="cheque">Cheque</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Status *</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as DonationStatus })}
                    className="w-full px-3 py-2 border rounded-lg text-xs font-bold"
                  >
                    <option value="received">Received (Confirmed)</option>
                    <option value="pledged">Pledged (Unconfirmed)</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Category / Purpose</label>
                  <input
                    type="text"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    placeholder="e.g. Campaign Fund, Logistics"
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 mb-1">External Ref / Receipt #</label>
                  <input
                    type="text"
                    value={form.external_reference}
                    onChange={(e) => setForm({ ...form, external_reference: e.target.value })}
                    placeholder="e.g. TRF/2027/001"
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-gray-700 mb-1">Notes / Instructions</label>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Administrative notes..."
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                />
              </div>

              <div className="flex justify-end gap-2 border-t pt-3">
                <button
                  type="button"
                  onClick={() => setShowFormModal(false)}
                  className="px-4 py-2 font-semibold text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 bg-apc-primary text-white font-bold rounded-lg hover:bg-apc-dark disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Record"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* AUDIT LOGS MODAL */}
      {selectedDonationForAudit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Contribution Audit Log</h3>
                <p className="text-xs text-gray-500">{selectedDonationForAudit.donor_name}</p>
              </div>
              <button onClick={() => setSelectedDonationForAudit(null)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 p-1">
              {loadingAudits ? (
                <div className="flex items-center justify-center py-8 text-xs text-gray-500">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading audit log...
                </div>
              ) : auditLogs.length === 0 ? (
                <p className="text-center py-6 text-xs text-gray-500">
                  No audit history records recorded for this contribution yet.
                </p>
              ) : (
                auditLogs.map((log) => (
                  <div key={log.id} className="p-3 border rounded-xl bg-gray-50 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold uppercase text-apc-primary">{log.action}</span>
                      <span className="text-[10px] text-gray-400">
                        {String(log.performed_at || "Recently")}
                      </span>
                    </div>
                    <p className="text-gray-800">{log.details}</p>
                    <p className="text-gray-500 text-[11px]">By: {log.performed_by_name || log.performed_by}</p>
                  </div>
                ))
              )}
            </div>

            <div className="border-t pt-3 flex justify-end">
              <button
                onClick={() => setSelectedDonationForAudit(null)}
                className="px-4 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg text-xs hover:bg-gray-200"
              >
                Close Audit Log
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
