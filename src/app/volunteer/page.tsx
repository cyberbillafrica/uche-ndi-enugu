"use client";

import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { UserPlus, ArrowRight, CheckCircle2, ExternalLink } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import Link from "next/link";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

import { signUpVolunteer } from "@/lib/firebase/auth";
import { getAllLGAs } from "@/lib/constants";
import type { LGA } from "@/types";

const volunteerSchema = z
  .object({
    // ─────────────────────────────────────────────
    // Personal information
    // ─────────────────────────────────────────────

    full_name: z.string().min(3, "Full name is required"),

    phone: z.string().min(11, "Valid phone number is required"),

    email: z.string().email("Valid email is required"),

    password: z.string().min(6, "Password must be at least 6 characters"),

    gender: z.enum(["male", "female"], {
      message: "Gender is required",
    }),

    // ─────────────────────────────────────────────
    // Membership
    // ─────────────────────────────────────────────

    membership_types: z
      .array(z.enum(["campaign_member", "social_member"]))
      .min(1, "Select at least one membership type"),

    // ─────────────────────────────────────────────
    // Electoral location
    // ─────────────────────────────────────────────

    lga_id: z.string().min(1, "LGA is required"),

    ward_id: z.string().min(1, "Ward is required"),

    polling_unit_id: z.string().min(1, "Polling unit is required"),

    // ─────────────────────────────────────────────
    // Facebook
    // ─────────────────────────────────────────────

    facebook_name: z.string().optional(),

    facebook_profile_url: z.string().optional(),

    // ─────────────────────────────────────────────
    // X
    // ─────────────────────────────────────────────

    x_name: z.string().optional(),

    x_profile_url: z.string().optional(),

    // ─────────────────────────────────────────────
    // Instagram
    // ─────────────────────────────────────────────

    instagram_name: z.string().optional(),

    instagram_profile_url: z.string().optional(),

    // ─────────────────────────────────────────────
    // TikTok
    // ─────────────────────────────────────────────

    tiktok_name: z.string().optional(),

    tiktok_profile_url: z.string().optional(),
  })

  .superRefine((data, ctx) => {
    const isSocialMember = data.membership_types.includes("social_member");

    if (!isSocialMember) {
      return;
    }

    // Facebook display name
    if (!data.facebook_name?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["facebook_name"],
        message: "Facebook name is required for Social Members",
      });
    }

    // Facebook profile
    if (!data.facebook_profile_url?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["facebook_profile_url"],
        message: "Facebook profile link is required for Social Members",
      });
    } else if (!isValidUrl(data.facebook_profile_url)) {
      ctx.addIssue({
        code: "custom",
        path: ["facebook_profile_url"],
        message: "Enter a valid Facebook profile URL",
      });
    }

    // X display name
    if (!data.x_name?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["x_name"],
        message: "X display name is required for Social Members",
      });
    }

    // X profile
    if (!data.x_profile_url?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["x_profile_url"],
        message: "X profile link is required for Social Members",
      });
    } else if (!isValidUrl(data.x_profile_url)) {
      ctx.addIssue({
        code: "custom",
        path: ["x_profile_url"],
        message: "Enter a valid X profile URL",
      });
    }

    // Optional platforms:
    // If a name is supplied, require its profile URL.
    if (data.instagram_name?.trim() && !data.instagram_profile_url?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["instagram_profile_url"],
        message: "Instagram profile link is required when a name is provided",
      });
    }

    if (data.tiktok_name?.trim() && !data.tiktok_profile_url?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["tiktok_profile_url"],
        message: "TikTok profile link is required when a name is provided",
      });
    }

    if (
      data.instagram_profile_url?.trim() &&
      !isValidUrl(data.instagram_profile_url)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["instagram_profile_url"],
        message: "Enter a valid Instagram profile URL",
      });
    }

    if (
      data.tiktok_profile_url?.trim() &&
      !isValidUrl(data.tiktok_profile_url)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tiktok_profile_url"],
        message: "Enter a valid TikTok profile URL",
      });
    }
  });

type VolunteerFormData = z.infer<typeof volunteerSchema>;

function isValidUrl(value?: string) {
  if (!value?.trim()) return false;

  try {
    const url = new URL(value.trim());

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export default function VolunteerPage() {
  const [submitted, setSubmitted] = useState(false);
  const [lgas, setLgas] = useState<LGA[]>([]);
  const toast = useToast();

  useEffect(() => {
    async function loadLgas() {
      const data = await getAllLGAs();
      setLgas(data);
    }
    loadLgas();
  }, []);

  const {
    register,
    control,
    handleSubmit,
    resetField,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm<VolunteerFormData>({
    resolver: zodResolver(volunteerSchema),

    defaultValues: {
      membership_types: [],
      gender: undefined,
      lga_id: "",
      ward_id: "",
      polling_unit_id: "",

      facebook_name: "",
      facebook_profile_url: "",

      x_name: "",
      x_profile_url: "",

      instagram_name: "",
      instagram_profile_url: "",

      tiktok_name: "",
      tiktok_profile_url: "",
    },
  });

  // ─────────────────────────────────────────────
  // Watch membership + lga + ward
  // ─────────────────────────────────────────────

  const selectedMemberships =
    useWatch({
      control,
      name: "membership_types",
    }) ?? [];

  const selectedLgaId = useWatch({
    control,
    name: "lga_id",
  });

  const selectedWardId = useWatch({
    control,
    name: "ward_id",
  });

  const isSocialMember = selectedMemberships.includes("social_member");

  // Clear social media errors when "Social Member" is unchecked
  useEffect(() => {
    if (!isSocialMember) {
      clearErrors([
        "facebook_name",
        "facebook_profile_url",
        "x_name",
        "x_profile_url",
        "instagram_name",
        "instagram_profile_url",
        "tiktok_name",
        "tiktok_profile_url",
      ]);
    }
  }, [isSocialMember, clearErrors]);

  // ─────────────────────────────────────────────
  // Selected LGA & Ward
  // ─────────────────────────────────────────────

  const selectedLga = lgas.find((lga) => lga.id === selectedLgaId);
  const wards = selectedLga?.wards ?? [];

  const selectedWard = wards.find((ward) => ward.id === selectedWardId);
  const pollingUnits = selectedWard?.pollingUnits ?? [];

  // ─────────────────────────────────────────────
  // Reset ward & polling unit when LGA changes
  // ─────────────────────────────────────────────

  useEffect(() => {
    resetField("ward_id", { defaultValue: "" });
    resetField("polling_unit_id", { defaultValue: "" });
  }, [selectedLgaId, resetField]);

  // ─────────────────────────────────────────────
  // Reset polling unit when ward changes
  // ─────────────────────────────────────────────

  useEffect(() => {
    resetField("polling_unit_id", { defaultValue: "" });
  }, [selectedWardId, resetField]);

  // ─────────────────────────────────────────────
  // Submit
  // ─────────────────────────────────────────────

  const onSubmit = async (data: VolunteerFormData) => {
    const { email, password, ...userData } = data;

    const { user, error: signUpError } = await signUpVolunteer(
      email,
      password,
      userData,
    );

    if (signUpError) {
      toast.error(signUpError);
      return;
    }

    if (user) {
      setSubmitted(true);
    }
  };

  // ─────────────────────────────────────────────
  // Success
  // ─────────────────────────────────────────────

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />

        <main className="mx-auto max-w-2xl px-4 py-20">
          <div className="rounded-2xl bg-white p-10 text-center shadow-lg">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <CheckCircle2 className="h-9 w-9 text-apc-green" />
            </div>

            <h1 className="mb-4 text-3xl font-bold text-apc-primary">
              Registration Successful!
            </h1>

            <p className="mb-8 text-gray-600">
              Thank you for joining the campaign. Your account has been created
              successfully.
            </p>

            <a
              href="/login"
              className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-apc-dark"
            >
              Login Now
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </main>

        <Footer />
      </div>
    );
  }

  // ─────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />

      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Header */}

        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-apc-light">
            <UserPlus className="h-7 w-7 text-apc-primary" />
          </div>

          <h1 className="mb-4 text-4xl font-bold text-apc-primary">
            Become a Member
          </h1>

          <p className="mx-auto max-w-2xl text-lg text-gray-600">
            Join the campaign community and take part in building a better Enugu
            State.
          </p>

          <div className="mt-6 flex items-center justify-center gap-2 text-sm text-gray-600">
            <span>Already a member?</span>

            <Link
              href="/login"
              className="font-semibold text-green-600 hover:text-green-700 hover:underline"
            >
              Login
            </Link>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-lg sm:p-8">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
            {/* ─────────────────────────────────────
                MEMBERSHIP
            ───────────────────────────────────── */}

            <section>
              <div className="mb-5">
                <h2 className="text-xl font-semibold text-apc-primary">
                  Select Your Membership Type
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  If you are a member of both Campaign Council and Social Media
                  Group, select both.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="cursor-pointer">
                  <input
                    type="checkbox"
                    value="campaign_member"
                    {...register("membership_types")}
                    className="peer sr-only"
                  />

                  <div className="rounded-xl border-2 border-gray-200 p-5 transition-all peer-checked:border-apc-primary peer-checked:bg-apc-light">
                    <h3 className="font-semibold text-gray-900">
                      Campaign Council Member
                    </h3>

                    <p className="mt-1 text-sm text-gray-600">
                      Participate in campaign council and organizational
                      activities.
                    </p>
                  </div>
                </label>

                <label className="cursor-pointer">
                  <input
                    type="checkbox"
                    value="social_member"
                    {...register("membership_types")}
                    className="peer sr-only"
                  />

                  <div className="rounded-xl border-2 border-gray-200 p-5 transition-all peer-checked:border-apc-primary peer-checked:bg-apc-light">
                    <h3 className="font-semibold text-gray-900">
                      Social Media Member
                    </h3>

                    <p className="mt-1 text-sm text-gray-600">
                      Participate in social activities, earn points and appear
                      on the leaderboard.
                    </p>
                  </div>
                </label>
              </div>

              {errors.membership_types && (
                <FieldError>{errors.membership_types.message}</FieldError>
              )}
            </section>

            {/* ─────────────────────────────────────
                PERSONAL
            ───────────────────────────────────── */}

            <section className="border-t pt-8">
              <h2 className="mb-5 text-xl font-semibold text-apc-primary">
                Personal Information
              </h2>

              <div className="grid gap-6 md:grid-cols-2">
                <FormField
                  label="Full Name *"
                  error={errors.full_name?.message}
                >
                  <input
                    {...register("full_name")}
                    className="form-input"
                    placeholder="Enter your full name"
                  />
                </FormField>

                <FormField label="Phone Number *" error={errors.phone?.message}>
                  <input
                    {...register("phone")}
                    className="form-input"
                    placeholder="08012345678"
                  />
                </FormField>

                <FormField
                  label="Email Address *"
                  error={errors.email?.message}
                >
                  <input
                    {...register("email")}
                    type="email"
                    className="form-input"
                    placeholder="your@email.com"
                  />
                </FormField>

                <FormField label="Password *" error={errors.password?.message}>
                  <input
                    {...register("password")}
                    type="password"
                    className="form-input"
                    placeholder="Minimum 6 characters"
                  />
                </FormField>

                <FormField label="Gender *" error={errors.gender?.message}>
                  <select {...register("gender")} className="form-input">
                    <option value="">Select gender</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </FormField>
              </div>
            </section>

            {/* ─────────────────────────────────────
                ELECTORAL LOCATION
            ───────────────────────────────────── */}

            <section className="border-t pt-8">
              <h2 className="mb-2 text-xl font-semibold text-apc-primary">
                Electoral Location
              </h2>

              <p className="mb-5 text-sm text-gray-500">
                Your registered LGA, ward, and polling unit determine where you can
                participate in election operations and reporting.
              </p>

              <div className="grid gap-6 md:grid-cols-3">
                <FormField label="LGA *" error={errors.lga_id?.message}>
                  <select {...register("lga_id")} className="form-input">
                    <option value="">Select your LGA</option>
                    {lgas.map((lga) => (
                      <option key={lga.id} value={lga.id}>
                        {lga.name}
                      </option>
                    ))}
                  </select>
                </FormField>

                <FormField label="Ward *" error={errors.ward_id?.message}>
                  <select
                    {...register("ward_id")}
                    className="form-input"
                    disabled={!selectedLgaId}
                  >
                    <option value="">
                      {selectedLgaId ? "Select your ward" : "Select an LGA first"}
                    </option>
                    {wards.map((ward) => (
                      <option key={ward.id} value={ward.id}>
                        {ward.code} — {ward.name}
                      </option>
                    ))}
                  </select>
                </FormField>

                <FormField
                  label="Polling Unit *"
                  error={errors.polling_unit_id?.message}
                >
                  <select
                    {...register("polling_unit_id")}
                    className="form-input"
                    disabled={!selectedWardId}
                  >
                    <option value="">
                      {selectedWardId
                        ? "Select your polling unit"
                        : "Select a ward first"}
                    </option>

                    {pollingUnits.map((pu) => (
                      <option key={pu.id} value={pu.id}>
                        {pu.code} — {pu.name}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
            </section>

            {/* ─────────────────────────────────────
                SOCIAL MEDIA
            ───────────────────────────────────── */}

            <section className="border-t pt-8">
              <div className="mb-6">
                <h2 className="text-xl font-semibold text-apc-primary">
                  Social Media Accounts
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  {isSocialMember
                    ? "Facebook and X are required for Social Media Members. Instagram and TikTok are optional."
                    : "Social media accounts are optional for Campaign Council Members."}
                </p>
              </div>

              <div className="space-y-8">
                {/* Facebook */}

                <SocialAccountFields
                  platform="Facebook"
                  nameField="facebook_name"
                  urlField="facebook_profile_url"
                  nameLabel="Facebook Display Name"
                  namePlaceholder="e.g. Ifeanyi Barth"
                  urlPlaceholder="https://facebook.com/your-profile"
                  required={isSocialMember}
                  register={register}
                  nameError={errors.facebook_name?.message}
                  urlError={errors.facebook_profile_url?.message}
                />

                {/* X */}

                <SocialAccountFields
                  platform="X"
                  nameField="x_name"
                  urlField="x_profile_url"
                  nameLabel="X Display Name"
                  namePlaceholder="e.g. Ifeanyi Barth"
                  urlPlaceholder="https://x.com/your-profile"
                  required={isSocialMember}
                  register={register}
                  nameError={errors.x_name?.message}
                  urlError={errors.x_profile_url?.message}
                />

                {/* Instagram */}

                <SocialAccountFields
                  platform="Instagram"
                  nameField="instagram_name"
                  urlField="instagram_profile_url"
                  nameLabel="Instagram Display Name"
                  namePlaceholder="e.g. Ifeanyi Barth"
                  urlPlaceholder="https://instagram.com/your-profile"
                  required={false}
                  register={register}
                  nameError={errors.instagram_name?.message}
                  urlError={errors.instagram_profile_url?.message}
                />

                {/* TikTok */}

                <SocialAccountFields
                  platform="TikTok"
                  nameField="tiktok_name"
                  urlField="tiktok_profile_url"
                  nameLabel="TikTok Display Name"
                  namePlaceholder="e.g. Ifeanyi Barth"
                  urlPlaceholder="https://tiktok.com/@your-profile"
                  required={false}
                  register={register}
                  nameError={errors.tiktok_name?.message}
                  urlError={errors.tiktok_profile_url?.message}
                />
              </div>
            </section>

            {/* ─────────────────────────────────────
                IMPORTANT NOTICE
            ───────────────────────────────────── */}

            <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
              <div className="flex gap-3">
                <ExternalLink className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />

                <div>
                  <h3 className="font-semibold text-blue-900">
                    Why do we need your social profile link?
                  </h3>

                  <p className="mt-1 text-sm leading-6 text-blue-800">
                    Your profile link allows campaign administrators to identify
                    your account when verifying social media activities. Please
                    provide the profile belonging to you and use the name that
                    appears publicly on that account.
                  </p>
                </div>
              </div>
            </div>

            {/* ─────────────────────────────────────
                SUBMIT
            ───────────────────────────────────── */}

            <div className="flex justify-end border-t pt-8">
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 rounded-lg bg-apc-green px-8 py-3 font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? "Creating Account..." : "Complete Registration"}

                {!isSubmitting && <ArrowRight className="h-4 w-4" />}
              </button>
            </div>
          </form>
        </div>
      </main>

      <Footer />
    </div>
  );
}

// ─────────────────────────────────────────────
// Form field
// ─────────────────────────────────────────────

function FormField({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="form-label">{label}</label>

      {children}

      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

// ─────────────────────────────────────────────
// Social account section
// ─────────────────────────────────────────────

function SocialAccountFields({
  platform,
  nameField,
  urlField,
  nameLabel,
  namePlaceholder,
  urlPlaceholder,
  required,
  register,
  nameError,
  urlError,
}: {
  platform: string;
  nameField: "facebook_name" | "x_name" | "instagram_name" | "tiktok_name";
  urlField:
    | "facebook_profile_url"
    | "x_profile_url"
    | "instagram_profile_url"
    | "tiktok_profile_url";
  nameLabel: string;
  namePlaceholder: string;
  urlPlaceholder: string;
  required: boolean;
  register: ReturnType<typeof useForm<VolunteerFormData>>["register"];
  nameError?: string;
  urlError?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
      <div className="mb-4">
        <h3 className="font-semibold text-gray-900">
          {platform}
          {required && <span className="ml-1 text-red-500">*</span>}
        </h3>

        <p className="mt-1 text-xs text-gray-500">
          Enter the public name displayed on your {platform} account and the
          direct link to your profile.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <label className="form-label">
            {nameLabel}
            {required && " *"}
          </label>

          <input
            {...register(nameField)}
            className="form-input"
            placeholder={namePlaceholder}
          />

          {nameError && <FieldError>{nameError}</FieldError>}
        </div>

        <div>
          <label className="form-label">
            Profile Link
            {required && " *"}
          </label>

          <input
            {...register(urlField)}
            type="url"
            className="form-input"
            placeholder={urlPlaceholder}
          />

          {urlError && <FieldError>{urlError}</FieldError>}
        </div>
      </div>
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-sm text-red-500">{children}</p>;
}
