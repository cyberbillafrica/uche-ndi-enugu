# IFEANYI 2027 — NEWS MODULE DOCUMENTATION Users

## Overview
The News module provides an end-to-end CMS and public news portal for the Ifeanyi 2027 campaign application. It operates entirely on Google Cloud Firestore and Firebase Storage while respecting existing authentication, security, and administrative role boundaries.

---

## Architecture & Data Flow

```
                     ┌───────────────────────┐
                     │    Cloud Firestore    │
                     │    collection: news   │
                     └───────────┬───────────┘
                                 │
            ┌────────────────────┴────────────────────┐
            ▼                                         ▼
   Public News Pages                         Admin News CMS
   - /news                                   - /portal/admin/news
   - /news/[slug]                            - Full CRUD
   - Query: status == "published"            - Status filtering & search
   - Public read access                      - Admin read/write access
```

---

## Data Schema & Types

Defined in `src/types/index.ts`:

```typescript
export type NewsStatus = "draft" | "published" | "scheduled" | "archived";

export interface NewsArticle {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  featured_image?: string | null;
  category?: string | null;
  status: NewsStatus;
  published?: boolean; // Supported for legacy backwards-compatibility
  published_at?: unknown | null;
  scheduled_at?: unknown | null;
  author?: string | null;
  created_by: string;
  updated_by?: string | null;
  created_at: unknown;
  updated_at: unknown;
}
```

---

## Status Semantics

1. **Draft:** Internal preparation state. Visible to admins only.
2. **Published:** Publicly visible on `/news` and accessible via `/news/[slug]`.
3. **Scheduled:** Retains future publication timestamp (`scheduled_at`).
   - *Limitation Note:* Automatic status transition from `scheduled` to `published` at the specified time requires a trusted scheduled process/Cloud Function. Client-side JavaScript must not be used as an authoritative publishing scheduler.
4. **Archived:** Retained for record keeping and history but removed from public listing and public detail pages.

---

## Firestore Security Model

Enforced in `firestore.rules`:

```rules
match /news/{newsId} {
  allow read: if resource.data.published == true
    || resource.data.status == "published"
    || isAdmin();

  allow create: if isAdmin();
  allow update: if isAdmin();
  allow delete: if isAdmin();
}
```

---

## Firebase Storage Strategy

Images uploaded via the Admin News CMS editor are stored under:

```
news/{timestamp}_{filename}
```

The storage helper `uploadFile()` in `src/lib/firebase/storage.ts` is used to upload the image file and return its public HTTPS download URL. Image URLs can also be directly pasted into the CMS editor.

---

## Legacy Compatibility

Legacy Firestore documents containing boolean field `published: true` are automatically normalized by `normalizeNewsArticle()` in `src/lib/firebase/firestore.ts` into `status: "published"`. Both new schema documents and legacy documents are retrieved together when querying published news.

---

## Verification & Testing Performed

1. **Type Checking:** Verified with `npx tsc --noEmit`.
2. **Linting:** Verified with `npm run lint`.
3. **Production Build:** Verified with `npm run build`.
