export type ConversationMode = "chat" | "image";

export type Conversation = Readonly<{
  id: string;
  mode: ConversationMode;
}>;

export function createConversation(input: {
  id: string;
  mode: ConversationMode;
}): Conversation {
  const id = input.id.trim();

  if (!id) {
    throw new Error("Conversation id 不能为空");
  }

  return Object.freeze({ id, mode: input.mode });
}
