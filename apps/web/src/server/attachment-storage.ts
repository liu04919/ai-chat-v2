import { createR2ObjectStorage, type ObjectStorage } from "@ai-chat/storage";

let attachmentObjectStorage: ObjectStorage | undefined;

function requireEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`缺少 ${name}，无法访问 Attachment 对象存储`);
  }

  return value;
}

export function getAttachmentObjectStorage(): ObjectStorage {
  attachmentObjectStorage ??= createR2ObjectStorage({
    endpoint: requireEnvironment("R2_ENDPOINT"),
    bucket: requireEnvironment("R2_BUCKET"),
    accessKeyId: requireEnvironment("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnvironment("R2_SECRET_ACCESS_KEY"),
  });

  return attachmentObjectStorage;
}
