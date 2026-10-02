CREATE TABLE "sensor_verdicts" (
	"sensor_pubkey" text NOT NULL,
	"cell_id" bigint NOT NULL,
	"kind" "reading_kind" NOT NULL,
	"interval_start" timestamp with time zone NOT NULL,
	"day_index" integer NOT NULL,
	"value_x100" integer NOT NULL,
	"median_x100" integer NOT NULL,
	"outlier" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sensor_verdicts_sensor_pubkey_interval_start_kind_pk" PRIMARY KEY("sensor_pubkey","interval_start","kind")
);
--> statement-breakpoint
ALTER TABLE "sensor_verdicts" ADD CONSTRAINT "sensor_verdicts_sensor_pubkey_sensors_pubkey_fk" FOREIGN KEY ("sensor_pubkey") REFERENCES "public"."sensors"("pubkey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_verdicts" ADD CONSTRAINT "sensor_verdicts_cell_id_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cells"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sensor_verdicts_cell_day_idx" ON "sensor_verdicts" USING btree ("cell_id","kind","day_index");