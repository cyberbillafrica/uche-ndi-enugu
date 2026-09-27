"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Save, ShieldAlert, X } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  resolveGovernanceAccess,
  listCategories,
  createCategory,
  updateCategory,
  setCategoryActive,
  type GovernanceAccess,
  type GovernanceCategory,
} from "@/lib/supabase";

export default function GovernanceCategoriesPage() {
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [categories, setCategories] = useState<GovernanceCategory[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [acting, setActing] = useState(false);

  // ─── ROUTE GUARD (fail closed: admin authority required) ───
  useEffect(() => {
    if (authLoading) return;
    if (!profile) {
      router.replace("/portal/dashboard");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const a = await resolveGovernanceAccess();
        if (!cancelled) setAccess(a);
        if (!a.moduleEnabled || !a.canViewGovernance || !a.isAdmin) {
          router.replace("/portal/dashboard");
        }
      } catch {
        router.replace("/portal/dashboard");
      } finally {
        if (!cancelled) setGuardDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  // ─── LOAD ───
  useEffect(() => {
    if (!guardDone || !access?.isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const cats = await listCategories();
        if (!cancelled) {
          setCategories(cats);
          setListLoaded(true);
        }
      } catch (err) {
        console.error("Failed to load categories:", err);
        if (!cancelled) {
          setListLoaded(true);
          setLoadError("Unable to load categories right now.");
        }
      } finally {
        void cancelled;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access?.isAdmin]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createCategory(newName.trim(), newDescription.trim());
      const cats = await listCategories();
      setCategories(cats);
      setNewName("");
      setNewDescription("");
      toast.success("Category created.");
    } catch (err) {
      console.error("Category create failed:", err);
      toast.error(getErrorMessage(err, "Unable to create the category."));
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async (id: string) => {
    if (!editName.trim()) return;
    setActing(true);
    try {
      await updateCategory(id, {
        name: editName.trim(),
        description: editDescription.trim(),
      });
      const cats = await listCategories();
      setCategories(cats);
      setEditingId(null);
      toast.success("Category updated.");
    } catch (err) {
      console.error("Category update failed:", err);
      toast.error(getErrorMessage(err, "Unable to update the category."));
    } finally {
      setActing(false);
    }
  };

  const handleToggleActive = async (c: GovernanceCategory) => {
    setActing(true);
    try {
      await setCategoryActive(c.id, !c.is_active);
      const cats = await listCategories();
      setCategories(cats);
      toast.success(c.is_active ? "Category deactivated." : "Category activated.");
    } catch (err) {
      console.error("Category toggle failed:", err);
      toast.error(getErrorMessage(err, "Unable to change the category."));
    } finally {
      setActing(false);
    }
  };

  if (authLoading || !guardDone) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
      </div>
    );
  }

  if (access && !access.moduleEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900">
          Governance is not available
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          The Governance module is not enabled for your organization.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Request Categories</h1>
        <p className="mt-1 text-sm text-gray-600">
          The taxonomy participants see when submitting requests. Inactive
          categories disappear from the submission form but keep their
          historical requests intact.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-gray-900">
            New category
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="govcat-name">Name</Label>
              <Input
                id="govcat-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Infrastructure"
                maxLength={80}
              />
            </div>
            <div className="flex-[2] space-y-1.5">
              <Label htmlFor="govcat-desc">Description (optional)</Label>
              <Input
                id="govcat-desc"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What belongs in this category?"
                maxLength={200}
              />
            </div>
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white hover:bg-apc-primary/90 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-gray-900">
            Categories
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="text-sm text-red-600">{loadError}</p>
          ) : !listLoaded ? (
            <p className="py-6 text-center text-sm text-gray-500">Loading…</p>
          ) : categories.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">
              No categories yet — submissions will appear under “General”.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {categories.map((c) => (
                <li key={c.id} className="py-3">
                  {editingId === c.id ? (
                    <div className="space-y-2">
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        maxLength={80}
                      />
                      <Input
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        maxLength={200}
                        placeholder="Description (optional)"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={acting || !editName.trim()}
                          onClick={() => handleUpdate(c.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-apc-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-apc-primary/90 disabled:opacity-50"
                        >
                          <Save className="h-3.5 w-3.5" />
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        >
                          <X className="h-3.5 w-3.5" />
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">
                          {c.name}
                          {!c.is_active ? (
                            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                              Inactive
                            </span>
                          ) : null}
                        </p>
                        {c.description ? (
                          <p className="mt-0.5 text-xs text-gray-500">{c.description}</p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(c.id);
                            setEditName(c.name);
                            setEditDescription(c.description);
                          }}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={acting}
                          onClick={() => handleToggleActive(c)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                            c.is_active
                              ? "border border-gray-300 text-gray-700 hover:bg-gray-50"
                              : "bg-apc-primary text-white hover:bg-apc-primary/90"
                          }`}
                        >
                          {c.is_active ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
