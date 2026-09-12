// src/components/ShareButtons.tsx

"use client";

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";

export default function ShareButtons() {
  const [url, setUrl] = useState("");

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setUrl(window.location.href);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!url) {
    return (
      <div className="mt-12 border-t border-gray-200 pt-8">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div>
            <h3 className="font-semibold text-gray-900">Share the Manifesto</h3>
            <p className="text-sm text-gray-500">Help spread the vision</p>
          </div>
          <div className="flex gap-3">
            <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-200" />
            <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-200" />
            <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-200" />
          </div>
        </div>
      </div>
    );
  }

  const text = "Read the manifesto and vision for our community:";

  return (
    <div className="mt-12 border-t border-gray-200 pt-8">
      <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
        <div>
          <h3 className="font-semibold text-gray-900">Share the Manifesto</h3>
          <p className="text-sm text-gray-500">Help spread the vision</p>
        </div>

        <div className="flex gap-3">
          {/* WhatsApp */}
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#1ebe5d] hover:-translate-y-0.5"
            aria-label="Share on WhatsApp"
          >
            <MessageCircle className="h-4 w-4" />
            WhatsApp
          </a>

          {/* Facebook */}
          <a
            href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
              url,
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-[#1877F2] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#166fe5] hover:-translate-y-0.5"
            aria-label="Share on Facebook"
          >
            Facebook
          </a>

          {/* X */}
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
              text,
            )}&url=${encodeURIComponent(url)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-gray-800 hover:-translate-y-0.5"
            aria-label="Share on X"
          >
            <span className="text-base font-bold leading-none">𝕏</span>X
          </a>
        </div>
      </div>
    </div>
  );
}
