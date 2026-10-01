import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import Link from "next/link";
import {
  BookOpen,
  FileText,
  PlusCircle,
  Globe,
  Tag,
  Image as ImageIcon,
  CheckCircle,
  AlertCircle,
  Edit2,
  FolderTree,
} from "lucide-react";

export const metadata = {
  title: "User Manual & Documentation | Ifeanyichukwu 2027",
  description: "Comprehensive user manual for campaign administrators and technical documentation for the Ifeanyi 2027 News System.",
};

export default function DocumentationPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-12 sm:px-6 lg:px-8">
        {/* Title */}
        <div className="mb-10 text-center sm:text-left border-b pb-8">
          <div className="inline-flex items-center gap-2 rounded-full bg-brand-primary/10 px-4 py-1.5 text-xs font-semibold text-brand-primary mb-3">
            <BookOpen className="h-4 w-4" />
            Campaign Portal Documentation & User Manual
          </div>
          <h1 className="text-3xl font-extrabold text-gray-900 sm:text-4xl">
            News CMS & System Documentation
          </h1>
          <p className="mt-2 text-gray-600 text-lg">
            Complete guide for site administrators on managing campaign news, uploading images via Cloudinary, and understanding technical platform architecture.
          </p>
        </div>

        <div className="space-y-12">
          {/* SECTION 1: NON-TECHNICAL USER MANUAL FOR SITE ADMINISTRATORS */}
          <section className="bg-white rounded-2xl p-6 sm:p-10 shadow-sm border border-gray-100">
            <div className="flex items-center gap-3 text-brand-primary mb-6">
              <FileText className="h-7 w-7 shrink-0" />
              <h2 className="text-2xl font-bold text-gray-900">
                User Manual: Campaign News Management
              </h2>
            </div>

            <div className="space-y-8 text-gray-700 text-sm leading-relaxed">
              {/* 1. What system does */}
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-2">1. What the News System Does</h3>
                <p>
                  The News system allows authorized campaign administrators to compose, preview, schedule, and publish official news updates, press releases, rally announcements, and candidate statements. Published articles automatically sync to the public <Link href="/news" className="text-brand-primary font-semibold hover:underline">News Page</Link>, the candidate <Link href="/" className="text-brand-primary font-semibold hover:underline">Homepage</Link>, and dedicated shareable article URLs.
                </p>
              </div>

              {/* 2. Accessing admin area */}
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-2">2. How to Access the News Admin CMS</h3>
                <ol className="list-decimal pl-5 space-y-1.5">
                  <li>Log in to your administrator account at <Link href="/login" className="text-brand-primary font-semibold hover:underline">/login</Link>.</li>
                  <li>From the portal dashboard sidebar, open <strong>Administration</strong> &rarr; <strong>News</strong> (or navigate directly to <Link href="/portal/admin/news" className="text-brand-primary font-semibold hover:underline">/portal/admin/news</Link>).</li>
                  <li>You will see the News management console with tabs for <em>All, Drafts, Published, Scheduled, and Archived</em> articles.</li>
                </ol>
              </div>

              {/* 3. Creating an article & field guide */}
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-2">3. How to Create an Article & Field Guide</h3>
                <p className="mb-3">Click the green <strong>"New Article"</strong> button to open the article editor:</p>
                <div className="grid gap-4 sm:grid-cols-2 bg-gray-50 p-5 rounded-xl border">
                  <div>
                    <h4 className="font-semibold text-gray-900 flex items-center gap-1.5">
                      <PlusCircle className="h-4 w-4 text-brand-primary" /> Article Title & Slug
                    </h4>
                    <p className="text-xs text-gray-600 mt-1">
                      Enter the headline. The system auto-generates a clean URL slug (e.g. <code>/news/candidate-visits-agbani</code>). You can also customize the slug manually.
                    </p>
                  </div>

                  <div>
                    <h4 className="font-semibold text-gray-900 flex items-center gap-1.5">
                      <Tag className="h-4 w-4 text-brand-primary" /> Category & Author
                    </h4>
                    <p className="text-xs text-gray-600 mt-1">
                      Specify a category (e.g., <em>Rally, Press Release, Statement, Community Visit</em>) and author byline.
                    </p>
                  </div>

                  <div>
                    <h4 className="font-semibold text-gray-900 flex items-center gap-1.5">
                      <FileText className="h-4 w-4 text-brand-primary" /> Excerpt & Full Content
                    </h4>
                    <p className="text-xs text-gray-600 mt-1">
                      Write a 2-sentence summary for card previews, followed by the complete article body in the main text area.
                    </p>
                  </div>

                  <div>
                    <h4 className="font-semibold text-gray-900 flex items-center gap-1.5">
                      <ImageIcon className="h-4 w-4 text-brand-primary" /> Featured Image
                    </h4>
                    <p className="text-xs text-gray-600 mt-1">
                      Upload an image file (JPG, PNG, WebP up to 5MB) via Cloudinary or paste a direct external image URL.
                    </p>
                  </div>
                </div>
              </div>

              {/* 4. Image Upload & Cloudinary */}
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-2">4. Image Uploads & Cloudinary Integration</h3>
                <p className="mb-2">
                  When you select an image file and click <strong>Upload</strong>, the file is automatically uploaded to the campaign Cloudinary storage under the folder path:
                </p>
                <code className="block bg-gray-100 p-2 rounded text-xs text-brand-primary font-mono mb-2">
                  ifeanyi-2027/news/
                </code>
                <p>
                  An immediate image preview appears in the editor. Alternatively, you can paste any public HTTPS image URL into the URL field. Both methods populate the same <code>featured_image</code> field in Firestore.
                </p>
              </div>

              {/* 5. Status Semantics & Publishing */}
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-2">5. Publishing Statuses</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="bg-yellow-50 p-3 rounded-lg border border-yellow-200">
                    <span className="font-bold text-xs text-yellow-800 uppercase tracking-wide">Draft</span>
                    <p className="text-xs text-yellow-900 mt-1">Saved privately in the admin console. Not visible on the public website.</p>
                  </div>
                  <div className="bg-green-50 p-3 rounded-lg border border-green-200">
                    <span className="font-bold text-xs text-green-800 uppercase tracking-wide">Published</span>
                    <p className="text-xs text-green-900 mt-1">Live immediately on `/news`, homepage, and public detail page.</p>
                  </div>
                  <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
                    <span className="font-bold text-xs text-blue-800 uppercase tracking-wide">Scheduled</span>
                    <p className="text-xs text-blue-900 mt-1">Saved with a scheduled future release date and timestamp.</p>
                  </div>
                  <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                    <span className="font-bold text-xs text-gray-700 uppercase tracking-wide">Archived</span>
                    <p className="text-xs text-gray-800 mt-1">Retained for internal records but hidden from the public website.</p>
                  </div>
                </div>
              </div>

              {/* 6. Homepage Display Rule */}
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-2">6. How the Homepage Displays Latest News</h3>
                <p>
                  The candidate homepage queries Firestore for published news and displays <strong>only the top 3 latest articles</strong> ordered newest to oldest. If there are 3 or more published articles, exactly 3 show; if fewer exist, 1 or 2 show accordingly.
                </p>
              </div>

              {/* 7. Editing & Correcting Mistakes */}
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-2">7. Editing Articles & Correcting Mistakes</h3>
                <p>
                  To edit an existing article, click the <Edit2 className="inline h-3.5 w-3.5 text-blue-600" /> icon next to any article in the News CMS table. Modify the content, status, or image, then click <strong>Save Changes</strong>. You can also quickly toggle an article between <em>Published</em> and <em>Draft</em> using the status action buttons.
                </p>
              </div>

              {/* 8. Troubleshooting */}
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-2">8. Troubleshooting: What to Check if News Doesn't Appear</h3>
                <div className="space-y-2 bg-gray-50 p-4 rounded-xl border text-xs">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-brand-primary shrink-0 mt-0.5" />
                    <p><strong>Check Publication Status:</strong> Verify the article status is set to <span className="text-green-700 font-semibold">Published</span> and not <em>Draft</em> or <em>Archived</em>.</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-brand-primary shrink-0 mt-0.5" />
                    <p><strong>Check Image URL:</strong> If a custom image URL was entered, ensure it begins with <code>https://</code> or <code>http://</code>.</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-brand-primary shrink-0 mt-0.5" />
                    <p><strong>Check Duplicate Slugs:</strong> Ensure the article URL slug is unique across all published articles.</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* SECTION 2: TECHNICAL IMPLEMENTATION OVERVIEW */}
          <section className="bg-white rounded-2xl p-6 sm:p-10 shadow-sm border border-gray-100">
            <div className="flex items-center gap-3 text-brand-primary mb-6">
              <Globe className="h-7 w-7 shrink-0" />
              <h2 className="text-2xl font-bold text-gray-900">
                Technical Architecture & Implementation Overview
              </h2>
            </div>

            <div className="space-y-6 text-sm text-gray-700 leading-relaxed">
              <p>
                The News feature uses Google Cloud Firestore for persistent storage, Cloudinary for asset hosting, and Next.js App Router for server/client rendering.
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="bg-gray-50 p-4 rounded-xl border text-xs font-mono">
                  <p className="font-bold text-gray-900 mb-2 font-sans flex items-center gap-1.5">
                    <FolderTree className="h-4 w-4 text-brand-primary" /> Cloudinary Folder Architecture:
                  </p>
                  <ul className="space-y-1 text-gray-700">
                    <li>ifeanyi-2027/news</li>
                    <li>ifeanyi-2027/gallery</li>
                    <li>ifeanyi-2027/candidate</li>
                    <li>ifeanyi-2027/election-results</li>
                  </ul>
                </div>

                <div className="bg-gray-50 p-4 rounded-xl border text-xs">
                  <p className="font-bold text-gray-900 mb-2 flex items-center gap-1.5">
                    <Globe className="h-4 w-4 text-brand-primary" /> Image Pipeline & Next.js:
                  </p>
                  <p className="text-gray-600 leading-relaxed">
                    <code>next.config.ts</code> configures <code>remotePatterns</code> to allow external hostnames. <code>&lt;Image unoptimized&gt;</code> is applied to render Cloudinary and user-specified external URLs seamlessly.
                  </p>
                </div>
              </div>

              <div className="bg-gray-50 p-4 rounded-xl border text-xs">
                <p className="font-bold text-gray-900 mb-2">Firestore Helpers & Security Policy:</p>
                <p className="text-gray-600 leading-relaxed">
                  <code>listPublishedNews()</code> in <code>src/lib/supabase/news.ts</code> reads published articles from the canonical <code>politicore.news_articles</code> table; RLS enforces <code>status == 'published'</code> for anonymous visitors and tenant-admin management server-side.
                </p>
              </div>
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
