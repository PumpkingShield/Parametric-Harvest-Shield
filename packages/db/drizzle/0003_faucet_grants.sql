CREATE TABLE "faucet_grants" (
	"pubkey" text PRIMARY KEY NOT NULL,
	"address_hash" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature" text
);
--> statement-breakpoint
CREATE INDEX "faucet_grants_address_idx" ON "faucet_grants" USING btree ("address_hash","granted_at");--> statement-breakpoint
CREATE INDEX "faucet_grants_granted_idx" ON "faucet_grants" USING btree ("granted_at");