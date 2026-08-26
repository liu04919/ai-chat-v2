import type { Metadata } from "next";

import { AuthForm } from "@/components/auth/auth-form";

export const metadata: Metadata = {
  title: "创建账户 · AI Chat V2",
};

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
