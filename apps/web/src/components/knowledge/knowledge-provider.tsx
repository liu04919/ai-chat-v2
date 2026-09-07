"use client";

import type { KnowledgeBaseDto } from "@ai-chat/contracts";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { fetchKnowledgeBases } from "@/lib/knowledge-client";

const KnowledgeContext = createContext<{
  ownerId: string;
  initialBases: KnowledgeBaseDto[];
} | null>(null);
export function KnowledgeProvider({
  ownerId,
  initialBases,
  children,
}: Readonly<{
  ownerId: string;
  initialBases: KnowledgeBaseDto[];
  children: React.ReactNode;
}>) {
  return (
    <KnowledgeContext.Provider value={{ ownerId, initialBases }}>
      {children}
    </KnowledgeContext.Provider>
  );
}
export function useKnowledgeBases() {
  const context = useContext(KnowledgeContext);
  if (!context) throw new Error("KnowledgeProvider is required");
  const queryKey = ["knowledge-bases", context.ownerId] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchKnowledgeBases(signal),
    initialData: context.initialBases,
  });
  return { ...query, queryKey, ownerId: context.ownerId };
}
