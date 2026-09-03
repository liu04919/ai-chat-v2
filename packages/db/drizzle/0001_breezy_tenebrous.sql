CREATE TABLE "user_tool_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"mcp_tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_tool_preferences" ADD CONSTRAINT "user_tool_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;