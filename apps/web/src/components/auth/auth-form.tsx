"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/client";
import { navigateAfterAuthentication } from "@/lib/auth/navigation";

import styles from "./auth-form.module.css";
import { SocialProviderIcon } from "./social-provider-icon";

const emailSchema = z.email("请输入有效的邮箱地址");
const passwordSchema = z
  .string()
  .min(8, "密码至少需要 8 个字符")
  .max(128, "密码不能超过 128 个字符");

const authFormSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("login"),
    name: z.string(),
    email: emailSchema,
    password: passwordSchema,
  }),
  z.object({
    mode: z.literal("register"),
    name: z.string().trim().min(1, "请输入你的称呼").max(50, "称呼不能超过 50 个字符"),
    email: emailSchema,
    password: passwordSchema,
  }),
]);

type AuthFormValues = z.input<typeof authFormSchema>;
type AuthMode = AuthFormValues["mode"];

const authErrorMessages: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确",
  USER_ALREADY_EXISTS: "该邮箱已经注册",
  USER_NOT_FOUND: "邮箱或密码不正确",
};

function getAuthErrorMessage(error: { code?: string }) {
  if (error.code && authErrorMessages[error.code]) {
    return authErrorMessages[error.code];
  }

  return "认证请求失败，请稍后重试";
}

export function AuthForm({
  mode,
  socialProviders,
  socialError = false,
}: Readonly<{
  mode: AuthMode;
  socialProviders: readonly ("google" | "github")[];
  socialError?: boolean;
}>) {
  const isRegister = mode === "register";
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState(socialError);
  const form = useForm<AuthFormValues>({
    resolver: zodResolver(authFormSchema),
    defaultValues: {
      mode,
      name: "",
      email: "",
      password: "",
    },
  });

  async function onSubmit(values: AuthFormValues) {
    form.clearErrors("root");
    setCallbackError(false);

    try {
      const result =
        values.mode === "register"
          ? await authClient.signUp.email({
            name: values.name,
            email: values.email,
            password: values.password,
          })
          : await authClient.signIn.email({
            email: values.email,
            password: values.password,
          });

      if (result.error) {
        form.setError("root", { message: getAuthErrorMessage(result.error) });
        return;
      }

      navigateAfterAuthentication("/chat");
    } catch {
      form.setError("root", { message: "暂时无法连接认证服务，请稍后重试" });
    }
  }

  async function signInWithProvider(provider: "google" | "github") {
    if (!socialProviders.includes(provider)) return;
    form.clearErrors("root");
    setCallbackError(false);
    setPendingProvider(provider);
    try {
      const result = await authClient.signIn.social({
        provider,
        // 第三方回调后也走账户切换通知，避免其他标签页保留旧账户数据。
        callbackURL: "/auth/complete",
        errorCallbackURL: isRegister ? "/register" : "/login",
      });
      if (result.error) {
        form.setError("root", { message: "暂时无法使用第三方登录，请重试或使用邮箱" });
      }
    } catch {
      form.setError("root", { message: "暂时无法连接认证服务，请稍后重试" });
    } finally {
      setPendingProvider(null);
    }
  }

  const rootError = form.formState.errors.root?.message ??
    (callbackError ? "第三方登录未完成，请重试或使用邮箱" : undefined);
  const nameError = form.formState.errors.name?.message;
  const emailError = form.formState.errors.email?.message;
  const passwordError = form.formState.errors.password?.message;
  const actionLabel = isRegister ? "创建账户" : "登录";
  const submitLabel = form.formState.isSubmitting ? `正在${actionLabel}…` : actionLabel;
  const busy = form.formState.isSubmitting || pendingProvider !== null;

  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <p className={styles.eyebrow}>一个想法，无限可能</p>
        <h1>
          {isRegister ? "创建账户" : "欢迎回来"}
        </h1>
        <p className={styles.description}>
          {isRegister
            ? "让灵感有个落脚的地方。"
            : "接着聊聊，那个还没说完的想法。"}
        </p>
      </div>

      <div className={styles.socials}>
        {(["google", "github"] as const).map((provider) => {
          const label = provider === "google" ? "Google" : "GitHub";
          const enabled = socialProviders.includes(provider);
          return (
            <Button
              key={provider}
              variant="outline"
              className={styles.socialButton}
              type="button"
              disabled={busy || !enabled}
              aria-label={enabled ? `使用 ${label} 登录` : `${label} 登录暂未启用`}
              title={enabled ? `使用 ${label} 登录` : "暂未启用，请先使用邮箱登录"}
              onClick={() => void signInWithProvider(provider)}
            >
              {pendingProvider === provider
                ? <LoaderCircle size={18} className={styles.spinner} aria-hidden="true" />
                : <SocialProviderIcon provider={provider} />}
              {label}
            </Button>
          );
        })}
      </div>
      <div className={styles.divider}><span>或使用邮箱</span></div>

      <form className={styles.form} noValidate onSubmit={form.handleSubmit(onSubmit)}>
        <fieldset disabled={busy} className={styles.fields}>
          {isRegister ? (
            <div className={styles.field}>
              <Label htmlFor="name">称呼</Label>
              <Input
                id="name"
                className={styles.input}
                autoComplete="name"
                aria-describedby={nameError ? "name-error" : undefined}
                aria-invalid={Boolean(nameError)}
                placeholder="你的称呼"
                {...form.register("name")}
              />
              {nameError ? (
                <p id="name-error" className="text-sm text-red-600">
                  {nameError}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className={styles.field}>
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              className={styles.input}
              type="email"
              autoCapitalize="none"
              autoComplete="email"
              spellCheck={false}
              aria-describedby={emailError ? "email-error" : undefined}
              aria-invalid={Boolean(emailError)}
              placeholder="name@example.com"
              {...form.register("email")}
            />
            {emailError ? (
              <p id="email-error" className="text-sm text-red-600">
                {emailError}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              className={styles.input}
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              aria-describedby={passwordError ? "password-error" : undefined}
              aria-invalid={Boolean(passwordError)}
              placeholder="至少 8 个字符"
              {...form.register("password")}
            />
            {passwordError ? (
              <p id="password-error" className="text-sm text-red-600">
                {passwordError}
              </p>
            ) : null}
          </div>
        </fieldset>

        {rootError ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {rootError}
          </p>
        ) : null}

        <Button className={styles.submit} disabled={busy} type="submit">
          {submitLabel}
          {form.formState.isSubmitting
            ? <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" />
            : <ArrowRight size={17} aria-hidden="true" />}
        </Button>
      </form>

      <p className={styles.switchMode}>
        {isRegister ? "已经有账户？" : "还没有账户？"}{" "}
        <Link
          className={styles.switchLink}
          href={isRegister ? "/login" : "/register"}
        >
          {isRegister ? "直接登录" : "创建账户"}
        </Link>
      </p>
    </div>
  );
}
