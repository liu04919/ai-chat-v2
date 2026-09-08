import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Next 保留 JSX 交给自己的编译器；组件测试需要在 Vitest 中完成转换。
  oxc: { jsx: { runtime: "automatic" } },
  test: { exclude: [...configDefaults.exclude, "**/artifacts/**", "**/.venv/**"] },
});
