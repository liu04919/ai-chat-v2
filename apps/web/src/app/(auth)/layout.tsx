import { Sparkles } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthBackground } from "@/components/auth/auth-background";
import { getCurrentSession } from "@/server/auth/session";

import styles from "./auth-scene.module.css";

export default async function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getCurrentSession();

  if (session) {
    redirect("/chat");
  }

  return (
    <main className={styles.scene}>
      <AuthBackground />
      <header className={styles.header}>
        <Link href="/login" className={styles.brand} aria-label="AI Chat 登录页">
          <span className={styles.brandMark}>
            <Sparkles size={19} strokeWidth={1.6} aria-hidden="true" />
          </span>
          <span>
            AI Chat
            <span className={styles.brandCaption}>留一点空间，给想象。</span>
          </span>
        </Link>
      </header>
      <section className={styles.content}>{children}</section>
      <footer className={styles.footer}>每一段好对话，都从一个想法开始。</footer>
    </main>
  );
}
