"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  User,
  Mail,
  Phone,
  MapPin,
  Shield,
  Briefcase,
  Key,
  Edit3,
  Save,
  X,
  Plus,
  Trash2,
  CheckCircle,
  XCircle,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useAuth } from "@/contexts/AuthContext";
import { hasPermission } from "@/lib/permissions";
import { getAllLGAs } from "@/lib/constants";
import {
  getCampaignMemberById,
  updateCampaignMemberProfile,
  updateMemberMembershipTypes,
  updateMemberAccessRole,
  type ScopedCampaignMember,
} from "@/lib/firebase/campaignMembers";
import {
  getUserOrganizationalAssignments,
  createOrganizationalAssignment,
  deleteOrganizationalAssignment,
} from "@/lib/firebase/organizationalAssignments";
import {
  getPermissionGrantsByUserId,
  createPermissionGrant,
  deletePermissionGrant,
} from "@/lib/firebase/permissionGrants";

import type {
  OrganizationalAssignment,
  OrganizationalPosition,
  ScopeType,
  MembershipType,
  Role,
  Permission,
  PermissionGrant,
  LGA,
} from "@/types";

/*
 * ============================================================
 * PAGE
 * ============================================================
 */

export default function MemberDetailPage() {
  const params = useParams();
  const router = useRouter();
  const memberId = params.id as string;

  const {
    profile,
    user,
    assignments: currentAssignments,
    grants: currentGrants,
  } = useAuth();

  const [member, setMember] = useState<ScopedCampaignMember | null>(null);
  const [lgas, setLgas] = useState<LGA[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [assignments, setAssignments] = useState<OrganizationalAssignment[]>(
    [],
  );
  const [permissionGrants, setPermissionGrants] = useState<PermissionGrant[]>(
    [],
  );

  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<ScopedCampaignMember>>({});

  const [membershipDialogOpen, setMembershipDialogOpen] = useState(false);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [assignmentDialogOpen, setAssignmentDialogOpen] = useState(false);
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);

  const [selectedAssignment, setSelectedAssignment] =
    useState<OrganizationalAssignment | null>(null);
  const [selectedGrant, setSelectedGrant] = useState<PermissionGrant | null>(
    null,
  );

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "assignment" | "grant";
    id: string;
  } | null>(null);

  /*
   * ----------------------------------------------------------
   * CHECK PERMISSIONS
   * ----------------------------------------------------------
   */

  const canManageMembers = hasPermission(
    {
      profile: profile ?? null,
      assignments: currentAssignments,
      grants: currentGrants,
    },
    "manage_members",
  );

  const canManageAssignments = hasPermission(
    {
      profile: profile ?? null,
      assignments: currentAssignments,
      grants: currentGrants,
    },
    "manage_organization",
  );

  const canManagePermissions = hasPermission(
    {
      profile: profile ?? null,
      assignments: currentAssignments,
      grants: currentGrants,
    },
    "manage_permissions",
  );

  // Admin fallback
  const isAdmin = profile?.access_role === "admin";
  const canEdit = isAdmin || canManageMembers;

  /*
   * ----------------------------------------------------------
   * LOAD MEMBER DATA & LGAs
   * ----------------------------------------------------------
   */

  const loadMember = useCallback(async () => {
    if (!memberId) return;

    try {
      setLoading(true);
      setError(null);

      const [data, lgasData] = await Promise.all([
        getCampaignMemberById(memberId),
        getAllLGAs(),
      ]);

      if (!data) {
        setError("Member not found");
        return;
      }

      setMember(data);
      setLgas(lgasData);
      setEditForm({ ...data });
    } catch (err) {
      console.error("Failed to load member:", err);
      setError("Unable to load member details");
    } finally {
      setLoading(false);
    }
  }, [memberId]);

  /*
   * ----------------------------------------------------------
   * LOAD ASSIGNMENTS
   * ----------------------------------------------------------
   */

  const loadAssignments = useCallback(async () => {
    if (!memberId) return;

    try {
      const data = await getUserOrganizationalAssignments(memberId);
      setAssignments(data);
    } catch (err) {
      console.error("Failed to load assignments:", err);
    }
  }, [memberId]);

  /*
   * ----------------------------------------------------------
   * LOAD PERMISSION GRANTS
   * ----------------------------------------------------------
   */

  const loadPermissionGrants = useCallback(async () => {
    if (!memberId) return;

    try {
      const data = await getPermissionGrantsByUserId(memberId);
      setPermissionGrants(data);
    } catch (err) {
      console.error("Failed to load permission grants:", err);
    }
  }, [memberId]);

  /*
   * ----------------------------------------------------------
   * INITIAL LOAD
   * ----------------------------------------------------------
   */

  useEffect(() => {
    loadMember();
    loadAssignments();
    loadPermissionGrants();
  }, [loadMember, loadAssignments, loadPermissionGrants]);

  /*
   * ----------------------------------------------------------
   * HELPER RESOLVERS
   * ----------------------------------------------------------
   */

  const memberLga = lgas.find(
    (lga) => lga.id === (member?.lga_id ?? "nkanu-west"),
  );
  const memberWard = memberLga?.wards.find((w) => w.id === member?.ward_id);
  const memberPollingUnit = memberWard?.pollingUnits.find(
    (pu) => pu.id === member?.polling_unit_id,
  );

  /*
   * ----------------------------------------------------------
   * LOADING
   * ----------------------------------------------------------
   */

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-apc-primary" />
        <p className="text-sm text-gray-500">Loading member details...</p>
      </div>
    );
  }

  /*
   * ----------------------------------------------------------
   * ERROR
   * ----------------------------------------------------------
   */

  if (error || !member) {
    return (
      <div className="space-y-6 pb-8">
        <BackLink />
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-6">
            <div className="flex gap-4">
              <AlertTriangle className="h-6 w-6 shrink-0 text-red-600" />
              <div>
                <h2 className="font-semibold text-red-900">
                  {error ?? "Member not found"}
                </h2>
                <p className="mt-1 text-sm text-red-800">
                  Unable to load this member's details.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /*
   * ----------------------------------------------------------
   * PAGE
   * ----------------------------------------------------------
   */

  return (
    <div className="space-y-6 pb-8">
      <BackLink />

      <PageHeader member={member} />

      {/* ======================================================
          PROFILE SECTION
          ====================================================== */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Profile Information</CardTitle>
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  isEditing ? handleSaveProfile() : setIsEditing(true)
                }
              >
                {isEditing ? (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    Save
                  </>
                ) : (
                  <>
                    <Edit3 className="mr-2 h-4 w-4" />
                    Edit
                  </>
                )}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isEditing ? (
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="full_name">Full Name</Label>
                <Input
                  id="full_name"
                  value={editForm.full_name ?? ""}
                  onChange={(e) =>
                    setEditForm({ ...editForm, full_name: e.target.value })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={editForm.email ?? ""}
                  onChange={(e) =>
                    setEditForm({ ...editForm, email: e.target.value })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={editForm.phone ?? ""}
                  onChange={(e) =>
                    setEditForm({ ...editForm, phone: e.target.value })
                  }
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsEditing(false);
                    setEditForm({ ...member });
                  }}
                >
                  <X className="mr-2 h-4 w-4" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <ProfileField
                icon={<User className="h-4 w-4" />}
                label="Full Name"
                value={member.full_name || "Not provided"}
              />
              <ProfileField
                icon={<Mail className="h-4 w-4" />}
                label="Email"
                value={member.email || "Not provided"}
              />
              <ProfileField
                icon={<Phone className="h-4 w-4" />}
                label="Phone"
                value={member.phone || "Not provided"}
              />
              <ProfileField
                icon={<Shield className="h-4 w-4" />}
                label="Access Role"
                value={formatRole(member.access_role)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ======================================================
          MEMBERSHIP TYPES
          ====================================================== */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Membership Types</CardTitle>
            {canEdit && (
              <Dialog
                open={membershipDialogOpen}
                onOpenChange={setMembershipDialogOpen}
              >
                <DialogTrigger render={<Button variant="outline" size="sm" />}>
                  <Edit3 className="mr-2 h-4 w-4" />
                  Manage
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Manage Membership Types</DialogTitle>
                  </DialogHeader>
                  <MembershipManager
                    member={member}
                    onSave={async (types) => {
                      await updateMemberMembershipTypes(member.id, types);
                      setMembershipDialogOpen(false);
                      loadMember();
                    }}
                    onClose={() => setMembershipDialogOpen(false)}
                  />
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {member.membership_types?.map((type) => (
              <Badge key={type} variant="secondary">
                {formatMembershipType(type)}
              </Badge>
            ))}
            {(!member.membership_types ||
              member.membership_types.length === 0) && (
              <p className="text-sm text-gray-500">No memberships assigned</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ======================================================
          ACCESS ROLE
          ====================================================== */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Access Role</CardTitle>
            {canEdit && (
              <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
                <DialogTrigger render={<Button variant="outline" size="sm" />}>
                  <Key className="mr-2 h-4 w-4" />
                  Manage
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Manage Access Role</DialogTitle>
                  </DialogHeader>
                  <RoleManager
                    currentRole={member.access_role}
                    onSave={async (role) => {
                      await updateMemberAccessRole(member.id, role);
                      setRoleDialogOpen(false);
                      loadMember();
                    }}
                    onClose={() => setRoleDialogOpen(false)}
                  />
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-gray-400" />
            <span className="font-medium">
              {formatRole(member.access_role)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ======================================================
          ELECTORAL IDENTITY
          ====================================================== */}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Electoral Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ElectoralField
            label="State"
            value="Enugu State"
            icon={<MapPin className="h-4 w-4" />}
          />
          <ElectoralField
            label="LGA"
            value={memberLga ? memberLga.name : "Not set"}
            icon={<MapPin className="h-4 w-4" />}
          />
          {member.ward_id && (
            <ElectoralField
              label="Ward"
              value={memberWard ? memberWard.name : member.ward_id}
              icon={<MapPin className="h-4 w-4" />}
            />
          )}
          {member.polling_unit_id && (
            <ElectoralField
              label="Polling Unit"
              value={
                memberPollingUnit
                  ? memberPollingUnit.name
                  : member.polling_unit_id
              }
              icon={<MapPin className="h-4 w-4" />}
            />
          )}
        </CardContent>
      </Card>

      {/* ======================================================
          ORGANIZATIONAL ASSIGNMENTS
          ====================================================== */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              Organizational Assignments
            </CardTitle>
            {canEdit && canManageAssignments && (
              <Dialog
                open={assignmentDialogOpen}
                onOpenChange={setAssignmentDialogOpen}
              >
                <DialogTrigger render={<Button variant="outline" size="sm" />}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Assignment
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Add Organizational Assignment</DialogTitle>
                  </DialogHeader>
                  <AssignmentManager
                    memberId={member.id}
                    lgas={lgas}
                    existingAssignments={assignments}
                    onSave={async (data) => {
                      await createOrganizationalAssignment({
                        tenant_id: member.tenant_id || CURRENT_TENANT_ID,
                        user_id: member.id,
                        position: data.position,
                        scope_type: data.scope_type,
                        scope_id: data.scope_id,
                        status: data.status || "active",
                        assigned_by: user?.uid || "system",
                      });
                      setAssignmentDialogOpen(false);
                      loadAssignments();
                    }}
                    onClose={() => setAssignmentDialogOpen(false)}
                  />
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {assignments.length === 0 ? (
            <p className="text-sm text-gray-500">
              No organizational assignments
            </p>
          ) : (
            <div className="space-y-3">
              {assignments.map((assignment) => (
                <AssignmentRow
                  key={assignment.id}
                  assignment={assignment}
                  lgas={lgas}
                  canEdit={canEdit && canManageAssignments}
                  onEdit={() => {
                    setSelectedAssignment(assignment);
                    setAssignmentDialogOpen(true);
                  }}
                  onDelete={() => {
                    setDeleteTarget({ type: "assignment", id: assignment.id });
                    setDeleteConfirmOpen(true);
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ======================================================
          PERMISSION GRANTS
          ====================================================== */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Permission Grants</CardTitle>
            {canEdit && canManagePermissions && (
              <Dialog
                open={permissionDialogOpen}
                onOpenChange={setPermissionDialogOpen}
              >
                <DialogTrigger render={<Button variant="outline" size="sm" />}>
                  <Plus className="mr-2 h-4 w-4" />
                  Grant Permission
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Grant Permission</DialogTitle>
                  </DialogHeader>
                  <PermissionGrantManager
                    memberId={member.id}
                    existingGrants={permissionGrants}
                    onSave={async (data) => {
                      await createPermissionGrant({
                        tenant_id: member.tenant_id || CURRENT_TENANT_ID,
                        user_id: member.id,
                        permission: data.permission,
                        granted: true,
                        scope_type: data.scope_type ?? null,
                        scope_id: data.scope_id ?? null,
                        granted_by: user?.uid || "system",
                      });
                      setPermissionDialogOpen(false);
                      loadPermissionGrants();
                    }}
                    onClose={() => setPermissionDialogOpen(false)}
                  />
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {permissionGrants.length === 0 ? (
            <p className="text-sm text-gray-500">
              No explicit permission grants
            </p>
          ) : (
            <div className="space-y-3">
              {permissionGrants.map((grant) => (
                <PermissionGrantRow
                  key={grant.id}
                  grant={grant}
                  canEdit={canEdit && canManagePermissions}
                  onRevoke={async () => {
                    setDeleteTarget({ type: "grant", id: grant.id });
                    setDeleteConfirmOpen(true);
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ======================================================
          DELETE CONFIRMATION
          ====================================================== */}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Action</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "assignment"
                ? "Are you sure you want to delete this organizational assignment? This action cannot be undone."
                : "Are you sure you want to revoke this permission grant? This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (deleteTarget?.type === "assignment") {
                  await deleteOrganizationalAssignment(deleteTarget.id);
                  loadAssignments();
                } else if (deleteTarget?.type === "grant") {
                  await deletePermissionGrant(deleteTarget.id);
                  loadPermissionGrants();
                }
                setDeleteConfirmOpen(false);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  /*
   * ----------------------------------------------------------
   * HANDLERS
   * ----------------------------------------------------------
   */

  async function handleSaveProfile() {
    if (!member) return;

    try {
      await updateCampaignMemberProfile(member.id, {
        full_name: editForm.full_name,
        email: editForm.email,
        phone: editForm.phone,
      });
      setIsEditing(false);
      loadMember();
    } catch (err) {
      console.error("Failed to save profile:", err);
      alert("Failed to save profile changes");
    }
  }
}

/*
 * ============================================================
 * COMPONENTS
 * ============================================================
 */

function BackLink() {
  return (
    <Link
      href="/portal/campaign/members"
      className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-apc-primary"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to Members
    </Link>
  );
}

function PageHeader({ member }: { member: ScopedCampaignMember }) {
  return (
    <div>
      <p className="text-sm font-semibold text-apc-primary">
        Campaign Member Management
      </p>
      <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
        {member.full_name || "Member"}
      </h1>
      <p className="mt-2 text-gray-600">{member.email}</p>
    </div>
  );
}

function ProfileField({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 text-gray-400">{icon}</div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {label}
        </p>
        <p className="font-medium text-gray-900">{value}</p>
      </div>
    </div>
  );
}

function ElectoralField({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-gray-400">{icon}</div>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="font-medium text-gray-900">{value}</p>
      </div>
    </div>
  );
}

function formatMembershipType(type: MembershipType): string {
  return type.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function formatRole(role: Role): string {
  return role.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

/*
 * ============================================================
 * MEMBERSHIP MANAGER
 * ============================================================
 */

function MembershipManager({
  member,
  onSave,
  onClose,
}: {
  member: ScopedCampaignMember;
  onSave: (types: MembershipType[]) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<MembershipType[]>(
    member.membership_types ?? [],
  );

  const toggleMembership = (type: MembershipType) => {
    if (selected.includes(type)) {
      setSelected(selected.filter((t) => t !== type));
    } else {
      setSelected([...selected, type]);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Select the membership types for this member. A member can have both
        Social and Campaign membership simultaneously.
      </p>

      <div className="space-y-2">
        <label className="flex items-center gap-3 rounded-lg border p-3">
          <input
            type="checkbox"
            checked={selected.includes("social_member")}
            onChange={() => toggleMembership("social_member")}
            className="h-4 w-4"
          />
          <div>
            <p className="font-medium">Social Member</p>
            <p className="text-xs text-gray-500">
              Access to social features, tasks, and leaderboard
            </p>
          </div>
        </label>

        <label className="flex items-center gap-3 rounded-lg border p-3">
          <input
            type="checkbox"
            checked={selected.includes("campaign_member")}
            onChange={() => toggleMembership("campaign_member")}
            className="h-4 w-4"
          />
          <div>
            <p className="font-medium">Campaign Member</p>
            <p className="text-xs text-gray-500">
              Access to campaign activities and organizational structure
            </p>
          </div>
        </label>
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => onSave(selected)}
          disabled={selected.length === 0}
        >
          Save Changes
        </Button>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * ROLE MANAGER
 * ============================================================
 */

function RoleManager({
  currentRole,
  onSave,
  onClose,
}: {
  currentRole: Role;
  onSave: (role: Role) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Role>(currentRole);

  const roles: Role[] = ["member", "election_officer", "admin"];

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Select the access role for this member. This controls system-level
        access permissions.
      </p>

      <Select value={selected} onValueChange={(v) => setSelected(v as Role)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {roles.map((role) => (
            <SelectItem key={role} value={role}>
              {formatRole(role)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => onSave(selected)}>Save Changes</Button>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * ASSIGNMENT MANAGER
 * ============================================================
 */

function AssignmentManager({
  memberId,
  lgas,
  existingAssignments,
  onSave,
  onClose,
}: {
  memberId: string;
  lgas: LGA[];
  existingAssignments: OrganizationalAssignment[];
  onSave: (data: {
    position: OrganizationalPosition;
    scope_type: ScopeType;
    scope_id: string;
    status?: "active" | "inactive";
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [position, setPosition] =
    useState<OrganizationalPosition>("campaign_member");
  const [scopeType, setScopeType] = useState<ScopeType>("ward");
  const [selectedLgaId, setSelectedLgaId] = useState<string>("");
  const [scopeId, setScopeId] = useState<string>("");
  const [status, setStatus] = useState<"active" | "inactive">("active");

  const selectedLga = lgas.find((lga) => lga.id === selectedLgaId);
  const wards = selectedLga?.wards ?? [];

  // Validate position/scope combination
  const isValidCombination = () => {
    if (position === "ward_coordinator" && scopeType !== "ward") {
      return false;
    }
    if (position === "lga_coordinator" && scopeType !== "lga") {
      return false;
    }
    if (position === "zone_coordinator" && scopeType !== "senatorial_zone") {
      return false;
    }
    if (position === "state_coordinator" && scopeType !== "state") {
      return false;
    }
    return true;
  };

  const handleSubmit = async () => {
    if (!isValidCombination()) {
      alert("Invalid position/scope combination");
      return;
    }

    let finalScopeId = scopeId;

    if (position === "lga_coordinator" && scopeType === "lga") {
      finalScopeId = selectedLgaId || "nkanu-west";
    }

    // For state coordinator
    if (position === "state_coordinator" && scopeType === "state") {
      finalScopeId = "enugu-state";
    }

    // For zone coordinator
    if (position === "zone_coordinator" && scopeType === "senatorial_zone") {
      finalScopeId = "enugu-east-senatorial-zone";
    }

    await onSave({
      position,
      scope_type: scopeType,
      scope_id: finalScopeId,
      status,
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label>Position</Label>
        <Select value={position} onValueChange={(v) => setPosition(v as any)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="campaign_member">Campaign Member</SelectItem>
            <SelectItem value="ward_coordinator">Ward Coordinator</SelectItem>
            <SelectItem value="lga_coordinator">LGA Coordinator</SelectItem>
            <SelectItem value="zone_coordinator">Zone Coordinator</SelectItem>
            <SelectItem value="state_coordinator">State Coordinator</SelectItem>
            <SelectItem value="campaign_manager">Campaign Manager</SelectItem>
            <SelectItem value="council_chairman">Council Chairman</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label>Scope Type</Label>
        <Select
          value={scopeType}
          onValueChange={(v) => setScopeType(v as ScopeType)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="campaign">Campaign-wide</SelectItem>
            <SelectItem value="ward">Ward</SelectItem>
            <SelectItem value="lga">LGA</SelectItem>
            <SelectItem value="senatorial_zone">Senatorial Zone</SelectItem>
            <SelectItem value="state">State</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {(scopeType === "ward" || scopeType === "lga") && (
        <div className="grid gap-2">
          <Label>LGA</Label>
          <Select
            value={selectedLgaId}
            onValueChange={(val) => {
              setSelectedLgaId(val ?? "");
              setScopeId("");
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select LGA" />
            </SelectTrigger>
            <SelectContent>
              {lgas.map((lga) => (
                <SelectItem key={lga.id} value={lga.id}>
                  {lga.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {scopeType === "ward" && (
        <div className="grid gap-2">
          <Label>Ward</Label>
          <Select
            value={scopeId}
            onValueChange={(value) => setScopeId(value ?? "")}
            disabled={!selectedLgaId}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  selectedLgaId ? "Select a ward" : "Select an LGA first"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {wards.map((ward) => (
                <SelectItem key={ward.id} value={ward.id}>
                  {ward.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid gap-2">
        <Label>Status</Label>
        <Select value={status} onValueChange={(v) => setStatus(v as any)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!isValidCombination() && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3">
          <p className="text-sm text-yellow-800">
            Warning: Position and scope type do not match. Please ensure Ward
            Coordinators have Ward scope, LGA Coordinators have LGA scope, etc.
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!isValidCombination()}>
          Save Assignment
        </Button>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * ASSIGNMENT ROW
 * ============================================================
 */

function AssignmentRow({
  assignment,
  lgas,
  canEdit,
  onEdit,
  onDelete,
}: {
  assignment: OrganizationalAssignment;
  lgas: LGA[];
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isActive = assignment.status === "active";

  const getScopeDisplay = () => {
    if (assignment.scope_type === "ward") {
      for (const lga of lgas) {
        const ward = lga.wards.find((w) => w.id === assignment.scope_id);
        if (ward) return `${lga.name} — ${ward.name}`;
      }
      return assignment.scope_id;
    }
    if (assignment.scope_type === "lga") {
      const lga = lgas.find((l) => l.id === assignment.scope_id);
      return lga ? `${lga.name} LGA` : assignment.scope_id;
    }
    if (assignment.scope_type === "senatorial_zone") {
      return "Enugu East Senatorial Zone";
    }
    if (assignment.scope_type === "state") {
      return "Enugu State";
    }
    if (assignment.scope_type === "campaign") {
      return "Campaign-wide";
    }
    return assignment.scope_id;
  };

  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-full ${
            isActive
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          <Briefcase className="h-5 w-5" />
        </div>
        <div>
          <p className="font-medium">
            {assignment.position
              .replace(/_/g, " ")
              .replace(/\b\w/g, (l) => l.toUpperCase())}
          </p>
          <p className="text-sm text-gray-500">{getScopeDisplay()}</p>
          <Badge variant={isActive ? "default" : "secondary"} className="mt-1">
            {isActive ? (
              <>
                <CheckCircle className="mr-1 h-3 w-3" />
                Active
              </>
            ) : (
              <>
                <XCircle className="mr-1 h-3 w-3" />
                Inactive
              </>
            )}
          </Badge>
        </div>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            className="text-red-600 hover:text-red-700"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

/*
 * ============================================================
 * PERMISSION GRANT MANAGER
 * ============================================================
 */

function PermissionGrantManager({
  memberId,
  existingGrants,
  onSave,
  onClose,
}: {
  memberId: string;
  existingGrants: PermissionGrant[];
  onSave: (data: {
    permission: Permission;
    scope_type?: ScopeType | null;
    scope_id?: string | null;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [permission, setPermission] = useState<Permission>("view_dashboard");
  const [scopeType, setScopeType] = useState<ScopeType | "" | "__none__">("");
  const [scopeId, setScopeId] = useState<string>("");

  const permissions: Permission[] = [
    "view_dashboard",
    "manage_members",
    "manage_organization",
    "manage_permissions",
    "create_activity",
    "manage_activity",
    "view_activity_reports",
    "submit_election_pu_report",
    "submit_election_incident",
    "upload_election_result",
  ];

  const handleSubmit = async () => {
    const finalScopeType = scopeType === "__none__" ? null : scopeType || null;
    await onSave({
      permission,
      scope_type: finalScopeType,
      scope_id: finalScopeType ? scopeId || null : null,
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label>Permission</Label>
        <Select
          value={permission}
          onValueChange={(v) => setPermission(v as Permission)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {permissions.map((perm) => (
              <SelectItem key={perm} value={perm}>
                {perm
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (l) => l.toUpperCase())}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label>Scope Type (optional)</Label>
        <Select
          value={scopeType || "__none__"}
          onValueChange={(v) => {
            setScopeType(v === "__none__" ? "" : (v as ScopeType));
            setScopeId("");
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="No scope restriction" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">No scope restriction</SelectItem>
            <SelectItem value="ward">Ward</SelectItem>
            <SelectItem value="lga">LGA</SelectItem>
            <SelectItem value="senatorial_zone">Senatorial Zone</SelectItem>
            <SelectItem value="state">State</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {scopeType && (
        <div className="grid gap-2">
          <Label>Scope ID</Label>
          <Input
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            placeholder="Enter scope identifier"
          />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSubmit}>Grant Permission</Button>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * PERMISSION GRANT ROW
 * ============================================================
 */

function PermissionGrantRow({
  grant,
  canEdit,
  onRevoke,
}: {
  grant: PermissionGrant;
  canEdit: boolean;
  onRevoke: () => Promise<void>;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
          <Key className="h-5 w-5" />
        </div>
        <div>
          <p className="font-medium">
            {grant.permission
              .replace(/_/g, " ")
              .replace(/\b\w/g, (l) => l.toUpperCase())}
          </p>
          {grant.scope_type && (
            <p className="text-sm text-gray-500">
              Scope: {grant.scope_type}
              {grant.scope_id ? ` (${grant.scope_id})` : ""}
            </p>
          )}
        </div>
      </div>
      {canEdit && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRevoke}
          className="text-red-600 hover:text-red-700"
        >
          Revoke
        </Button>
      )}
    </div>
  );
}
