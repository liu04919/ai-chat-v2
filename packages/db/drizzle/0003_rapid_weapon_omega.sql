CREATE TABLE "conversation_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"token" text NOT NULL,
	"title" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD CONSTRAINT "conversation_shares_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_shares_conversation_id_unique" ON "conversation_shares" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_shares_token_unique" ON "conversation_shares" USING btree ("token");