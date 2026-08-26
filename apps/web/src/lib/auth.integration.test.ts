import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  closeApplicationDatabase,
  createDatabase,
  migrateDatabase,
} from "@ai-chat/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const localEnvironment = fileURLToPath(
  new URL("../../.env.local", import.meta.url),
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
const inspectionDatabase = createDatabase(testDatabaseUrl, 1);

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(
      new URL("../../../../packages/db/drizzle", import.meta.url),
    ),
  });
});

afterAll(async () => {
  await inspectionDatabase.client`DELETE FROM "user" WHERE email = ${email}`;
  await inspectionDatabase.close();
  await closeApplicationDatabase();
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
});
