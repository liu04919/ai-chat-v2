import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createDevelopmentEnvironment } from "./dev.mjs";

const servers: Server[] = [];
const execute = promisify(execFile);

async function listen(server = createServer((socket) => socket.end())) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试端口未绑定");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await close(server);
  }
});

describe("开发启动代理选择", () => {
  it("未配置代理时直连，保留其他环境且不修改原对象", async () => {
    const original = { NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost", APP_SETTING: "value" };
    const result = await createDevelopmentEnvironment(original);
    expect(result).toMatchObject({ NODE_USE_ENV_PROXY: "0", NO_PROXY: "localhost", APP_SETTING: "value", HTTP_PROXY: "", HTTPS_PROXY: "" });
    expect(original).toEqual({ NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost", APP_SETTING: "value" });
  });

  it("代理端口可连接时启用，保留地址与 NO_PROXY", async () => {
    const proxy = await listen();
    const result = await createDevelopmentEnvironment({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: "localhost,127.0.0.1" });
    expect(result).toMatchObject({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: "localhost,127.0.0.1" });
  });

  it("关闭代理端口后直连，并清空子进程的大小写代理变量", async () => {
    const server = createServer();
    const proxy = await listen(server);
    await close(server);
    const result = await createDevelopmentEnvironment({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy, NODE_USE_ENV_PROXY: "1" });
    expect(result.NODE_USE_ENV_PROXY).toBe("0");
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) expect(result[key]).toBe("");
  });

  it("HTTP / HTTPS 代理只要有一个不可连接，本次开发进程就直连", async () => {
    const live = await listen();
    const server = createServer();
    const closed = await listen(server);
    await close(server);
    const result = await createDevelopmentEnvironment({ HTTP_PROXY: live, HTTPS_PROXY: closed });
    expect(result.NODE_USE_ENV_PROXY).toBe("0");
    expect(result.HTTP_PROXY).toBe("");
  });

  it("与 Node 一致，优先使用非空的小写代理变量", async () => {
    const proxy = await listen();
    const result = await createDevelopmentEnvironment({ http_proxy: proxy, HTTP_PROXY: "invalid", https_proxy: proxy, HTTPS_PROXY: "invalid" });
    expect(result.NODE_USE_ENV_PROXY).toBe("1");
  });

  it.each(["invalid", "socks5://127.0.0.1:7890", "http://127.0.0.1:99999"])("无效或不支持的地址 %s 不阻止开发服务启动", async (address) => {
    expect((await createDevelopmentEnvironment({ HTTPS_PROXY: address })).NODE_USE_ENV_PROXY).toBe("0");
  });

  it("真实 Node 请求：代理开启时经过代理，端口关闭后新进程可直连", async () => {
    const origin = await listen(createHttpServer((_request, response) => response.end("origin-ok")));
    const originUrl = new URL(origin);
    let proxyRequests = 0;
    const proxyServer = createHttpServer();
    proxyServer.on("connect", (_request, socket, head) => {
      proxyRequests++;
      // 测试代理只允许转发到测试自身的本机 HTTP 服务。
      const upstream = connect(Number(originUrl.port), "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    const proxy = await listen(proxyServer);
    const environment = { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: "", no_proxy: "" };
    const fetchOnce = async () => {
      const env = await createDevelopmentEnvironment(environment);
      const result = await execute(process.execPath, [
        env.NODE_USE_ENV_PROXY === "1" ? "--use-env-proxy" : "--no-use-env-proxy",
        "-e", `fetch(${JSON.stringify(origin)}, { signal: AbortSignal.timeout(2000) }).then(r => r.text()).then(text => { console.log(text); process.exit(0); }).catch(() => process.exit(1));`,
      ], { env, windowsHide: true, timeout: 4000 });
      expect(result.stdout.trim()).toBe("origin-ok");
      return env.NODE_USE_ENV_PROXY;
    };

    expect(await fetchOnce()).toBe("1");
    expect(proxyRequests).toBe(1);
    await close(proxyServer);
    expect(await fetchOnce()).toBe("0");
    expect(proxyRequests).toBe(1);
  });
});
