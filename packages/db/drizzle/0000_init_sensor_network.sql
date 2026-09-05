CREATE TYPE "public"."reading_kind" AS ENUM('precipitation_mm');--> statement-breakpoint
CREATE TYPE "public"."reading_status" AS ENUM('accepted', 'outlier', 'late', 'rejected');--> statement-breakpoint
CREATE TABLE "cell_days" (
	"cell_id" bigint NOT NULL,
	"day_index" integer NOT NULL,
	"state" smallint NOT NULL,
	"rainfall_x100" integer,
	"covered_hours" smallint NOT NULL,
	"merkle_root" text,
	"tx_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_days_cell_id_day_index_pk" PRIMARY KEY("cell_id","day_index")
);
--> statement-breakpoint
CREATE TABLE "cell_hours" (
	"cell_id" bigint NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"kind" "reading_kind" NOT NULL,
	"median_x100" integer,
	"vote_count" smallint NOT NULL,
	"merkle_root" text,
	"disputed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_hours_cell_id_hour_start_kind_pk" PRIMARY KEY("cell_id","hour_start","kind")
);
--> statement-breakpoint
CREATE TABLE "cells" (
	"id" bigint PRIMARY KEY NOT NULL,
	"resolution" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_wallet_unique" UNIQUE("wallet")
);
--> statement-breakpoint
CREATE TABLE "readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sensor_pubkey" text NOT NULL,
	"cell_id" bigint NOT NULL,
	"kind" "reading_kind" NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_x100" integer NOT NULL,
	"counter" bigint NOT NULL,
	"signature" text NOT NULL,
	"status" "reading_status" NOT NULL,
	CONSTRAINT "readings_sensor_counter_uq" UNIQUE("sensor_pubkey","counter")
);
--> statement-breakpoint
CREATE TABLE "sensors" (
	"pubkey" text PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"cell_id" bigint NOT NULL,
	"kind" "reading_kind" NOT NULL,
	"slot_in_cell" smallint NOT NULL,
	"stake" bigint DEFAULT 0 NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"outliers" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sensors_cell_slot_uq" UNIQUE("cell_id","slot_in_cell")
);
--> statement-breakpoint
ALTER TABLE "cell_days" ADD CONSTRAINT "cell_days_cell_id_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cells"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_hours" ADD CONSTRAINT "cell_hours_cell_id_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cells"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readings" ADD CONSTRAINT "readings_sensor_pubkey_sensors_pubkey_fk" FOREIGN KEY ("sensor_pubkey") REFERENCES "public"."sensors"("pubkey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readings" ADD CONSTRAINT "readings_cell_id_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cells"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_cell_id_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cells"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cell_hours_cell_start_idx" ON "cell_hours" USING btree ("cell_id","hour_start");--> statement-breakpoint
CREATE INDEX "readings_cell_measured_idx" ON "readings" USING btree ("cell_id","kind","measured_at");--> statement-breakpoint
CREATE INDEX "readings_received_idx" ON "readings" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "sensors_cell_idx" ON "sensors" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "sensors_operator_idx" ON "sensors" USING btree ("operator_id");