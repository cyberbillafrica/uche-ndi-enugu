-- =====================================================================
-- 0004: REFERENCE DATA (Phase 1A)
-- Permission vocabulary, positions, position-permission matrix (ported
-- verbatim from src/lib/permissions.ts POSITION_DEFAULT_PERMISSIONS),
-- dev tenant + module subscriptions + settings defaults.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Permission vocabulary (src/types Permission union)
-- ---------------------------------------------------------------------
INSERT INTO politicore.permissions (name, domain) VALUES
  ('view_dashboard','general'),('view_area','general'),
  ('view_members','members'),('view_member_contacts','members'),('manage_members','members'),
  ('view_assignments','campaign'),('create_assignment','campaign'),('assign_task','campaign'),('review_assignment','campaign'),
  ('view_activities','campaign'),('create_activity','campaign'),('manage_activity','campaign'),('view_activity_reports','campaign'),
  ('submit_field_report','campaign'),('review_field_report','campaign'),
  ('report_issue','campaign'),('manage_issue','campaign'),
  ('view_notices','communications'),('send_notice','communications'),
  ('view_documents','documents'),('manage_documents','documents'),
  ('view_analytics','analytics'),
  ('manage_organization','organization'),('manage_permissions','organization'),
  ('manage_campaign_settings','campaign'),
  ('submit_election_pu_report','election'),('submit_election_incident','election'),
  ('upload_election_result','election'),('view_election_dashboard','election'),('manage_election_settings','election'),
  ('view_private_donations','donations'),('manage_private_donations','donations'),
  ('view_public_donations','donations'),('manage_public_donations','donations');

-- ---------------------------------------------------------------------
-- Organizational positions (NOT access roles)
-- ---------------------------------------------------------------------
INSERT INTO politicore.positions (name, description, grants_authority) VALUES
  ('campaign_member','Field campaign member',true),
  ('ward_coordinator','Coordinates a ward',true),
  ('lga_coordinator','Coordinates an LGA',true),
  ('zone_coordinator','Coordinates a senatorial zone',true),
  ('state_coordinator','Coordinates the state',true),
  ('campaign_manager','Campaign management; authority comes from access_role only',false),
  ('council_chairman','Council chair; authority comes from access_role only',false);

-- ---------------------------------------------------------------------
-- Position default permission matrix (verbatim port of
-- POSITION_DEFAULT_PERMISSIONS; campaign_manager/council_chairman
-- intentionally carry zero — authority flows from access_role)
-- ---------------------------------------------------------------------
INSERT INTO politicore.position_permissions (position, permission) VALUES
  ('campaign_member','view_dashboard'),('campaign_member','view_area'),
  ('campaign_member','view_assignments'),('campaign_member','view_activities'),
  ('campaign_member','create_activity'),('campaign_member','submit_field_report'),
  ('campaign_member','report_issue'),('campaign_member','view_notices'),('campaign_member','view_documents'),

  ('ward_coordinator','view_dashboard'),('ward_coordinator','view_area'),
  ('ward_coordinator','view_members'),('ward_coordinator','view_member_contacts'),
  ('ward_coordinator','view_assignments'),('ward_coordinator','create_assignment'),
  ('ward_coordinator','assign_task'),('ward_coordinator','review_assignment'),
  ('ward_coordinator','view_activities'),('ward_coordinator','create_activity'),
  ('ward_coordinator','manage_activity'),('ward_coordinator','view_activity_reports'),
  ('ward_coordinator','submit_field_report'),('ward_coordinator','review_field_report'),
  ('ward_coordinator','report_issue'),('ward_coordinator','manage_issue'),
  ('ward_coordinator','view_notices'),('ward_coordinator','send_notice'),
  ('ward_coordinator','view_documents'),('ward_coordinator','manage_documents'),
  ('ward_coordinator','view_analytics');

INSERT INTO politicore.position_permissions (position, permission)
SELECT 'lga_coordinator', permission FROM politicore.position_permissions WHERE position = 'ward_coordinator';
INSERT INTO politicore.position_permissions (position, permission)
SELECT 'zone_coordinator', permission FROM politicore.position_permissions WHERE position = 'ward_coordinator';

INSERT INTO politicore.position_permissions (position, permission) VALUES
  ('state_coordinator','view_dashboard'),('state_coordinator','view_area'),
  ('state_coordinator','view_members'),('state_coordinator','view_member_contacts'),
  ('state_coordinator','manage_members'),
  ('state_coordinator','view_assignments'),('state_coordinator','create_assignment'),
  ('state_coordinator','assign_task'),('state_coordinator','review_assignment'),
  ('state_coordinator','view_activities'),('state_coordinator','create_activity'),
  ('state_coordinator','manage_activity'),('state_coordinator','view_activity_reports'),
  ('state_coordinator','submit_field_report'),('state_coordinator','review_field_report'),
  ('state_coordinator','report_issue'),
  ('state_coordinator','manage_issue'),
  ('state_coordinator','view_notices'),('state_coordinator','send_notice'),
  ('state_coordinator','view_documents'),('state_coordinator','view_analytics'),
  ('state_coordinator','manage_organization'),('state_coordinator','manage_permissions'),
  ('state_coordinator','manage_documents');

-- ---------------------------------------------------------------------
-- Dev tenant (matches CURRENT_TENANT_ID "ifeanyi-2027") + subscriptions
-- ---------------------------------------------------------------------
INSERT INTO politicore.tenants (id, slug, name, primary_state_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'ifeanyi-2027', 'Ifeanyi 2027', 'enugu-state');

INSERT INTO politicore.tenant_modules (tenant_id, module, enabled) VALUES
  ('11111111-1111-1111-1111-111111111111','social',true),
  ('11111111-1111-1111-1111-111111111111','campaign',true),
  ('11111111-1111-1111-1111-111111111111','election',true),
  ('11111111-1111-1111-1111-111111111111','governance',false);

INSERT INTO politicore.tenant_settings (tenant_id, settings) VALUES
  ('11111111-1111-1111-1111-111111111111', '{"election_mode_enabled": false, "volunteer_registration_enabled": true}'::jsonb);

INSERT INTO politicore.public_site_settings (tenant_id) VALUES
  ('11111111-1111-1111-1111-111111111111');

INSERT INTO politicore.platform_settings (id, settings) VALUES (1, '{}');
