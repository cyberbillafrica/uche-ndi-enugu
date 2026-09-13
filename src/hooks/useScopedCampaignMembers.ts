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
      // Ordinary members without specific administrative assignments are scoped to their registered Polling Unit & Ward
      if (profile?.polling_unit_id || profile?.ward_id) {
        try {
          setLoading(true);
          setError(null);
          setScopeSupported(true);
          const allMembers = await getAllCampaignMembersForTenant();
          const puScoped = allMembers.filter((m) => {
            if (profile.polling_unit_id && m.polling_unit_id) {
              return m.polling_unit_id === profile.polling_unit_id;
            }
            if (profile.ward_id && m.ward_id) {
              return m.ward_id === profile.ward_id;
            }
            return false;
          });
          setMembers(puScoped);
        } catch (err) {
          console.error("Failed to load PU scoped campaign members:", err);
          setError("Unable to load members in your polling unit.");
        } finally {
          setLoading(false);
        }
        return;
      }

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
