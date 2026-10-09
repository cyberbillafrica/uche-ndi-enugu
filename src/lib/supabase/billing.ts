/**
 * POLITICORE — Subscription & Billing Core service (Phase 29, SaaS B).
 *
 * Typed browser surface over the Phase 29 RPCs. This service owns NO
 * security and NO money math: every operation delegates authority to the
 * SECURITY DEFINER RPCs (owner = tenant_super_admin, operations =
 * platform_super_admin, identity server-resolved, Core-Audit-logged).
 * Money is ALWAYS integer minor units (kobo) — never floats, never FX.
 *
 * Provider independence: the provider identity is DATA (`provider` text)
 * and behavior lives behind the `PaymentProviderAdapter` seam below. The
 * manual/offline adapter is the ONLY functional adapter this phase — and
 * even it records VERIFIED payments through the SAME server state machine
 * as any future PSP. There is no second billing path.
 */
import { getSupabaseClient } from "./config";

import type { PlanModule } from "./commercialPlans";

/* ── enumerations (mirror the Phase 29 DB enums) ─────────────────────── */

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "restricted"
  | "cancelled";

export type BillingInterval = "monthly" | "annual";

export type InvoiceStatus =
  | "draft"
  | "issued"
  | "paid"
  | "past_due"
  | "void"
  | "refunded";

export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded";
export type PaymentAttemptStatus = "pending" | "succeeded" | "failed";
export type RefundStatus = "pending" | "succeeded" | "failed";
export type CreditStatus = "issued" | "applied" | "void";
export type BillingEventStatus = "received" | "processed" | "rejected" | "failed";

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  restricted: "Restricted",
  cancelled: "Cancelled",
};

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  paid: "Paid",
  past_due: "Past due",
  void: "Void",
  refunded: "Refunded",
};

/* ── row shapes (mirror the RPC RETURNS TABLE columns) ───────────────── */

export interface SubscriptionCurrentRow {
  subscription_id: string;
  tenant_id: string;
  status: SubscriptionStatus;
  billing_interval: BillingInterval;
  currency: string;
  plan_version_id: string;
  plan_code: string;
  plan_name: string;
  plan_version: number;
  feature_entitlements: Partial<Record<PlanModule | string, boolean>>;
  limits: Record<string, number | null>;
  unit_price_minor: number;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_start: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  pending_plan_version_id: string | null;
  pending_plan_code: string | null;
  pending_plan_name: string | null;
  failed_payment_count: number;
  past_due_since: string | null;
  created_at: string;
}

export interface SubscriptionPlanRow {
  plan_version_id: string;
  plan_code: string;
  plan_name: string;
  description: string | null;
  sort_order: number;
  version: number;
  currency: string;
  included_modules: PlanModule[];
  feature_entitlements: Partial<Record<PlanModule | string, boolean>>;
  limits: Record<string, number | null>;
  trial_enabled: boolean;
  trial_days: number;
  prices: Record<string, number>;
}

export interface MyInvoiceRow {
  invoice_id: string;
  status: InvoiceStatus;
  invoice_number: string | null;
  plan_code: string;
  plan_name: string;
  plan_version: number;
  billing_interval: BillingInterval;
  currency: string;
  period_start: string;
  period_end: string;
  subtotal_minor: number;
  discount_credits_minor: number;
  tax_minor: number;
  total_minor: number;
  refunded_minor: number;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  line_item_count: number;
}

export interface MyInvoiceDetailRow extends Omit<MyInvoiceRow, "line_item_count"> {
  plan_version_id: string;
  line_items: InvoiceLineItemSnapshot[];
  payments: InvoicePaymentSnapshot[];
  refunds: InvoiceRefundSnapshot[];
  payment_attempts: InvoiceAttemptSnapshot[];
}

export interface InvoiceLineItemSnapshot {
  description: string;
  item_type: string;
  quantity: number;
  amount_minor: number;
  currency: string;
}

export interface InvoicePaymentSnapshot {
  id: string;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  provider_payment_reference: string;
  received_at: string | null;
}

export interface InvoiceRefundSnapshot {
  id: string;
  amount_minor: number;
  currency: string;
  status: RefundStatus;
  reason: string;
  processed_at: string | null;
}

export interface InvoiceAttemptSnapshot {
  attempt_number: number;
  status: PaymentAttemptStatus;
  failure_code: string | null;
  failure_message: string | null;
  attempted_at: string | null;
}

export interface MyPaymentRow {
  payment_id: string;
  invoice_id: string;
  invoice_number: string | null;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  provider_payment_reference: string;
  received_at: string | null;
}

export interface PlatformSubscriptionRow {
  subscription_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  status: SubscriptionStatus;
  billing_interval: BillingInterval;
  currency: string;
  plan_code: string;
  plan_name: string;
  plan_version: number;
  unit_price_minor: number;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_start: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  pending_plan_version_id: string | null;
  failed_payment_count: number;
  past_due_since: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface PlatformInvoiceRow {
  invoice_id: string;
  tenant_id: string;
  tenant_name: string;
  subscription_id: string;
  status: InvoiceStatus;
  invoice_number: string | null;
  plan_code: string;
  plan_name: string;
  plan_version: number;
  billing_interval: BillingInterval;
  currency: string;
  period_start: string;
  period_end: string;
  subtotal_minor: number;
  discount_credits_minor: number;
  tax_minor: number;
  total_minor: number;
  refunded_minor: number;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
}

export interface PlatformPaymentRow {
  payment_id: string;
  tenant_id: string;
  tenant_name: string;
  invoice_id: string;
  invoice_number: string | null;
  subscription_id: string | null;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  provider_payment_reference: string;
  notes: string | null;
  received_at: string | null;
}

export interface PlatformBillingEventRow {
  event_id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  processing_status: BillingEventStatus;
  signature_verified: boolean;
  failure_reason: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface BillingConfigRow {
  grace_period_days: number;
  max_payment_retries: number;
}

export interface ProcessorActionRow {
  subscription_id: string;
  action: string;
}

export interface BillingEventActionRow {
  event_id: string;
  action: string;
}

/* ── money helpers — integer minor units ONLY ────────────────────────── */

const toNum = (v: unknown): number => Number(v ?? 0);

/** Format minor units for display (e.g. 1500000 → "₦15,000.00"). */
export function formatMinor(amountMinor: number, currency = "NGN"): string {
  const symbol = currency === "NGN" ? "₦" : `${currency} `;
  const major = amountMinor / 100;
  return `${symbol}${major.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/* ── owner read models ───────────────────────────────────────────────── */

export async function getMySubscription(): Promise<SubscriptionCurrentRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("subscription_current");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    subscription_id: String(r.subscription_id),
    tenant_id: String(r.tenant_id),
    status: r.status as SubscriptionStatus,
    billing_interval: r.billing_interval as BillingInterval,
    currency: String(r.currency),
    plan_version_id: String(r.plan_version_id),
    plan_code: String(r.plan_code),
    plan_name: String(r.plan_name),
    plan_version: toNum(r.plan_version),
    feature_entitlements:
      (r.feature_entitlements as SubscriptionCurrentRow["feature_entitlements"]) ?? {},
    limits: (r.limits as SubscriptionCurrentRow["limits"]) ?? {},
    unit_price_minor: toNum(r.unit_price_minor),
    current_period_start: (r.current_period_start as string | null) ?? null,
    current_period_end: (r.current_period_end as string | null) ?? null,
    trial_start: (r.trial_start as string | null) ?? null,
    trial_end: (r.trial_end as string | null) ?? null,
    cancel_at_period_end: Boolean(r.cancel_at_period_end),
    pending_plan_version_id: (r.pending_plan_version_id as string | null) ?? null,
    pending_plan_code: (r.pending_plan_code as string | null) ?? null,
    pending_plan_name: (r.pending_plan_name as string | null) ?? null,
    failed_payment_count: toNum(r.failed_payment_count),
    past_due_since: (r.past_due_since as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

/**
 * Owner-scoped subscribable catalog (0067): ACTIVE plan versions WITH their
 * ids and committed prices. Authority mirrors create_subscription exactly —
 * tenant owners and platform admins receive rows; every other caller
 * (anon, member, admin, election_officer) receives an empty list. The
 * anonymous public catalog (getPlanCatalogPublic) stays id-free.
 */
export async function getSubscriptionPlans(): Promise<SubscriptionPlanRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("subscription_plans");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    plan_version_id: String(r.plan_version_id),
    plan_code: String(r.plan_code),
    plan_name: String(r.plan_name),
    description: (r.description as string | null) ?? null,
    sort_order: toNum(r.sort_order),
    version: toNum(r.version),
    currency: String(r.currency),
    included_modules: (r.included_modules as PlanModule[]) ?? [],
    feature_entitlements:
      (r.feature_entitlements as SubscriptionPlanRow["feature_entitlements"]) ?? {},
    limits: (r.limits as SubscriptionPlanRow["limits"]) ?? {},
    trial_enabled: Boolean(r.trial_enabled),
    trial_days: toNum(r.trial_days),
    prices: (r.prices as Record<string, number>) ?? {},
  }));
}

export async function getMyInvoices(): Promise<MyInvoiceRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("my_invoices");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    invoice_id: String(r.invoice_id),
    status: r.status as InvoiceStatus,
    invoice_number: (r.invoice_number as string | null) ?? null,
    plan_code: String(r.plan_code),
    plan_name: String(r.plan_name),
    plan_version: toNum(r.plan_version),
    billing_interval: r.billing_interval as BillingInterval,
    currency: String(r.currency),
    period_start: String(r.period_start),
    period_end: String(r.period_end),
    subtotal_minor: toNum(r.subtotal_minor),
    discount_credits_minor: toNum(r.discount_credits_minor),
    tax_minor: toNum(r.tax_minor),
    total_minor: toNum(r.total_minor),
    refunded_minor: toNum(r.refunded_minor),
    issued_at: (r.issued_at as string | null) ?? null,
    due_at: (r.due_at as string | null) ?? null,
    paid_at: (r.paid_at as string | null) ?? null,
    line_item_count: toNum(r.line_item_count),
  }));
}

export async function getMyInvoice(invoiceId: string): Promise<MyInvoiceDetailRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("my_invoice", { p_invoice_id: invoiceId });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    invoice_id: String(r.invoice_id),
    status: r.status as InvoiceStatus,
    invoice_number: (r.invoice_number as string | null) ?? null,
    plan_code: String(r.plan_code),
    plan_name: String(r.plan_name),
    plan_version: toNum(r.plan_version),
    plan_version_id: String(r.plan_version_id),
    billing_interval: r.billing_interval as BillingInterval,
    currency: String(r.currency),
    period_start: String(r.period_start),
    period_end: String(r.period_end),
    subtotal_minor: toNum(r.subtotal_minor),
    discount_credits_minor: toNum(r.discount_credits_minor),
    tax_minor: toNum(r.tax_minor),
    total_minor: toNum(r.total_minor),
    refunded_minor: toNum(r.refunded_minor),
    issued_at: (r.issued_at as string | null) ?? null,
    due_at: (r.due_at as string | null) ?? null,
    paid_at: (r.paid_at as string | null) ?? null,
    line_items: (r.line_items as MyInvoiceDetailRow["line_items"]) ?? [],
    payments: (r.payments as MyInvoiceDetailRow["payments"]) ?? [],
    refunds: (r.refunds as MyInvoiceDetailRow["refunds"]) ?? [],
    payment_attempts: (r.payment_attempts as MyInvoiceDetailRow["payment_attempts"]) ?? [],
  };
}

export async function getMyPayments(): Promise<MyPaymentRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("my_payments");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    payment_id: String(r.payment_id),
    invoice_id: String(r.invoice_id),
    invoice_number: (r.invoice_number as string | null) ?? null,
    amount_minor: toNum(r.amount_minor),
    currency: String(r.currency),
    status: r.status as PaymentStatus,
    provider: String(r.provider),
    provider_payment_reference: String(r.provider_payment_reference),
    received_at: (r.received_at as string | null) ?? null,
  }));
}

/* ── owner lifecycle ─────────────────────────────────────────────────── */

export async function createSubscription(input: {
  planVersionId: string;
  billingInterval: BillingInterval;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("create_subscription", {
    p_plan_version_id: input.planVersionId,
    p_billing_interval: input.billingInterval,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function scheduleSubscriptionCancellation(input: {
  subscriptionId: string;
  reason?: string | null;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("schedule_subscription_cancellation", {
    p_subscription_id: input.subscriptionId,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function revokeSubscriptionCancellation(input: {
  subscriptionId: string;
  reason?: string | null;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("revoke_subscription_cancellation", {
    p_subscription_id: input.subscriptionId,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function changeSubscriptionPlan(input: {
  subscriptionId: string;
  planVersionId: string;
  reason?: string | null;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("change_subscription_plan", {
    p_subscription_id: input.subscriptionId,
    p_plan_version_id: input.planVersionId,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/* ── platform read models ────────────────────────────────────────────── */

export async function getPlatformSubscriptions(): Promise<PlatformSubscriptionRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("platform_subscriptions");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    subscription_id: String(r.subscription_id),
    tenant_id: String(r.tenant_id),
    tenant_name: String(r.tenant_name),
    tenant_slug: String(r.tenant_slug),
    status: r.status as SubscriptionStatus,
    billing_interval: r.billing_interval as BillingInterval,
    currency: String(r.currency),
    plan_code: String(r.plan_code),
    plan_name: String(r.plan_name),
    plan_version: toNum(r.plan_version),
    unit_price_minor: toNum(r.unit_price_minor),
    current_period_start: (r.current_period_start as string | null) ?? null,
    current_period_end: (r.current_period_end as string | null) ?? null,
    trial_start: (r.trial_start as string | null) ?? null,
    trial_end: (r.trial_end as string | null) ?? null,
    cancel_at_period_end: Boolean(r.cancel_at_period_end),
    pending_plan_version_id: (r.pending_plan_version_id as string | null) ?? null,
    failed_payment_count: toNum(r.failed_payment_count),
    past_due_since: (r.past_due_since as string | null) ?? null,
    ended_at: (r.ended_at as string | null) ?? null,
    created_at: String(r.created_at),
  }));
}

export async function getPlatformInvoices(): Promise<PlatformInvoiceRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("platform_invoices");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    invoice_id: String(r.invoice_id),
    tenant_id: String(r.tenant_id),
    tenant_name: String(r.tenant_name),
    subscription_id: String(r.subscription_id),
    status: r.status as InvoiceStatus,
    invoice_number: (r.invoice_number as string | null) ?? null,
    plan_code: String(r.plan_code),
    plan_name: String(r.plan_name),
    plan_version: toNum(r.plan_version),
    billing_interval: r.billing_interval as BillingInterval,
    currency: String(r.currency),
    period_start: String(r.period_start),
    period_end: String(r.period_end),
    subtotal_minor: toNum(r.subtotal_minor),
    discount_credits_minor: toNum(r.discount_credits_minor),
    tax_minor: toNum(r.tax_minor),
    total_minor: toNum(r.total_minor),
    refunded_minor: toNum(r.refunded_minor),
    issued_at: (r.issued_at as string | null) ?? null,
    due_at: (r.due_at as string | null) ?? null,
    paid_at: (r.paid_at as string | null) ?? null,
    voided_at: (r.voided_at as string | null) ?? null,
  }));
}

export async function getPlatformPayments(): Promise<PlatformPaymentRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("platform_payments");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    payment_id: String(r.payment_id),
    tenant_id: String(r.tenant_id),
    tenant_name: String(r.tenant_name),
    invoice_id: String(r.invoice_id),
    invoice_number: (r.invoice_number as string | null) ?? null,
    subscription_id: (r.subscription_id as string | null) ?? null,
    amount_minor: toNum(r.amount_minor),
    currency: String(r.currency),
    status: r.status as PaymentStatus,
    provider: String(r.provider),
    provider_payment_reference: String(r.provider_payment_reference),
    notes: (r.notes as string | null) ?? null,
    received_at: (r.received_at as string | null) ?? null,
  }));
}

export async function getPlatformBillingEvents(): Promise<PlatformBillingEventRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("platform_billing_events");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    event_id: String(r.event_id),
    provider: String(r.provider),
    provider_event_id: String(r.provider_event_id),
    event_type: String(r.event_type),
    processing_status: r.processing_status as BillingEventStatus,
    signature_verified: Boolean(r.signature_verified),
    failure_reason: (r.failure_reason as string | null) ?? null,
    processed_at: (r.processed_at as string | null) ?? null,
    created_at: String(r.created_at),
  }));
}

export async function getPlatformBillingConfig(): Promise<BillingConfigRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("platform_billing_config");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  return {
    grace_period_days: toNum(rows[0].grace_period_days),
    max_payment_retries: toNum(rows[0].max_payment_retries),
  };
}

/* ── platform operations (reason-mandated where exceptional) ─────────── */

export async function recordManualPayment(input: {
  invoiceId: string;
  amountMinor: number;
  currency: string;
  providerReference: string;
  notes: string;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("record_manual_payment", {
    p_invoice_id: input.invoiceId,
    p_amount_minor: input.amountMinor,
    p_currency: input.currency,
    p_provider_reference: input.providerReference,
    p_notes: input.notes,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function recordManualRefund(input: {
  paymentId: string;
  amountMinor: number;
  reason: string;
  providerReference: string;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("record_manual_refund", {
    p_payment_id: input.paymentId,
    p_amount_minor: input.amountMinor,
    p_reason: input.reason,
    p_provider_reference: input.providerReference,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function recordPaymentFailureManual(input: {
  invoiceId: string;
  failureCode: string;
  failureMessage: string;
  providerReference: string;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("record_payment_failure_manual", {
    p_invoice_id: input.invoiceId,
    p_failure_code: input.failureCode,
    p_failure_message: input.failureMessage,
    p_provider_reference: input.providerReference,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function platformCreateInvoice(input: {
  subscriptionId: string;
  reason: string;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("platform_create_invoice", {
    p_subscription_id: input.subscriptionId,
    p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function platformIssueInvoice(input: {
  invoiceId: string;
  reason: string;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("platform_issue_invoice", {
    p_invoice_id: input.invoiceId,
    p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function issueCredit(input: {
  tenantId: string;
  amountMinor: number;
  reason: string;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("issue_credit", {
    p_tenant_id: input.tenantId,
    p_amount_minor: input.amountMinor,
    p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function applyCredit(input: {
  creditId: string;
  invoiceId: string;
  amountMinor: number;
  reason: string;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("apply_credit", {
    p_credit_id: input.creditId,
    p_invoice_id: input.invoiceId,
    p_amount_minor: input.amountMinor,
    p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function correctSubscriptionState(input: {
  subscriptionId: string;
  newStatus: SubscriptionStatus;
  reason: string;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("correct_subscription_state", {
    p_subscription_id: input.subscriptionId,
    p_new_status: input.newStatus,
    p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function setBillingConfig(input: {
  gracePeriodDays: number;
  maxPaymentRetries: number;
  reason: string;
}): Promise<BillingConfigRow> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("set_billing_config", {
    p_grace_period_days: input.gracePeriodDays,
    p_max_payment_retries: input.maxPaymentRetries,
    p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    grace_period_days: toNum(r.grace_period_days),
    max_payment_retries: toNum(r.max_payment_retries),
  };
}

/* ── deterministic processors (platform-invoked) ─────────────────────── */

export async function runTrialExpiries(): Promise<ProcessorActionRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("process_trial_expiries");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    subscription_id: String(r.subscription_id),
    action: String(r.action),
  }));
}

export async function runDunningTransitions(): Promise<ProcessorActionRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("process_dunning_transitions");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    subscription_id: String(r.subscription_id),
    action: String(r.action),
  }));
}

export async function runPeriodRenewals(): Promise<ProcessorActionRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("process_period_renewals");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    subscription_id: String(r.subscription_id),
    action: String(r.action),
  }));
}

/* ── provider-independent payment adapter seam ───────────────────────── */

export interface InitializeCheckoutInput {
  tenantId: string;
  invoiceId: string | null;
  amountMinor: number;
  currency: string;
  description: string;
}

export interface CheckoutSession {
  provider: string;
  mode: "hosted" | "offline";
  providerPaymentReference: string | null;
  instructions: string;
}

export interface JournalWebhookInput {
  provider: string;
  providerEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureVerified: boolean;
}

export interface JournalEventResult {
  event_id: string;
  duplicate: boolean;
  processing_status: BillingEventStatus;
}

/**
 * The provider seam (§16): a future PSP plugs in by implementing this
 * interface. Provider identity is DATA; the billing core never branches
 * on which provider is calling — every adapter funnels into the SAME
 * server state machine via the platform core primitives.
 */
export interface PaymentProviderAdapter {
  readonly provider: string;
  initializeCheckout(input: InitializeCheckoutInput): Promise<CheckoutSession>;
  verifyWebhook(event: JournalWebhookInput): Promise<JournalEventResult>;
  getPaymentStatus(providerPaymentReference: string): Promise<PaymentStatus | null>;
  refund(input: { paymentId: string; amountMinor: number; reason: string }): Promise<string>;
}

/**
 * The manual / offline adapter — the ONLY functional adapter this phase.
 * A platform admin records a VERIFIED payment (actor + reference + notes
 * required) which flows through the SAME core primitives; webhooks are
 * journaled raw before processing (idempotent, write-once).
 */
export const manualAdapter: PaymentProviderAdapter = {
  provider: "manual",

  async initializeCheckout(input: InitializeCheckoutInput): Promise<CheckoutSession> {
    return {
      provider: "manual",
      mode: "offline",
      providerPaymentReference: null,
      instructions:
        `Offline payment instruction for ${input.description}: record the verified ` +
        `transfer of ${input.amountMinor} minor units (${input.currency}) with a bank ` +
        `reference, then have a platform admin record it against the invoice.`,
    };
  },

  async verifyWebhook(event: JournalWebhookInput): Promise<JournalEventResult> {
    // Journal the RAW payload BEFORE any processing (idempotent by
    // provider + provider_event_id), then advance the journal write-once.
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("journal_billing_event", {
      p_provider: event.provider,
      p_provider_event_id: event.providerEventId,
      p_event_type: event.eventType,
      p_payload: event.payload,
      p_signature_verified: event.signatureVerified,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    const row = rows[0] ?? {};
    const result: JournalEventResult = {
      event_id: String(row.event_id ?? ""),
      duplicate: Boolean(row.duplicate),
      processing_status: row.processing_status as BillingEventStatus,
    };
    if (!result.duplicate) {
      await runBillingEventsProcessor();
    }
    return result;
  },

  async getPaymentStatus(providerPaymentReference: string): Promise<PaymentStatus | null> {
    const payments = await getPlatformPayments();
    const hit = payments.find(
      (p) => p.provider_payment_reference === providerPaymentReference
    );
    return hit?.status ?? null;
  },

  async refund(input: {
    paymentId: string;
    amountMinor: number;
    reason: string;
  }): Promise<string> {
    return recordManualRefund({
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      reason: input.reason,
      providerReference: `manual-refund-${Date.now()}`,
    });
  },
};

/** Advance the journal: received → processed | rejected (write-once). */
export async function runBillingEventsProcessor(): Promise<BillingEventActionRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("process_billing_events");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    event_id: String(r.event_id),
    action: String(r.action),
  }));
}
