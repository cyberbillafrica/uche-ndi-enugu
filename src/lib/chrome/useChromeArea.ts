/**
 * POLITICORE — Control Center chrome editor hook (Phase 25).
 *
 * Shared lifecycle for the header/navigation/footer editors: load the area
 * record, edit the draft client-side, save against the loaded revision
 * (server-enforced optimistic concurrency), publish, and manage bounded
 * history rollback. Authority stays server-side (migration 0063 RPCs) —
 * the client only sends configuration payloads; validation here is UX
 * convenience, never the security boundary.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import { getErrorMessage } from "@/lib/errors";
import { getSiteConfig, type SiteConfigRecord } from "@/lib/supabase/controlCenter";
import {
  getSiteConfigHistory,
  publishFooter,
  publishNavigation,
  saveFooterDraft,
  saveNavigationDraft,
} from "@/lib/supabase/websiteExperience";
import { rollbackSiteConfig } from "@/lib/supabase/controlCenter";

export type ChromeArea = "navigation" | "footer";

export function useChromeArea<T extends object>(
  area: ChromeArea,
  defaults: T,
  validate: (draft: T) => string | null
) {
  const [record, setRecord] = useState<SiteConfigRecord | null>(null);
  const [draft, setDraft] = useState<T>(defaults);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ revision: number; published_at: string | null }[]>([]);

  const load = useCallback(async () => {
    try {
      const rec = await getSiteConfig(area);
      const hist = await getSiteConfigHistory(area);
      setRecord(rec);
      setDraft(((rec?.draft ?? rec?.published) as T | null | undefined) ?? defaults);
      setHistory(hist);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area]);

  // Initial load — matches the established editor pattern (Phase 23/24
  // pages): an async function declared INSIDE the effect body. State
  // updates only fire after await points, never synchronously in the
  // effect body, satisfying react-hooks/set-state-in-effect.
  useEffect(() => {
    async function initialLoad() {
      await load();
    }
    void initialLoad();
  }, [load]);

  const revision = record?.revision ?? 0;
  const savedDraft = (record?.draft ?? record?.published ?? null) as T | null;
  const isDirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const hasPublished = Boolean(record?.published);

  /** Client-side validation gate; the server re-validates authoritatively. */
  const validationError = validate(draft);

  async function saveDraft(notify: (msg: string) => void, fail: (msg: string) => void) {
    if (validationError) {
      fail(validationError);
      return;
    }
    setBusy(true);
    try {
      const next =
        area === "navigation"
          ? await saveNavigationDraft(draft as never, revision)
          : await saveFooterDraft(draft as never, revision);
      notify(`Draft saved (revision ${next}). Not yet public.`);
      await load();
    } catch (err) {
      fail(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function publish(notify: (msg: string) => void, fail: (msg: string) => void) {
    setBusy(true);
    try {
      const result =
        area === "navigation"
          ? await publishNavigation(revision)
          : await publishFooter(revision);
      notify(`Published — live at revision ${result.revision}.`);
      await load();
    } catch (err) {
      fail(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function rollback(
    historyRevision: number,
    notify: (msg: string) => void,
    fail: (msg: string) => void
  ) {
    setBusy(true);
    try {
      await rollbackSiteConfig(area, historyRevision);
      notify(`Revision ${historyRevision} restored to draft — review, then publish.`);
      await load();
    } catch (err) {
      fail(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return {
    record,
    draft,
    setDraft,
    loading,
    busy,
    error,
    history,
    revision,
    isDirty,
    hasPublished,
    validationError,
    reload: load,
    saveDraft,
    publish,
    rollback,
  };
}
