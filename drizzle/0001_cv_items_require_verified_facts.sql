CREATE FUNCTION "cv_version_items_require_verified_fact"() RETURNS trigger AS $$
DECLARE
	fact_user uuid;
	fact_status verification_status;
	version_user uuid;
BEGIN
	SELECT "user_id", "verification_status" INTO fact_user, fact_status FROM "career_facts" WHERE "id" = NEW."career_fact_id";
	SELECT "user_id" INTO version_user FROM "cv_versions" WHERE "id" = NEW."cv_version_id";
	IF fact_status IS DISTINCT FROM 'verified' THEN
		RAISE EXCEPTION 'cv_version_items may only reference verified career facts (fact %)', NEW."career_fact_id";
	END IF;
	IF fact_user IS DISTINCT FROM version_user THEN
		RAISE EXCEPTION 'career fact % does not belong to the CV owner', NEW."career_fact_id";
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "cv_version_items_require_verified_fact_trg"
	BEFORE INSERT OR UPDATE OF "career_fact_id", "cv_version_id" ON "cv_version_items"
	FOR EACH ROW EXECUTE FUNCTION "cv_version_items_require_verified_fact"();
