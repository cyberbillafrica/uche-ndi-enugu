"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Mail,
  MailOpen,
  Phone,
  User,
  Calendar,
  X,
  CheckCircle,
  AlertCircle,
  Inbox,
  Filter,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import {
  listContactMessages,
  markContactMessageRead,
  type ContactMessage,
} from "@/lib/supabase";

export default function AdminContactMessagesPage() {
  const { profile, loading: authLoading } = useAuth();
  const router = useRouter();

  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "unread" | "read">("all");
  const [selectedMessage, setSelectedMessage] = useState<ContactMessage | null>(null);

  // Auth guard
  useEffect(() => {
    if (authLoading) return;
    if (!profile || profile.access_role !== "admin") {
      router.replace("/portal/dashboard");
    }
  }, [authLoading, profile, router]);

  const loadMessages = useCallback(async () => {
    try {
      setLoading(true);
      const data = await listContactMessages();
      setMessages(data);
    } catch (err) {
      console.error("Failed to load contact messages:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && profile?.access_role === "admin") {
      loadMessages();
    }
  }, [authLoading, profile, loadMessages]);

  const handleOpenModal = async (msg: ContactMessage) => {
    setSelectedMessage(msg);
    if (msg.status === "unread") {
      try {
        await markContactMessageRead(msg.id);
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, status: "read" } : m))
        );
      } catch (err) {
        console.error("Failed to mark message as read:", err);
      }
    }
  };

  const filteredMessages = messages.filter((msg) => {
    if (filter === "unread") return msg.status === "unread";
    if (filter === "read") return msg.status === "read";
    return true;
  });

  const unreadCount = messages.filter((m) => m.status === "unread").length;

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <span className="ml-3 text-gray-500">Loading messages...</span>
      </div>
    );
  }

  if (!profile || profile.access_role !== "admin") {
    return null;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contact Messages</h1>
          <p className="text-sm text-gray-500">
            Review inquiries and contact requests sent through the public website.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            <Mail className="h-3.5 w-3.5" />
            {unreadCount} Unread
          </span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center justify-between border-b border-gray-200 pb-3">
        <div className="flex gap-2">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              filter === "all"
                ? "bg-brand-primary text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All ({messages.length})
          </button>
          <button
            onClick={() => setFilter("unread")}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              filter === "unread"
                ? "bg-brand-primary text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Unread ({unreadCount})
          </button>
          <button
            onClick={() => setFilter("read")}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              filter === "read"
                ? "bg-brand-primary text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Read ({messages.length - unreadCount})
          </button>
        </div>
      </div>

      {/* Messages List */}
      {filteredMessages.length === 0 ? (
        <div className="rounded-2xl bg-white border border-gray-200 p-12 text-center">
          <Inbox className="h-12 w-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">No messages found</p>
          <p className="text-sm text-gray-400 mt-1">
            {filter === "unread"
              ? "All caught up! No unread messages."
              : "No contact submissions received yet."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredMessages.map((msg) => {
            const isUnread = msg.status === "unread";
            return (
              <div
                key={msg.id}
                onClick={() => handleOpenModal(msg)}
                className={`bg-white rounded-xl border p-5 cursor-pointer transition-all hover:shadow-md ${
                  isUnread
                    ? "border-brand-primary/40 bg-blue-50/20"
                    : "border-gray-200"
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        isUnread ? "bg-brand-primary" : "bg-gray-300"
                      }`}
                    />
                    <h3 className="font-semibold text-gray-900">{msg.name}</h3>
                    <span className="text-xs text-gray-500">({msg.email})</span>
                  </div>

                  <span className="text-xs text-gray-400">
                    {formatTimestamp(msg.created_at)}
                  </span>
                </div>

                <p className="text-sm text-gray-600 line-clamp-2 pl-4 border-l-2 border-gray-200">
                  {msg.message}
                </p>

                {msg.phone && (
                  <div className="mt-3 flex items-center gap-1.5 text-xs text-gray-500">
                    <Phone className="h-3.5 w-3.5" />
                    <span>{msg.phone}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selectedMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="bg-brand-primary text-white p-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-white/10">
                  <MailOpen className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-lg font-bold">Contact Inquiry</h2>
                  <p className="text-xs text-white/80">
                    Received {formatTimestamp(selectedMessage.created_at)}
                  </p>
                </div>
              </div>

              <button
                onClick={() => setSelectedMessage(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-white/80 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 bg-gray-50 p-4 rounded-xl border border-gray-100">
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    Sender Name
                  </p>
                  <p className="font-semibold text-gray-900 mt-0.5">
                    {selectedMessage.name}
                  </p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    Email
                  </p>
                  <a
                    href={`mailto:${selectedMessage.email}`}
                    className="font-semibold text-brand-primary hover:underline mt-0.5 block truncate"
                  >
                    {selectedMessage.email}
                  </a>
                </div>

                {selectedMessage.phone && (
                  <div className="sm:col-span-2">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      Phone Number
                    </p>
                    <a
                      href={`tel:${selectedMessage.phone}`}
                      className="font-semibold text-gray-900 hover:text-brand-primary mt-0.5 block"
                    >
                      {selectedMessage.phone}
                    </a>
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                  Message Content
                </p>
                <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 text-sm text-gray-800 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {selectedMessage.message}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="border-t px-6 py-4 bg-gray-50 flex items-center justify-between">
              <a
                href={`mailto:${selectedMessage.email}?subject=RE: Inquiry from Campaign Website`}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-brand-primary transition-colors"
              >
                <Mail className="h-4 w-4" />
                Reply via Email
              </a>

              <button
                onClick={() => setSelectedMessage(null)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimestamp(ts: any) {
  if (!ts) return "Recently";
  let date: Date;
  if (ts.seconds) {
    date = new Date(ts.seconds * 1000);
  } else if (typeof ts === "string" || typeof ts === "number") {
    date = new Date(ts);
  } else {
    return "Recently";
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
