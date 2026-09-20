/*
 * ============================================================
 * USER-FRIENDLY ERROR MESSAGES
 *
 * Converts technical Firebase/Firestore/Cloudinary errors into
 * plain language for end users. The raw error is always logged
 * to the console for developers but never shown in the UI.
 * ============================================================
 */

interface FirebaseLikeError {
  code?: string;
  message?: string;
}

const FIRESTORE_ERROR_MESSAGES: Record<string, string> = {
  "permission-denied":
    "You don't have permission to perform this action.",
  unavailable:
    "The service is temporarily unavailable. Please check your connection and try again.",
  "unauthenticated":
    "Your session has expired. Please sign in again.",
  "failed-precondition":
    "This action can't be completed right now. Please refresh the page and try again.",
  "aborted":
    "The operation was interrupted. Please try again.",
  "deadline-exceeded":
    "The operation took too long. Please try again.",
  "resource-exhausted":
    "The service is temporarily busy. Please try again in a moment.",
  "not-found":
    "The record you were working with no longer exists.",
  "already-exists":
    "A record like this already exists.",
  "invalid-argument":
    "Some of the information provided isn't valid. Please check your entries and try again.",
  "cancelled":
    "The operation was cancelled.",
  "internal":
    "Something went wrong on our side. Please try again.",
  "data-loss":
    "Something went wrong on our side. Please try again.",
};

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  "auth/invalid-credential":
    "The email address or password is incorrect.",
  "auth/wrong-password":
    "The email address or password is incorrect.",
  "auth/user-not-found":
    "No account was found with that email address.",
  "auth/invalid-email":
    "That email address doesn't look right. Please check it and try again.",
  "auth/too-many-requests":
    "Too many attempts. Please wait a moment and try again.",
  "auth/email-already-in-use":
    "An account with that email address already exists.",
  "auth/weak-password":
    "That password is too weak. Please choose a stronger one.",
  "auth/network-request-failed":
    "Network problem. Please check your internet connection and try again.",
  "auth/requires-recent-login":
    "For security reasons, please sign out and sign in again before doing this.",
};

/**
 * Maps a thrown error to a human-readable sentence.
 * Falls back to a generic message for unknown errors.
 * Always logs the raw error to the console for developers.
 */
export function getErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  if (error instanceof Error || typeof error === "object") {
    const err = error as FirebaseLikeError & { code?: string };

    if (err?.code) {
      const mapped =
        AUTH_ERROR_MESSAGES[err.code] ?? FIRESTORE_ERROR_MESSAGES[err.code];
      if (mapped) return mapped;
    }

    // Firestore messages sometimes carry the code inside `message`.
    const message = err?.message ?? "";
    for (const key of Object.keys(FIRESTORE_ERROR_MESSAGES)) {
      if (message.includes(key)) {
        return FIRESTORE_ERROR_MESSAGES[key];
      }
    }

    // A few well-known non-Firebase technical strings.
    if (/network|failed to fetch|load failed/i.test(message)) {
      return "Network problem. Please check your internet connection and try again.";
    }
  }

  return fallback;
}
