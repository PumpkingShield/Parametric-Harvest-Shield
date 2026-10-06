CREATE TABLE "slot_rewards" (
	"cell_id" bigint NOT NULL,
	"day_index" integer NOT NULL,
	"slot" smallint NOT NULL,
	"sensor_pubkey" text,
	"earned" bigint NOT NULL,
	CONSTRAINT "slot_rewards_cell_id_day_index_slot_pk" PRIMARY KEY("cell_id","day_index","slot")
);
--> statement-breakpoint
ALTER TABLE "cell_days" ADD COLUMN "rewards_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slot_rewards" ADD CONSTRAINT "slot_rewards_cell_id_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cells"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_rewards" ADD CONSTRAINT "slot_rewards_sensor_pubkey_sensors_pubkey_fk" FOREIGN KEY ("sensor_pubkey") REFERENCES "public"."sensors"("pubkey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slot_rewards_sensor_idx" ON "slot_rewards" USING btree ("sensor_pubkey","day_index");