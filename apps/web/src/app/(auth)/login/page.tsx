import type { Metadata } from "next";

import { AuthForm } from "@/components/auth/auth-form";

export const metadata: Metadata = {
  title: "登录 · AI Chat V2",
};

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
