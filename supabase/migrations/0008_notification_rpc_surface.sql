-- =====================================================================
-- 0008: NOTIFICATIONS RPC SURFACE (Phase 1B vertical slice)
--
-- PostgREST (hosted Supabase data API) exposes public.* functions only,
-- so the notifications vertical slice needs public wrappers alongside
-- the politicore.* originals (0007). SECURITY INVOKER — the per-user
-- notifications RLS policies fully apply inside these calls.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[])
RETURNS integer AS $$
  SELECT politicore.mark_notifications_read(p_ids);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.my_unread_count()
RETURNS bigint AS $$
  SELECT politicore.my_unread_count();
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_unread_count() TO anon, authenticated, service_role;
