"use client";

/**
 * POLITICORE — Platform Billing Console (Phase 29, SaaS B).
 *
 * Platform-admin operations surface: all tenant subscriptions, the
 * immutable invoice ledger, the payment ledger, the webhook journal and
 * the dunning configuration. Every mutation is a platform authority op
 * with a MANDATORY reason, enforced server-side by the SECURITY DEFINER
 * RPCs — this UI mirrors it for presentation only. The manual/offline
 * adapter (the only functional adapter this phase) records VERIFIED
 * payments through the same server state machine as any future PSP.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import {
  correctSubscriptionState,
  formatMinor,
  getPlatformBillingConfig,
  getPlatformBillingEvents,
  getPlatformInvoices,
  getPlatformPayments,
  getPlatformSubscriptions,
  platformCreateInvoice,
  platformIssueInvoice,
  recordManualPayment,
  runDunningTransitions,
  runPeriodRenewals,
  runTrialExpiries,
  setBillingConfig,
  INVOICE_STATUS_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  type InvoiceStatus,
  type PlatformBillingEventRow,
  type PlatformInvoiceRow,
  type PlatformPaymentRow,
  type PlatformSubscriptionRow,
  type SubscriptionStatus,
} from "@/lib/supabase";
import { CreditCard, Loader2, ShieldAlert } from "lucide-react";

const SUB_STATUS_STYLES: Record<SubscriptionStatus, string> = {
  trialing: "bg-sky-100 text-sky-800 border-sky-200",
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  past_due: "bg-amber-100 text-amber-800 border-amber-200",
  restricted: "bg-red-100 text-red-800 border-red-200",
  cancelled: "bg-gray-100 text-gray-600 border-gray-200",
};

const INVOICE_STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-gray-100 text-gray-600 border-gray-200",
  issued: "bg-sky-100 text-sky-800 border-sky-200",
  paid: "bg-emerald-100 text-emerald-800 border-emerald-200",
  past_due: "bg-amber-100 text-amber-800 border-amber-200",
  void: "bg-gray-100 text-gray-600 border-gray-200",
  refunded: "bg-purple-100 text-purple-800 border-purple-200",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-NG", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function AdminBillingPage() {
  const { profile } = useAuth();
  const toast = useToast();
  const [subscriptions, setSubscriptions] = useState<PlatformSubscriptionRow[]>([]);
  const [invoices, setInvoices] = useState<PlatformInvoiceRow[]>([]);
  const [payments, setPayments] = useState<PlatformPaymentRow[]>([]);
  const [events, setEvents] = useState<PlatformBillingEventRow[]>([]);
  const [config, setConfig] = useState<{ grace_period_days: number; max_payment_retries: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const isPlatformAdmin = profile?.access_role === "platform_super_admin";

  const load = useCallback(async () => {
    const [subs, invs, pays, evts, cfg] = await Promise.all([
      getPlatformSubscriptions(),
      getPlatformInvoices(),
      getPlatformPayments(),
      getPlatformBillingEvents(),
      getPlatformBillingConfig(),
    ]);
    setSubscriptions(subs);
    setInvoices(invs);
    setPayments(pays);
    setEvents(evts);
    setConfig(cfg);
  }, []);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    async function loadBilling() {
      setLoading(true);
      try {
        const [subs, invs, pays, evts, cfg] = await Promise.all([
          getPlatformSubscriptions(),
          getPlatformInvoices(),
          getPlatformPayments(),
          getPlatformBillingEvents(),
          getPlatformBillingConfig(),
        ]);
        if (cancelled) return;
        setSubscriptions(subs);
        setInvoices(invs);
        setPayments(pays);
        setEvents(evts);
        setConfig(cfg);
      } catch (err) {
        console.error("Failed to load billing data:", err);
        if (!cancelled)
          toast.error("We couldn't load billing data. Please refresh and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadBilling();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin, toast]);

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load();
    } catch (err) {
      console.error("Billing operation failed:", err);
      toast.error(err instanceof Error ? err.message : "The billing operation failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!isPlatformAdmin) {
    return (
      <div className="max-w-7xl mx-auto pb-12">
        <Card>
          <CardContent className="p-8 text-center">
            <ShieldAlert className="h-10 w-10 mx-auto text-gray-400" />
            <h1 className="mt-3 text-lg font-bold text-gray-900">Platform administration only</h1>
            <p className="mt-1 text-sm text-gray-500">
              Billing operations are restricted to platform administrators.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <span className="ml-3 text-gray-500">Loading billing...</span>
      </div>
    );
  }

  /** An actionable invoice: issuable (draft) or settleable (issued/past_due). */
  const issuable = invoices.filter((i) => i.status === "draft");
  const settleable = invoices.filter((i) => i.status === "issued" || i.status === "past_due");

  return (
    <div className="max-w-7xl mx-auto pb-12 space-y-6">
      {/* Dunning config + processors */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <CreditCard className="h-5 w-5 text-brand-primary" /> Billing operations
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-gray-600">
            Dunning configuration:{" "}
            <strong>{config ? `${config.grace_period_days}-day grace` : "defaults (7-day grace)"}</strong>
            {" · "}
            <strong>{config ? `${config.max_payment_retries} retries` : "3 retries"}</strong>{" "}
            (stored in platform settings — tunable without a migration).
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                run("grace", () => setBillingConfig({ gracePeriodDays: 7, maxPaymentRetries: 3, reason: "Reaffirm dunning defaults from the billing console" }), "Dunning configuration saved (7-day grace, 3 retries).")
              }
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              Set dunning defaults (7d / 3)
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                run("trials", async () => {
                  const rows = await runTrialExpiries();
                  toast.info(`Trial processor: ${rows.length} action(s).`);
                }, "Trial expiry processor ran.")
              }
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              Run trial expiries
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                run("dunning", async () => {
                  const rows = await runDunningTransitions();
                  toast.info(`Dunning processor: ${rows.length} action(s).`);
                }, "Dunning processor ran.")
              }
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              Run dunning transitions
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                run("renewals", async () => {
                  const rows = await runPeriodRenewals();
                  toast.info(`Renewal processor: ${rows.length} action(s).`);
                }, "Renewal processor ran.")
              }
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              Run period renewals
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Subscriptions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Tenant subscriptions</CardTitle>
        </CardHeader>
        <CardContent>
          {subscriptions.length === 0 ? (
            <p className="text-sm text-gray-500">No subscriptions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-2 pr-4 font-medium">Tenant</th>
                    <th className="py-2 pr-4 font-medium">Plan</th>
                    <th className="py-2 pr-4 font-medium">Price</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Period end</th>
                    <th className="py-2 font-medium">Operations</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s) => (
                    <tr key={s.subscription_id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-gray-900">{s.tenant_name}</div>
                        <div className="text-xs text-gray-500">{s.tenant_slug}</div>
                      </td>
                      <td className="py-2 pr-4">
                        {s.plan_name} v{s.plan_version}
                        <div className="text-xs text-gray-500">{s.billing_interval}</div>
                      </td>
                      <td className="py-2 pr-4">{formatMinor(s.unit_price_minor, s.currency)}</td>
                      <td className="py-2 pr-4">
                        <span
                          className={`px-2 py-0.5 rounded-full border text-xs font-semibold ${SUB_STATUS_STYLES[s.status]}`}
                        >
                          {SUBSCRIPTION_STATUS_LABELS[s.status]}
                        </span>
                        {s.cancel_at_period_end && s.status === "active" && (
                          <div className="text-xs text-amber-700 mt-1">cancels at period end</div>
                        )}
                      </td>
                      <td className="py-2 pr-4">{formatDate(s.current_period_end ?? s.trial_end)}</td>
                      <td className="py-2 space-y-1">
                        {(s.status === "trialing" || s.status === "active" || s.status === "past_due") && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              run("inv:" + s.subscription_id, async () => {
                                const invId = await platformCreateInvoice({
                                  subscriptionId: s.subscription_id,
                                  reason: `Ad-hoc invoice created from the billing console for ${s.tenant_name}`,
                                });
                                await platformIssueInvoice({
                                  invoiceId: invId,
                                  reason: `Invoice issued from the billing console for ${s.tenant_name}`,
                                });
                              }, "Invoice created and issued.")
                            }
                            className="block px-2 py-1 rounded text-xs font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Create + issue invoice
                          </button>
                        )}
                        {s.status !== "cancelled" && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              run(
                                "cancel:" + s.subscription_id,
                                () =>
                                  correctSubscriptionState({
                                    subscriptionId: s.subscription_id,
                                    newStatus: "cancelled",
                                    reason: `Immediate cancellation ordered from the billing console for ${s.tenant_name}`,
                                  }),
                                "Subscription cancelled (immediate, non-destructive)."
                              )
                            }
                            className="block px-2 py-1 rounded text-xs font-medium bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:opacity-50"
                          >
                            Cancel immediately
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invoice ledger */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Invoices (immutable ledger)</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-gray-500">No invoices yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-2 pr-4 font-medium">Invoice</th>
                    <th className="py-2 pr-4 font-medium">Tenant</th>
                    <th className="py-2 pr-4 font-medium">Total</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Due</th>
                    <th className="py-2 font-medium">Operations</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.invoice_id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">
                        {inv.invoice_number ?? "— (draft)"}
                      </td>
                      <td className="py-2 pr-4">{inv.tenant_name}</td>
                      <td className="py-2 pr-4 font-medium">
                        {formatMinor(inv.total_minor, inv.currency)}
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={`px-2 py-0.5 rounded-full border text-xs font-semibold ${INVOICE_STATUS_STYLES[inv.status]}`}
                        >
                          {INVOICE_STATUS_LABELS[inv.status]}
                        </span>
                      </td>
                      <td className="py-2 pr-4">{formatDate(inv.due_at)}</td>
                      <td className="py-2">
                        {inv.status === "draft" && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              run(
                                "issue:" + inv.invoice_id,
                                () =>
                                  platformIssueInvoice({
                                    invoiceId: inv.invoice_id,
                                    reason: `Issued from the billing console (${inv.tenant_name})`,
                                  }),
                                "Invoice issued."
                              )
                            }
                            className="px-2 py-1 rounded text-xs font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Issue
                          </button>
                        )}
                        {settleable.some((i) => i.invoice_id === inv.invoice_id) && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              run(
                                "pay:" + inv.invoice_id,
                                () =>
                                  recordManualPayment({
                                    invoiceId: inv.invoice_id,
                                    amountMinor: inv.total_minor,
                                    currency: inv.currency,
                                    providerReference: `manual-${Date.now()}-${inv.invoice_id.slice(0, 8)}`,
                                    notes: "Verified offline payment recorded from the billing console",
                                  }),
                                "Verified payment recorded — invoice paid."
                              )
                            }
                            className="px-2 py-1 rounded text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            Record verified payment
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {issuable.length === 0 && settleable.length === 0 && invoices.length > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              No drafts to issue and no open invoices to settle.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Payments ledger */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Payments</CardTitle>
        </CardHeader>
        <CardContent>
          {payments.length === 0 ? (
            <p className="text-sm text-gray-500">No payments yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-2 pr-4 font-medium">Received</th>
                    <th className="py-2 pr-4 font-medium">Tenant</th>
                    <th className="py-2 pr-4 font-medium">Invoice</th>
                    <th className="py-2 pr-4 font-medium">Amount</th>
                    <th className="py-2 pr-4 font-medium">Provider</th>
                    <th className="py-2 font-medium">Operations</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((pay) => (
                    <tr key={pay.payment_id} className="border-b last:border-0">
                      <td className="py-2 pr-4">{formatDate(pay.received_at)}</td>
                      <td className="py-2 pr-4">{pay.tenant_name}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{pay.invoice_number ?? "—"}</td>
                      <td className="py-2 pr-4 font-medium">
                        {formatMinor(pay.amount_minor, pay.currency)}
                      </td>
                      <td className="py-2 pr-4">{pay.provider}</td>
                      <td className="py-2">
                        {pay.status === "succeeded" && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              run(
                                "refund:" + pay.payment_id,
                                () =>
                                  refundPayment(pay.payment_id, pay.amount_minor, pay.tenant_name),
                                "Refund recorded."
                              )
                            }
                            className="px-2 py-1 rounded text-xs font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Refund
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Webhook journal */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Billing events (webhook journal)</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-gray-500">
              No provider events journaled. Raw payloads are stored before processing and are
              idempotent by provider event id.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-2 pr-4 font-medium">Received</th>
                    <th className="py-2 pr-4 font-medium">Provider</th>
                    <th className="py-2 pr-4 font-medium">Event</th>
                    <th className="py-2 pr-4 font-medium">Signature</th>
                    <th className="py-2 font-medium">Processing</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.event_id} className="border-b last:border-0">
                      <td className="py-2 pr-4">{formatDate(e.created_at)}</td>
                      <td className="py-2 pr-4">{e.provider}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{e.event_type}</td>
                      <td className="py-2 pr-4 text-xs">
                        {e.signature_verified ? "verified" : "unverified"}
                      </td>
                      <td className="py-2 text-xs">
                        {e.processing_status}
                        {e.failure_reason ? ` — ${e.failure_reason}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  /** Partial-capable refund through the manual adapter (never exceeds refundable — DB-enforced). */
  async function refundPayment(paymentId: string, amountMinor: number, tenantName: string) {
    const { recordManualRefund } = await import("@/lib/supabase");
    return recordManualRefund({
      paymentId,
      amountMinor,
      reason: `Refund processed from the billing console for ${tenantName}`,
      providerReference: `manual-refund-${Date.now()}-${paymentId.slice(0, 8)}`,
    });
  }
}
