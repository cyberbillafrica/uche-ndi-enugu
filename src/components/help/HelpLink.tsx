"use client";

import { HelpCircle } from "lucide-react";

/*
 * ============================================================
 * CONTEXTUAL HELP LINKS
 *
 * Small inline "help" buttons that open the Portal Guidance
 * panel directly on a specific article. See
 * src/lib/help-content.ts for the article ids.
 * ============================================================
 */

export const HELP_OPEN_EVENT = "politicore:open-help";

/** Programmatically open the Portal Guidance panel on a specific article. */
export function openHelpArticle(articleId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(HELP_OPEN_EVENT, { detail: { articleId } }),
  );
}

/**
 * Inline contextual help button for portal screens.
 *
 * Usage: <HelpLink article="result-upload" label="How do I submit a result?" />
 */
export function HelpLink({
  article,
  label,
  className = "",
}: {
  article: string;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => openHelpArticle(article)}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 transition-colors hover:border-apc-primary/40 hover:text-apc-primary focus:outline-none focus:ring-2 focus:ring-apc-primary/40 ${className}`}
      title={`Help: ${label}`}
      aria-label={`Help: ${label}`}
    >
      <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
