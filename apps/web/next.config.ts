import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: false,
  // 容器只携带运行产物；工作区依赖在 apps/web 之外，需要一并追踪。
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // 独立评测实例不能与正在运行的开发网站共用构建缓存。
  ...(process.env.RAG_EVAL_INSTANCE === "1" ? { distDir: ".next-rag-eval" } : {}),
  transpilePackages: ["@ai-chat/contracts"],
};

export default nextConfig;
