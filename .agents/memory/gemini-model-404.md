---
name: Gemini API 404 on generateContent
description: Diagnosing "models/X is not found for API version v1beta" errors from the Gemini generateContent endpoint.
---

Google periodically retires Gemini model aliases (e.g. `gemini-pro` is no longer served on `v1beta`). A 404 with `status: NOT_FOUND` from `generateContent` almost always means the model name in the endpoint URL is stale, not that the API key is invalid.

**Why:** The key itself can be valid and working while a specific model name has been deprecated/removed, so error messages pointing at "the API" are misleading — the fix is in the URL, not auth.

**How to apply:** Call `GET https://generativelanguage.googleapis.com/v1beta/models?key=<key>` to list currently-served models with the same key, then swap the endpoint to a listed one (as of July 2026, `gemini-2.5-flash` and `gemini-2.0-flash` were available). Don't guess a model name — verify against the live list first.
