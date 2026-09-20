"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
} from "lucide-react";

/*
 * ============================================================
 * TOAST NOTIFICATIONS
 *
 * Transient feedback for the action the user just performed
 * (saved, submitted, failed, permission denied, ...).
 *
 * This is deliberately separate from the Notification Center
 * (bell icon) in the portal layout, which is the persistent
 * notification history. Toasts are never written there.
 * ============================================================
 */

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  /** Optional short heading. Defaults to a variant-appropriate title. */
  title?: string;
  /** The human-readable message. */
  description: string;
  variant?: ToastVariant;
  /** Auto-dismiss after this many milliseconds. */
  duration?: number;
}

interface ToastItem extends Required<Omit<ToastOptions, "title">> {
  id: number;
  title?: string;
  leaving?: boolean;
}

interface ToastContextValue {
  toast: {
    (options: ToastOptions): void;
    success: (description: string, options?: Partial<ToastOptions>) => void;
    error: (description: string, options?: Partial<ToastOptions>) => void;
    warning: (description: string, options?: Partial<ToastOptions>) => void;
    info: (description: string, options?: Partial<ToastOptions>) => void;
  };
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Default auto-dismiss durations (ms). Errors stay longer so they can be read. */
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 5000,
  info: 6000,
  warning: 8000,
  error: 12000,
};

const VARIANT_META: Record<
  ToastVariant,
  { icon: typeof Info; classes: string; title: string; live: "polite" | "assertive" }
> = {
  success: {
    icon: CheckCircle2,
    classes: "border-green-200 bg-green-50 text-green-900",
    title: "Success",
    live: "polite",
  },
  error: {
    icon: XCircle,
    classes: "border-red-200 bg-red-50 text-red-900",
    title: "Something went wrong",
    live: "assertive",
  },
  warning: {
    icon: AlertTriangle,
    classes: "border-amber-200 bg-amber-50 text-amber-900",
    title: "Please note",
    live: "polite",
  },
  info: {
    icon: Info,
    classes: "border-sky-200 bg-sky-50 text-sky-900",
    title: "Information",
    live: "polite",
  },
};

const MAX_VISIBLE_TOASTS = 4;
const EXIT_ANIMATION_MS = 200;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    // Mark as leaving so the exit animation can play, then remove.
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    );
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_ANIMATION_MS);
  }, []);

  const push = useCallback(
    (options: ToastOptions) => {
      const variant = options.variant ?? "info";
      const id = nextId.current++;
      const item: ToastItem = {
        id,
        title: options.title,
        description: options.description,
        variant,
        duration: options.duration ?? DEFAULT_DURATION[variant],
      };

      setToasts((prev) => {
        const next = [...prev, item];
        // Keep the most recent toasts; oldest overflow is dismissed.
        return next.length > MAX_VISIBLE_TOASTS
          ? next.slice(next.length - MAX_VISIBLE_TOASTS)
          : next;
      });

      if (item.duration > 0) {
        window.setTimeout(() => dismiss(id), item.duration);
      }
    },
    [dismiss],
  );

  const toast = useMemo(() => {
    const fn = (options: ToastOptions) => push(options);
    fn.success = (description: string, options?: Partial<ToastOptions>) =>
      push({ ...options, description, variant: "success" });
    fn.error = (description: string, options?: Partial<ToastOptions>) =>
      push({ ...options, description, variant: "error" });
    fn.warning = (description: string, options?: Partial<ToastOptions>) =>
      push({ ...options, description, variant: "warning" });
    fn.info = (description: string, options?: Partial<ToastOptions>) =>
      push({ ...options, description, variant: "info" });
    return fn;
  }, [push]);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue["toast"] {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fail loudly in development rather than silently dropping feedback.
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx.toast;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    // The container is an aria-live region so screen readers announce toasts
    // without moving keyboard focus. Individual toasts are also focusable via
    // their dismiss buttons.
    <div
      aria-live="polite"
      aria-relevant="additions text"
      className="pointer-events-none fixed inset-x-3 top-3 z-[70] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:top-4 sm:items-end"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const meta = VARIANT_META[toast.variant];
  const Icon = meta.icon;

  return (
    <div
      role={toast.variant === "error" ? "alert" : "status"}
      aria-live={meta.live}
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border p-4 shadow-lg transition-all duration-200 ${
        toast.leaving
          ? "translate-x-0 opacity-0 sm:translate-x-4"
          : "animate-in fade-in slide-in-from-top-2 duration-200"
      } ${meta.classes}`}
    >
      <Icon
        className="mt-0.5 h-5 w-5 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {toast.title && (
          <p className="text-sm font-bold leading-tight">{toast.title}</p>
        )}
        <p className="text-sm leading-snug">{toast.description}</p>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="-m-1 shrink-0 rounded-md p-1 transition-colors hover:bg-black/5 focus:outline-none focus:ring-2 focus:ring-current"
        aria-label="Dismiss notification"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
