const runtime = {
  name: "@ai-chat/worker",
  status: "ready",
} as const;

console.info(`${runtime.name} bootstrap ${runtime.status}`);
