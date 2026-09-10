-- pgvector must exist before the chunks.embedding column is created.
-- Prepended by hand after generation: drizzle-kit models the column type but not
-- the extension that provides it, so a fresh database needs this line first.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."score_confidence" AS ENUM('code_only', 'refined');--> statement-breakpoint
CREATE TYPE "public"."dependency_type" AS ENUM('sync_call', 'async_event', 'shared_db', 'external_api', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."operational_data_kind" AS ENUM('log', 'health', 'traffic', 'incident', 'db_stats');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."risk_weighting" AS ENUM('equal', 'dependency');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_step" AS ENUM('discovery', 'architecture', 'risk', 'comparison', 'done');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('example', 'upload');--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"step" "run_step" DEFAULT 'discovery' NOT NULL,
	"discovery_report" text,
	"architecture_proposal" text,
	"risk_assessment" text,
	"comparison_report" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"file_name" text NOT NULL,
	"document_type" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"token_count" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"risk_factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommendation" text,
	"has_test_coverage_gap" boolean DEFAULT false NOT NULL,
	"data_quality_issue_count" integer DEFAULT 0 NOT NULL,
	"requires_major_restructuring" boolean DEFAULT false NOT NULL,
	"dependent_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_parameters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"target_environment" text,
	"provider" text,
	"team_size" integer,
	"weekly_rate" numeric(10, 2),
	"budget" numeric(14, 2),
	"timeline_weeks" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "operational_data_kind" NOT NULL,
	"source" text NOT NULL,
	"content" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_hash" text,
	"file_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scorecards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid,
	"owner_id" text NOT NULL,
	"migration_readiness" numeric(5, 2) NOT NULL,
	"risk" numeric(5, 2) NOT NULL,
	"effort" numeric(4, 2) NOT NULL,
	"cost" numeric(14, 2) NOT NULL,
	"time_weeks_min" numeric(6, 2) NOT NULL,
	"time_weeks_max" numeric(6, 2) NOT NULL,
	"confidence" "score_confidence" DEFAULT 'code_only' NOT NULL,
	"risk_weighting" "risk_weighting" DEFAULT 'equal' NOT NULL,
	"breakdown" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"from_service" text NOT NULL,
	"to_service" text NOT NULL,
	"type" "dependency_type" DEFAULT 'unknown' NOT NULL,
	"evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"duration_ms" numeric(12, 3) NOT NULL,
	"status_code" text DEFAULT 'unset' NOT NULL,
	"status_message" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"project_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_parameters" ADD CONSTRAINT "migration_parameters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_data" ADD CONSTRAINT "operational_data_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_project_idx" ON "analysis_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_owner_created_idx" ON "analysis_runs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "chunks_project_idx" ON "chunks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "chunks_project_source_idx" ON "chunks" USING btree ("project_id","source");--> statement-breakpoint
CREATE INDEX "findings_run_idx" ON "findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "findings_project_service_idx" ON "findings" USING btree ("project_id","service_name");--> statement-breakpoint
CREATE INDEX "operational_data_project_idx" ON "operational_data" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "projects_owner_created_idx" ON "projects" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "projects_source_hash_idx" ON "projects" USING btree ("source_hash");--> statement-breakpoint
CREATE INDEX "scorecards_project_idx" ON "scorecards" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "scorecards_owner_created_idx" ON "scorecards" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "service_dependencies_project_idx" ON "service_dependencies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "service_dependencies_from_idx" ON "service_dependencies" USING btree ("project_id","from_service");--> statement-breakpoint
CREATE INDEX "service_dependencies_to_idx" ON "service_dependencies" USING btree ("project_id","to_service");--> statement-breakpoint
CREATE INDEX "trace_spans_trace_idx" ON "trace_spans" USING btree ("trace_id","start_time");--> statement-breakpoint
CREATE INDEX "trace_spans_parent_idx" ON "trace_spans" USING btree ("trace_id","parent_span_id");--> statement-breakpoint
CREATE INDEX "trace_spans_created_idx" ON "trace_spans" USING btree ("created_at");