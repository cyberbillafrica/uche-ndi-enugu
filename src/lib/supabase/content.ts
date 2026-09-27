/**
 * POLITICORE — Canonical content services (Phase 4): Contact, Biography,
 * Gallery, Manifesto, Site Settings, Donations.
 *
 * Each family keeps its own table and RLS (migration 0033). Donations are
 * a PRIVATE administrative ledger of donations received directly by the
 * campaign — no public collection surface exists by design.
 *
 * Single-row content domains are read/written per tenant; the tenant is
 * server-resolved inside RLS, never taken from the client as an
 * authorization boundary.
 */

import { getSupabaseClient } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Contact ────────────────────────────────────────────────────────────────

export interface ContactMessage {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  status: "unread" | "read";
  created_at: string;
}

export interface ContactInput {
  name: string;
  email: string;
  phone: string | null;
  message: string;
}

/** Public contact-form submission (RLS: contact_insert_public). */
export async function submitContactMessage(
  input: ContactInput,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { error } = await supabase.from("contact_messages").insert({
    name: input.name.trim(),
    email: input.email.trim(),
    phone: input.phone?.trim() || null,
    message: input.message.trim(),
  });
  if (error) throw new Error(`contact: submitContactMessage failed: ${error.message}`);
}

/** Tenant inbox (admin; RLS tenant-scoped). */
export async function listContactMessages(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<ContactMessage[]> {
  const { data, error } = await supabase
    .from("contact_messages")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`contact: listContactMessages failed: ${error.message}`);
  return (data ?? []) as ContactMessage[];
}

export async function markContactMessageRead(
  id: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { error } = await supabase
    .from("contact_messages")
    .update({ status: "read" })
    .eq("id", id);
  if (error) throw new Error(`contact: markContactMessageRead failed: ${error.message}`);
}

// ── Biography / Gallery / Manifesto (single-row per tenant) ───────────────

export interface BiographyData {
  tenant_id: string;
  full_name: string;
  title: string;
  about: string;
  image_url: string | null;
  stats: { years_experience: number; communities_served: number; volunteers: number };
  social_links: { facebook?: string; x?: string; instagram?: string; tiktok?: string };
  status: "draft" | "published";
}

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
  status: "draft" | "published";
}

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
  pdf_url: string | null;
  status: "draft" | "published";
}

/**
 * Biography read. RLS decides visibility: anonymous visitors receive only
 * the published row; same-tenant authenticated users (admins editing) see
 * their row in any status.
 */
export async function getBiography(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<BiographyData | null> {
  const { data, error } = await supabase.from("biographies").select("*").limit(1);
  if (error) throw new Error(`content: getBiography failed: ${error.message}`);
  return (data?.[0] as BiographyData) ?? null;
}

/** Admin upsert. tenant_id comes from the authenticated admin's profile. */
export async function updateBiography(
  tenantId: string,
  data: Omit<BiographyData, "tenant_id">,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { error } = await supabase
    .from("biographies")
    .upsert({ ...data, tenant_id: tenantId });
  if (error) throw new Error(`content: updateBiography failed: ${error.message}`);
}

export async function getGallery(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<GalleryData | null> {
  const { data, error } = await supabase.from("galleries").select("*").limit(1);
  if (error) throw new Error(`content: getGallery failed: ${error.message}`);
  return (data?.[0] as GalleryData) ?? null;
}

export async function updateGallery(
  tenantId: string,
  images: GalleryImage[],
  status: "draft" | "published",
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { error } = await supabase
    .from("galleries")
    .upsert({
      tenant_id: tenantId,
      images,
      status,
    });
  if (error) throw new Error(`content: updateGallery failed: ${error.message}`);
}

/**
 * Manifesto read. RLS decides visibility (published for anonymous;
 * same-tenant admins see any status).
 */
export async function getManifesto(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<ManifestoData | null> {
  const { data, error } = await supabase.from("manifestos").select("*").limit(1);
  if (error) throw new Error(`content: getManifesto failed: ${error.message}`);
  return (data?.[0] as ManifestoData) ?? null;
}

/** Admin upsert. tenant_id comes from the authenticated admin's profile. */
export async function updateManifesto(
  tenantId: string,
  data: Omit<ManifestoData, "tenant_id">,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { error } = await supabase
    .from("manifestos")
    .upsert({ ...data, tenant_id: tenantId });
  if (error) throw new Error(`content: updateManifesto failed: ${error.message}`);
}

// ── Site Settings (canonical tenant config) ───────────────────────────────

export interface TenantSettings {
  election_mode_enabled: boolean;
  volunteer_registration_enabled: boolean;
  new_member_alerts: boolean;
  task_verification_alerts: boolean;
}

/** Read the tenant config row (RLS: same-tenant authenticated). */
export async function getTenantSettings(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<TenantSettings> {
  const { data, error } = await supabase
    .from("tenants")
    .select("config")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`content: getTenantSettings failed: ${error.message}`);
  const config = (data?.config ?? {}) as Record<string, unknown>;
  return {
    election_mode_enabled: (config.election_mode_enabled as boolean) ?? true,
    volunteer_registration_enabled: (config.volunteer_registration_enabled as boolean) ?? true,
    new_member_alerts: (config.new_member_alerts as boolean) ?? true,
    task_verification_alerts: (config.task_verification_alerts as boolean) ?? true,
  };
}

export async function updateTenantSettings(
  settings: TenantSettings,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  // Read the tenant id from the RLS-visible row; the merge keeps any other
  // config keys intact. Tenant admins only (RLS denies member writes).
  const { data, error: readErr } = await supabase
    .from("tenants")
    .select("id, config")
    .limit(1)
    .maybeSingle();
  if (readErr) throw new Error(`content: updateTenantSettings read failed: ${readErr.message}`);
  if (!data?.id) throw new Error("content: updateTenantSettings: tenant row not visible");
  const merged = { ...((data.config ?? {}) as Record<string, unknown>), ...settings };
  const { error } = await supabase.from("tenants").update({ config: merged }).eq("id", data.id);
  if (error) throw new Error(`content: updateTenantSettings failed: ${error.message}`);
}

// ── Donations (PRIVATE admin-only ledger; no public collection) ───────────

export type DonationStatus = "received" | "pledged" | "cancelled";

export type DonationSourceMethod = "cash" | "bank_transfer" | "pos" | "cheque" | "other";

export interface DonationRecord {
  id: string;
  tenant_id: string;
  donor_name: string;
  donor_phone: string | null;
  donor_email: string | null;
  donor_reference: string | null;
  amount: number;
  currency: string;
  date_received: string; // YYYY-MM-DD
  payment_method: DonationSourceMethod;
  category: string;
  status: DonationStatus;
  external_reference: string | null;
  notes: string | null;
  lga_id: string | null;
  ward_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface DonorRecord {
  id: string;
  tenant_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  reference_identifier: string | null;
  lga_id: string | null;
  ward_id: string | null;
  total_received_amount: number;
  contribution_count: number;
  latest_contribution_date: string | null;
}

export interface DonationAuditLog {
  id: number;
  tenant_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_email?: string | null;
  action: string;
  affected_resource?: string;
  resource_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason_notes?: string | null;
  occurred_at: string;
}

export interface DonationInput {
  donorName: string;
  donorPhone: string | null;
  donorEmail: string | null;
  donorReference: string | null;
  amount: number;
  currency: string;
  dateReceived: string;
  paymentMethod: DonationSourceMethod;
  category: string;
  status: DonationStatus;
  externalReference: string | null;
  notes: string | null;
  lgaId: string | null;
  wardId: string | null;
}

export async function listDonations(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<DonationRecord[]> {
  const { data, error } = await supabase
    .from("donations")
    .select("*")
    .order("date_received", { ascending: false });
  if (error) throw new Error(`donations: listDonations failed: ${error.message}`);
  return (data ?? []) as DonationRecord[];
}

export async function listDonors(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<DonorRecord[]> {
  const { data, error } = await supabase
    .from("donors")
    .select("*")
    .order("total_received_amount", { ascending: false });
  if (error) throw new Error(`donations: listDonors failed: ${error.message}`);
  return (data ?? []) as DonorRecord[];
}

export async function listDonationAuditLogs(
  resourceId?: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<DonationAuditLog[]> {
  // Ledger writes are audited into the canonical politicore.system_audits
  // stream (0033 trg_audit_donations); read that single trail filtered to
  // the donations resource (RLS: tenant-scoped admin rows only).
  let q = supabase
    .from("system_audit_logs")
    .select("*")
    .eq("affected_resource", "donations")
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (resourceId) q = q.eq("resource_id", resourceId);
  const { data, error } = await q;
  if (error) throw new Error(`donations: listDonationAuditLogs failed: ${error.message}`);
  return (data ?? []) as DonationAuditLog[];
}

export async function createDonation(
  input: DonationInput,
  createdBy: string,
  createdByName: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<DonationRecord> {
  const { data, error } = await supabase
    .from("donations")
    .insert({
      donor_name: input.donorName,
      donor_phone: input.donorPhone,
      donor_email: input.donorEmail,
      donor_reference: input.donorReference,
      amount: input.amount,
      currency: input.currency,
      date_received: input.dateReceived,
      payment_method: input.paymentMethod,
      category: input.category,
      status: input.status,
      external_reference: input.externalReference,
      notes: input.notes,
      lga_id: input.lgaId,
      ward_id: input.wardId,
      created_by: createdBy,
      created_by_name: createdByName,
    })
    .select()
    .single();
  if (error) throw new Error(`donations: createDonation failed: ${error.message}`);
  return data as DonationRecord;
}

export async function updateDonation(
  id: string,
  patch: Partial<DonationInput>,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.donorName !== undefined) update.donor_name = patch.donorName;
  if (patch.donorPhone !== undefined) update.donor_phone = patch.donorPhone;
  if (patch.donorEmail !== undefined) update.donor_email = patch.donorEmail;
  if (patch.donorReference !== undefined) update.donor_reference = patch.donorReference;
  if (patch.amount !== undefined) update.amount = patch.amount;
  if (patch.currency !== undefined) update.currency = patch.currency;
  if (patch.dateReceived !== undefined) update.date_received = patch.dateReceived;
  if (patch.paymentMethod !== undefined) update.payment_method = patch.paymentMethod;
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.externalReference !== undefined) update.external_reference = patch.externalReference;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (patch.lgaId !== undefined) update.lga_id = patch.lgaId;
  if (patch.wardId !== undefined) update.ward_id = patch.wardId;
  const { error } = await supabase.from("donations").update(update).eq("id", id);
  if (error) throw new Error(`donations: updateDonation failed: ${error.message}`);
}
