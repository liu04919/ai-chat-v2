import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const PROBE_TIMEOUT_MS = 1_000;

function canConnectProxy(address) {
  let proxy;
  try {
    proxy = new URL(address);
    if (!["http:", "https:"].includes(proxy.protocol)) return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolveResult) => {
    const socket = createConnection({
      host: proxy.hostname.replace(/^\[|\]$/g, ""),
      port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
    });
    const finish = (available) => {
      clearTimeout(timer);
      socket.destroy();
      resolveResult(available);
    };
    // 只探测端口是否监听，不发送业务请求，也不检查上游网络是否可用。
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function createDevelopmentEnvironment(environment) {
  const proxies = [...new Set([
    environment.http_proxy || environment.HTTP_PROXY,
    environment.https_proxy || environment.HTTPS_PROXY,
  ].filter(Boolean))];
  const available = await Promise.all(proxies.map(canConnectProxy));
  const useProxy = proxies.length > 0 && available.every(Boolean);
  const result = { ...environment, NODE_USE_ENV_PROXY: useProxy ? "1" : "0" };

  if (!useProxy) {
    // 仅清空子进程的代理，保留系统配置；空值也防止 Next 再从 .env.local 补回。
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      result[key] = "";
    }
  }
  return result;
}

async function main() {
  const target = process.argv[2];
  if (target !== "web" && target !== "worker") {
    throw new Error("用法：node scripts/dev.mjs <web|worker>，从对应应用目录执行");
  }
  // 必须先加载配置、再启动真正的 Node 进程，代理初始化才能读到最终选择。
  if (existsSync(".env.local")) loadEnvFile(".env.local");
  const environment = await createDevelopmentEnvironment(process.env);
  const useProxy = environment.NODE_USE_ENV_PROXY === "1";
  console.info(`[开发代理:${target}] ${useProxy ? "端口可连接，启用环境代理" : "未配置代理或端口不可连接，本次启动使用直连"}`);

  const require = createRequire(resolve("package.json"));
  const command = target === "web"
    ? [require.resolve("next/dist/bin/next"), "dev"]
    : [require.resolve("tsx/cli"), "watch", "src/index.ts"];
  const child = spawn(process.execPath, [
    useProxy ? "--use-env-proxy" : "--no-use-env-proxy",
    ...command,
    ...process.argv.slice(3),
  ], { env: environment, stdio: "inherit", windowsHide: true });

  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.once("error", () => {
    console.error("开发进程启动失败，请检查 Node 和项目依赖");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
  });
}

if (import.meta.main) {
  await main();
}
