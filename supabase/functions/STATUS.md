# Edge Functions Status

## Shared Helpers
| Module | Purpose |
|---|---|
| `_shared/cors.ts` | CORS headers + preflight response |
| `_shared/supabase-admin.ts` | Service-role + user-scoped Supabase clients |
| `_shared/auth.ts` | requireAuth, requireAdmin, requireClipOwner |
| `_shared/errors.ts` | AppError class, errorResponse, jsonResponse |
| `_shared/validation.ts` | Input parsing (strings, UUIDs, enums, arrays) |
| `_shared/rate-limit.ts` | Rate limit enforcement + app_config helpers |
| `_shared/logging.ts` | Structured JSON logging with timed blocks |
| `_shared/notifications.ts` | Insert notification + Expo Push API |

## Edge Functions
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `health-check` | YES | YES (curl) | None |
