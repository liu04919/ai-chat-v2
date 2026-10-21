import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  closeApplicationDatabase,
  createDatabase,
  migrateDatabase,
} from "@ai-chat/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const localEnvironment = fileURLToPath(
  new URL("../../../.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error("缺少 TEST_DATABASE_URL");
}

process.env.DATABASE_URL = testDatabaseUrl;

const email = `auth-test-${randomUUID()}@example.com`;
const oauthEmail = `oauth-test-${randomUUID()}@example.com`;
const inspectionDatabase = createDatabase(testDatabaseUrl, 1);
const oauthStates: string[] = [];

beforeAll(async () => {
  // OAuth 测试使用假凭据及模拟的提供商响应，不访问真实第三方账户。
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-secret");
  vi.stubEnv("GITHUB_CLIENT_ID", "test-github-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "test-github-secret");
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(
      new URL("../../../../../packages/db/drizzle", import.meta.url),
    ),
  });
  // Better Auth 默认在测试环境跳过 Origin 校验，这里恢复线上默认行为。
  const { auth } = await import("./auth");
  (await auth.$context).skipOriginCheck = false;
});

afterAll(async () => {
  for (const state of oauthStates) {
    await inspectionDatabase.client`DELETE FROM verification WHERE identifier = ${state}`;
  }
  await inspectionDatabase.client`DELETE FROM "user" WHERE email = ${email}`;
  await inspectionDatabase.client`DELETE FROM "user" WHERE email = ${oauthEmail}`;
  await inspectionDatabase.close();
  await closeApplicationDatabase();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Better Auth PostgreSQL adapter", () => {
  it("创建邮箱账户，并通过 HttpOnly Cookie 恢复服务端 Session", async () => {
    const { auth } = await import("./auth");
    const result = await auth.api.signUpEmail({
      body: {
        name: "认证集成测试用户",
        email,
        password: "integration-test-password",
      },
    });

    expect(result.user.email).toBe(email);

    const [persistedUser] = await inspectionDatabase.client<
      { name: string }[]
    >`SELECT name FROM "user" WHERE email = ${email}`;

    const [credentialAccount] = await inspectionDatabase.client<
      { issuer: string; password: string | null; providerId: string }[]
    >`
      SELECT
        issuer,
        password,
        provider_id AS "providerId"
      FROM account
      WHERE user_id = ${result.user.id}
    `;

    const [persistedSession] = await inspectionDatabase.client<
      { id: string }[]
    >`SELECT id FROM session WHERE user_id = ${result.user.id}`;

    expect(persistedUser?.name).toBe("认证集成测试用户");
    expect(credentialAccount?.providerId).toBe("credential");
    expect(credentialAccount?.issuer).toBeTruthy();
    expect(credentialAccount?.password).toBeTruthy();
    expect(persistedSession?.id).toBeTruthy();

    const signInResponse = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          email,
          password: "integration-test-password",
        }),
      }),
    );

    expect(signInResponse.status).toBe(200);

    const setCookie = signInResponse.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");

    const sessionCookie = setCookie?.split(";", 1)[0];
    expect(sessionCookie).toBeTruthy();

    const restoredSession = await auth.api.getSession({
      headers: new Headers({ cookie: sessionCookie ?? "" }),
    });

    expect(restoredSession?.user.email).toBe(email);
  });

  it.each([
    ["google", "accounts.google.com"],
    ["github", "github.com"],
  ])("%s 授权使用正确回调，取消授权返回表单且不创建登录会话", async (provider, hostname) => {
    const { auth } = await import("./auth");
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        provider,
        callbackURL: "/auth/complete",
        errorCallbackURL: "/register",
        disableRedirect: true,
      }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    const authorization = new URL(body.url);
    expect(authorization.hostname).toBe(hostname);
    expect(authorization.searchParams.get("redirect_uri")).toBe(`http://localhost:3000/api/auth/callback/${provider}`);
    expect(authorization.searchParams.get("client_id")).toBe(`test-${provider}-id`);
    expect(body.url).not.toContain(`test-${provider}-secret`);
    const state = authorization.searchParams.get("state")!;
    expect(state).toBeTruthy();
    oauthStates.push(state);
    const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const callback = await auth.handler(new Request(
      `http://localhost:3000/api/auth/callback/${provider}?error=access_denied&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    ));
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get("location")!, "http://localhost:3000");
    expect(destination.pathname).toBe("/register");
    expect(destination.searchParams.get("error")).toBe("access_denied");
    expect(callback.headers.get("set-cookie") ?? "").not.toContain("session_token=");
  });

  it("拒绝第三方登录的外站回调，避免开放重定向", async () => {
    const { auth } = await import("./auth");
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ provider: "google", callbackURL: "https://untrusted.example/auth/complete" }),
    }));
    expect(response.status).toBe(403);
  });

  it("GitHub 回调可落库第三方账户并建立 Session（仅模拟提供商 HTTP 响应）", async () => {
    const { auth } = await import("./auth");
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ provider: "github", callbackURL: "/auth/complete", disableRedirect: true }),
    }));
    expect(response.status).toBe(200);
    const authorization = new URL((await response.json()).url);
    const state = authorization.searchParams.get("state")!;
    oauthStates.push(state);
    const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "test-access-token", token_type: "bearer", scope: "read:user,user:email" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: randomUUID(), login: "oauth-test", name: "OAuth 集成测试用户", email: oauthEmail });
      }
      if (url === "https://api.github.com/user/emails") {
        return Response.json([{ email: oauthEmail, primary: true, verified: true }]);
      }
      throw new Error(`测试不允许访问未模拟的地址: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      const callback = await auth.handler(new Request(
        `http://localhost:3000/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie } },
      ));
      expect(callback.status).toBe(302);
      expect(new URL(callback.headers.get("location")!, "http://localhost:3000").pathname).toBe("/auth/complete");
      const sessionCookie = callback.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
      const session = await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) });
      expect(session?.user.email).toBe(oauthEmail);
      const [account] = await inspectionDatabase.client<{ providerId: string; password: string | null }[]>`
        SELECT provider_id AS "providerId", password FROM account WHERE user_id = ${session!.user.id}
      `;
      expect(account).toEqual({ providerId: "github", password: null });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
