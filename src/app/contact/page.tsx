"use client";

import { useState } from "react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { Mail, Phone, MapPin, Send, CheckCircle2, Loader2 } from "lucide-react";
import { submitContactMessage } from "@/lib/supabase";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";

export default function ContactPage() {
  const toast = useToast();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    message: "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.name.trim()) {
      toast.warning("Please enter your name.");
      return;
    }

    if (!form.email.trim() || !form.email.includes("@")) {
      toast.warning("Please enter a valid email address.");
      return;
    }

    if (!form.message.trim()) {
      toast.warning("Please enter a message.");
      return;
    }

    setSubmitting(true);

    try {
      await submitContactMessage({
        name: form.name,
        email: form.email,
        phone: form.phone,
        message: form.message,
      });

      setSubmitted(true);
      setForm({ name: "", email: "", phone: "", message: "" });
    } catch (err: any) {
      console.error("Failed to submit contact message:", err);
      toast.error(
        getErrorMessage(err, "We couldn't send your message. Please try again later."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-between">
      <div>
        <Header />
        <main className="max-w-4xl mx-auto px-4 py-16">
          <h1 className="text-4xl font-bold text-apc-primary mb-8">Contact Us</h1>
          <div className="grid md:grid-cols-2 gap-10">
            <div className="space-y-6">
              <div className="flex items-start space-x-4">
                <MapPin className="h-6 w-6 text-apc-primary mt-1 shrink-0" />
                <div>
                  <h3 className="font-semibold text-gray-900">Campaign Office</h3>
                  <p className="text-gray-600">
                    No. 15 Independence Layout, Agbani, Nkanu West LGA, Enugu
                    State
                  </p>
                </div>
              </div>
              <div className="flex items-start space-x-4">
                <Phone className="h-6 w-6 text-apc-primary mt-1 shrink-0" />
                <div>
                  <h3 className="font-semibold text-gray-900">Phone</h3>
                  <p className="text-gray-600">+234 800 000 0000</p>
                </div>
              </div>
              <div className="flex items-start space-x-4">
                <Mail className="h-6 w-6 text-apc-primary mt-1 shrink-0" />
                <div>
                  <h3 className="font-semibold text-gray-900">Email</h3>
                  <p className="text-gray-600">contact@ifeanyi4nkanu.ng</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm p-6">
              {submitted ? (
                <div className="text-center py-8 space-y-4">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
                    <CheckCircle2 className="h-8 w-8 text-green-600" />
                  </div>
                  <h3 className="text-2xl font-bold text-gray-900">
                    Message Sent!
                  </h3>
                  <p className="text-gray-600">
                    Thank you for reaching out to the campaign team. We have received your message and will respond shortly.
                  </p>
                  <button
                    onClick={() => setSubmitted(false)}
                    className="inline-flex items-center justify-center rounded-lg bg-apc-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark transition-colors"
                  >
                    Send Another Message
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <h2 className="text-xl font-semibold text-apc-primary mb-2">
                    Send a Message
                  </h2>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Full Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
                      placeholder="Your full name"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email Address *
                    </label>
                    <input
                      type="email"
                      required
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
                      placeholder="you@example.com"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Phone Number (optional)
                    </label>
                    <input
                      type="tel"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
                      placeholder="08012345678"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Message *
                    </label>
                    <textarea
                      rows={4}
                      required
                      value={form.message}
                      onChange={(e) => setForm({ ...form, message: e.target.value })}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
                      placeholder="How can we help you or how would you like to get involved?"
                    ></textarea>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex items-center justify-center space-x-2 bg-apc-primary text-white px-6 py-3 rounded-lg font-semibold hover:bg-apc-dark transition-colors w-full disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Sending...</span>
                      </>
                    ) : (
                      <>
                        <Send className="h-4 w-4" />
                        <span>Send Message</span>
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>
          </div>
        </main>
      </div>
      <Footer />
    </div>
  );
}
