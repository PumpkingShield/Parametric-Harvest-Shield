ALTER TABLE "sensors" ADD COLUMN "previous_cell_id" bigint;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "previous_slot" smallint;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "moved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_previous_cell_id_cells_id_fk" FOREIGN KEY ("previous_cell_id") REFERENCES "public"."cells"("id") ON DELETE no action ON UPDATE no action;