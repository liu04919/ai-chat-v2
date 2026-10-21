import { afterEach, describe, expect, it, vi } from "vitest";

import { getEnabledSocialProviders, getSocialProviders } from "./social-providers";

afterEach(() => vi.unstubAllEnvs());

describe("social provider configuration", () => {
  it("未配置凭据时不启用任何提供商", () => {
    expect(getSocialProviders({})).toEqual({});
  });

  it("ID 和 Secret 必须成对配置，空白不算有效配置", () => {
    expect(getSocialProviders({ GOOGLE_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })).toEqual({});
    expect(getSocialProviders({ GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: "secret" })).toEqual({});
  });

  it("分别启用 Google 和 GitHub，并清理环境变量首尾空白", () => {
    expect(getSocialProviders({
      GOOGLE_CLIENT_ID: " google-id ", GOOGLE_CLIENT_SECRET: "google-secret",
      GITHUB_CLIENT_ID: "github-id", GITHUB_CLIENT_SECRET: " github-secret ",
    })).toEqual({
      google: { clientId: "google-id", clientSecret: "google-secret" },
      github: { clientId: "github-id", clientSecret: "github-secret" },
    });
  });

  it("发给页面的只有名称，不包含服务端凭据", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
    vi.stubEnv("GITHUB_CLIENT_ID", "github-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    expect(getEnabledSocialProviders()).toEqual(["google"]);
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-secret");
    expect(getEnabledSocialProviders()).toEqual(["google", "github"]);
  });
});
