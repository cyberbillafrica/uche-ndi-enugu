"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { useToast } from "@/components/ui/toast";

import { getSupabaseClient, signIn } from "@/lib/supabase";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setLoading(true);

    const { error: signInError } = await signIn(email, password, getSupabaseClient());

    if (signInError) {
      toast.error(getLoginErrorMessage(signInError));
      setLoading(false);
      return;
    }

    router.push("/portal/dashboard");
  };

  return (
    <div className="min-h-screen bg-brand-surface flex flex-col">
      <Header />

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="bg-white rounded-2xl shadow-lg p-8">
            {/* Header */}
            <div className="text-center mb-8">
              <div className="mx-auto mb-4 w-14 h-14 rounded-full bg-brand-primary flex items-center justify-center">
                <LogIn className="w-7 h-7 text-white" />
              </div>

              <h1 className="text-3xl font-bold text-brand-primary">
                Sign In
              </h1>

              <p className="mt-2 text-gray-600">
                Access your member portal
              </p>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Email */}
              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Email Address
                </label>

                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300
                             focus:outline-none focus:ring-2
                             focus:ring-brand-primary focus:border-transparent"
                  required
                />
              </div>

              {/* Password */}
              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Password
                </label>

                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    className="w-full px-4 py-3 pr-12 rounded-lg border border-gray-300
                               focus:outline-none focus:ring-2
                               focus:ring-brand-primary focus:border-transparent"
                    required
                  />

                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    title={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2
                               text-gray-500 hover:text-brand-primary
                               focus:outline-none focus:ring-2
                               focus:ring-brand-primary rounded-md p-1
                               transition-colors"
                  >
                    {showPassword ? (
                      <EyeOff className="w-5 h-5" />
                    ) : (
                      <Eye className="w-5 h-5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-brand-primary text-white py-3 rounded-lg
                           font-semibold hover:bg-brand-primary transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            {/* Registration */}
            <div className="mt-6 text-center text-sm text-gray-600">
              Don't have an account?{" "}
              <Link
                href="/volunteer"
                className="font-semibold text-brand-primary hover:underline"
              >
                Register as a volunteer
              </Link>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

/**
 * Convert Supabase Auth's technical authentication errors
 * into messages that make sense to normal users.
 */
function getLoginErrorMessage(error: string): string {
  if (error.includes("Invalid login credentials")) {
    return "Incorrect email or password.";
  }

  if (error.includes("Email not confirmed")) {
    return "Please confirm your email address before signing in.";
  }

  if (error.includes("invalid")) {
    return "Please enter a valid email address.";
  }

  if (error.includes("Too many requests") || error.includes("rate limit")) {
    return "Too many unsuccessful attempts. Please try again later.";
  }

  if (error.includes("auth/network-request-failed")) {
    return "Network error. Please check your internet connection and try again.";
  }

  return "Unable to sign in. Please try again.";
}