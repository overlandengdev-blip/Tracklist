import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  parseBody,
  requireString,
  optionalString,
  optionalPositiveInt,
} from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("create-venue");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const name = requireString(body, "name", { maxLength: 200, minLength: 2 });
    const city = optionalString(body, "city", { maxLength: 100 });
    const country = optionalString(body, "country", { maxLength: 100 });
    const description = optionalString(body, "description", { maxLength: 2000 });
    const website = optionalString(body, "website", { maxLength: 500 });
    const instagram = optionalString(body, "instagram", { maxLength: 100 });
    const capacity = optionalPositiveInt(body, "capacity", { max: 500000 }) || null;
    const genres = Array.isArray(body.genres) ? body.genres.filter((g: unknown) => typeof g === "string").slice(0, 20) : null;
    const lat = typeof body.lat === "number" ? body.lat : null;
    const lng = typeof body.lng === "number" ? body.lng : null;

    // Generate slug from name
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);

    const supabase = getServiceClient();

    // Check for duplicate slug
    const { data: existing } = await supabase
      .from("venues")
      .select("id")
      .eq("slug", slug)
      .single();

    if (existing) {
      throw Errors.conflict(`A venue with a similar name already exists (slug: ${slug})`);
    }

    const { data: venue, error } = await supabase
      .from("venues")
      .insert({
        name,
        slug,
        city,
        country,
        lat,
        lng,
        capacity,
        genres,
        website,
        instagram,
        description,
        created_by: user.id,
        updated_by: user.id,
      })
      .select("id, name, slug, city, country, verified, created_at")
      .single();

    if (error) {
      throw Errors.internal(`Failed to create venue: ${error.message}`);
    }

    log.info("Venue created", { user_id: user.id, venue_id: venue.id, name });

    return jsonResponse({ venue }, 201);
  } catch (err) {
    log.error("Create venue failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
