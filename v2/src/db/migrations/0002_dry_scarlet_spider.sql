ALTER TABLE "analysis_runs" ADD COLUMN "discovery_output" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "architecture_output" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "risk_output" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "comparison_output" jsonb;