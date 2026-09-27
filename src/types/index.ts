// ============================================================
// SYSTEM ACCESS ROLES
// ============================================================
//
// These are application-level access roles.
// DO NOT use this for Ward/LGA/Zone/State positions.
//
// Organizational positions are handled separately through
// OrganizationalAssignment.
//

export type Role =
  | "admin"
  | "member"
  | "election_officer"
  | "tenant_super_admin"
  | "platform_super_admin";

// ============================================================
// MEMBERSHIP TYPES
// ============================================================

export type MembershipType = "campaign_member" | "social_member";

// ============================================================
// ORGANIZATIONAL POSITIONS
// ============================================================

export type OrganizationalPosition =
  | "campaign_member"
  | "ward_coordinator"
  | "lga_coordinator"
  | "zone_coordinator"
  | "state_coordinator"
  | "campaign_manager"
  | "council_chairman";

// ============================================================
// ORGANIZATIONAL SCOPE
// ============================================================

export type ScopeType =
  | "polling_unit"
  | "ward"
  | "lga"
  | "senatorial_zone"
  | "state"
  | "campaign";

// ============================================================
// ASSIGNMENT STATUS
// ============================================================

export type OrganizationalAssignmentStatus =
  | "active"
  | "inactive"
  | "suspended"
  | "expired";

// ============================================================
// ORGANIZATIONAL ASSIGNMENT
// ============================================================

export interface OrganizationalAssignment {
  id: string;

  tenant_id: string;

  user_id: string;

  position: OrganizationalPosition;

  scope_type: ScopeType;

  scope_id: string;

  status: OrganizationalAssignmentStatus;

  assigned_by: string;

  assigned_at?: unknown;

  starts_at?: unknown;
  ends_at?: unknown;

  created_at?: unknown;
  updated_at?: unknown;
}

// ============================================================
// NEWS
// ============================================================

export type NewsStatus = "draft" | "published" | "scheduled" | "archived";

export interface NewsArticle {
  id: string;

  title: string;
  slug: string;

  excerpt: string;
  content: string;

  featured_image?: string | null;

  category?: string | null;

  status: NewsStatus;

  // Support legacy boolean flag
  published?: boolean;

  published_at?: unknown | null;
  scheduled_at?: unknown | null;

  author?: string | null;

  created_by: string;
  updated_by?: string | null;

  created_at: unknown;
  updated_at: unknown;
}

// ============================================================
// PERMISSIONS
// ============================================================

export type Permission =
  // General
  | "view_dashboard"
  | "view_area"

  // Members
  | "view_members"
  | "view_member_contacts"
  | "manage_members"

  // Campaign assignments
  | "view_assignments"
  | "create_assignment"
  | "assign_task"
  | "review_assignment"

  // Campaign activities
  | "view_activities"
  | "create_activity"
  | "manage_activity"
  | "view_activity_reports"

  // Field reporting
  | "submit_field_report"
  | "review_field_report"

  // Issues
  | "report_issue"
  | "manage_issue"

  // Communications
  | "view_notices"
  | "send_notice"

  // Documents
  | "view_documents"
  | "manage_documents"

  // Analytics
  | "view_analytics"

  // Organization
  | "manage_organization"
  | "manage_permissions"

  // Campaign administration
  | "manage_campaign_settings"

  // Election
  | "submit_election_pu_report"
  | "submit_election_incident"
  | "upload_election_result"
  | "view_election_dashboard"
  | "manage_election_settings"

  // Donations
  | "view_private_donations"
  | "manage_private_donations"
  | "view_public_donations"
  | "manage_public_donations";

// ============================================================
// PERMISSION GRANT
// ============================================================

export interface PermissionGrant {
  id: string;

  tenant_id: string;

  user_id: string;

  permission: Permission;

  granted: boolean;

  scope_type?: ScopeType | null;
  scope_id?: string | null;

  granted_by: string;

  created_at?: unknown;
  updated_at?: unknown;
}

// ============================================================
// CAMPAIGN ACTIVITIES
// ============================================================

export type CampaignActivityType =
  | "meeting"
  | "rally"
  | "community_engagement"
  | "training"
  | "coordination"
  | "stakeholder_meeting"
  | "other";

export type CampaignActivityStatus =
  | "scheduled"
  | "ongoing"
  | "completed"
  | "cancelled";

export interface AttendanceParticipant {
  user_id: string;
  name: string;
  rsvp?: "Going" | "Interested" | "Not Going";
  checked_in?: boolean;
  checked_in_at?: string | null;
  checked_out?: boolean;
  checked_out_at?: string | null;
  verified_by?: string | null;
}

export interface CampaignActivity {
  id: string;

  tenant_id: string;

  title: string;
  description?: string;

  activity_type: CampaignActivityType;
  status: CampaignActivityStatus;

  date: string;
  start_time?: string;
  end_time?: string;

  venue?: string;

  scope_type: ScopeType;
  scope_id: string;

  organizer_id: string;
  organizer_name?: string;

  expected_attendance?: number;
  participants?: AttendanceParticipant[];

  created_at?: unknown;
  updated_at?: unknown;
}

// ============================================================
// TENANT
// ============================================================

export interface Tenant {
  id: string;

  name: string;

  candidate_name?: string;

  state_id?: string;

  campaign_active?: boolean;

  election_mode_enabled?: boolean;

  created_at?: unknown;
  updated_at?: unknown;
}

// ============================================================
// USER PROFILE
// ============================================================

// ============================================================
// ELECTORAL STRUCTURE TYPES
// ============================================================

export interface PollingUnit {
  id: string;
  code: string;
  name: string;
  isNew?: boolean;
}

export interface Ward {
  id: string;
  code: string;
  name: string;
  pollingUnits: PollingUnit[];
}

export interface LGA {
  id: string;
  code: string;
  name: string;
  wards: Ward[];
}

export interface EnuguStateElectoralData {
  id?: string;
  state: string;
  lgas: LGA[];
  updated_at?: unknown;
}

export type UserLifecycleStatus = "active" | "suspended" | "deactivated";

export type OnboardingStatus = "pending" | "completed";

export interface UserProfile {
  id?: string;

  // Tenant ownership
  tenant_id?: string;

  // Personal information
  full_name: string;
  email: string;
  phone: string;
  gender: string;

  // Registered electoral location
  lga_id?: string;
  ward_id: string;
  polling_unit_id: string;

  // Social media identity
  facebook_name?: string;
  facebook_profile_url?: string;

  instagram_name?: string;
  instagram_profile_url?: string;

  x_name?: string;
  x_profile_url?: string;

  tiktok_name?: string;
  tiktok_profile_url?: string;

  // System access
  access_role: Role;

  // Membership & Lifecycle
  membership_types: MembershipType[];
  lifecycle_status?: UserLifecycleStatus;
  onboarding_status?: OnboardingStatus;
  status_reason?: string | null;

  // Social points
  points: number;
  rank: string;

  created_at?: unknown;
  updated_at?: unknown;
}

// ============================================================
// MANIFESTO
// ============================================================

export interface ManifestoSection {
  id: string;
  title: string;
  icon?: string; // emoji
  description: string;
  points: string[];
}

export interface ManifestoData {
  tenant_id: string;
  title: string;
  subtitle: string;
  introduction: string;
  candidate_name: string;
  candidate_title: string;
  sections: ManifestoSection[];
  closing: string;
  call_to_action: string;
  call_to_action_link: string;
  pdf_url?: string | null;
  status: "draft" | "published";
  created_at?: unknown;
  updated_at?: unknown;
}

// ============================================================
// BIOGRAPHY
// ============================================================

export interface BiographyData {
  tenant_id: string;
  full_name: string;
  title: string; // e.g., "APC Candidate, Nkanu West"
  about: string; // Main biography text
  image_url?: string | null;
  stats: {
    years_experience: number;
    communities_served: number;
    volunteers: number;
  };
  social_links?: {
    facebook?: string;
    x?: string;
    instagram?: string;
    tiktok?: string;
  };
  status: "draft" | "published";
  created_at?: unknown;
  updated_at?: unknown;
}

// ============================================================
// GALLERY
// ============================================================

export interface GalleryImage {
  id: string;
  url: string;
  title: string;
  description?: string;
  uploaded_at: string;
}

export interface GalleryData {
  tenant_id: string;
  images: GalleryImage[];
  updated_at?: unknown;
}

// ============================================================
// ANNOUNCEMENTS & EVENTS (Combined)
// ============================================================

export type AnnouncementScope =
  | "general"
  | "campaign_members"
  | "social_members"
  | "election_officers"
  | "admins";

export interface Announcement {
  id: string;
  title: string;
  content: string;
  scope: AnnouncementScope; // Who sees this in the portal
  type: "announcement"; // Discriminator
  created_at?: string;
  updated_at?: unknown;
}

export interface EventData {
  id: string;
  title: string;
  description: string;
  date: string; // ISO date string
  time: string;
  venue: string;
  ward: string;
  type: "event"; // Discriminator
  status: "draft" | "published";
  created_at?: string;
  updated_at?: unknown;
}

// Union type for combined admin management
export type PortalContent = Announcement | EventData;

export interface PortalContentData {
  tenant_id: string;
  items: PortalContent[];
  updated_at?: unknown;
}

// ============================================================
// ELECTORAL ENGINE CORE TYPES (POLITICORE SPECIFICATION)
// ============================================================

export type ContestType =
  | "presidential"
  | "governorship"
  | "senatorial"
  | "federal_house"
  | "state_house";

export type ContestScopeType =
  | "national"
  | "state"
  | "senatorial_zone"
  | "federal_constituency"
  | "state_constituency";

export type ElectionCycleStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "ACTIVE"
  | "PAUSED"
  | "CLOSED"
  | "ARCHIVED";

export type ContestStatus = "DRAFT" | "OPEN" | "PAUSED" | "CLOSED";

/** @deprecated legacy Firestore shape — use ContestStatus (DRAFT/OPEN/PAUSED/CLOSED) */
export type CollationStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "PAUSED";

export interface ElectionCycle {
  id: string;
  tenant_id: string;
  name: string;
  year: number;
  description?: string;
  status: ElectionCycleStatus;
  start_date?: string;
  end_date?: string;
  created_by: string;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface ElectionContest {
  id: string;
  tenant_id: string;
  election_cycle_id: string;
  contest_type: ContestType;
  name: string;
  scope_type: ContestScopeType;
  scope_id: string;
  state_id?: string;
  senatorial_zone_id?: string;
  lga_ids?: string[];
  election_date?: string;
  status: ContestStatus;
  collation_status: CollationStatus;
  tracked_parties: string[];
  participating_parties?: string[];
  focus_party_id?: string;
  created_by: string;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface PoliticalParty {
  id: string;
  acronym: string;
  name: string;
  logo_url?: string | null;
  inec_registered: boolean;
  status: "active" | "inactive";
  color?: string;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface ElectionCandidate {
  id: string;
  tenant_id: string;
  contest_id: string;
  party_id: string;
  candidate_name: string;
  running_mate_name?: string;
  status: "active" | "disqualified" | "withdrawn";
  created_at?: unknown;
  updated_at?: unknown;
}

export interface ElectionSettings {
  id?: string;
  tenant_id: string;
  active_election_cycle_id: string | null;
  active_contest_id: string | null;
  updated_by?: string;
  updated_at?: unknown;
}

// ============================================================
// POSTGRESQL ELECTION DOMAIN TYPES (Phase 2 cutover)
//
// Source of truth for migrated Election application code. These mirror
// the politicore.* rows served through the Supabase data API (views +
// RPCs) — the legacy Firestore document shapes were removed with the
// final Firebase retirement (Phase 5); 0016 retains the seed lineage.
// ============================================================

/** politicore.result_status — the DB-enforced result state machine. */
export type ElectionResultStatus =
  | "submitted"
  | "pending_review"
  | "approved"
  | "rejected"
  | "clarification_required"
  | "reopened";

/** History actions written exclusively by the database workflow RPCs. */
export type ElectionResultHistoryAction =
  | "create"
  | "correct"
  | "review_approve"
  | "review_reject"
  | "review_clarify"
  | "reopen"
  | "resubmit";

/** One row of politicore.election_result_votes — the relational ballot. */
export interface ElectionResultVote {
  id?: number;
  result_id: string;
  contest_id: string;
  party_id: string;
  votes: number;
}

/**
 * A composed application result: the election_results row plus the
 * relational ballot expanded into vote rows (and labels where the query
 * joined parties). Application representation only — persistence is the
 * election_result_votes table.
 */
export interface ElectionResult {
  result_id: string;
  tenant_id: string;
  election_cycle_id: string;
  contest_id: string;
  contest_type: ContestType;
  contest_scope_type?: ContestScopeType;
  contest_scope_id?: string;
  contest_name?: string;
  polling_unit_id: string;
  ward_id: string;
  lga_id: string;
  status: ElectionResultStatus;
  verified: boolean;
  reviewed_by?: string | null;
  review_notes?: string | null;
  reviewed_at?: string | null;
  evidence_asset_id: string | null;
  submitted_by: string;
  created_at?: string | null;
  updated_at?: string | null;
  votes: ElectionResultVote[];
}

/** politicore.election_result_history row (append-only, DB-written). */
export interface ElectionResultHistory {
  id: number;
  result_id: string;
  action: ElectionResultHistoryAction;
  actor_id: string;
  old_status: ElectionResultStatus | null;
  new_status: ElectionResultStatus | null;
  /** Forensic ballots (JSONB snapshots of election_result_votes rows). */
  old_votes: Array<{ party_id: string; votes: number }> | null;
  new_votes: Array<{ party_id: string; votes: number }> | null;
  old_evidence_asset_id: string | null;
  new_evidence_asset_id: string | null;
  notes?: string | null;
  reason?: string | null;
  created_at?: string | null;
}

/** politicore.pu_reports row (POST schema — tenant_id is resolved server-side). */
export interface PUReport {
  id: string;
  tenant_id: string;
  ward_id: string;
  polling_unit_id: string;
  submitted_by: string;
  report_type: "opening" | "turnout" | "conduct" | "closing" | "general";
  title: string;
  content: string;
  evidence_asset_id?: string | null;
  status: "submitted" | "under_review" | "acknowledged";
  created_at?: string | null;
}

/** politicore.election_incidents row. */
export interface ElectionIncident {
  id: string;
  tenant_id: string;
  ward_id: string;
  polling_unit_id?: string | null;
  incident_type:
    | "ballot_snatching"
    | "violence"
    | "bvas_malfunction"
    | "late_arrival"
    | "vote_buying"
    | "other";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  evidence_asset_id?: string | null;
  status: "reported" | "investigating" | "resolved" | "dismissed";
  reported_by: string;
  created_at?: string | null;
}

/** One party total from get_results_aggregate (relational SQL aggregation). */
export interface ElectionPartyTotal {
  party_id: string;
  acronym: string;
  name: string;
  total_votes: number;
}

/** Return shape of get_results_aggregate (§31 contract). */
export interface ElectionAggregate {
  cycle_id: string;
  contest_id: string;
  scope_type: string;
  party_totals: ElectionPartyTotal[];
  approved_pus: number;
  pending_pus: number;
  total_pus_in_scope: number;
  reporting_pct: number;
}

/** Vote-label pair used by the current-results view / UI composition. */
export interface ElectionVoteDetail {
  party_id: string;
  acronym: string;
  name: string;
  color?: string | null;
  votes: number;
}

/** A row of the election_results_current security-invoker view. */
export interface ElectionResultCurrentRow {
  result_id: string;
  tenant_id: string;
  election_cycle_id: string;
  contest_id: string;
  contest_name: string;
  contest_type: ContestType;
  contest_scope_type: ContestScopeType;
  contest_scope_id: string;
  polling_unit_id: string;
  ward_id: string;
  lga_id: string;
  status: ElectionResultStatus;
  verified: boolean;
  reviewed_by?: string | null;
  review_notes?: string | null;
  reviewed_at?: string | null;
  evidence_asset_id: string | null;
  submitted_by: string;
  created_at?: string | null;
  updated_at?: string | null;
  vote_details: ElectionVoteDetail[];
}

/** Vote payload accepted by submit_election_result / correct_election_result. */
export type BallotInput = Array<{ party_id: string; votes: number }>;

/** Result of submit/review/correct RPCs: (result_id, status, verified). */
export interface ElectionWorkflowResult {
  result_id: string;
  status: ElectionResultStatus;
  verified: boolean;
}

// ============================================================
// CANDIDATE DONATION & CONTRIBUTION LEDGER
// ============================================================

export type DonationStatus = "received" | "pledged" | "cancelled";

export type DonationSourceMethod =
  | "cash"
  | "bank_transfer"
  | "pos"
  | "cheque"
  | "other";

export interface DonorRecord {
  id: string;
  tenant_id: string;
  full_name: string;
  phone?: string | null;
  email?: string | null;
  reference_identifier?: string | null;
  lga_id?: string | null;
  ward_id?: string | null;
  total_received_amount: number;
  contribution_count: number;
  latest_contribution_date?: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface DonationRecord {
  id: string;
  tenant_id: string;
  donor_id?: string | null;
  donor_name: string;
  donor_phone?: string | null;
  donor_email?: string | null;
  donor_reference?: string | null;
  amount: number;
  currency: string;
  date_received: string; // YYYY-MM-DD
  payment_method: DonationSourceMethod;
  category: string; // e.g., "campaign_fund", "event_sponsorship", "logistics"
  status: DonationStatus;
  external_reference?: string | null;
  notes?: string | null;
  lga_id?: string | null;
  ward_id?: string | null;
  created_by: string;
  created_by_name?: string | null;
  created_at?: unknown;
  updated_by?: string | null;
  updated_at?: unknown;
}

export interface DonationAuditLog {
  id: string;
  tenant_id: string;
  donation_id: string;
  action: "created" | "updated" | "status_changed" | "cancelled";
  performed_by: string;
  performed_by_name?: string | null;
  performed_at?: unknown;
  details: string;
  changes?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
}

// ============================================================
// IN-APP NOTIFICATION SYSTEM & ENGINE
// ============================================================

export type NotificationType =
  | "system"
  | "election_alert"
  | "task_update"
  | "activity_reminder"
  | "report_status"
  | "issue_update";

export type NotificationTargetType =
  | "user"
  | "role"
  | "scope"
  | "all";

export interface NotificationItem {
  id: string;
  tenant_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link_url?: string | null;
  target_type: NotificationTargetType;
  target_id?: string | null; // user_id, role name, or scope_id
  read_by: string[]; // array of user_ids who marked read
  created_by?: string | null;
  created_at?: unknown;
}

// ============================================================
// CENTRALIZED SYSTEM AUDIT LOG SYSTEM
// ============================================================

export type AuditResource =
  | "user"
  | "assignment"
  | "permission"
  | "donation"
  | "task"
  | "activity"
  | "field_report"
  | "issue"
  | "election_config"
  | "system_settings";

export interface SystemAuditLog {
  id: string;
  tenant_id: string;
  actor_id: string;
  actor_name?: string | null;
  actor_email?: string | null;
  action: string;
  affected_resource: AuditResource;
  resource_id: string;
  old_value?: Record<string, unknown> | null;
  new_value?: Record<string, unknown> | null;
  reason_notes?: string | null;
  organizational_scope?: string | null;
  timestamp: unknown;
}
