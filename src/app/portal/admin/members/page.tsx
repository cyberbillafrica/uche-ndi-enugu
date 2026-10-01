'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useToast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/errors';
import { listMembers, setMemberLifecycle, listLgas, listAllWards } from '@/lib/supabase';
import type { DirectoryMember, GeoLga, GeoWard } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { exportToCSV, exportToExcel } from '@/lib/export';
import {
  Plus,
  Search,
  Filter,
  Download,
  FileSpreadsheet,
  Loader2,
  X,
} from 'lucide-react';
import type { UserLifecycleStatus } from '@/types';

/** LGA/ward label resolution over the canonical geography engine. */
interface GeoIndex {
  lgaNames: Map<string, string>;
  wardNames: Map<string, string>;
}

function buildGeoIndex(lgas: GeoLga[], wards: GeoWard[]): GeoIndex {
  return {
    lgaNames: new Map(lgas.map((l) => [l.id, l.name])),
    wardNames: new Map(wards.map((w) => [w.id, w.name])),
  };
}

function getWardName(user: Pick<DirectoryMember, 'ward_id'>, geo: GeoIndex): string {
  if (!user.ward_id) return '-';
  return geo.wardNames.get(user.ward_id) ?? user.ward_id;
}

function getLgaName(user: Pick<DirectoryMember, 'lga_id'>, geo: GeoIndex): string {
  if (!user.lga_id) return '-';
  return geo.lgaNames.get(user.lga_id) ?? user.lga_id;
}

export default function AdminMembersPage() {
  const toast = useToast();
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [geo, setGeo] = useState<GeoIndex>({ lgaNames: new Map(), wardNames: new Map() });
  const [lgaOptions, setLgaOptions] = useState<GeoLga[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Advanced Search & Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [membershipFilter, setMembershipFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [lgaFilter, setLgaFilter] = useState('all');
  const [wardFilter, setWardFilter] = useState('all');

  // Reason Modal
  const [actionModal, setActionModal] = useState<{
    user: DirectoryMember;
    targetStatus: UserLifecycleStatus;
  } | null>(null);
  const [reasonNotes, setReasonNotes] = useState('');

  const fetchMembers = async () => {
    setLoading(true);
    try {
      // Canonical Supabase directory + geography (RLS-scoped reads).
      const [memberData, lgaData, wardData] = await Promise.all([
        listMembers(),
        listLgas(),
        listAllWards(),
      ]);
      setMembers(memberData);
      setGeo(buildGeoIndex(lgaData, wardData));
      setLgaOptions(lgaData);
    } catch (err) {
      console.error("Failed to load members:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Deferred so the effect body performs no synchronous setState
    // (react-hooks/set-state-in-effect): fetchMembers flips `loading`.
    void Promise.resolve().then(fetchMembers);
  }, []);

  // Advanced Multi-Parameter Filtering
  const filteredMembers = useMemo(() => {
    return members.filter((m) => {
      const nameMatch =
        (m.full_name && m.full_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (m.email && m.email.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (m.phone && m.phone.includes(searchTerm));

      const typeMatch =
        membershipFilter === 'all' ||
        (m.membership_types && m.membership_types.includes(membershipFilter));

      const roleMatch = roleFilter === 'all' || m.access_role === roleFilter;

      const status = m.lifecycle_status || 'active';
      const statusMatch = statusFilter === 'all' || status === statusFilter;

      const lgaMatch = lgaFilter === 'all' || m.lga_id === lgaFilter;
      const wardMatch = wardFilter === 'all' || m.ward_id === wardFilter;

      return nameMatch && typeMatch && roleMatch && statusMatch && lgaMatch && wardMatch;
    });
  }, [members, searchTerm, membershipFilter, roleFilter, statusFilter, lgaFilter, wardFilter]);

  const handleUpdateStatus = async () => {
    if (!actionModal) return;
    const { user, targetStatus } = actionModal;
    setUpdatingId(user.id);

    try {
      // Server-side authority RPC (0032): actor/tenant resolved server-side,
      // fail-closed for non-admins, audited via the 0002 trigger.
      await setMemberLifecycle({
        memberId: user.id,
        lifecycleStatus: targetStatus,
        statusReason: reasonNotes || null,
      });
      setActionModal(null);
      setReasonNotes('');
      await fetchMembers();
    } catch (err) {
      console.error("Failed to update user status:", err);
      toast.error(
        getErrorMessage(err, "We couldn't update the member's status. Please try again."),
      );
    } finally {
      setUpdatingId(null);
    }
  };

  const handleExportCSV = () => {
    const headers = ["Name", "Email", "Phone", "LGA", "Ward", "PU", "Role", "Membership", "Lifecycle Status", "Points"];
    const rows = filteredMembers.map((m) => [
      m.full_name || "",
      m.email || "",
      m.phone || "",
      getLgaName(m, geo),
      getWardName(m, geo),
      m.polling_unit_id || "",
      m.access_role || "member",
      (m.membership_types || []).join(";"),
      m.lifecycle_status || "active",
      m.points || 0,
    ]);
    exportToCSV(`member_directory_${Date.now()}.csv`, headers, rows);
  };

  const handleExportExcel = () => {
    const headers = ["Name", "Email", "Phone", "LGA", "Ward", "PU", "Role", "Membership", "Lifecycle Status", "Points"];
    const rows = filteredMembers.map((m) => [
      m.full_name || "",
      m.email || "",
      m.phone || "",
      getLgaName(m, geo),
      getWardName(m, geo),
      m.polling_unit_id || "",
      m.access_role || "member",
      (m.membership_types || []).join(";"),
      m.lifecycle_status || "active",
      m.points || 0,
    ]);
    exportToExcel(`member_directory_${Date.now()}.xls`, "Members Directory", headers, rows);
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Member Directory & Lifecycle Management</h1>
          <p className="text-sm text-gray-500">
            Campaign-wide member search, registration completeness, and administrative status lifecycle control.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50 shadow-sm"
          >
            <Download className="h-3.5 w-3.5 text-brand-primary" /> CSV
          </button>
          <button
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border rounded-lg text-xs font-semibold text-emerald-700 hover:bg-emerald-50 shadow-sm"
          >
            <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" /> Excel
          </button>
          <Link
            href="/portal/admin/members/add"
            className="inline-flex items-center gap-1.5 bg-brand-primary text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-brand-primary transition-colors shadow-sm"
          >
            <Plus className="h-4 w-4" />
            <span>Add Member</span>
          </Link>
        </div>
      </div>

      {/* Advanced Filter Toolbar */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="relative w-full md:w-80">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search name, phone, or email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 border rounded-xl text-xs"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <Filter className="h-3.5 w-3.5 text-gray-500 shrink-0" />
              <select
                value={membershipFilter}
                onChange={(e) => setMembershipFilter(e.target.value)}
                className="px-2.5 py-1.5 border rounded-lg text-xs font-semibold bg-gray-50"
              >
                <option value="all">All Memberships</option>
                <option value="campaign_member">Campaign Council</option>
                <option value="social_member">Social Member</option>
              </select>

              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="px-2.5 py-1.5 border rounded-lg text-xs font-semibold bg-gray-50"
              >
                <option value="all">All Access Roles</option>
                <option value="member">Member</option>
                <option value="election_officer">Election Officer</option>
                <option value="admin">Administrator</option>
              </select>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-2.5 py-1.5 border rounded-lg text-xs font-semibold bg-gray-50"
              >
                <option value="all">All Lifecycle Statuses</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="deactivated">Deactivated</option>
              </select>

              <select
                value={lgaFilter}
                onChange={(e) => {
                  setLgaFilter(e.target.value);
                  setWardFilter('all');
                }}
                className="px-2.5 py-1.5 border rounded-lg text-xs font-semibold bg-gray-50 max-w-[130px] truncate"
              >
                <option value="all">All LGAs</option>
                {lgaOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Member Directory ({filteredMembers.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8 text-xs text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading member directory...
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="border-b bg-gray-50 font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="py-3 px-4">Member / Contacts</th>
                    <th className="py-3 px-4">Location (LGA / Ward / PU)</th>
                    <th className="py-3 px-4">Membership / Roles</th>
                    <th className="py-3 px-4 text-center">Lifecycle Status</th>
                    <th className="py-3 px-4 text-right">Points</th>
                    <th className="py-3 px-4 text-right">Lifecycle Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredMembers.map((m: DirectoryMember) => {
                    const status: UserLifecycleStatus = m.lifecycle_status || 'active';

                    return (
                      <tr key={m.id} className="hover:bg-gray-50">
                        <td className="py-3 px-4">
                          <p className="font-bold text-gray-900">{m.full_name}</p>
                          <p className="text-[11px] text-gray-500">{m.email} {m.phone ? `· ${m.phone}` : ''}</p>
                        </td>
                        <td className="py-3 px-4">
                          <p className="font-semibold text-gray-800">{getLgaName(m, geo)}</p>
                          <p className="text-[11px] text-gray-500">Ward: {getWardName(m, geo)}</p>
                          {m.polling_unit_id && <p className="text-[10px] text-gray-400">PU: {m.polling_unit_id}</p>}
                        </td>
                        <td className="py-3 px-4">
                          {(m.membership_types || []).map((r: string) => (
                            <span key={r} className="inline-block bg-brand-surface text-brand-primary text-[10px] font-bold px-2 py-0.5 rounded mr-1">
                              {r.replace('_', ' ')}
                            </span>
                          ))}
                          {m.access_role && (
                            <span className="inline-block bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded mr-1">
                              {m.access_role.replace('_', ' ')}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                              status === 'active'
                                ? 'bg-emerald-100 text-emerald-800'
                                : status === 'suspended'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {status}
                          </span>
                        </td>
                        <td className="text-right py-3 px-4 font-mono font-bold text-gray-900">
                          {m.points || 0}
                        </td>
                        <td className="text-right py-3 px-4">
                          <div className="flex items-center justify-end gap-1">
                            {status !== 'active' && (
                              <button
                                onClick={() => setActionModal({ user: m, targetStatus: 'active' })}
                                className="px-2 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded text-[10px] font-bold"
                              >
                                Activate
                              </button>
                            )}
                            {status === 'active' && (
                              <button
                                onClick={() => setActionModal({ user: m, targetStatus: 'suspended' })}
                                className="px-2 py-1 bg-amber-50 text-amber-700 hover:bg-amber-100 rounded text-[10px] font-bold"
                              >
                                Suspend
                              </button>
                            )}
                            {status !== 'deactivated' && (
                              <button
                                onClick={() => setActionModal({ user: m, targetStatus: 'deactivated' })}
                                className="px-2 py-1 bg-red-50 text-red-700 hover:bg-red-100 rounded text-[10px] font-bold"
                              >
                                Deactivate
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* LIFECYCLE ACTION REASON MODAL */}
      {actionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-lg font-bold text-gray-900 uppercase">
                Update Status to {actionModal.targetStatus}
              </h3>
              <button onClick={() => setActionModal(null)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            <p className="text-xs text-gray-600">
              Target Member: <span className="font-bold text-gray-900">{actionModal.user.full_name}</span> ({actionModal.user.email})
            </p>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Administrative Notes / Reason
              </label>
              <textarea
                rows={3}
                value={reasonNotes}
                onChange={(e) => setReasonNotes(e.target.value)}
                placeholder="Specify reason for lifecycle update..."
                className="w-full px-3 py-2 border rounded-lg text-xs"
              />
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <button
                onClick={() => setActionModal(null)}
                className="px-4 py-2 font-semibold text-gray-600 hover:text-gray-900 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateStatus}
                disabled={updatingId === actionModal.user.id}
                className="px-5 py-2 bg-brand-primary text-white font-bold rounded-lg text-xs hover:bg-brand-primary disabled:opacity-50"
              >
                {updatingId === actionModal.user.id ? 'Updating...' : 'Confirm Status Update'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
