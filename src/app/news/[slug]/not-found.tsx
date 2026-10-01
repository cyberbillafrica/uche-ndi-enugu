import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="rounded-2xl bg-white p-12 text-center shadow-sm border max-w-lg w-full">
          <h1 className="text-3xl font-bold text-gray-900">
            Article Not Found
          </h1>

          <p className="mt-3 text-gray-600">
            The article you are looking for does not exist or is no longer
            published.
          </p>

          <Link
            href="/news"
            className="mt-6 inline-flex items-center rounded-lg bg-brand-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary"
          >
            Return to News Updates
          </Link>
        </div>
      </main>
    </div>
  );
}
