# Edge Functions Status

## Shared Helpers
| Module | Purpose |
|---|---|
| `_shared/cors.ts` | CORS headers + preflight response |
| `_shared/supabase-admin.ts` | Service-role + user-scoped Supabase clients |
| `_shared/auth.ts` | requireAuth, requireAdmin, requireClipOwner, getOptionalUser |
| `_shared/errors.ts` | AppError class, errorResponse, jsonResponse |
| `_shared/validation.ts` | Input parsing (strings, UUIDs, enums, arrays) |
| `_shared/rate-limit.ts` | Rate limit enforcement + app_config helpers |
| `_shared/logging.ts` | Structured JSON logging with timed blocks + child loggers |
| `_shared/notifications.ts` | Insert notification + Expo Push API + bulk send |

## Edge Functions (33 deployed)

### Group 1-3: Core Pipeline
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `health-check` | YES | YES (curl) | None |
| `identify-clip` | YES | YES (mock match, error cases) | ACRCLOUD_*, AUDD_API_TOKEN (optional — mock works without) |
| `post-clip-to-community` | YES | YES (curl) | None |
| `retry-identification` | YES | Deployed only | None |
| `propose-track-id` | YES | YES (freeform proposal) | SPOTIFY_CLIENT_ID/SECRET (optional) |
| `vote-on-id` | YES | YES (upvote) | None |
| `accept-community-id` | YES | YES (accept + reputation verified) | None |
| `unaccept-community-id` | YES | YES (unaccept + reputation reversal) | None |

### Group 4: Spotify Integration
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `spotify-search` | YES | Deployed only | SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (graceful 503 without) |

### Group 5: Notifications
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `register-push-token` | YES | Deployed only | None |
| `unregister-push-token` | YES | Deployed only | None |
| `mark-notifications-read` | YES | Deployed only | None |

### Group 6: Badges
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `check-and-award-badges` | YES | Deployed only (internal, called by accept-community-id) | None |

### Group 7: Video Stubs
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `extract-audio-from-video` | YES | N/A (stub — returns 503) | None |
| `finalize-video-for-sharing` | YES | N/A (stub — returns 503) | None |

### Group 8: Venues / Events / DJs
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `create-venue` | YES | Deployed only | None |
| `search-venues` | YES | Deployed only | None |
| `create-event` | YES | Deployed only | None |
| `attribute-clip-to-event` | YES | Deployed only | None |
| `claim-dj-profile` | YES | Deployed only | None |
| `search-djs` | YES | Deployed only | None |

### Group 9: Feed / Discovery
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `get-community-feed` | YES | Deployed only | None |
| `get-clip-detail` | YES | Deployed only | None |
| `get-user-feed` | YES | Deployed only | None |
| `get-venue-page` | YES | Deployed only | None |
| `get-dj-page` | YES | Deployed only | None |
| `get-profile` | YES | Deployed only | None |

### Group 10: Admin
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `admin-review-report` | YES | Deployed only | None |
| `admin-verify-entity` | YES | Deployed only | None |
| `admin-approve-dj-claim` | YES | Deployed only | None |

### Group 11: Search + Utilities
| Function | Deployed | Tested | Secrets Required |
|---|---|---|---|
| `search-everything` | YES | Deployed only | None |
| `get-signed-audio-url` | YES | Deployed only | None |
| `log-clip-play` | YES | Deployed only | None |
