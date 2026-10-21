import type { Metadata } from "next";

import { AuthForm } from "@/components/auth/auth-form";
import { getEnabledSocialProviders } from "@/server/auth/social-providers";

export const metadata: Metadata = {
  title: "登录 · AI Chat",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  return (
    <AuthForm
      mode="login"
      socialProviders={getEnabledSocialProviders()}
      socialError={Boolean((await searchParams).error)}
    />
  );
}
