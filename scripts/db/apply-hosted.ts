/**
 * POLITICORE — apply migrations to the HOSTED Supabase database (Phase 1B).
 *
 * Uses the Supabase DATABASE_URL (session pooler) directly because the
 * environment has no Supabase CLI / Docker / psql. Migrations run in
 * filename order; each file executes as one implicit transaction
 * (node-postgres simple-query semantics), matching `supabase db push`.
 *
 * Idempotence: some hosted projects lack supabase_migrations.schema_migrations
 * (this one does), so "already applied" is detected per-migration by a
 * signature object (a table/function/view that migration creates). A
 * migration whose signature exists is skipped (and recorded when the
 * history table IS available). A migration with no recorded history and
 * no signature is applied exactly once. Re-running is always safe.
 *
 * Secrets come from .env.local; they are never printed.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";

// ── env loading (no dotenv dependency) ──────────────────────────────────────
function loadEnv(): Record<string, string> {
  const vals: Record<string, string> = {};
  const file = path.resolve(".env.local");
  if (!fs.existsSync(file)) return vals;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) vals[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return vals;
}

/**
 * Tolerant Postgres URL parser. The pasted Supabase connection string can
 * arrive wrapped in quotes and with a password containing % / + characters
 * that are NOT percent-encoded; new URL() and pg's own parser either fail
 * or mis-decode those. We therefore extract components with a regex and do
 * NOT decode, passing them to pg as a config object.
 */
export function parseDatabaseUrl(rawUrl: string): pg.ClientConfig {
  const url = rawUrl.trim().replace(/^["']+|["']+$/g, "");
  const m = url.match(/^postgres(?:ql)?:\/\/([^:@/]+):([^@]+)@([^:/]+):(\d+)\/([^?\s]+)/);
  if (!m) throw new Error("DATABASE_URL is not a recognizable postgres:// URL");
  const [, user, password, host, port, database] = m;
  return {
    user,
    password,
    host,
    port: Number(port),
    database,
    ssl: { rejectUnauthorized: false }, // Supabase pooler TLS
  };
}

export function getHostedConfig(): pg.ClientConfig {
  const env = loadEnv();
  const url = env.DATABASE_URL ?? env.SUPABASE_DB_URL ?? env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  return parseDatabaseUrl(url);
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await client.connect();
  return client;
}

// ── preflight ────────────────────────────────────────────────────────────────
interface Preflight {
  currentUser: string;
  serverVersion: string;
  hostedAuthSchema: boolean;
  existingPoliticoreTables: number;
}

export async function preflight(client: pg.Client): Promise<Preflight> {
  const me = await client.query<{ current_user: string }>("SELECT current_user");
  const ver = await client.query<{ server_version: string }>("SHOW server_version");
  const hosted = await client.query<{ hosted: boolean }>(
    `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`
  );
  const tables = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables
     WHERE table_schema = 'politicore' AND table_type = 'BASE TABLE'`
  );
  return {
    currentUser: me.rows[0].current_user,
    serverVersion: ver.rows[0].server_version,
    hostedAuthSchema: hosted.rows[0].hosted,
    existingPoliticoreTables: Number(tables.rows[0].n),
  };
}

// ── per-migration signature objects (idempotence without history) ───────────
const SIGNATURES: Record<string, string> = {
  "0000": `to_regprocedure('auth.uid()') IS NOT NULL`,
  "0001": `to_regclass('politicore.tenants') IS NOT NULL`,
  "0002": `to_regprocedure('politicore.has_permission(text,politicore.scope_type_enum,text)') IS NOT NULL`,
  "0003": `to_regclass('politicore.states') IS NOT NULL AND (SELECT count(*) FROM politicore.states) > 0`,
  "0004": `to_regclass('politicore.permissions') IS NOT NULL AND (SELECT count(*) FROM politicore.permissions) > 0`,
  "0005": `to_regprocedure('politicore.my_tenant_id()') IS NOT NULL`,
  "0006": `to_regprocedure('politicore.custom_access_token_hook(jsonb)') IS NOT NULL`,
  "0007": `to_regprocedure('politicore.provision_tenant(text,text,text,text,jsonb)') IS NOT NULL`,
  "0008": `to_regprocedure('public.mark_notifications_read(uuid[])') IS NOT NULL`,
  "0009": `to_regclass('public.notifications') IS NOT NULL`,
  "0010": `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'politicore' AND p.proname = 'provision_tenant'
           AND p.prosrc LIKE '%IS TRUE%')`,
  "0013": `NOT EXISTS (SELECT 1 FROM politicore.senatorial_zones WHERE id = 'enugu-south-zone')`,
  "0014": `to_regclass('politicore.election_results') IS NOT NULL`,
  "0015": `to_regprocedure('politicore.submit_election_result(uuid,text,jsonb,uuid)') IS NOT NULL`,
  "0016": `(SELECT count(*) FROM politicore.political_parties) > 0`,
  // 0017's durable artifact is the realtime publication membership (the
  // views it created are dropped/recreated by 0018/0019 during the
  // relational-votes amendment, so the view is NOT a stable signature).
  "0017": `(SELECT count(*) FROM pg_publication_tables
           WHERE pubname='supabase_realtime' AND schemaname='politicore'
             AND tablename IN ('election_results','pu_reports','election_incidents')) = 3`,
  "0018": `to_regclass('politicore.election_result_votes') IS NOT NULL`,
  "0019": `to_regclass('politicore.election_results_current') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema='politicore'
                             AND table_name='election_results_current'
                             AND column_name='votes')`,
  "0020": `(SELECT count(*) FROM pg_views WHERE schemaname='public'
           AND viewname IN ('election_cycles','election_contests','election_candidates',
                            'election_settings','political_parties','pu_reports',
                            'election_incidents','election_result_history')) = 8`,
  "0021": `to_regclass('politicore.campaign_issues') IS NOT NULL`,
  "0023": `to_regprocedure('public.set_campaign_activity_status(uuid,politicore.campaign_activity_status)') IS NOT NULL`,
  "0022": `to_regprocedure('politicore.update_campaign_activity(uuid,text,text,politicore.campaign_activity_type,text,timestamptz,timestamptz,integer,uuid,politicore.scope_type_enum,text)') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname='politicore' AND p.proname='can_view_campaign_activity_row')`,
  "0024": `to_regprocedure('public.campaign_assignment_transition(uuid,text)') IS NOT NULL
           AND to_regprocedure('public.campaign_assignable_members(politicore.scope_type_enum,text)') IS NOT NULL
           AND to_regprocedure('public.create_campaign_assignment(text,text,uuid,politicore.scope_type_enum,text,politicore.campaign_assignment_priority,date,text)') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname='politicore' AND p.proname='campaign_assignable_members')`,
  "0025": `to_regprocedure('public.submit_campaign_report(politicore.campaign_report_type,text,text,politicore.scope_type_enum,text,text,integer,text,text,text,boolean,uuid)') IS NOT NULL
           AND to_regprocedure('public.review_campaign_report(uuid,text,text)') IS NOT NULL
           AND to_regprocedure('public.resubmit_campaign_report(uuid,text,uuid)') IS NOT NULL
           AND to_regprocedure('public.campaign_issue_transition(uuid,text,uuid,text)') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname='politicore' AND p.proname='submit_campaign_report')
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname='politicore' AND p.proname='campaign_issue_transition')`,
  "0026": `to_regprocedure('public.campaign_coordination_summary()') IS NOT NULL
           AND to_regprocedure('public.campaign_members_page(text,text,text,integer,integer)') IS NOT NULL
           AND to_regprocedure('public.campaign_members_page_count(text,text,text)') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname='politicore' AND p.proname='campaign_members_page')
           AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname='public' AND c.relname='organizational_assignments')
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                           WHERE table_schema='public' AND table_name='organizational_assignments'
                             AND grantee='anon' AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))`,
  "0027": `NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='politicore_profiles'
             AND grantee IN ('anon','authenticated')
             AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                           WHERE table_schema='public' AND table_name LIKE 'campaign%'
                             AND grantee IN ('anon','authenticated')
                             AND privilege_type IN ('TRUNCATE'))
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                           WHERE table_schema='public' AND table_name='campaign_issues'
                             AND grantee='anon'
                             AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                           WHERE table_schema='public'
                             AND table_name IN ('campaign_activity_participants','campaign_field_reports')
                             AND grantee IN ('anon','authenticated')
                             AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))
           AND EXISTS (SELECT 1 FROM information_schema.role_table_grants
                       WHERE table_schema='public' AND table_name='campaign_assignments'
                         AND grantee='authenticated' AND privilege_type='DELETE')
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                           WHERE table_schema='public' AND table_name='campaign_assignments'
                             AND grantee='anon' AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))`,
  "0028": `EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='politicore' AND c.relname='social_point_awards')
           AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='social_leaderboard')
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='verify_social_submission')
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='social_point_awards'
             AND grantee IN ('anon','authenticated')
             AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))`,
  "0029": `to_regprocedure('public.social_admin_award_history(uuid, integer)') IS NOT NULL
           AND (SELECT count(*) FROM pg_get_viewdef('public.social_leaderboard'::regclass) d
                WHERE d::text ILIKE '%module_enabled%') = 1
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='social_point_awards'
             AND grantee IN ('anon','authenticated')
             AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))`,
  "0030": `EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='permission_grants' AND c.relkind='v')
           AND EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='permission_grants'
             AND grantee='authenticated' AND privilege_type='SELECT')
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='permission_grants'
             AND grantee='anon')`,
  "0031": `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='politicore' AND p.proname='admin_enrich_member_profile')
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='admin_enrich_member_profile')
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='politicore_profiles'
             AND grantee IN ('anon','authenticated')
             AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))`,
  "0032": `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='politicore' AND p.proname='admin_set_member_lifecycle')
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='admin_set_member_lifecycle')
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='politicore_profiles'
             AND grantee IN ('anon','authenticated')
             AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))`,
  "0033": `EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='politicore' AND c.relname='events' AND c.relkind='r')
           AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='politicore' AND c.relname='announcements' AND c.relkind='r')
           AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='politicore' AND c.relname='donations' AND c.relkind='r')
           AND EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='politicore' AND table_name='tenants' AND column_name='config')
           AND EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
           JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='politicore' AND c.relname='events' AND p.polname='events_read_published')
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='donations'
             AND grantee='anon')`,
  "0034": `EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace

           WHERE n.nspname='politicore' AND c.relname='governance_requests' AND c.relkind='r')

           AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace

           WHERE n.nspname='politicore' AND c.relname='governance_participants' AND c.relkind='r')

           AND EXISTS (SELECT 1 FROM politicore.permissions WHERE name='view_governance')

           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace

           WHERE n.nspname='public' AND p.proname='submit_governance_request')

           AND EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid

           JOIN pg_namespace n ON n.oid=c.relnamespace

           WHERE n.nspname='politicore' AND c.relname='governance_requests' AND p.polname='governance_requests_read')

           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants

           WHERE table_schema='public' AND table_name='governance_requests'

             AND grantee='anon')`,

  "0035": `NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants

           WHERE table_schema='public' AND table_name='donations' AND grantee='anon')

           AND (SELECT count(*)::int FROM information_schema.role_table_grants

           WHERE table_schema='public' AND table_name='events' AND grantee='anon') = 1

           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants

           WHERE table_schema='public' AND table_name='governance_requests'

             AND grantee='anon')`,

  "0036": `to_regprocedure('politicore.governance_notify(uuid,uuid,text,text,text,uuid)') IS NOT NULL

           AND to_regprocedure('politicore.governance_notify_participant(uuid,text,text,text,uuid)') IS NOT NULL`,

  "0037": `to_regprocedure('public.governance_public_intake(text,text,text,text,text,text,text,text,text,boolean)') IS NOT NULL

           AND to_regprocedure('public.governance_verify(text,text)') IS NOT NULL

           AND to_regprocedure('public.governance_track(text,text)') IS NOT NULL

           AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace

           WHERE n.nspname='politicore' AND c.relname='governance_intake_staging' AND c.relkind='r')

           AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace

           WHERE n.nspname='politicore' AND c.relname='governance_tracking_credentials' AND c.relkind='r')

           AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace

           WHERE n.nspname='politicore' AND c.relname='core_delivery_intents' AND c.relkind='r')`,

  "0038": `to_regprocedure('public.governance_public_categories(text)') IS NOT NULL`,

  "0039": `position('BEFORE the throttle checks' in pg_get_functiondef(to_regproc('politicore.governance_submit_public_request'))) > 0

           AND position('RETURN false' in pg_get_functiondef(to_regproc('politicore.governance_submit_public_request'))) > 0`,

  "0040": `position('RETURN QUERY SELECT v_ref, v_secret' in pg_get_functiondef(to_regproc('politicore.governance_verify_public_request'))) > 0`,

  "0041": `position('RETURN false' in pg_get_functiondef(to_regproc('politicore.governance_submit_public_request'))) > 0

           AND (SELECT pg_get_function_result(to_regproc('public.governance_public_intake'))) = 'boolean'`,

  "0042": `position('rejected: empty result' in pg_get_functiondef(to_regproc('politicore.governance_track_public_request'))) > 0`,

  "0043": `to_regproc('politicore.create_governance_project') IS NOT NULL`,

  "0044": `position('visibility_rpc' in coalesce(pg_get_functiondef(to_regproc('politicore.set_governance_project_visibility')), '')) > 0`,

  "0045": `position('scope within your authority' in coalesce(pg_get_functiondef(to_regproc('politicore.create_governance_project')), '')) > 0`,

  "0046": `position('scope being attached' in coalesce(pg_get_functiondef(to_regproc('politicore.add_governance_project_scope')), '')) > 0 OR position('bootstrap-correct' in coalesce(pg_get_functiondef(to_regproc('politicore.add_governance_project_scope')), '')) > 0`,

  "0047": `to_regclass('public.governance_projects') IS NOT NULL AND to_regprocedure('public.set_governance_project_visibility(uuid,boolean)') IS NOT NULL`,

  "0048": `to_regproc('politicore.create_governance_commitment') IS NOT NULL

           AND position('commitment_id' in coalesce((SELECT pg_get_viewdef('public.governance_updates'::regclass, true)), '')) > 0`,

  "0049": `position('jsonb_typeof(p_scopes::jsonb)' in coalesce(pg_get_functiondef(to_regproc('politicore.create_governance_commitment')), '')) > 0`,

  "0050": `position('end loop' in lower(coalesce(pg_get_functiondef(to_regproc('politicore.make_governance_commitment_reference')), ''))) < position('new.reference_code := v_ref' in lower(coalesce(pg_get_functiondef(to_regproc('politicore.make_governance_commitment_reference')), '')))`,

  "0051": `to_regproc('politicore.submit_governance_consultation_response') IS NOT NULL

           AND position('politicore.governance_authority' in coalesce(pg_get_functiondef(to_regproc('politicore.guard_governance_consultation_identity')), '')) > 0`,

  "0052": `to_regproc('politicore.sign_governance_petition') IS NOT NULL

           AND position('governance_petitions_origin_proposer' in coalesce(pg_get_functiondef(to_regproc('politicore.guard_governance_petition_status')), '')) = 0

           AND (SELECT count(*) FROM pg_constraint WHERE conname = 'governance_updates_single_subject') = 1`,

  "0053": `position('ward_id IS NOT NULL) AND (polling_unit_id IS NULL' in
           (SELECT coalesce(pg_get_constraintdef(oid), '') FROM pg_constraint WHERE conname = 'governance_petition_scope_shape')) > 0`,

  "0054": `position('permission_grants' in coalesce(pg_get_functiondef(to_regproc('politicore.governance_notify_petition_submitted')), '')) > 0

           AND position('access_role = ''admin''' in coalesce(pg_get_functiondef(to_regproc('politicore.governance_notify_petition_submitted')), '')) > 0`,

  "0055": `to_regproc('politicore.vote_governance_poll') IS NOT NULL

           AND to_regproc('politicore.guard_governance_poll_options') IS NOT NULL

           AND position('only editable while draft' in coalesce(pg_get_functiondef(to_regproc('politicore.guard_governance_poll_content')), '')) > 0

           AND (SELECT count(*) FROM pg_constraint WHERE conname = 'governance_polls_results_require_closed') = 1`,

  "0056": `to_regproc('politicore.create_governance_engagement_update') IS NOT NULL

           AND position('sealed once concluded' in coalesce(pg_get_functiondef(to_regproc('politicore.guard_governance_engagement_content')), '')) > 0

           AND position('engagement_id IS NOT NULL' in (SELECT coalesce(pg_get_constraintdef(oid), '') FROM pg_constraint WHERE conname = 'governance_updates_single_subject')) > 0`,

  "0057": `to_regproc('politicore.public_governance_request_stats') IS NOT NULL

           AND position('publish_accountability' in coalesce(pg_get_functiondef(to_regproc('politicore.set_governance_project_visibility')), '')) > 0

           AND to_regproc('politicore.governance_privacy_bucket') IS NOT NULL`,

  "0059": `to_regproc('public.governance_analytics_requests') IS NOT NULL

           AND coalesce(pg_get_functiondef(to_regproc('politicore.governance_analytics_tenant_wide')),'') like '%EXPLICIT UNSCOPED grant%'

           AND position('FROM PUBLIC, anon, authenticated' in coalesce(pg_get_functiondef(to_regproc('politicore.governance_analytics_tenant_wide')),'')) = 0

           AND (select not(coalesce(array_to_string(proacl, ','), '') like '%authenticated=X%'))
               from pg_proc where oid = to_regproc('politicore.governance_analytics_tenant_wide')

           AND position('deny-wins: an unscoped deny suppresses' in coalesce(pg_get_functiondef(to_regproc('politicore.governance_analytics_tenant_wide')),'')) > 0`,
  "0058": `to_regproc('politicore.governance_analytics_requests') IS NOT NULL

           AND to_regproc('politicore.governance_memory_timeline') IS NOT NULL

           AND position('view_governance required for analytics' in coalesce(pg_get_functiondef(to_regproc('politicore.governance_analytics_requests')), '')) > 0`,

  "0061": `to_regproc('politicore.cc_validate_branding') IS NOT NULL
           AND to_regproc('politicore.cc_validate_seo') IS NOT NULL
           AND to_regproc('public.get_public_site_chrome') IS NOT NULL
           AND to_regproc('public.get_public_brand_asset') IS NOT NULL
           AND to_regproc('public.get_site_config_preview') IS NOT NULL
           AND position('cc_validate_branding' in pg_get_functiondef(to_regproc('politicore.save_site_config_draft'))) > 0
           AND position('cc_validate_branding' in pg_get_functiondef(to_regproc('politicore.publish_site_config'))) > 0
           AND (SELECT provolatile = 'v' FROM pg_proc WHERE oid = to_regproc('public.get_site_config_preview'))`,

  "0062": `to_regproc('politicore.cc_validate_homepage') IS NOT NULL
           AND to_regproc('politicore.rollback_site_config') IS NOT NULL
           AND to_regproc('public.get_published_homepage') IS NOT NULL
           AND to_regproc('public.get_site_config_history') IS NOT NULL
           AND position('cc_validate_homepage' in pg_get_functiondef(to_regproc('politicore.publish_site_config'))) > 0
           AND (SELECT provolatile = 'v' FROM pg_proc WHERE oid = to_regproc('public.rollback_site_config'))`,

  "0063": `to_regproc('politicore.cc_validate_navigation') IS NOT NULL
           AND to_regproc('politicore.cc_validate_footer') IS NOT NULL
           AND position('cc_validate_navigation' in pg_get_functiondef(to_regproc('politicore.save_site_config_draft'))) > 0
           AND position('cc_validate_footer' in pg_get_functiondef(to_regproc('politicore.publish_site_config'))) > 0
           AND position(''navigation'' in coalesce(pg_get_functiondef(to_regproc('politicore.rollback_site_config')), '')) > 0
           AND position('navigation' in coalesce(pg_get_functiondef(to_regproc('public.get_public_site_chrome')), '')) > 0`,

  "0064": `to_regproc('politicore.control_center_site_config_status') IS NOT NULL
           AND position('is_tenant_admin' in pg_get_functiondef(to_regproc('politicore.control_center_site_config_status'))) > 0`,  // 0064 — Control Center administration status summary

  "0060": `to_regproc('politicore.set_tenant_module_enabled') IS NOT NULL

           AND to_regproc('politicore.control_center_overview') IS NOT NULL

           AND to_regproc('public.get_published_site_config') IS NOT NULL

           AND (SELECT provolatile = 'v' FROM pg_proc WHERE oid = to_regproc('public.set_tenant_module_enabled'))

           AND (SELECT provolatile = 'v' FROM pg_proc WHERE oid = to_regproc('public.save_site_config_draft'))

           AND position('Tenant administration authority is required for service activation' in coalesce(pg_get_functiondef(to_regproc('politicore.set_tenant_module_enabled')), '')) > 0

           AND position('service_entitlements' in coalesce(pg_get_functiondef(to_regproc('politicore.service_entitled')), '')) > 0

           AND position('not entitled' in coalesce(pg_get_functiondef(to_regproc('politicore.set_tenant_module_enabled')), '')) > 0`,

};

function migrationFiles(dir: string): { file: string; version: string; sql: string }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, version: f.split("_")[0], sql: fs.readFileSync(path.join(dir, f), "utf8") }));
}

export async function applyHostedMigrations(
  client: pg.Client,
  log: (s: string) => void = console.log
): Promise<string[]> {
  const files = migrationFiles(path.resolve("supabase/migrations"));
  const appliedNow: string[] = [];

  const hasMigrationTable = await client
    .query("SELECT 1 FROM supabase_migrations.schema_migrations LIMIT 1")
    .then(() => true)
    .catch(() => false);
  if (!hasMigrationTable) {
    log("note: supabase_migrations.schema_migrations not present — using signature-based idempotence");
  }

  for (const f of files) {
    if (hasMigrationTable) {
      const done = await client.query(
        `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1`,
        [f.version]
      );
      if (done.rows.length) {
        log(`  = ${f.file} (recorded)`);
        continue;
      }
    }

    const sigSql = SIGNATURES[f.version];
    if (sigSql) {
      try {
        const sig = await client.query(`SELECT ${sigSql} AS applied`);
        if (sig.rows[0].applied) {
          log(`  = ${f.file} (signature exists)`);
          if (hasMigrationTable) {
            await client.query(
              `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [f.version, f.file, f.sql]
            );
          }
          continue;
        }
      } catch {
        // signature query failed (e.g. count on missing table) → not applied
      }
    }

    log(`  → ${f.file}`);
    await client.query(f.sql); // single implicit transaction
    appliedNow.push(f.file);
    if (hasMigrationTable) {
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [f.version, f.file, f.sql]
      );
    }
  }
  return appliedNow;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const client = await connect();
  try {
    const pre = await preflight(client);
    console.log("Hosted preflight:");
    console.log("  user:", pre.currentUser, "| server:", pre.serverVersion);
    console.log("  real auth schema:", pre.hostedAuthSchema);
    console.log("  existing politicore tables:", pre.existingPoliticoreTables);

    if (!pre.hostedAuthSchema) {
      console.error("STOP: auth schema/uid() not found — this does not look like the hosted Supabase project.");
      process.exit(2);
    }

    console.log("Applying migrations:");
    const applied = await applyHostedMigrations(client);
    console.log(`Applied ${applied.length} migration(s).`);

    // ── verification against Phase 1A local results ──────────────────────
    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM politicore.states) states,
        (SELECT count(*) FROM politicore.senatorial_zones) zones,
        (SELECT count(*) FROM politicore.lgas) lgas,
        (SELECT count(*) FROM politicore.wards) wards,
        (SELECT count(*) FROM politicore.polling_units) polling_units,
        (SELECT count(*) FROM politicore.permissions) permissions,
        (SELECT count(*) FROM politicore.position_permissions) position_permissions,
        (SELECT count(*) FROM politicore.tenant_modules) tenant_modules
    `);
    console.log("Row counts:", counts.rows[0]);

    const rls = await client.query(`
      SELECT
        count(*) FILTER (WHERE c.relrowsecurity) AS enabled,
        count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity) AS forced,
        (SELECT count(*) FROM pg_policies WHERE schemaname='politicore') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='politicore' AND c.relkind='r'
    `);
    console.log("RLS:", rls.rows[0]);

    const views = await client.query(`
      SELECT count(*)::int AS public_views FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN ('politicore_profiles','tenants','tenant_modules','public_site_settings',
                           'notifications','states','senatorial_zones','lgas','wards','polling_units')
    `);
    console.log("Public API views:", views.rows[0]);

    const hookSmoke = await client.query(
      `SELECT politicore.custom_access_token_hook('{"claims":{"sub":"00000000-0000-0000-0000-000000000000"}}'::jsonb) AS out`
    );
    const hookOut = hookSmoke.rows[0].out as { claims: { app_metadata?: Record<string, unknown> } };
    console.log("Hook smoke (unknown user → null claims):", JSON.stringify(hookOut.claims.app_metadata));

    console.log("HOSTED MIGRATIONS OK");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("HOSTED APPLY FAILED:", e.message);
    process.exit(1);
  });
}
