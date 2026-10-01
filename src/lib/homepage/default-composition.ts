/**
 * POLITICORE — Default homepage composition (Phase 24 §32).
 *
 * A deterministic, registry-valid composition representing the previously
 * hard-coded homepage (Hero + Priorities → Candidate → Latest News →
 * Upcoming Events → CTA, with Election Countdown). Served as the initial
 * published/draft state whenever a tenant has no stored homepage
 * configuration, so no tenant ever sees a blank homepage (§15/§32).
 * Validated by the same registry rules as administrator compositions.
 */
import type { SectionInstance } from "./registry";

export const DEFAULT_HOMEPAGE_SECTIONS: SectionInstance[] = [
  {
    stable_id: "election-countdown",
    section_type: "election_countdown",
    display_order: 10,
    enabled: true,
    config: { label: "Election Day" },
    service_dependency: "election",
  },
  {
    stable_id: "hero",
    section_type: "hero",
    display_order: 20,
    enabled: true,
    config: {
      eyebrow: "PDP Governorship Candidate • Enugu State • 2027",
      title: "A New Direction for Enugu State",
      description:
        "A vision for a safer, stronger and more prosperous Enugu, driven by responsible leadership, economic opportunity, infrastructure development and inclusive governance.",
      primary_cta: { label: "Join the Movement", href: "/volunteer" },
      secondary_cta: { label: "Our Agenda", href: "/manifesto" },
      background_variant: "brand",
      alignment: "left",
    },
  },
  {
    stable_id: "candidate",
    section_type: "biography",
    display_order: 30,
    enabled: true,
    config: {
      heading: "Meet the Candidate",
      body: "A businessman, public servant and former Minister of Innovation, Science and Technology, Chief Uche Geoffrey Nnaji is the Peoples Democratic Party candidate for Governor of Enugu State in the 2027 election.",
      cta: { label: "Read Full Biography", href: "/biography" },
    },
  },
  {
    stable_id: "latest-news",
    section_type: "news",
    display_order: 40,
    enabled: true,
    config: {
      heading: "Latest News",
      item_count: 3,
      layout: "grid",
      show_excerpt: true,
      cta: { label: "View All", href: "/news" },
    },
  },
  {
    stable_id: "upcoming-events",
    section_type: "events",
    display_order: 50,
    enabled: true,
    config: {
      heading: "Upcoming Events",
      item_count: 3,
      layout: "grid",
      cta: { label: "All Events", href: "/events" },
    },
  },
  {
    stable_id: "join-cta",
    section_type: "cta",
    display_order: 60,
    enabled: true,
    config: {
      heading: "Join the Movement for a Better Enugu",
      description:
        "Stay connected, participate in campaign activities and be part of the conversation about the future of Enugu State.",
      primary_cta: { label: "Become a Volunteer", href: "/volunteer" },
      secondary_cta: { label: "Member Portal", href: "/portal/dashboard" },
      background_variant: "gradient",
    },
  },
];

/** Fallback + fallback metadata for the engine/renderer. */
export const FALLBACK_HOMEPAGE: { revision: number; sections: SectionInstance[] } = {
  revision: 0,
  sections: DEFAULT_HOMEPAGE_SECTIONS,
};
