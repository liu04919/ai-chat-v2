"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

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

export function AuthForm({ mode }: Readonly<{ mode: AuthMode }>) {
  const router = useRouter();
  const isRegister = mode === "register";
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

      router.replace("/chat");
      router.refresh();
    } catch {
      form.setError("root", { message: "暂时无法连接认证服务，请稍后重试" });
    }
  }

  const rootError = form.formState.errors.root?.message;
  const nameError = form.formState.errors.name?.message;
  const emailError = form.formState.errors.email?.message;
  const passwordError = form.formState.errors.password?.message;
  const actionLabel = isRegister ? "创建账户" : "登录";
  const submitLabel = form.formState.isSubmitting ? `正在${actionLabel}…` : actionLabel;

  return (
    <Card className="w-full max-w-[calc(100vw-3rem)] sm:max-w-md">
      <CardHeader>
        <p className="text-sm font-medium text-muted-foreground">AI Chat V2</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isRegister ? "创建账户" : "欢迎回来"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isRegister
            ? "使用邮箱创建账户，开始建立属于你的对话空间。"
            : "登录后继续访问你的对话工作区。"}
        </p>
      </CardHeader>

      <CardContent>
        <form className="space-y-5" noValidate onSubmit={form.handleSubmit(onSubmit)}>
          {isRegister ? (
            <div className="space-y-2">
              <Label htmlFor="name">称呼</Label>
              <Input
                id="name"
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

          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
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

          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
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

          {rootError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {rootError}
            </p>
          ) : null}

          <Button className="w-full" disabled={form.formState.isSubmitting} type="submit">
            {submitLabel}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {isRegister ? "已经有账户？" : "还没有账户？"}{" "}
          <Link
            className="font-medium text-foreground underline-offset-4 hover:underline"
            href={isRegister ? "/login" : "/register"}
          >
            {isRegister ? "直接登录" : "创建账户"}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
