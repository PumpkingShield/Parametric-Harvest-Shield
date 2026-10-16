CREATE TYPE "public"."reference_state" AS ENUM('pending', 'agrees', 'disputed', 'unchecked');--> statement-breakpoint
CREATE TABLE "reference_hours" (
	"cell_id" bigint NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"value_x100" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_hours_cell_id_hour_start_pk" PRIMARY KEY("cell_id","hour_start")
);
--> statement-breakpoint
ALTER TABLE "cell_days" ADD COLUMN "reference_rainfall_x100" integer;--> statement-breakpoint
ALTER TABLE "cell_days" ADD COLUMN "reference_state" "reference_state" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
-- Days closed before the reference existed were never going to be compared: unchecked, not pending (FR-044).
UPDATE "cell_days" SET "reference_state" = 'unchecked';--> statement-breakpoint
ALTER TABLE "reference_hours" ADD CONSTRAINT "reference_hours_cell_id_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cells"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_hours" DROP COLUMN "disputed";