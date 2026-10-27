CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"user_id" text NOT NULL,
	"user_email" text,
	"name" text DEFAULT 'Default API Key' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "code_edges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"relation" text NOT NULL,
	"confidence" text DEFAULT 'EXTRACTED',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "unique_repo_edge" UNIQUE("repo_id","source_id","target_id","relation")
);
--> statement-breakpoint
CREATE TABLE "code_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"node_type" text NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"signature" text,
	"raw_code" text,
	"summary" text DEFAULT 'pending_summary',
	"embedding" vector(768),
	"level" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "git_ownership" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"node_id" text NOT NULL,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"lines_authored" integer NOT NULL,
	"ownership_percentage" numeric(5, 2) NOT NULL,
	"last_commit_date" timestamp with time zone,
	"total_commits" integer DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"root_path" text NOT NULL,
	"owner_id" text,
	"status" text DEFAULT 'pending',
	"checkpoint_data" jsonb DEFAULT '{}'::jsonb,
	"architecture_summary" text,
	"onboarding_guide" text,
	"indexed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_source_id_code_nodes_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."code_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_target_id_code_nodes_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."code_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_nodes" ADD CONSTRAINT "code_nodes_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_ownership" ADD CONSTRAINT "git_ownership_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_ownership" ADD CONSTRAINT "git_ownership_node_id_code_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."code_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_user" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_code_edges_source" ON "code_edges" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_code_edges_target" ON "code_edges" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_code_edges_relation" ON "code_edges" USING btree ("relation");--> statement-breakpoint
CREATE INDEX "idx_code_nodes_repo" ON "code_nodes" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "idx_code_nodes_type_path" ON "code_nodes" USING btree ("repo_id","node_type","file_path");--> statement-breakpoint
CREATE INDEX "idx_git_ownership_node" ON "git_ownership" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_repositories_owner" ON "repositories" USING btree ("owner_id");