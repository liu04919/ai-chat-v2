/** 认证成功后更换整个文档，结束旧账户的缓存、流连接和内存状态。 */
export function navigateAfterAuthentication(path: "/login" | "/chat"): void {
  // 不使用客户端路由：根布局的 QueryClient 会跨软导航继续存活。
  window.location.replace(path);
}
