"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/contexts/AuthContext";

import { getActiveOrganizationalAssignments } from "@/lib/firebase/organizationalAssignments";

import type {
  OrganizationalAssignment,
  OrganizationalPosition,
  ScopeType,
} from "@/types";

/*
 * ============================================================
 * SCOPE SUMMARY
 * ============================================================
 */

export interface OrganizationalScope {
  pollingUnits: string[];
  wards: string[];
  lgas: string[];
  zones: string[];
  states: string[];
  campaigns: string[];
}

/*
 * ============================================================
 * HOOK
 * ============================================================
 */

export function useOrganizationalAssignments() {
  const { user, profile, loading: authLoading } = useAuth();

  const [assignments, setAssignments] = useState<OrganizationalAssignment[]>(
    [],
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /*
   * ------------------------------------------------------------
   * LOAD ASSIGNMENTS
   * ------------------------------------------------------------
   */

  const loadAssignments = useCallback(async () => {
    if (!user?.uid) {
      setAssignments([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const results = await getActiveOrganizationalAssignments(user.uid);

      setAssignments(results);
    } catch (err) {
      console.error("Failed to load organizational assignments:", err);

      setAssignments([]);
      setError("Unable to load your organizational assignments.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  /*
   * ------------------------------------------------------------
   * INITIAL LOAD
   * ------------------------------------------------------------
   */

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (authLoading) {
      return;
    }

    loadAssignments();
  }, [authLoading, loadAssignments]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /*
   * ------------------------------------------------------------
   * PRIMARY ASSIGNMENT
   * ------------------------------------------------------------
   *
   * We don't change the user's role.
   *
   * This simply determines which organizational position
   * should be displayed as their primary position.
   *
   * Higher organizational responsibility gets priority.
   */

  const primaryAssignment = useMemo(() => {
    const priority: Record<OrganizationalPosition, number> = {
      council_chairman: 100,
      campaign_manager: 90,
      state_coordinator: 80,
      zone_coordinator: 70,
      lga_coordinator: 60,
      ward_coordinator: 50,
      campaign_member: 10,
    };

    return (
      [...assignments].sort(
        (a, b) => (priority[b.position] ?? 0) - (priority[a.position] ?? 0),
      )[0] ?? null
    );
  }, [assignments]);

  /*
   * ------------------------------------------------------------
   * ORGANIZATIONAL SCOPE
   * ------------------------------------------------------------
   */

  const scope = useMemo<OrganizationalScope>(() => {
    const result: OrganizationalScope = {
      pollingUnits: [],
      wards: [],
      lgas: [],
      zones: [],
      states: [],
      campaigns: [],
    };

    for (const assignment of assignments) {
      switch (assignment.scope_type) {
        case "polling_unit":
          result.pollingUnits.push(assignment.scope_id);
          break;

        case "ward":
          result.wards.push(assignment.scope_id);
          break;

        case "lga":
          result.lgas.push(assignment.scope_id);
          break;

        case "senatorial_zone":
          result.zones.push(assignment.scope_id);
          break;

        case "state":
          result.states.push(assignment.scope_id);
          break;

        case "campaign":
          result.campaigns.push(assignment.scope_id);
          break;
      }
    }

    return result;
  }, [assignments]);

  /*
   * ------------------------------------------------------------
   * POSITION CHECK
   * ------------------------------------------------------------
   */

  const hasPosition = useCallback(
    (position: OrganizationalPosition) => {
      return assignments.some(
        (assignment) =>
          assignment.position === position && assignment.status === "active",
      );
    },
    [assignments],
  );

  /*
   * ------------------------------------------------------------
   * SCOPE CHECK
   * ------------------------------------------------------------
   */

  const hasScope = useCallback(
    (scopeType: ScopeType, scopeId?: string) => {
      return assignments.some((assignment) => {
        if (assignment.scope_type !== scopeType) {
          return false;
        }

        if (!scopeId) {
          return true;
        }

        return assignment.scope_id === scopeId;
      });
    },
    [assignments],
  );

  /*
   * ------------------------------------------------------------
   * RESULT
   * ------------------------------------------------------------
   */

  return {
    assignments,

    primaryAssignment,

    scope,

    hasPosition,

    hasScope,

    loading: authLoading || loading,

    error,

    refresh: loadAssignments,

    isCampaignMember: hasPosition("campaign_member") || assignments.length > 0,

    isWardCoordinator: hasPosition("ward_coordinator"),

    isLgaCoordinator: hasPosition("lga_coordinator"),

    isZoneCoordinator: hasPosition("zone_coordinator"),

    isStateCoordinator: hasPosition("state_coordinator"),

    isCampaignManager: hasPosition("campaign_manager"),

    isCouncilChairman: hasPosition("council_chairman"),

    isAssignedToOrganization: assignments.length > 0,

    profile,
  };
}
