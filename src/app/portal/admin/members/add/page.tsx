"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createMemberByAdmin } from "@/lib/firebase/auth";
import { getAllLGAs } from "@/lib/constants";
import { useAuth } from "@/contexts/AuthContext";
import type { MembershipType, Role, LGA } from "@/types";

export default function AddMemberPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && profile && profile.access_role !== "admin") {
      router.replace("/portal/dashboard");
    }
  }, [authLoading, profile, router]);

  const [lgas, setLgas] = useState<LGA[]>([]);

  useEffect(() => {
    async function loadLgas() {
      const data = await getAllLGAs();
      setLgas(data);
    }
    loadLgas();
  }, []);

  const [form, setForm] = useState<{
    full_name: string;
    email: string;
    password: string;
    phone: string;
    lga_id: string;
    ward_id: string;
    polling_unit_id: string;
    membership_types: MembershipType[];
    access_role: Role;
    facebook_username: string;
    x_username: string;
    instagram_username: string;
    tiktok_username: string;
    gender: string;
  }>({
    full_name: "",
    email: "",
    password: "",
    phone: "",
    lga_id: "",
    ward_id: "",
    polling_unit_id: "",
    membership_types: ["campaign_member"],
    access_role: "member",
    facebook_username: "",
    x_username: "",
    instagram_username: "",
    tiktok_username: "",
    gender: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const selectedLga = lgas.find((lga) => lga.id === form.lga_id);
  const wards = selectedLga?.wards ?? [];

  const selectedWard = wards.find((ward) => ward.id === form.ward_id);
  const pollingUnits = selectedWard?.pollingUnits ?? [];

  const handleRoleToggle = (type: MembershipType) => {
    setForm((prev) => ({
      ...prev,
      membership_types: prev.membership_types.includes(type)
        ? prev.membership_types.filter((t) => t !== type)
        : [...prev.membership_types, type],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { user, error: createError } = await createMemberByAdmin(
      form.email,
      form.password,
      {
        full_name: form.full_name,
        phone: form.phone,
        lga_id: form.lga_id,
        ward_id: form.ward_id,
        polling_unit_id: form.polling_unit_id,
        membership_types: form.membership_types,
        access_role: form.access_role,
        ...(form.facebook_username ? { facebook_username: form.facebook_username, facebook_name: form.facebook_username } : {}),
        ...(form.x_username ? { x_username: form.x_username, x_name: form.x_username } : {}),
        ...(form.instagram_username ? { instagram_username: form.instagram_username, instagram_name: form.instagram_username } : {}),
        ...(form.tiktok_username ? { tiktok_username: form.tiktok_username, tiktok_name: form.tiktok_username } : {}),
        ...(form.gender ? { gender: form.gender } : {}),
      },
    );

    if (createError) {
      setError(createError);
      setLoading(false);
      return;
    }
    router.push("/portal/admin/members");
  };

  if (authLoading || !profile) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-gray-500">Loading…</p>
      </div>
    );
  }

  if (profile.access_role !== "admin") {
    return null;
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Add New Member</h1>
      <form
        onSubmit={handleSubmit}
        className="space-y-6 bg-white rounded-xl shadow p-8"
      >
        {error && (
          <div className="p-4 bg-red-50 text-red-700 rounded-lg">{error}</div>
        )}
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium mb-2">
              Full Name *
            </label>
            <input
              required
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="w-full px-4 py-3 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Email *</label>
            <input
              required
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full px-4 py-3 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Password *</label>
            <input
              required
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full px-4 py-3 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Phone *</label>
            <input
              required
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full px-4 py-3 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">LGA *</label>
            <select
              required
              value={form.lga_id}
              onChange={(e) =>
                setForm({
                  ...form,
                  lga_id: e.target.value,
                  ward_id: "",
                  polling_unit_id: "",
                })
              }
              className="w-full px-4 py-3 border rounded-lg"
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
            <label className="block text-sm font-medium mb-2">Ward *</label>
            <select
              required
              value={form.ward_id}
              onChange={(e) =>
                setForm({
                  ...form,
                  ward_id: e.target.value,
                  polling_unit_id: "",
                })
              }
              disabled={!form.lga_id}
              className="w-full px-4 py-3 border rounded-lg disabled:bg-gray-100 disabled:cursor-not-allowed"
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
            <label className="block text-sm font-medium mb-2">
              Polling Unit *
            </label>
            <select
              required
              value={form.polling_unit_id}
              onChange={(e) =>
                setForm({ ...form, polling_unit_id: e.target.value })
              }
              disabled={!form.ward_id}
              className="w-full px-4 py-3 border rounded-lg disabled:bg-gray-100 disabled:cursor-not-allowed"
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
          <div>
            <label className="block text-sm font-medium mb-2">Gender</label>
            <select
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value })}
              className="w-full px-4 py-3 border rounded-lg"
            >
              <option value="">Select gender</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-3">Membership</label>
          <div className="flex flex-wrap gap-4">
            {(["campaign_member", "social_member"] as const).map((type) => (
              <label key={type} className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={form.membership_types.includes(type)}
                  onChange={() => handleRoleToggle(type)}
                  className="rounded border-gray-300 text-apc-primary focus:ring-apc-primary"
                />
                <span className="capitalize">{type.replace("_", " ")}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Access Role</label>
          <select
            value={form.access_role}
            onChange={(e) =>
              setForm({ ...form, access_role: e.target.value as Role })
            }
            className="w-full px-4 py-3 border rounded-lg"
          >
            <option value="member">Member</option>
            <option value="election_officer">Election Officer</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        {form.membership_types.includes("social_member") && (
          <div className="border-t pt-6">
            <h3 className="font-semibold mb-4">
              Social Media (required for social members)
            </h3>
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium mb-2">
                  Facebook Username *
                </label>
                <input
                  required
                  value={form.facebook_username}
                  onChange={(e) =>
                    setForm({ ...form, facebook_username: e.target.value })
                  }
                  className="w-full px-4 py-3 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  X Username *
                </label>
                <input
                  required
                  value={form.x_username}
                  onChange={(e) =>
                    setForm({ ...form, x_username: e.target.value })
                  }
                  className="w-full px-4 py-3 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  Instagram
                </label>
                <input
                  value={form.instagram_username}
                  onChange={(e) =>
                    setForm({ ...form, instagram_username: e.target.value })
                  }
                  className="w-full px-4 py-3 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">TikTok</label>
                <input
                  value={form.tiktok_username}
                  onChange={(e) =>
                    setForm({ ...form, tiktok_username: e.target.value })
                  }
                  className="w-full px-4 py-3 border rounded-lg"
                />
              </div>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-apc-primary text-white py-3 rounded-lg font-semibold hover:bg-apc-dark disabled:opacity-50"
        >
          {loading ? "Creating..." : "Create Member"}
        </button>
      </form>
    </div>
  );
}
