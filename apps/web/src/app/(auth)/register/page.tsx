import type { Metadata } from "next";

import { AuthForm } from "@/components/auth/auth-form";
import { getEnabledSocialProviders } from "@/server/auth/social-providers";

export const metadata: Metadata = {
  title: "创建账户 · AI Chat",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  return (
    <AuthForm
      mode="register"
      socialProviders={getEnabledSocialProviders()}
      socialError={Boolean((await searchParams).error)}
    />
  );
}
