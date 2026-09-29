ALTER TABLE "sensors" DROP CONSTRAINT "sensors_cell_slot_uq";--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "mirrored_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "sensors_cell_slot_uq" ON "sensors" USING btree ("cell_id","slot_in_cell") WHERE "sensors"."mirrored_at" is not null;