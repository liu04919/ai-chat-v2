/** 凭据只在服务端读取；缺少任意一项时，不启用对应的第三方登录。 */
export function getSocialProviders(environment: Record<string, string | undefined> = process.env) {
  const googleId = environment.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = environment.GOOGLE_CLIENT_SECRET?.trim();
  const githubId = environment.GITHUB_CLIENT_ID?.trim();
  const githubSecret = environment.GITHUB_CLIENT_SECRET?.trim();

  return {
    ...(googleId && googleSecret
      ? { google: { clientId: googleId, clientSecret: googleSecret } }
      : {}),
    ...(githubId && githubSecret
      ? { github: { clientId: githubId, clientSecret: githubSecret } }
      : {}),
  };
}

/** 页面只收到可用的提供商名称，不把 client secret 序列化到客户端。 */
export function getEnabledSocialProviders() {
  const providers = getSocialProviders();
  return (["google", "github"] as const).filter((name) => providers[name]);
}
