/**
 * POLITICORE — Checkout abstraction (Phase 30, §10).
 *
 * A provider-INDEPENDENT purchase seam for the subscription journey. The
 * Phase 29 `PaymentProviderAdapter` remains the payment/billing seam
 * (platform-core-centered); this module is the ONBOARDING-side seam so
 * tenant/onboarding business logic depends only on an abstraction and
 * never hard-codes Paystack / Flutterwave / Stripe (or any PSP SDK).
 *
 * Provider identity is DATA; behavior lives behind the interface. The
 * manual/offline adapter is the ONLY functional implementation in this
 * phase (the ratified launch billing path) — a future PSP plugs in by
 * implementing `CheckoutProvider` and registering itself. No payment
 * state is ever fabricated from the browser: even the adapter's money
 * facts are DISPLAY data sourced from the server; actual payment state
 * changes continue through the Phase 29 billing state machine.
 */
import type { BillingInterval } from "./billing"; // single canonical definition (barrel rule)

export type CheckoutMode = "hosted" | "offline";

export interface CheckoutRequest {
  /** Descriptive display data only — amounts come from server price rows. */
  planCode: string;
  planName: string;
  billingInterval: BillingInterval;
  amountMinor: number;
  currency: string;
  description: string;
}

export interface CheckoutInitiation {
  provider: string;
  mode: CheckoutMode;
  /** PSP-hosted reference or raw offline instruction reference; manual = null. */
  providerPaymentReference: string | null;
  /** What the customer does next (UI copy; server echoes allowed verbs). */
  instructions: string;
}

export interface PaymentVerificationInput {
  /** Customer/provider-supplied reference; the SERVER still re-resolves truth. */
  providerPaymentReference: string | null;
  invoiceId: string | null;
}

export interface PaymentVerificationResult {
  provider: string;
  /** Whether the provider VERIFIED a completed payment (never browser-claimed). */
  verified: boolean;
  mode: CheckoutMode;
  message: string;
  /** Server-reported subscription state after any verified transition. */
  subscriptionStatus: string | null;
}

/**
 * The checkout seam (§10 semantics): initialize a purchase, verify its
 * outcome. All state changes remain inside the Phase 29 billing state
 * machine — this seam NEVER marks invoices paid client-side.
 */
export interface CheckoutProvider {
  readonly provider: string;
  initializeCheckout(request: CheckoutRequest): Promise<CheckoutInitiation>;
  verifyPayment(input: PaymentVerificationInput): Promise<PaymentVerificationResult>;
}

/**
 * The manual/offline adapter — the default (and only functional) provider.
 * A trial never needs a payment (Phase 28 D3: no payment method); a paid
 * start records instructions for the offline path, and a platform admin
 * records the VERIFIED payment through Phase 29 (`record_manual_payment`).
 * Browser-declared "I paid" is never authoritative.
 */
export const manualCheckoutProvider: CheckoutProvider = {
  provider: "manual",

  async initializeCheckout(request: CheckoutRequest): Promise<CheckoutInitiation> {
    return {
      provider: "manual",
      mode: "offline",
      providerPaymentReference: null,
      instructions:
        `Offline payment for ${request.description} ` +
        `(${request.amountMinor} ${request.currency} minor units, ${request.billingInterval}): ` +
        `record the verified bank transfer, then a platform admin records it against the ` +
        `invoice — the subscription activates only after server verification.`,
    };
  },

  async verifyPayment(input: PaymentVerificationInput): Promise<PaymentVerificationResult> {
    void input; // the manual adapter cannot self-verify — the server decides
    return {
      provider: "manual",
      verified: false,
      mode: "offline",
      message:
        "Offline payments are verified out-of-band (platform admin records the transfer). " +
        "The subscription state shown by the server is the truth.",
      subscriptionStatus: null,
    };
  },
};

const providers = new Map<string, CheckoutProvider>([["manual", manualCheckoutProvider]]);
let active: CheckoutProvider = manualCheckoutProvider;

/** Currently selected checkout provider (manual/offline until a PSP phase). */
export function getCheckoutProvider(): CheckoutProvider {
  return active;
}

/** Register (or re-select) a provider — the future PSP integration point. */
export function registerCheckoutProvider(provider: CheckoutProvider): void {
  providers.set(provider.provider, provider);
  active = provider;
}

export function selectCheckoutProvider(providerName: string): CheckoutProvider {
  const found = providers.get(providerName);
  if (!found) throw new Error(`no checkout provider registered as "${providerName}"`);
  active = found;
  return found;
}
