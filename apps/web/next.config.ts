import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: false,
  transpilePackages: ["@ai-chat/contracts"],
};

export default nextConfig;
