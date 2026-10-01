// src/app/news/[slug]/loading.tsx

import { Loader2 } from "lucide-react";

export default function NewsArticleLoading() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <div className="max-w-4xl w-full mx-auto px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex min-h-[400px] flex-col items-center justify-center gap-3 text-gray-500">
          <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
          <p className="text-sm font-medium">Loading article…</p>
        </div>
      </div>
    </div>
  );
}
