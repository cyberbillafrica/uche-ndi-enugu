"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSystemAuditLogs } from "@/lib/firebase/audit";
import type { SystemAuditLog, AuditResource } from "@/types";
import {
  ShieldAlert,
  Search,
  Filter,
  Loader2,
  X,
  History,
  UserCheck,
  FileText,
  Calendar,
  Layers,
} from "lucide-react";

export default function AdminAuditLogsPage() {
  const [logs, setLogs] = useState<SystemAuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [resourceFilter, setResourceFilter] = useState<string>("all");
  const [selectedLog, setSelectedLog] = useState<SystemAuditLog | null>(null);

  useEffect(() => {
    async function loadLogs() {
      setLoading(true);
      try {
        const data = await getSystemAuditLogs();
        setLogs(data);
      } catch (err) {
        console.error("Failed to load system audit logs:", err);
      } finally {
        setLoading(false);
      }
    }
    loadLogs();
  }, []);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const matchSearch =
        (log.actor_name && log.actor_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (log.action && log.action.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (log.resource_id && log.resource_id.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (log.reason_notes && log.reason_notes.toLowerCase().includes(searchTerm.toLowerCase()));

      const matchResource = resourceFilter === "all" || log.affected_resource === resourceFilter;

      return matchSearch && matchResource;
    });
  }, [logs, searchTerm, resourceFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading system audit logs...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-apc-primary mb-1">
            <ShieldAlert className="h-4 w-4" />
            <span>Centralized Compliance Audit Trail</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
            Platform System Audit Logs
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Immutable platform-wide history recording administrative actions, resource modifications, and user lifecycle events.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="relative w-full md:w-80">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search actor, action, resource, or notes..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 border rounded-xl text-xs"
              />
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto">
              <Filter className="h-3.5 w-3.5 text-gray-500" />
              <span className="text-xs font-semibold text-gray-600">Resource:</span>
              <select
                value={resourceFilter}
                onChange={(e) => setResourceFilter(e.target.value)}
                className="px-2.5 py-1.5 border rounded-lg text-xs font-semibold bg-gray-50"
              >
                <option value="all">All Resources</option>
                <option value="user">Users / Members</option>
                <option value="assignment">Assignments</option>
                <option value="permission">Permissions</option>
                <option value="donation">Donations</option>
                <option value="task">Tasks</option>
                <option value="activity">Activities</option>
                <option value="field_report">Field Reports</option>
                <option value="issue">Issues</option>
                <option value="election_config">Election Config</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit Entries ({filteredLogs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            {filteredLogs.length === 0 ? (
              <p className="text-center py-8 text-sm text-gray-500">
                No system audit log entries found matching your search.
              </p>
            ) : (
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b bg-gray-50 font-semibold uppercase text-gray-500">
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-4">Actor</th>
                    <th className="py-3 px-4">Action</th>
                    <th className="py-3 px-4">Resource</th>
                    <th className="py-3 px-4">Resource ID</th>
                    <th className="py-3 px-4 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="py-3 px-4 whitespace-nowrap text-gray-600 font-mono">
                        {String((log.timestamp as any)?.toDate?.() || log.timestamp || "Recently")}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-bold text-gray-900">{log.actor_name || log.actor_id}</p>
                        <p className="text-[11px] text-gray-500">{log.actor_email || ""}</p>
                      </td>
                      <td className="py-3 px-4 font-bold text-apc-primary uppercase">
                        {log.action}
                      </td>
                      <td className="py-3 px-4 capitalize font-semibold text-gray-700">
                        {log.affected_resource.replace("_", " ")}
                      </td>
                      <td className="py-3 px-4 font-mono text-gray-500 truncate max-w-[120px]">
                        {log.resource_id}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => setSelectedLog(log)}
                          className="px-2.5 py-1 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded font-bold text-xs inline-flex items-center gap-1"
                        >
                          <History className="h-3 w-3" /> Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* INSPECT AUDIT LOG MODAL */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Audit Log Details</h3>
                <p className="text-xs text-gray-500">ID: {selectedLog.id}</p>
              </div>
              <button onClick={() => setSelectedLog(null)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 text-xs p-1">
              <div className="p-3 bg-gray-50 rounded-xl border space-y-1">
                <p className="text-gray-500 font-semibold">Actor:</p>
                <p className="font-bold text-gray-900">{selectedLog.actor_name || selectedLog.actor_id}</p>
                <p className="text-gray-500">{selectedLog.actor_email}</p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 bg-gray-50 rounded-xl border">
                  <p className="text-gray-500 font-semibold">Action:</p>
                  <p className="font-bold text-apc-primary uppercase">{selectedLog.action}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-xl border">
                  <p className="text-gray-500 font-semibold">Resource:</p>
                  <p className="font-bold text-gray-900 capitalize">{selectedLog.affected_resource}</p>
                </div>
              </div>

              {selectedLog.reason_notes && (
                <div className="p-3 bg-gray-50 rounded-xl border">
                  <p className="text-gray-500 font-semibold">Reason / Notes:</p>
                  <p className="text-gray-800">{selectedLog.reason_notes}</p>
                </div>
              )}

              {selectedLog.old_value && (
                <div className="p-3 bg-red-50/60 rounded-xl border border-red-200">
                  <p className="text-red-800 font-bold mb-1">Previous State (Old Value):</p>
                  <pre className="text-[10px] text-gray-800 bg-white p-2 rounded border overflow-x-auto">
                    {JSON.stringify(selectedLog.old_value, null, 2)}
                  </pre>
                </div>
              )}

              {selectedLog.new_value && (
                <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-200">
                  <p className="text-emerald-800 font-bold mb-1">New State (New Value):</p>
                  <pre className="text-[10px] text-gray-800 bg-white p-2 rounded border overflow-x-auto">
                    {JSON.stringify(selectedLog.new_value, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            <div className="border-t pt-3 flex justify-end">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg text-xs hover:bg-gray-200"
              >
                Close Details
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
