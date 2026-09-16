import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { db } from "./config";
import { getAnnouncements as getPortalAnnouncements } from "./portal-content";
import { getCurrentTenant } from "./tenants";


// ============================================================
// ORGANIZATIONAL ASSIGNMENTS
// ============================================================

import type { Announcement, OrganizationalAssignment } from "@/types";

/**
 * Get all active organizational assignments for a user.
 *
 * Security rules already ensure that a normal user can only
 * read assignments belonging to themselves.
 */
export async function getUserOrganizationalAssignments(
  userId: string,
): Promise<OrganizationalAssignment[]> {
  const q = query(
    collection(db, "organizational_assignments"),
    where("user_id", "==", userId),
    where("status", "==", "active"),
  );

  const snap = await getDocs(q);

  return snap.docs.map((document) => ({
    id: document.id,
    ...document.data(),
  })) as OrganizationalAssignment[];
}

// ─────────────────────────────────────────────
// User
// ─────────────────────────────────────────────

export async function getAllUsers() {
  const q = query(collection(db, "users"), orderBy("created_at", "desc"));

  const snap = await getDocs(q);

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
}

export async function getUserProfile(userId: string) {
  const snap = await getDoc(doc(db, "users", userId));

  return snap.exists()
    ? {
        id: snap.id,
        ...snap.data(),
      }
    : null;
}

export async function updateUserProfile(
  userId: string,
  data: Record<string, unknown>,
) {
  const userRef = doc(db, "users", userId);
  await updateDoc(userRef, {
    ...data,
    updated_at: serverTimestamp(),
  });

  try {
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      const uData = snap.data();
      await syncLeaderboardProjection(userId, {
        display_name: (uData.display_name || uData.full_name) as string,
        full_name: uData.full_name as string,
        points: Number(uData.points) || 0,
        rank: uData.rank as string,
        tenant_id: uData.tenant_id as string,
        state_id: uData.state_id as string,
        zone_id: uData.zone_id as string,
        lga_id: uData.lga_id as string,
        ward_id: uData.ward_id as string,
      });
    }
  } catch (syncErr) {
    console.warn("Leaderboard projection sync warning on profile update:", syncErr);
  }
}

// ─────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────

export async function getActiveTasks() {
  const q = query(
    collection(db, "tasks"),
    where("status", "==", "active"),
    orderBy("created_at", "desc"),
  );

  const snap = await getDocs(q);

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
}

export async function getAllTasks() {
  const q = query(collection(db, "tasks"), orderBy("created_at", "desc"));

  const snap = await getDocs(q);

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
}

export async function createTask(taskData: Record<string, unknown>) {
  const docRef = await addDoc(collection(db, "tasks"), {
    ...taskData,
    status: "active",
    created_at: serverTimestamp(),
  });

  return docRef.id;
}

// ─────────────────────────────────────────────
// Task submissions
// ─────────────────────────────────────────────

/**
 * Creates a single submission for a member/task combination.
 *
 * IMPORTANT:
 * The document ID is deterministic:
 *
 *     {taskId}_{userId}
 *
 * This matches the Firestore Security Rules and prevents a member
 * from submitting the same task multiple times.
 *
 * Proof URL:
 * - Like       → not required
 * - Comment    → not required
 * - Share      → required
 * - Make post  → required
 */
export async function submitTaskCompletion(
  taskId: string,
  userId: string,
  proofUrl?: string,
) {
  const submissionId = `${taskId}_${userId}`;

  const submissionRef = doc(db, "task_submissions", submissionId);

  await setDoc(submissionRef, {
    task_id: taskId,
    user_id: userId,
    proof_url: proofUrl?.trim() || null,
    status: "pending",
    submitted_at: serverTimestamp(),
  });
}

/**
 * Updates an existing task submission (allows resubmission/overwriting proof URL)
 * as long as it has not already been verified.
 */
export async function updateTaskSubmission(
  taskId: string,
  userId: string,
  proofUrl?: string,
) {
  const submissionId = `${taskId}_${userId}`;
  const submissionRef = doc(db, "task_submissions", submissionId);

  const snap = await getDoc(submissionRef);
  if (!snap.exists()) {
    throw new Error("Task submission not found.");
  }

  const currentData = snap.data();
  if (currentData.status === "verified") {
    throw new Error("Cannot update a verified task submission.");
  }

  await updateDoc(submissionRef, {
    proof_url: proofUrl?.trim() || null,
    status: "pending",
    updated_at: serverTimestamp(),
  });
}

/**
 * Gets all submissions for a specific task.
 *
 * Admin use only.
 *
 * Firestore has no joins, so we resolve each submitter's profile
 * individually.
 */
export async function getSubmissionsForTaskWithUsers(taskId: string) {
  const q = query(
    collection(db, "task_submissions"),
    where("task_id", "==", taskId),
    orderBy("submitted_at", "desc"),
  );

  const snap = await getDocs(q);

  const submissions = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as {
    id: string;
    user_id: string;
    [key: string]: unknown;
  }[];

  if (submissions.length === 0) return [];

  // Extract unique user IDs
  const userIds = Array.from(new Set(submissions.map((s) => s.user_id)));
  const userMap = new Map<string, unknown>();

  // Batch query in chunks of 30
  const chunkSize = 30;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    const usersQ = query(
      collection(db, "users"),
      where("__name__", "in", chunk)
    );
    const userSnap = await getDocs(usersQ);
    userSnap.docs.forEach((d) => {
      userMap.set(d.id, { id: d.id, ...d.data() });
    });
  }

  return submissions.map((submission) => ({
    ...submission,
    user: userMap.get(submission.user_id) || null,
  }));
}

/**
 * Gets the current user's task submissions.
 */
export async function getUserTaskSubmissions(userId: string) {
  const q = query(
    collection(db, "task_submissions"),
    where("user_id", "==", userId),
    orderBy("submitted_at", "desc"),
  );

  const snap = await getDocs(q);

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
}

/**
 * Verifies a task submission and awards the task points.
 *
 * Everything happens inside one Firestore transaction so that:
 *
 * 1. A submission cannot be verified twice.
 * 2. Points are only awarded once.
 * 3. The submission and user's points stay synchronized.
 */
export async function verifyTaskSubmission(
  submissionId: string,
  adminId: string,
) {
  await runTransaction(db, async (transaction) => {
    const submissionRef = doc(db, "task_submissions", submissionId);

    const submissionSnap = await transaction.get(submissionRef);

    if (!submissionSnap.exists()) {
      throw new Error("Submission not found");
    }

    const submissionData = submissionSnap.data();

    // Prevent double verification / double points.
    if (submissionData.status === "verified") {
      throw new Error("Submission has already been verified");
    }

    const taskId = submissionData.task_id;
    const userId = submissionData.user_id;

    if (!taskId || !userId) {
      throw new Error("Submission is missing task or user information");
    }

    const taskRef = doc(db, "tasks", taskId);

    const taskSnap = await transaction.get(taskRef);

    if (!taskSnap.exists()) {
      throw new Error("Task not found");
    }

    const taskData = taskSnap.data();
    const points = Number(taskData.points ?? 0);

    if (points <= 0) {
      throw new Error("This task does not have valid points assigned");
    }

    const userRef = doc(db, "users", userId);

    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists()) {
      throw new Error("Member profile not found");
    }

    // Mark submission verified.
    transaction.update(submissionRef, {
      status: "verified",
      verified_at: serverTimestamp(),
      verified_by: adminId,
    });

    // Award points exactly once.
    transaction.update(userRef, {
      points: increment(points),
      updated_at: serverTimestamp(),
    });
  });

  // Sync updated user profile to public leaderboard projection
  try {
    const submissionDoc = await getDoc(doc(db, "task_submissions", submissionId));
    if (submissionDoc.exists()) {
      const uId = submissionDoc.data().user_id;
      if (uId) {
        const uDoc = await getDoc(doc(db, "users", uId));
        if (uDoc.exists()) {
          const userData = uDoc.data();
          await syncLeaderboardProjection(uId, {
            display_name: (userData.display_name || userData.full_name) as string,
            full_name: userData.full_name as string,
            points: Number(userData.points) || 0,
            rank: userData.rank as string,
            tenant_id: userData.tenant_id as string,
            state_id: userData.state_id as string,
            zone_id: userData.zone_id as string,
            lga_id: userData.lga_id as string,
            ward_id: userData.ward_id as string,
          });
        }
      }
    }
  } catch (syncErr) {
    console.warn("Post-verification leaderboard sync warning:", syncErr);
  }
}

// ─────────────────────────────────────────────
// Leaderboard
// ─────────────────────────────────────────────

export async function getLeaderboard(
  topN: number = 50,
  tenantId: string = CURRENT_TENANT_ID,
) {
  // Authoritative query against the public non-sensitive leaderboard projection
  const publicQ = query(
    collection(db, "leaderboard_public"),
    where("tenant_id", "==", tenantId),
    orderBy("points", "desc"),
    limit(topN),
  );

  const publicSnap = await getDocs(publicQ);

  return publicSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      user_id: data.user_id || d.id,
      display_name: data.display_name || data.full_name || "Anonymous Member",
      full_name: data.display_name || data.full_name || "Anonymous Member",
      points: Number(data.points) || 0,
      rank: data.rank || "Volunteer",
      tenant_id: data.tenant_id || tenantId,
      state_id: data.state_id || "enugu-state",
      zone_id: data.zone_id || null,
      lga_id: data.lga_id || null,
      ward_id: data.ward_id || null,
    };
  });
}

/**
 * Sync user profile to the public non-sensitive leaderboard projection.
 * Schema includes user_id, display_name, points, rank, tenant_id,
 * state_id, zone_id, lga_id, ward_id. (Polling unit is explicitly excluded).
 */
export async function syncLeaderboardProjection(
  userId: string,
  profileData: {
    display_name?: string;
    full_name?: string;
    points?: number;
    rank?: string;
    tenant_id?: string;
    state_id?: string;
    zone_id?: string;
    lga_id?: string;
    ward_id?: string;
  },
) {
  if (!userId) return;

  try {
    const { doc, setDoc } = await import("firebase/firestore");
    const projRef = doc(db, "leaderboard_public", userId);
    await setDoc(
      projRef,
      {
        user_id: userId,
        display_name:
          profileData.display_name || profileData.full_name || "Anonymous Member",
        points: Number(profileData.points) || 0,
        rank: profileData.rank || "Volunteer",
        tenant_id: profileData.tenant_id || CURRENT_TENANT_ID,
        state_id: profileData.state_id || "enugu-state",
        zone_id: profileData.zone_id || null,
        lga_id: profileData.lga_id || null,
        ward_id: profileData.ward_id || null,
      },
      { merge: true },
    );
  } catch (err) {
    console.warn("Failed to sync leaderboard projection:", err);
  }
}

// ─────────────────────────────────────────────
// News
// ─────────────────────────────────────────────

import type { NewsArticle, NewsStatus } from "@/types";

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalizes Firestore news document data into a consistent NewsArticle interface.
 * Handles legacy documents that use `published: boolean`.
 */
export function normalizeNewsArticle(id: string, data: Record<string, unknown>): NewsArticle {
  const status: NewsStatus =
    (data.status as NewsStatus) || (data.published ? "published" : "draft");

  return {
    id,
    title: (data.title as string) || "Untitled Article",
    slug: (data.slug as string) || generateSlug((data.title as string) || id),
    excerpt: (data.excerpt as string) || "",
    content: (data.content as string) || "",
    featured_image: (data.featured_image as string) ?? null,
    category: (data.category as string) ?? null,
    status,
    published: status === "published",
    published_at: data.published_at ?? data.created_at ?? null,
    scheduled_at: data.scheduled_at ?? null,
    author: (data.author as string) ?? null,
    created_by: (data.created_by as string) || "",
    updated_by: (data.updated_by as string) ?? null,
    created_at: data.created_at ?? null,
    updated_at: data.updated_at ?? null,
  };
}

export async function getPublishedNews(limitCount: number = 20): Promise<NewsArticle[]> {
  const qStatus = query(
    collection(db, "news"),
    where("status", "==", "published"),
    limit(limitCount),
  );

  const qLegacy = query(
    collection(db, "news"),
    where("published", "==", true),
    limit(limitCount),
  );

  try {
    const [snapStatus, snapLegacy] = await Promise.all([
      getDocs(qStatus).catch(() => ({ docs: [] })),
      getDocs(qLegacy).catch(() => ({ docs: [] })),
    ]);

    const articleMap = new Map<string, NewsArticle>();

    snapStatus.docs.forEach((d) => {
      articleMap.set(d.id, normalizeNewsArticle(d.id, d.data()));
    });
    snapLegacy.docs.forEach((d) => {
      if (!articleMap.has(d.id)) {
        articleMap.set(d.id, normalizeNewsArticle(d.id, d.data()));
      }
    });

    const articles = Array.from(articleMap.values());
    articles.sort((a, b) => {
      const timeA = (a.created_at as { seconds?: number })?.seconds || 0;
      const timeB = (b.created_at as { seconds?: number })?.seconds || 0;
      return timeB - timeA;
    });

    return articles.slice(0, limitCount);
  } catch (error) {
    console.error("Error fetching published news:", error);
    return [];
  }
}

export async function getAllNewsArticles(): Promise<NewsArticle[]> {
  const q = query(collection(db, "news"), orderBy("created_at", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => normalizeNewsArticle(d.id, d.data()));
}

export async function getNewsArticle(id: string): Promise<NewsArticle | null> {
  const snap = await getDoc(doc(db, "news", id));
  if (!snap.exists()) return null;
  return normalizeNewsArticle(snap.id, snap.data());
}

export async function getNewsArticleBySlug(slug: string): Promise<NewsArticle | null> {
  // Query status == published or legacy published == true
  const qStatus = query(
    collection(db, "news"),
    where("slug", "==", slug),
    where("status", "==", "published"),
    limit(1)
  );

  const qLegacy = query(
    collection(db, "news"),
    where("slug", "==", slug),
    where("published", "==", true),
    limit(1)
  );

  const [snapStatus, snapLegacy] = await Promise.all([
    getDocs(qStatus).catch(() => ({ docs: [], empty: true })),
    getDocs(qLegacy).catch(() => ({ docs: [], empty: true })),
  ]);

  const docData = snapStatus.docs[0] || snapLegacy.docs[0];
  if (!docData) return null;

  return normalizeNewsArticle(docData.id, docData.data());
}

export async function createNewsArticle(
  articleData: Omit<NewsArticle, "id" | "created_at" | "updated_at">
): Promise<string> {
  const docData: Record<string, unknown> = {
    title: articleData.title,
    slug: articleData.slug || generateSlug(articleData.title),
    excerpt: articleData.excerpt || "",
    content: articleData.content || "",
    featured_image: articleData.featured_image || null,
    category: articleData.category || null,
    status: articleData.status || "draft",
    published: articleData.status === "published",
    published_at: articleData.status === "published" ? serverTimestamp() : (articleData.published_at || null),
    scheduled_at: articleData.scheduled_at || null,
    author: articleData.author || null,
    created_by: articleData.created_by || "",
    updated_by: articleData.updated_by || null,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  };

  const docRef = await addDoc(collection(db, "news"), docData);
  return docRef.id;
}

export async function updateNewsArticle(
  id: string,
  articleData: Partial<NewsArticle>
): Promise<void> {
  const updateData: Record<string, unknown> = {
    updated_at: serverTimestamp(),
  };

  if (articleData.title !== undefined) updateData.title = articleData.title;
  if (articleData.slug !== undefined) updateData.slug = articleData.slug;
  if (articleData.excerpt !== undefined) updateData.excerpt = articleData.excerpt;
  if (articleData.content !== undefined) updateData.content = articleData.content;
  if (articleData.featured_image !== undefined) updateData.featured_image = articleData.featured_image;
  if (articleData.category !== undefined) updateData.category = articleData.category;
  if (articleData.author !== undefined) updateData.author = articleData.author;
  if (articleData.updated_by !== undefined) updateData.updated_by = articleData.updated_by;
  if (articleData.scheduled_at !== undefined) updateData.scheduled_at = articleData.scheduled_at;

  if (articleData.status !== undefined) {
    updateData.status = articleData.status;
    updateData.published = articleData.status === "published";
    if (articleData.status === "published" && !articleData.published_at) {
      updateData.published_at = serverTimestamp();
    }
  }

  await updateDoc(doc(db, "news", id), updateData);
}

export async function deleteNewsArticle(id: string): Promise<void> {
  const { deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "news", id));
}



/**
 * Get announcements for the current tenant, filtered by user scope
 */
export async function getUserAnnouncements(userProfile: {
  access_role?: string;
  membership_types?: string[];
} | null): Promise<Announcement[]> {
  const tenant = await getCurrentTenant();
  const allAnnouncements = await getPortalAnnouncements(tenant.id);
  
  // Filter by scope
  return allAnnouncements.filter((announcement) => {
    if (announcement.scope === "general") return true;
    if (announcement.scope === "admins" && userProfile?.access_role === "admin") return true;
    if (announcement.scope === "campaign_members" && userProfile?.membership_types?.includes("campaign_member")) return true;
    if (announcement.scope === "social_members" && userProfile?.membership_types?.includes("social_member")) return true;
    if (announcement.scope === "election_officers" && userProfile?.access_role === "election_officer") return true;
    return false;
  });
}

// ─────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────

export async function getUpcomingEvents() {
  const today = new Date().toISOString().split("T")[0];

  const q = query(
    collection(db, "events"),
    where("date", ">=", today),
    orderBy("date", "asc"),
    limit(5),
  );

  const snap = await getDocs(q);

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
}

// ─────────────────────────────────────────────
// Election results
// ─────────────────────────────────────────────

export interface ElectionResult {
  party: string;
  votes: number;
}

/**
 * Submits a polling unit's election results as a SINGLE document,
 * keyed by a deterministic ID derived from ward_id + polling_unit_id.
 *
 * Document ID:
 *
 *     {ward_id}__{polling_unit_id}
 *
 * Firestore Security Rules prevent a second submission for the
 * same polling unit.
 */
export async function submitElectionResult(
  pollingUnitId: string,
  wardId: string,
  results: ElectionResult[],
  userId: string,
) {
  const resultDocId = `${wardId}__${pollingUnitId}`;

  const resultRef = doc(db, "election_results", resultDocId);

  await setDoc(resultRef, {
    ward_id: wardId,
    polling_unit_id: pollingUnitId,
    results,
    submitted_by: userId,
    verified: false,
    created_at: serverTimestamp(),
  });
}

// ─────────────────────────────────────────────
// Contact messages
// ─────────────────────────────────────────────

export interface ContactMessage {
  name: string;
  email: string;
  phone?: string;
  message: string;
}

export interface ContactMessageDoc extends ContactMessage {
  id: string;
  tenant_id: string;
  status: "unread" | "read";
  created_at: unknown;
}

export async function submitContactMessage(data: ContactMessage): Promise<string> {
  const tenant = await getCurrentTenant();
  const docRef = await addDoc(collection(db, "contact_messages"), {
    name: data.name.trim(),
    email: data.email.trim(),
    phone: data.phone?.trim() || null,
    message: data.message.trim(),
    tenant_id: tenant.id,
    status: "unread",
    created_at: serverTimestamp(),
  });

  return docRef.id;
}

export async function getContactMessages(): Promise<ContactMessageDoc[]> {
  const tenant = await getCurrentTenant();
  const q = query(
    collection(db, "contact_messages"),
    where("tenant_id", "==", tenant.id),
    orderBy("created_at", "desc")
  );

  try {
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as ContactMessageDoc[];
  } catch (err) {
    console.error("Error fetching contact messages:", err);
    // Fallback simple query without orderBy if index is building
    const qSimple = query(
      collection(db, "contact_messages"),
      where("tenant_id", "==", tenant.id)
    );
    const snapSimple = await getDocs(qSimple);
    return snapSimple.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as ContactMessageDoc[];
  }
}

export async function markContactMessageAsRead(id: string): Promise<void> {
  const docRef = doc(db, "contact_messages", id);
  await updateDoc(docRef, {
    status: "read",
    read_at: serverTimestamp(),
  });
}
