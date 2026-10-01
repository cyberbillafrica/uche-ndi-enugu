"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Plus,
  Search,
  Edit2,
  Trash2,
  Eye,
  CheckCircle,
  Archive,
  Clock,
  AlertCircle,
  Loader2,
  X,
  Upload,
  Calendar,
  Tag,
  ArrowLeft,
  Globe,
  FileText,
  User,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  listNews,
  createNews,
  updateNews,
  deleteNews,
  generateNewsSlug,
  type NewsArticle,
  type NewsStatus,
} from "@/lib/supabase";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function AdminNewsCMSPage() {
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters & Search
  const [activeTab, setActiveTab] = useState<"all" | NewsStatus>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Editor Modal State
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<NewsArticle | null>(
    null,
  );

  // Preview Modal State
  const [previewArticle, setPreviewArticle] = useState<NewsArticle | null>(
    null,
  );

  // Delete Confirmation Modal State
  const [deletingArticle, setDeletingArticle] = useState<NewsArticle | null>(
    null,
  );

  // Form State
  const [formTitle, setFormTitle] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [isCustomSlug, setIsCustomSlug] = useState(false);
  const [formExcerpt, setFormExcerpt] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formAuthor, setFormAuthor] = useState("");
  const [formStatus, setFormStatus] = useState<NewsStatus>("draft");
  const [formScheduledAt, setFormScheduledAt] = useState("");
  const [formFeaturedImage, setFormFeaturedImage] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadArticles();
  }, []);

  async function loadArticles() {
    try {
      setLoading(true);
      const data = await listNews();
      setArticles(data);
    } catch (err: any) {
      console.error("Failed to load news articles:", err);
      toast.error("We couldn't load the news articles. Please refresh the page.");
    } finally {
      setLoading(false);
    }
  }

  function openCreateModal() {
    setEditingArticle(null);
    setFormTitle("");
    setFormSlug("");
    setIsCustomSlug(false);
    setFormExcerpt("");
    setFormContent("");
    setFormCategory("Campaign Update");
    setFormAuthor(profile?.full_name || "Campaign Team");
    setFormStatus("draft");
    setFormScheduledAt("");
    setFormFeaturedImage("");
    setIsEditorOpen(true);
  }

  function formatScheduledAtInput(raw: unknown): string {
    if (!raw) return "";

    let date: Date | null = null;

    if (raw && typeof raw === "object" && "seconds" in raw) {
      const ts = raw as { seconds: number };
      date = new Date(ts.seconds * 1000);
    } else if (raw instanceof Date) {
      date = raw;
    } else if (typeof raw === "string" || typeof raw === "number") {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) {
        date = d;
      }
    }

    if (!date || isNaN(date.getTime())) {
      return "";
    }

    // Format to YYYY-MM-DDTHH:mm for datetime-local input
    const pad = (num: number) => String(num).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());

    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function openEditModal(article: NewsArticle) {
    setEditingArticle(article);
    setFormTitle(article.title);
    setFormSlug(article.slug);
    setIsCustomSlug(true);
    setFormExcerpt(article.excerpt || "");
    setFormContent(article.content || "");
    setFormCategory(article.category || "Campaign Update");
    setFormAuthor(article.author || profile?.full_name || "Campaign Team");
    setFormStatus(article.status || "draft");
    setFormScheduledAt(formatScheduledAtInput(article.scheduled_at));
    setFormFeaturedImage(article.featured_image || "");
    setIsEditorOpen(true);
  }

  function handleTitleChange(val: string) {
    setFormTitle(val);
    if (!isCustomSlug) {
      setFormSlug(generateNewsSlug(val));
    }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setUploadingImage(true);
      const downloadUrl = await uploadToCloudinary(file, "ifeanyi-2027/news");
      setFormFeaturedImage(downloadUrl);
      toast.success("Image uploaded successfully.");
    } catch (err: any) {
      console.error("Failed to upload image to Cloudinary:", err);
      toast.error(
        getErrorMessage(err,
          "Image upload failed. You can also paste an external image URL directly."),
      );
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleSaveArticle(e: React.FormEvent) {
    e.preventDefault();

    if (!formTitle.trim()) {
      toast.warning("Please enter a title for the article.");
      return;
    }

    if (!formContent.trim()) {
      toast.warning("Please write the article content before saving.");
      return;
    }

    const slugToUse = formSlug.trim() || generateNewsSlug(formTitle);

    // Check for duplicate slug
    const isDuplicateSlug = articles.some(
      (a) => a.slug === slugToUse && a.id !== editingArticle?.id,
    );

    const finalSlug = isDuplicateSlug
      ? `${slugToUse}-${Date.now().toString().slice(-4)}`
      : slugToUse;

    try {
      setSaving(true);

      if (editingArticle) {
        await updateNews(
          editingArticle.id,
          {
            title: formTitle.trim(),
            slug: finalSlug,
            excerpt: formExcerpt.trim(),
            content: formContent.trim(),
            category: formCategory.trim() || null,
            author: formAuthor.trim() || null,
            status: formStatus,
            scheduledAt: formScheduledAt.trim() || null,
            featuredImage: formFeaturedImage.trim() || null,
          },
          profile?.id || "admin",
        );
        toast.success(`Article "${formTitle}" updated successfully.`);
      } else {
        await createNews(
          {
            title: formTitle.trim(),
            slug: finalSlug,
            excerpt: formExcerpt.trim(),
            content: formContent.trim(),
            category: formCategory.trim() || null,
            author: formAuthor.trim() || null,
            status: formStatus,
            scheduledAt: formScheduledAt.trim() || null,
            featuredImage: formFeaturedImage.trim() || null,
          },
          profile?.id || "admin",
        );
        toast.success(`Article "${formTitle}" created successfully.`);
      }

      setIsEditorOpen(false);
      await loadArticles();
    } catch (err: any) {
      console.error("Error saving article:", err);
      toast.error(getErrorMessage(err, "We couldn't save the article. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  async function handleQuickStatusChange(
    article: NewsArticle,
    newStatus: NewsStatus,
  ) {
    try {
      await updateNews(article.id, { status: newStatus }, profile?.id || "admin");
      toast.success(
        newStatus === "published"
          ? `Article "${article.title}" is now published.`
          : newStatus === "draft"
            ? `Article "${article.title}" was unpublished and returned to draft.`
            : `Article "${article.title}" was archived.`,
      );
      await loadArticles();
    } catch (err: any) {
      console.error("Failed to update status:", err);
      toast.error(getErrorMessage(err, "We couldn't update the article status. Please try again."));
    }
  }

  async function handleDeleteConfirm() {
    if (!deletingArticle) return;

    try {
      setSaving(true);
      await deleteNews(deletingArticle.id);
      toast.success(`Article "${deletingArticle.title}" deleted successfully.`);
      setDeletingArticle(null);
      await loadArticles();
    } catch (err: any) {
      console.error("Failed to delete article:", err);
      toast.error(getErrorMessage(err, "We couldn't delete the article. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin text-brand-primary" />
        Authenticating...
      </div>
    );
  }

  if (profile?.access_role !== "admin") {
    return (
      <div className="rounded-2xl bg-white p-8 text-center shadow-sm border my-8">
        <AlertCircle className="mx-auto h-10 w-10 text-red-500 mb-3" />
        <h2 className="text-xl font-bold text-gray-900">Access Denied</h2>
        <p className="mt-2 text-gray-600">
          You do not have administrative permissions to view this page.
        </p>
      </div>
    );
  }

  // Filter articles
  const filteredArticles = articles.filter((article) => {
    const matchesTab = activeTab === "all" || article.status === activeTab;
    const matchesSearch =
      searchQuery === "" ||
      article.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (article.excerpt &&
        article.excerpt.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (article.category &&
        article.category.toLowerCase().includes(searchQuery.toLowerCase()));

    return matchesTab && matchesSearch;
  });

  const counts = {
    all: articles.length,
    draft: articles.filter((a) => a.status === "draft").length,
    published: articles.filter((a) => a.status === "published").length,
    scheduled: articles.filter((a) => a.status === "scheduled").length,
    archived: articles.filter((a) => a.status === "archived").length,
  };

  function formatDate(rawTimestamp: any) {
    if (!rawTimestamp) return "N/A";
    let date: Date;
    if (rawTimestamp.seconds) {
      date = new Date(rawTimestamp.seconds * 1000);
    } else if (
      typeof rawTimestamp === "string" ||
      typeof rawTimestamp === "number"
    ) {
      date = new Date(rawTimestamp);
    } else {
      return "N/A";
    }
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">News CMS</h1>
          <p className="text-sm text-gray-500">
            Create, manage, schedule, and publish news updates for the campaign.
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-primary shadow-sm"
        >
          <Plus className="h-4 w-4" />
          <span>New Article</span>
        </button>
      </div>

      {/* Tabs & Search */}
      <Card>
        <CardContent className="p-4 sm:p-6 space-y-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            {/* Tabs */}
            <div className="flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1">
              {(
                ["all", "draft", "published", "scheduled", "archived"] as const
              ).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition-all ${
                    activeTab === tab
                      ? "bg-white text-brand-primary shadow-sm"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  <span>{tab}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                      activeTab === tab
                        ? "bg-brand-primary/10 text-brand-primary"
                        : "bg-gray-200 text-gray-700"
                    }`}
                  >
                    {counts[tab]}
                  </span>
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="relative w-full lg:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search articles..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-lg border border-gray-200 pl-9 pr-4 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Table / List */}
          {loading ? (
            <div className="flex min-h-[200px] items-center justify-center gap-2 text-gray-500">
              <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
              <span>Loading news management console...</span>
            </div>
          ) : filteredArticles.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-gray-500">
              <FileText className="mx-auto h-8 w-8 text-gray-300 mb-2" />
              <p className="font-semibold text-gray-700">No articles found</p>
              <p className="text-xs text-gray-500 mt-1">
                {searchQuery
                  ? "Try adjusting your search keywords or filter tab."
                  : "Click 'New Article' above to create your first article."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-600">
                <thead className="bg-gray-50 text-xs font-semibold uppercase tracking-wider text-gray-500 border-b">
                  <tr>
                    <th className="px-4 py-3">Article Title</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredArticles.map((article) => (
                    <tr
                      key={article.id}
                      className="hover:bg-gray-50/80 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900 max-w-xs">
                        <div className="truncate font-semibold text-gray-900">
                          {article.title}
                        </div>
                        <div className="truncate text-xs text-gray-400 font-mono mt-0.5">
                          /{article.slug}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                          <Tag className="h-3 w-3 text-gray-400" />
                          {article.category || "General"}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <StatusBadge status={article.status} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
                        {formatDate(article.published_at || article.created_at)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* Preview Button */}
                          <button
                            type="button"
                            onClick={() => setPreviewArticle(article)}
                            title="Preview Article"
                            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-brand-primary transition-colors"
                          >
                            <Eye className="h-4 w-4" />
                          </button>

                          {/* Edit Button */}
                          <button
                            type="button"
                            onClick={() => openEditModal(article)}
                            title="Edit Article"
                            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>

                          {/* Quick Publish / Draft toggles */}
                          {article.status === "draft" && (
                            <button
                              type="button"
                              onClick={() =>
                                handleQuickStatusChange(article, "published")
                              }
                              title="Publish Article"
                              className="rounded p-1.5 text-green-600 hover:bg-green-50 transition-colors"
                            >
                              <CheckCircle className="h-4 w-4" />
                            </button>
                          )}

                          {article.status === "published" && (
                            <button
                              type="button"
                              onClick={() =>
                                handleQuickStatusChange(article, "draft")
                              }
                              title="Unpublish (Return to Draft)"
                              className="rounded p-1.5 text-orange-600 hover:bg-orange-50 transition-colors"
                            >
                              <Clock className="h-4 w-4" />
                            </button>
                          )}

                          {/* Archive Button */}
                          {article.status !== "archived" && (
                            <button
                              type="button"
                              onClick={() =>
                                handleQuickStatusChange(article, "archived")
                              }
                              title="Archive Article"
                              className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors"
                            >
                              <Archive className="h-4 w-4" />
                            </button>
                          )}

                          {/* Delete Button */}
                          <button
                            type="button"
                            onClick={() => setDeletingArticle(article)}
                            title="Delete Article"
                            className="rounded p-1.5 text-red-500 hover:bg-red-50 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Editor Modal */}
      {isEditorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-xl my-8 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900">
                {editingArticle ? "Edit Article" : "Create New Article"}
              </h2>
              <button
                type="button"
                onClick={() => setIsEditorOpen(false)}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form
              onSubmit={handleSaveArticle}
              className="p-6 overflow-y-auto space-y-5 flex-1"
            >
              {/* Title & Slug */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                    Article Title *
                  </label>
                  <input
                    type="text"
                    required
                    value={formTitle}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    placeholder="e.g. Campaign Flag-off in Agbani"
                    className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                    URL Slug
                  </label>
                  <div className="flex rounded-lg border border-gray-300 overflow-hidden">
                    <span className="inline-flex items-center bg-gray-50 px-2.5 text-xs text-gray-400 border-r">
                      /news/
                    </span>
                    <input
                      type="text"
                      value={formSlug}
                      onChange={(e) => {
                        setFormSlug(e.target.value);
                        setIsCustomSlug(true);
                      }}
                      placeholder="article-slug"
                      className="w-full px-3 py-2 text-sm focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Excerpt */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                  Excerpt / Summary
                </label>
                <textarea
                  rows={2}
                  value={formExcerpt}
                  onChange={(e) => setFormExcerpt(e.target.value)}
                  placeholder="Short summary displayed on news listings..."
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
                />
              </div>

              {/* Article Content */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                  Article Content *
                </label>
                <textarea
                  rows={8}
                  required
                  value={formContent}
                  onChange={(e) => setFormContent(e.target.value)}
                  placeholder="Write full article content here..."
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-sans focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
                />
              </div>

              {/* Category, Author, Status */}
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                    Category
                  </label>
                  <input
                    type="text"
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value)}
                    placeholder="e.g. Rally, Statement, Press Release"
                    className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                    Author / Byline
                  </label>
                  <input
                    type="text"
                    value={formAuthor}
                    onChange={(e) => setFormAuthor(e.target.value)}
                    placeholder="e.g. Campaign Media Office"
                    className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                    Publishing Status
                  </label>
                  <select
                    value={formStatus}
                    onChange={(e) =>
                      setFormStatus(e.target.value as NewsStatus)
                    }
                    className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
                  >
                    <option value="draft">Draft (Private)</option>
                    <option value="published">Published (Public)</option>
                    <option value="scheduled">Scheduled (Future)</option>
                    <option value="archived">Archived (Hidden)</option>
                  </select>
                </div>
              </div>

              {/* Scheduled Date if Status == scheduled */}
              {formStatus === "scheduled" && (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                    Scheduled Publication Date & Time
                  </label>
                  <input
                    type="datetime-local"
                    value={formScheduledAt}
                    onChange={(e) => setFormScheduledAt(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
                  />
                </div>
              )}

              {/* Featured Image */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
                  Featured Image URL or Upload
                </label>

                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={formFeaturedImage}
                      onChange={(e) => setFormFeaturedImage(e.target.value)}
                      placeholder="https://example.com/image.jpg"
                      className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
                    />
                    <label className="cursor-pointer inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-100 transition-colors shrink-0">
                      <Upload className="h-4 w-4" />
                      <span>{uploadingImage ? "Uploading..." : "Upload"}</span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handleImageUpload}
                        disabled={uploadingImage}
                        className="hidden"
                      />
                    </label>
                  </div>

                  {/* ✅ General hint */}
                  <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-1">
                    <p className="font-medium text-gray-700">
                      ℹ️ How to get a working image URL:
                    </p>
                    <ul className="list-disc pl-5 space-y-0.5">
                      <li>
                        <strong>Upload</strong> an image using the button above
                        – this always works.
                      </li>
                      <li>
                        Or paste a <strong>direct image URL</strong> – the link
                        must end with <code>.jpg</code>, <code>.png</code>,{" "}
                        <code>.webp</code>, or come from an image CDN.
                      </li>
                      <li>
                        <strong>Page links do not work</strong> – e.g.{" "}
                        <code>https://drive.google.com/file/d/.../view</code>,
                        social media posts, or photo gallery pages.
                      </li>
                      <li>
                        <strong>For Google Drive:</strong> use the direct format{" "}
                        <code>
                          https://drive.google.com/uc?export=view&amp;id=FILE_ID
                        </code>{" "}
                        (replace <code>FILE_ID</code> with your file&apos;s ID).
                      </li>
                      <li>
                        <strong>For most other sites:</strong> right-click the
                        image and select <em>&quot;Copy Image Address&quot;</em>{" "}
                        - that gives a direct URL.
                      </li>
                    </ul>
                  </div>

                  {formFeaturedImage && (
                    <div className="relative aspect-[16/9] w-48 overflow-hidden rounded-lg border bg-gray-100">
                      <Image
                        src={formFeaturedImage}
                        alt="Featured image preview"
                        fill
                        unoptimized
                        className="object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => setFormFeaturedImage("")}
                        className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white hover:bg-black"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Submit Buttons */}
              <div className="flex items-center justify-end gap-3 border-t pt-4">
                <button
                  type="button"
                  onClick={() => setIsEditorOpen(false)}
                  className="rounded-lg border px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-5 py-2 text-sm font-semibold text-white hover:bg-brand-primary disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span>
                    {editingArticle ? "Save Changes" : "Create Article"}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-xl my-8 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-gray-50">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase text-gray-500">
                  Article Preview
                </span>
                <StatusBadge status={previewArticle.status} />
              </div>
              <button
                type="button"
                onClick={() => setPreviewArticle(null)}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 sm:p-8 overflow-y-auto space-y-6">
              {previewArticle.category && (
                <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-primary/10 px-3 py-1 text-xs font-semibold text-brand-primary">
                  <Tag className="h-3.5 w-3.5" />
                  {previewArticle.category}
                </div>
              )}

              <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">
                {previewArticle.title}
              </h1>

              <div className="flex items-center gap-4 text-xs text-gray-500 border-b pb-4">
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-brand-primary" />
                  {formatDate(
                    previewArticle.published_at || previewArticle.created_at,
                  )}
                </span>
                {previewArticle.author && (
                  <span className="flex items-center gap-1">
                    <User className="h-3.5 w-3.5 text-brand-primary" />
                    {previewArticle.author}
                  </span>
                )}
              </div>

              {previewArticle.featured_image && (
                <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl bg-gray-100">
                  <Image
                    src={previewArticle.featured_image}
                    alt={previewArticle.title}
                    fill
                    unoptimized
                    className="object-cover"
                  />
                </div>
              )}

              {previewArticle.excerpt && (
                <p className="text-base font-medium text-gray-700 italic border-l-4 border-brand-primary pl-4 py-1 bg-gray-50">
                  {previewArticle.excerpt}
                </p>
              )}

              <div className="prose max-w-none text-gray-800 leading-relaxed whitespace-pre-wrap text-sm sm:text-base">
                {previewArticle.content}
              </div>
            </div>

            <div className="flex justify-end border-t px-6 py-4 bg-gray-50">
              <button
                type="button"
                onClick={() => setPreviewArticle(null)}
                className="rounded-lg bg-gray-200 px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-300"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border">
            <div className="flex items-center gap-3 text-red-600 mb-4">
              <AlertCircle className="h-6 w-6 shrink-0" />
              <h3 className="text-lg font-bold">Delete Article</h3>
            </div>

            <p className="text-sm text-gray-600">
              Are you sure you want to permanently delete article{" "}
              <span className="font-semibold text-gray-900">
                &quot;{deletingArticle.title}&quot;
              </span>
              ? This action cannot be undone.
            </p>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeletingArticle(null)}
                className="rounded-lg border px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleDeleteConfirm}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>Delete Permanently</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: NewsStatus }) {
  switch (status) {
    case "published":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800">
          <CheckCircle className="h-3 w-3" />
          Published
        </span>
      );
    case "scheduled":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-800">
          <Clock className="h-3 w-3" />
          Scheduled
        </span>
      );
    case "archived":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700">
          <Archive className="h-3 w-3" />
          Archived
        </span>
      );
    case "draft":
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-semibold text-yellow-800">
          <FileText className="h-3 w-3" />
          Draft
        </span>
      );
  }
}
