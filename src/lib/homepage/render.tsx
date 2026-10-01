/**
 * POLITICORE — Homepage section renderer (Phase 24).
 *
 * The one and only production renderer for the configurable homepage —
 * the public page and the admin preview both draw through these
 * components (§21: never two renderers). Every section renders through a
 * per-section boundary: data failure → safe fallback; unknown type →
 * skipped entirely (§9/§20). No HTML/CSS/JS from configuration is ever
 * interpreted — text is rendered as React text, media via Core Media
 * asset ids, links pre-validated by isSafeHref.
 */
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Calendar, FileText, MapPin, Tag } from "lucide-react";

import {
  sectionDefinition,
  isSafeHref,
  type SectionConfig,
  type SafeLink,
} from "./registry";
import type { ResolvedSection } from "./engine";
import ElectionCountdown from "@/components/home/ElectionCountdown";
import { brandMediaUrl } from "./media-url";
import type { MediaRef } from "./registry";

function formatDate(raw: unknown): string {
  if (!raw) return "Recent";
  if (typeof raw === "string" || typeof raw === "number") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    }
  }
  return "Recent";
}

function CtaLink({
  cta,
  variant,
}: {
  cta: SafeLink | undefined;
  variant: "solid" | "ghost" | "inline";
}) {
  if (!cta?.label || !cta.href || !isSafeHref(cta.href)) return null;
  const cls =
    variant === "solid"
      ? "inline-flex items-center justify-center rounded-lg bg-white px-8 py-4 font-semibold text-green-900 transition-colors hover:bg-gray-100"
      : variant === "ghost"
        ? "inline-flex items-center justify-center rounded-lg bg-white/10 px-8 py-4 font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/20"
        : "inline-flex items-center font-semibold text-green-900 transition-colors hover:text-green-700";
  return (
    <Link href={cta.href} className={cls}>
      {cta.label}
      {variant === "inline" && <ArrowRight className="ml-2 h-5 w-5" aria-hidden />}
    </Link>
  );
}

function SectionMedia({
  media,
  alt,
  className,
  priority,
}: {
  media: MediaRef | undefined;
  alt: string;
  className: string;
  priority?: boolean;
}) {
  if (!media?.asset_id) return null;
  const src = brandMediaUrl(media.asset_id);
  if (!src) return null;
  return (
    <Image src={src} alt={media.alt || alt} fill unoptimized className={className} sizes="(max-width: 768px) 100vw, 50vw" priority={priority} />
  );
}

/** Section background wrapper honoring the background_variant vocabulary. */
function SectionShell({
  variant,
  children,
}: {
  variant: SectionConfig["background_variant"] | undefined;
  children: React.ReactNode;
}) {
  const bg =
    variant === "dark"
      ? "bg-gray-900 text-white"
      : variant === "light"
        ? "bg-white"
        : variant === "gradient"
          ? "bg-gradient-to-br from-green-900 to-green-950 py-16 text-white"
          : variant === "surface"
            ? "bg-gray-50 py-16"
            : undefined; // brand: components style themselves with brand tokens
  return <section className={bg ?? "py-16"}>{children}</section>;
}

export function SectionRenderer({ resolved }: { resolved: ResolvedSection }) {
  const { section } = resolved;
  const def = sectionDefinition(section.section_type);

  // §9 — unknown stored type: skip safely, never crash, never execute.
  if (!def) return null;
  // §12 — suppressed sections are not rendered (config retained).
  if (!resolved.eligible) return null;

  const cfg = (section.config ?? {}) as SectionConfig;
  const data = resolved.data;

  switch (section.section_type) {
    // ── Presentation / marketing ─────────────────────────────────────
    case "hero":
      return (
        <section className="relative overflow-hidden bg-gradient-to-br from-green-900 via-green-800 to-green-950 text-white">
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-32 lg:px-8">
            <div className={cfg.alignment === "center" ? "mx-auto max-w-3xl text-center" : "max-w-3xl"}>
              {cfg.eyebrow && (
                <div className="mb-6 inline-block rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium backdrop-blur-sm">
                  {cfg.eyebrow}
                </div>
              )}
              <h1 className="mb-6 text-4xl font-bold leading-tight md:text-6xl">{cfg.title}</h1>
              {cfg.description && <p className="mb-8 text-lg text-gray-200 md:text-xl">{cfg.description}</p>}
              <div className="flex flex-col gap-4 sm:flex-row">
                <CtaLink cta={cfg.primary_cta} variant="solid" />
                <CtaLink cta={cfg.secondary_cta ?? undefined} variant="ghost" />
              </div>
            </div>
          </div>
        </section>
      );

    case "rich_text":
      return (
        <SectionShell variant={cfg.background_variant}>
          <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
            {cfg.heading && <h2 className="mb-6 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
            {cfg.body && <p className="text-lg leading-relaxed text-gray-600">{cfg.body}</p>}
          </div>
        </SectionShell>
      );

    case "image_text":
      return (
        <SectionShell variant={cfg.background_variant ?? "light"}>
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            <div className="grid items-center gap-12 md:grid-cols-2">
              <div className={cfg.image_side === "right" ? "order-2" : ""}>
                <div className="relative aspect-[4/5] overflow-hidden rounded-2xl bg-gradient-to-br from-green-900/10 to-green-700/10">
                  <SectionMedia media={cfg.image} alt={cfg.heading ?? "Section image"} className="object-cover" />
                </div>
              </div>
              <div className={cfg.image_side === "right" ? "order-1" : ""}>
                {cfg.heading && <h2 className="mb-6 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
                {cfg.body && <div className="space-y-4 text-gray-600"><p className="text-lg">{cfg.body}</p></div>}
                <div className="mt-6">
                  <CtaLink cta={cfg.cta} variant="inline" />
                </div>
              </div>
            </div>
          </div>
        </SectionShell>
      );

    case "feature_cards":
      return (
        <SectionShell variant={cfg.background_variant}>
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            {cfg.heading && <h2 className="mb-12 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
            <div className="grid gap-8 md:grid-cols-3">
              {(cfg.cards ?? []).map((card, i) => (
                <div key={i} className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
                  {card.image ? (
                    <div className="relative mb-4 aspect-[16/9] overflow-hidden rounded-lg">
                      <SectionMedia media={card.image} alt={card.title ?? "Card image"} className="object-cover" />
                    </div>
                  ) : null}
                  {card.title && <h3 className="mb-2 text-lg font-bold text-gray-900">{card.title}</h3>}
                  {card.description && <p className="text-sm text-gray-600">{card.description}</p>}
                  {card.href && isSafeHref(card.href) && (
                    <Link href={card.href} className="mt-3 inline-flex items-center text-sm font-semibold text-green-900 hover:underline">
                      {card.value ?? "Learn more"} <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </div>
        </SectionShell>
      );

    case "statistics":
      return (
        <SectionShell variant={cfg.background_variant ?? "surface"}>
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            {cfg.heading && <h2 className="mb-12 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
            <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
              {(cfg.items ?? []).map((s, i) => (
                <div key={i} className="text-center">
                  <div className="text-3xl font-bold text-green-900">{s.value}</div>
                  <div className="text-sm text-gray-500">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </SectionShell>
      );

    case "cta":
      return (
        <section className="bg-gradient-to-br from-green-900 to-green-950 py-16 text-white">
          <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
            <h2 className="mb-6 text-3xl font-bold md:text-4xl">{cfg.heading}</h2>
            {cfg.description && <p className="mb-8 text-xl text-gray-200">{cfg.description}</p>}
            <div className="flex flex-col justify-center gap-4 sm:flex-row">
              <CtaLink cta={cfg.primary_cta} variant="solid" />
              <CtaLink cta={cfg.secondary_cta ?? undefined} variant="ghost" />
            </div>
          </div>
        </section>
      );

    case "quote":
      return (
        <SectionShell variant={cfg.background_variant ?? "surface"}>
          <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 lg:px-8">
            {cfg.quote && <blockquote className="text-2xl font-medium italic text-gray-800">“{cfg.quote}”</blockquote>}
            {cfg.attribution && <p className="mt-4 text-sm font-semibold uppercase tracking-wider text-green-900">{cfg.attribution}</p>}
          </div>
        </SectionShell>
      );

    case "video":
      return (
        <SectionShell variant={cfg.background_variant}>
          <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
            {cfg.heading && <h2 className="mb-8 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
            {cfg.video_url && /^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|player\.vimeo\.com\/video\/)/.test(cfg.video_url) ? (
              <div className="aspect-video overflow-hidden rounded-2xl">
                <iframe
                  src={cfg.video_url.replace("watch?v=", "embed/").replace("youtu.be/", "www.youtube.com/embed/")}
                  title={cfg.heading ?? "Video"}
                  className="h-full w-full"
                  allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
            ) : cfg.poster ? (
              <div className="relative aspect-video overflow-hidden rounded-2xl">
                <SectionMedia media={cfg.poster} alt={cfg.heading ?? "Video poster"} className="object-cover" />
              </div>
            ) : null}
          </div>
        </SectionShell>
      );

    case "link_cards":
      return (
        <SectionShell variant={cfg.background_variant}>
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            {cfg.heading && <h2 className="mb-12 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
            <div className="grid gap-6 md:grid-cols-3">
              {(cfg.cards ?? []).map((card, i) =>
                card.href && isSafeHref(card.href) ? (
                  <Link key={i} href={card.href} className="group rounded-xl border border-gray-100 bg-white p-6 shadow-sm transition hover:shadow-md">
                    {card.title && <h3 className="text-lg font-bold text-gray-900 group-hover:text-green-800">{card.title}</h3>}
                    {card.description && <p className="mt-2 text-sm text-gray-600">{card.description}</p>}
                  </Link>
                ) : null
              )}
            </div>
          </div>
        </SectionShell>
      );

    case "divider":
      return cfg.style === "dots" ? (
        <div className="flex justify-center gap-2 py-8">
          {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 rounded-full bg-green-900/30" />)}
        </div>
      ) : cfg.style === "space" ? (
        <div className="py-8" />
      ) : (
        <div className="mx-auto max-w-7xl px-4"><hr className="border-gray-200" /></div>
      );

    // ── Content-backed ───────────────────────────────────────────────
    case "election_countdown":
      // Election owns the countdown data (§16): the registered component is
      // the existing ElectionCountdown; service dependency 'election' gates
      // eligibility upstream. No eligible cycle → the component's own safe
      // empty state.
      return <ElectionCountdown />;

    case "news": {
      const news = data.status === "ok" ? (data as { news?: import("@/lib/supabase/news").NewsArticle[] }).news ?? [] : [];
      return (
        <section className="bg-gray-50 py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-12 flex items-center justify-between">
              <h2 className="text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading ?? "Latest News"}</h2>
              <CtaLink cta={cfg.cta} variant="inline" />
            </div>
            {news.length === 0 ? (
              <div className="rounded-2xl border bg-white p-8 text-center shadow-sm">
                <FileText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                <p className="text-base font-medium text-gray-700">No published news articles yet.</p>
                <p className="mt-1 text-sm text-gray-500">Check back soon for news and updates.</p>
              </div>
            ) : (
              <div className="grid gap-8 md:grid-cols-3">
                {news.map((article) => (
                  <Link key={article.id} href={`/news/${article.slug}`} className="group flex flex-col overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-all hover:-translate-y-1 hover:shadow-md">
                    <div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-green-900/10 to-green-700/10">
                      <span className="text-2xl font-bold text-green-900/20">Nwakabeiya 2027</span>
                    </div>
                    <div className="flex flex-1 flex-col p-6">
                      <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                        <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5 text-green-800" />{formatDate(article.published_at || article.created_at)}</span>
                        {article.category && (
                          <span className="flex items-center gap-1 rounded bg-green-900/10 px-2 py-0.5 font-medium text-green-900"><Tag className="h-3 w-3" />{article.category}</span>
                        )}
                      </div>
                      <h3 className="mb-2 line-clamp-2 text-lg font-bold text-gray-900 group-hover:text-green-800">{article.title}</h3>
                      {cfg.show_excerpt !== false && (
                        <p className="mb-4 line-clamp-3 flex-1 text-sm leading-relaxed text-gray-600">{article.excerpt || article.content}</p>
                      )}
                      <div className="inline-flex items-center text-sm font-semibold text-green-900">Read story <ArrowRight className="ml-1 h-4 w-4" /></div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      );
    }

    case "events": {
      const events = data.status === "ok" ? (data as { events?: import("@/lib/supabase/events").SiteEvent[] }).events ?? [] : [];
      return (
        <section className="bg-white py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="mb-12 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading ?? "Upcoming Events"}</h2>
            {events.length === 0 ? (
              <div className="rounded-2xl bg-gray-50 p-8 text-center">
                <Calendar className="mx-auto mb-3 h-8 w-8 text-gray-300" />
                <p className="text-base font-medium text-gray-700">No upcoming events at the moment.</p>
                <p className="mt-1 text-sm text-gray-500">Check back soon for events and community engagements.</p>
              </div>
            ) : (
              <div className="grid gap-8 md:grid-cols-3">
                {events.map((event) => (
                  <div key={event.id} className="rounded-xl bg-gray-50 p-6 transition-shadow hover:shadow-md">
                    <div className="mb-4 flex items-center space-x-2 text-green-800">
                      <Calendar className="h-5 w-5" /><span className="font-medium">{formatDate(event.event_date)}</span>
                    </div>
                    <h3 className="mb-3 text-xl font-semibold text-green-900">{event.title}</h3>
                    <div className="space-y-2 text-gray-600">
                      <div className="flex items-center space-x-2"><MapPin className="h-4 w-4" /><span className="text-sm">{event.venue}</span></div>
                      <div className="text-sm text-gray-500">{event.description || "Join us — all are welcome."}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      );
    }

    case "biography":
      return (
        <section className="bg-white py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="grid items-center gap-12 md:grid-cols-2">
              <div className="relative">
                <div className="relative aspect-[4/5] overflow-hidden rounded-2xl bg-gradient-to-br from-green-900/10 to-green-700/10">
                  <SectionMedia media={cfg.image} alt={cfg.heading ?? "Candidate"} className="object-cover" priority />
                </div>
              </div>
              <div>
                <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-green-700">Meet the Candidate</p>
                {cfg.heading && <h2 className="mb-6 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
                {cfg.body && <div className="space-y-4 text-gray-600"><p className="text-lg">{cfg.body}</p></div>}
                <div className="mt-8">
                  <CtaLink cta={cfg.cta} variant="inline" />
                </div>
              </div>
            </div>
          </div>
        </section>
      );

    case "manifesto":
      return (
        <SectionShell variant={cfg.background_variant}>
          <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 lg:px-8">
            {cfg.heading && <h2 className="mb-6 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
            {cfg.body && <p className="mb-8 text-lg text-gray-600">{cfg.body}</p>}
            <CtaLink cta={cfg.cta} variant="inline" />
          </div>
        </SectionShell>
      );

    case "gallery": {
      const gallery = data.status === "ok" ? (data as { data?: unknown }).data : null;
      const photos = (gallery as { photos?: { url?: string }[] } | null)?.photos ?? [];
      return (
        <section className="bg-gray-50 py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {cfg.heading && <h2 className="mb-12 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading}</h2>}
            {photos.length === 0 ? (
              <p className="text-sm text-gray-500">Gallery highlights will appear here.</p>
            ) : (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                {photos.slice(0, cfg.item_count ?? 6).map((p, i) =>
                  p.url ? (
                    <div key={i} className="relative aspect-square overflow-hidden rounded-xl bg-gray-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    </div>
                  ) : null
                )}
              </div>
            )}
            <div className="mt-6"><CtaLink cta={cfg.cta} variant="inline" /></div>
          </div>
        </section>
      );
    }

    case "governance_projects": {
      const items = data.status === "ok" ? ((data as { data?: unknown }).data ?? []) as import("@/lib/supabase/governance").PublicGovernanceProjectSummary[] : [];
      return (
        <SectionShell variant={cfg.background_variant ?? "light"}>
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            <div className="mb-12 flex items-center justify-between">
              <h2 className="text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading ?? "Projects in Progress"}</h2>
              <CtaLink cta={cfg.cta} variant="inline" />
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-gray-500">Public project updates will appear here.</p>
            ) : (
              <div className="grid gap-6 md:grid-cols-3">
                {items.slice(0, cfg.item_count ?? 3).map((p) => (
                  <Link key={p.reference_code} href={`/governance/projects/${p.reference_code}`} className="group rounded-xl border border-gray-100 bg-white p-6 shadow-sm transition hover:shadow-md">
                    <h3 className="text-lg font-bold text-gray-900 group-hover:text-green-800">{p.title}</h3>
                    {p.category_label && <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-green-700">{p.category_label}</p>}
                    {p.description && <p className="mt-2 line-clamp-3 text-sm text-gray-600">{p.description}</p>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </SectionShell>
      );
    }

    case "governance_commitments": {
      const items = data.status === "ok" ? ((data as { data?: unknown }).data ?? []) as import("@/lib/supabase/governance").PublicGovernanceCommitmentSummary[] : [];
      return (
        <SectionShell variant={cfg.background_variant ?? "surface"}>
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            <h2 className="mb-12 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading ?? "Our Commitments"}</h2>
            {items.length === 0 ? (
              <p className="text-sm text-gray-500">Public commitments will appear here.</p>
            ) : (
              <div className="grid gap-6 md:grid-cols-3">
                {items.slice(0, cfg.item_count ?? 3).map((c) => (
                  <Link key={c.reference_code} href={`/governance/commitments/${c.reference_code}`} className="group rounded-xl border border-gray-100 bg-white p-6 shadow-sm transition hover:shadow-md">
                    <h3 className="text-lg font-bold text-gray-900 group-hover:text-green-800">{c.title}</h3>
                    {c.status && <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-green-700">{c.status}</p>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </SectionShell>
      );
    }

    case "public_participation": {
      const items = data.status === "ok" ? ((data as { data?: unknown }).data ?? []) as import("@/lib/supabase/governance").PublicGovernanceParticipateItem[] : [];
      return (
        <SectionShell variant={cfg.background_variant ?? "light"}>
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            <div className="mb-12 flex items-center justify-between">
              <h2 className="text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading ?? "Participate Now"}</h2>
              <CtaLink cta={cfg.cta} variant="inline" />
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-gray-500">Open consultations, petitions and polls will appear here.</p>
            ) : (
              <div className="grid gap-6 md:grid-cols-3">
                {items.slice(0, cfg.item_count ?? 3).map((it) => (
                  <Link key={it.reference_code} href={`/governance/participate/${it.kind}/${it.reference_code}`} className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm transition hover:shadow-md">
                    <p className="text-xs font-semibold uppercase tracking-wide text-green-700">{it.kind}</p>
                    <h3 className="mt-1 text-lg font-bold text-gray-900">{it.title}</h3>
                    {it.closes_at && <p className="mt-2 text-xs text-gray-500">Closes {formatDate(it.closes_at)}</p>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </SectionShell>
      );
    }

    case "public_accountability": {
      const items = data.status === "ok" ? ((data as { data?: unknown }).data ?? []) as import("@/lib/supabase/governance").PublicGovernanceRequestStat[] : [];
      return (
        <SectionShell variant={cfg.background_variant ?? "surface"}>
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            <div className="mb-12 flex items-center justify-between">
              <h2 className="text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading ?? "Open & Accountable"}</h2>
              <CtaLink cta={cfg.cta} variant="inline" />
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-gray-500">Request statistics will appear here.</p>
            ) : (
              <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
                {items.slice(0, 4).map((s) => (
                  <div key={s.scope_name} className="text-center">
                    <div className="text-3xl font-bold text-green-900">{s.resolved_bucket}</div>
                    <div className="text-sm text-gray-500">resolved · {s.scope_name}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SectionShell>
      );
    }

    case "governance_updates": {
      const items = data.status === "ok" ? ((data as { data?: unknown }).data ?? []) as import("@/lib/supabase/governance").PublicGovernanceHub[] : [];
      return (
        <SectionShell variant={cfg.background_variant ?? "light"}>
          <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
            <h2 className="mb-8 text-3xl font-bold text-green-900 md:text-4xl">{cfg.heading ?? "Latest Governance Updates"}</h2>
            {items.length === 0 ? (
              <p className="text-sm text-gray-500">Updates will appear here.</p>
            ) : (
              <div className="grid grid-cols-2 gap-6 md:grid-cols-3">
                {items.slice(0, 1).map((h, i) => (
                  <div key={i} className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
                    <div className="text-3xl font-bold text-green-900">{h.published_projects}</div>
                    <div className="text-sm text-gray-500">public projects</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SectionShell>
      );
    }

    case "contact_cta":
      return (
        <SectionShell variant={cfg.background_variant ?? "gradient"}>
          <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 lg:px-8">
            <h2 className="mb-6 text-3xl font-bold md:text-4xl">{cfg.heading ?? "Get in Touch"}</h2>
            {cfg.description && <p className="mb-8 text-lg text-gray-200">{cfg.description}</p>}
            <CtaLink cta={cfg.cta} variant="solid" />
          </div>
        </SectionShell>
      );

    default:
      // Registered but not yet rendered: skip (never blank the page).
      return null;
  }
}
