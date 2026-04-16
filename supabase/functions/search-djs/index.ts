import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireString, optionalPositiveInt } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("search-djs");

  try {
    await requireAuth(req);
    const body = await parseBody(req);

    const query = requireString(body, "query", { maxLength: 200, minLength: 1 });
    const limit = optionalPositiveInt(body, "limit", { max: 50, defaultValue: 20 });
    const offset = optionalPositiveInt(body, "offset", { max: 1000, defaultValue: 0 });

    const supabase = getServiceClient();

    const tsQuery = query.split(/\s+/).filter(Boolean).join(" & ");

    const { data: djs, error, count } = await supabase
      .from("djs")
      .select(
        "id, name, slug, bio, avatar_url, genres, claimed_by_user_id, created_at",
        { count: "exact" },
      )
      .or(`search_vector.fts.${tsQuery},name.ilike.%${query}%`)
      .order("name")
      .range(offset, offset + limit - 1);

    if (error) {
      throw Errors.internal(`DJ search failed: ${error.message}`);
    }

    return jsonResponse({
      djs: djs ?? [],
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    log.error("Search DJs failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
