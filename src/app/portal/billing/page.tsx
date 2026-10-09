"use client";

/**
 * POLITICORE — Billing (Phase 29, SaaS B) — tenant-owner surface.
 *
 * Owner-only visibility: billing data is visible to the EXISTING
 * tenant_super_admin only (members and plain admins never see billing —
 * enforced server-side by the RPCs; mirrored here for presentation).
 * Subscribe (trial comes from the plan version), cancel-at-period-end,
 * revoke cancellation, next-period plan change, invoices and payments.
 * Money renders in integer minor units (kobo); the client performs no
 * money math and no authority decisions.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import {
  changeSubscriptionPlan,
  createSubscription,
  formatMinor,
  getMyInvoices,
  getMyPayments,
  getMySubscription,
  getSubscriptionPlans,
  revokeSubscriptionCancellation,
  scheduleSubscriptionCancellation,
  INVOICE_STATUS_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  type BillingInterval,
  type MyInvoiceRow,
  type MyPaymentRow,
  type SubscriptionCurrentRow,
  type SubscriptionPlanRow,
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

const INVOICE_STATUS_STYLES: Record<string, string> = {
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

export default function BillingPage() {
  const { profile } = useAuth();
  const toast = useToast();
  const [subscription, setSubscription] = useState<SubscriptionCurrentRow | null>(null);
  const [invoices, setInvoices] = useState<MyInvoiceRow[]>([]);
  const [payments, setPayments] = useState<MyPaymentRow[]>([]);
  const [catalog, setCatalog] = useState<SubscriptionPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const isOwner = profile?.access_role === "tenant_super_admin";

  const load = useCallback(async () => {
    const [sub, inv, pay] = await Promise.all([
      getMySubscription(),
      getMyInvoices(),
      getMyPayments(),
    ]);
    setSubscription(sub);
    setInvoices(inv);
    setPayments(pay);
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    async function loadBilling() {
      setLoading(true);
      try {
        const [sub, inv, pay, plans] = await Promise.all([
          getMySubscription(),
          getMyInvoices(),
          getMyPayments(),
          getSubscriptionPlans(),
        ]);
        if (cancelled) return;
        setSubscription(sub);
        setInvoices(inv);
        setPayments(pay);
        setCatalog(plans);
      } catch (err) {
        console.error("Failed to load billing data:", err);
        if (!cancelled)
          toast.error("We couldn't load your billing data. Please refresh and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadBilling();
    return () => {
      cancelled = true;
    };
  }, [isOwner, toast]);

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load();
    } catch (err) {
      console.error("Billing action failed:", err);
      toast.error(err instanceof Error ? err.message : "The billing action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!isOwner) {
    return (
      <div className="max-w-7xl mx-auto pb-12">
        <Card>
          <CardContent className="p-8 text-center">
            <ShieldAlert className="h-10 w-10 mx-auto text-gray-400" />
            <h1 className="mt-3 text-lg font-bold text-gray-900">Owner only</h1>
            <p className="mt-1 text-sm text-gray-500">
              Billing is visible only to the tenant owner.
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
        <span className="ml-3 text-gray-500">Loading your billing...</span>
      </div>
    );
  }

  const liveVersions = catalog.filter(
    (c) => !subscription || c.plan_version_id !== subscription.plan_version_id
  );

  return (
    <div className="max-w-7xl mx-auto pb-12 space-y-6">
      {/* Current subscription */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <CreditCard className="h-5 w-5 text-brand-primary" /> Subscription
          </CardTitle>
        </CardHeader>
        <CardContent>
          {subscription ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xl font-bold text-gray-900">
                  {subscription.plan_name}
                </span>
                <span className="text-sm text-gray-500">
                  v{subscription.plan_version} · {subscription.billing_interval} ·{" "}
                  {formatMinor(subscription.unit_price_minor, subscription.currency)}
                </span>
                <span
                  className={`ml-auto px-2.5 py-0.5 rounded-full border text-xs font-semibold ${SUB_STATUS_STYLES[subscription.status]}`}
                >
                  {SUBSCRIPTION_STATUS_LABELS[subscription.status]}
                </span>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-gray-500">Current period</dt>
                  <dd className="font-medium text-gray-900">
                    {formatDate(subscription.current_period_start)} –{" "}
                    {formatDate(subscription.current_period_end)}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Trial ends</dt>
                  <dd className="font-medium text-gray-900">
                    {formatDate(subscription.trial_end)}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Failed payments</dt>
                  <dd className="font-medium text-gray-900">
                    {subscription.failed_payment_count}
                  </dd>
                </div>
              </dl>

              {subscription.pending_plan_name && (
                <p className="text-sm text-sky-700 bg-sky-50 border border-sky-200 rounded-md px-3 py-2">
                  Scheduled to change to <strong>{subscription.pending_plan_name}</strong> at
                  the next billing period (no proration).
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {subscription.cancel_at_period_end ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      run(
                        "revoke",
                        () =>
                          revokeSubscriptionCancellation({
                            subscriptionId: subscription.subscription_id,
                          }),
                        "Cancellation revoked — your subscription will renew."
                      )
                    }
                    className="px-3 py-1.5 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Revoke scheduled cancellation
                  </button>
                ) : (
                  subscription.status !== "cancelled" &&
                  subscription.status !== "restricted" && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        run(
                          "cancel",
                          () =>
                            scheduleSubscriptionCancellation({
                              subscriptionId: subscription.subscription_id,
                            }),
                          "Cancellation scheduled for the end of the current period."
                        )
                      }
                      className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:opacity-50"
                    >
                      Cancel at period end
                    </button>
                  )
                )}
              </div>

              {liveVersions.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    Change plan (takes effect next billing period)
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {liveVersions.map((v) => (
                      <button
                        key={v.plan_version_id}
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          run(
                            `plan:${v.plan_version_id}`,
                            () =>
                              changeSubscriptionPlan({
                                subscriptionId: subscription.subscription_id,
                                planVersionId: v.plan_version_id,
                              }),
                            `Plan change to ${v.plan_name} scheduled for the next period.`
                          )
                        }
                        className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {v.plan_name} (v{v.version})
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                No active subscription. Choose a plan to start — trials come from the plan
                (14 days on launch plans, no payment method required).
              </p>
              <div className="flex flex-wrap gap-2">
                {catalog.map((v) => (                    <div key={v.plan_version_id} className="flex items-center gap-1">
                    {(["monthly", "annual"] as BillingInterval[]).map((interval) => (
                      <button
                        key={interval}
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          run(
                            `sub:${v.plan_version_id}:${interval}`,
                            () =>
                              createSubscription({
                                planVersionId: v.plan_version_id,
                                billingInterval: interval,
                              }),
                            `Subscribed to ${v.plan_name} (${interval}).`
                          )
                        }
                        className="px-3 py-1.5 rounded-md text-sm font-medium bg-brand-primary text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {v.plan_name} · {interval}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invoices */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Invoices</CardTitle>
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
                    <th className="py-2 pr-4 font-medium">Plan</th>
                    <th className="py-2 pr-4 font-medium">Period</th>
                    <th className="py-2 pr-4 font-medium">Total</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.invoice_id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">
                        {inv.invoice_number ?? "— (draft)"}
                      </td>
                      <td className="py-2 pr-4">{inv.plan_name}</td>
                      <td className="py-2 pr-4">
                        {formatDate(inv.period_start)} – {formatDate(inv.period_end)}
                      </td>
                      <td className="py-2 pr-4 font-medium">
                        {formatMinor(inv.total_minor, inv.currency)}
                        {inv.refunded_minor > 0 && (
                          <span className="ml-1 text-xs text-purple-700">
                            ({formatMinor(inv.refunded_minor, inv.currency)} refunded)
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={`px-2 py-0.5 rounded-full border text-xs font-semibold ${INVOICE_STATUS_STYLES[inv.status] ?? ""}`}
                        >
                          {INVOICE_STATUS_LABELS[inv.status]}
                        </span>
                      </td>
                      <td className="py-2">{formatDate(inv.due_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payments */}
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
                    <th className="py-2 pr-4 font-medium">Invoice</th>
                    <th className="py-2 pr-4 font-medium">Amount</th>
                    <th className="py-2 pr-4 font-medium">Provider</th>
                    <th className="py-2 font-medium">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((pay) => (
                    <tr key={pay.payment_id} className="border-b last:border-0">
                      <td className="py-2 pr-4">{formatDate(pay.received_at)}</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {pay.invoice_number ?? "—"}
                      </td>
                      <td className="py-2 pr-4 font-medium">
                        {formatMinor(pay.amount_minor, pay.currency)}
                      </td>
                      <td className="py-2 pr-4">{pay.provider}</td>
                      <td className="py-2 font-mono text-xs">
                        {pay.provider_payment_reference}
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
}
