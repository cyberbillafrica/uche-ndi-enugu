"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAllCampaignMembersForTenant,
  getScopedCampaignMembers,
  type ScopedCampaignMember,
} from "@/lib/firebase/campaignMembers";
import { isAdminUser } from "@/lib/permissions";
import type { OrganizationalAssignment, UserProfile } from "@/types";

export function useScopedCampaignMembers(
  assignment: OrganizationalAssignment | null,
  profile?: UserProfile | null,
) {
  const [members, setMembers] = useState<ScopedCampaignMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeSupported, setScopeSupported] = useState(true);

  const loadMembers = useCallback(async () => {
    // ADMIN GLOBAL RULE: Admin loads all campaign members globally without requiring an assignment
    if (profile && isAdminUser(profile)) {
      try {
        setLoading(true);
        setError(null);
        setScopeSupported(true);
        const allMembers = await getAllCampaignMembersForTenant();
        setMembers(allMembers);
      } catch (err) {
        console.error("Failed to load global campaign members for admin:", err);
        setError("Unable to load campaign member directory.");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!assignment) {
      setMembers([]);
      setError(null);
      setScopeSupported(true);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const result = await getScopedCampaignMembers(assignment);

      setMembers(result.members);
      setScopeSupported(result.scopeSupported);

      if (!result.scopeSupported) {
        setError(
          result.message ?? "This organizational scope is not yet supported.",
        );
      }
    } catch (err) {
      console.error("Failed to load scoped campaign members:", err);
      setMembers([]);
      setScopeSupported(false);
      setError("Unable to load campaign members for this area.");
    } finally {
      setLoading(false);
    }
  }, [assignment, profile]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    loadMembers();
  }, [loadMembers]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    members,
    loading,
    error,
    scopeSupported,
    refresh: loadMembers,
  };
}
