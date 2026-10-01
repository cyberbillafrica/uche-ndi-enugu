/**
 * POLITICORE — Homepage/Core Media URL mapping (Phase 24 §18).
 *
 * Section media references are canonical Core Media asset ids; rendering
 * resolves them through the Phase 23 public render route (which enforces
 * slug + tenant + visibility server-side). No provider URLs are ever
 * stored or constructed here.
 */
export function brandMediaUrl(assetId: string | null | undefined): string | null {
  if (!assetId || !/^[0-9a-fA-F-]{36}$/.test(assetId)) return null;
  return `/api/media/${assetId}`;
}
