"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings, Bell, Shield, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { getCurrentTenant } from "@/lib/firebase/tenants";

export default function AdminSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [settings, setSettings] = useState({
    election_mode_enabled: true,
    volunteer_registration_enabled: true,
    new_member_alerts: true,
    task_verification_alerts: true,
  });

  useEffect(() => {
    async function loadSettings() {
      try {
        const tenant = await getCurrentTenant();
        const docRef = doc(db, "tenants", tenant.id);
        const snap = await getDoc(docRef);

        if (snap.exists()) {
          const data = snap.data();
          setSettings({
            election_mode_enabled: data.election_mode_enabled ?? true,
            volunteer_registration_enabled: data.volunteer_registration_enabled ?? true,
            new_member_alerts: data.new_member_alerts ?? true,
            task_verification_alerts: data.task_verification_alerts ?? true,
          });
        }
      } catch (err) {
        console.error("Failed to load tenant settings:", err);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const handleSave = async (updatedSettings: typeof settings) => {
    setSettings(updatedSettings);
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const tenant = await getCurrentTenant();
      const docRef = doc(db, "tenants", tenant.id);
      await setDoc(
        docRef,
        {
          ...updatedSettings,
          updated_at: serverTimestamp(),
        },
        { merge: true }
      );
      setMessage("Tenant settings saved and updated in real-time.");
    } catch (err: unknown) {
      const errorObj = err as Error;
      console.error("Failed to save tenant settings:", err);
      setError(errorObj.message || "Failed to save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading system settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Settings & Controls</h1>
          <p className="text-sm text-gray-500">
            Configure system-wide toggles, election mode, and notification preferences.
          </p>
        </div>
        {saving && (
          <div className="flex items-center gap-2 text-xs font-semibold text-apc-primary">
            <Loader2 className="h-4 w-4 animate-spin" /> Saving...
          </div>
        )}
      </div>

      {message && (
        <div className="flex items-center gap-2 p-4 bg-green-50 text-green-700 rounded-lg border border-green-200 text-sm">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-4 bg-red-50 text-red-700 rounded-lg border border-red-200 text-sm">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2 text-lg">
              <Settings className="h-5 w-5 text-apc-primary" />
              <span>General System Toggles</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-gray-500 mb-4">
              Control portal feature availability and registration channels.
            </p>
            <div className="space-y-4 text-sm font-medium">
              <label className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border cursor-pointer">
                <span>Enable Election Mode</span>
                <input
                  type="checkbox"
                  checked={settings.election_mode_enabled}
                  onChange={(e) =>
                    handleSave({
                      ...settings,
                      election_mode_enabled: e.target.checked,
                    })
                  }
                  className="rounded border-gray-300 text-apc-primary h-4 w-4"
                />
              </label>

              <label className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border cursor-pointer">
                <span>Allow Public Volunteer Registration</span>
                <input
                  type="checkbox"
                  checked={settings.volunteer_registration_enabled}
                  onChange={(e) =>
                    handleSave({
                      ...settings,
                      volunteer_registration_enabled: e.target.checked,
                    })
                  }
                  className="rounded border-gray-300 text-apc-primary h-4 w-4"
                />
              </label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2 text-lg">
              <Bell className="h-5 w-5 text-apc-primary" />
              <span>Notifications & Alerts</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-gray-500 mb-4">
              Manage in-app notification triggers and admin alert preferences.
            </p>
            <div className="space-y-4 text-sm font-medium">
              <label className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border cursor-pointer">
                <span>New Member Sign-up Alerts</span>
                <input
                  type="checkbox"
                  checked={settings.new_member_alerts}
                  onChange={(e) =>
                    handleSave({
                      ...settings,
                      new_member_alerts: e.target.checked,
                    })
                  }
                  className="rounded border-gray-300 text-apc-primary h-4 w-4"
                />
              </label>

              <label className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border cursor-pointer">
                <span>Task Verification Requests</span>
                <input
                  type="checkbox"
                  checked={settings.task_verification_alerts}
                  onChange={(e) =>
                    handleSave({
                      ...settings,
                      task_verification_alerts: e.target.checked,
                    })
                  }
                  className="rounded border-gray-300 text-apc-primary h-4 w-4"
                />
              </label>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2 text-lg">
              <Shield className="h-5 w-5 text-apc-primary" />
              <span>Electoral Engine Management</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-gray-500 mb-4">
              Configure active election cycles, contests, INEC party datasets, candidate lists, and active collation contexts.
            </p>
            <a
              href="/portal/admin/election"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-apc-primary text-white text-xs font-bold rounded-lg hover:bg-apc-dark transition-colors"
            >
              Open Admin Election Configurator &rarr;
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
