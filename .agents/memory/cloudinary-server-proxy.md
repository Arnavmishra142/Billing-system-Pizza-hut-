---
name: Cloudinary server-side upload pattern
description: How Cloudinary image uploads are wired in this project — server proxy, no client credentials.
---

# Cloudinary Server-Side Upload Pattern

## The rule
Cloudinary API secret must never reach the browser. All uploads/deletes go through Express endpoints.

**Why:** Cloudinary requires a signed request (HMAC-SHA256 of params + api_secret). The secret must stay server-side or any visitor can upload unlimited files to the account.

## How to apply
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` → Replit Secrets → read only in `server.js`
- `POST /api/upload-menu-image` — multer `memoryStorage()` receives file buffer, streams to `cloudinary.uploader.upload_stream()`, returns `{ url, publicId }`
- `POST /api/delete-menu-image` — receives `{ publicId }`, calls `cloudinary.uploader.destroy()`
- `js/cloudinary-upload.js` — browser-side service; contains zero credentials; calls the two endpoints above

## Key details
- `multer({ storage: memoryStorage(), limits: { fileSize: 10MB } })` — no temp files, buffer piped directly to Cloudinary stream
- Upload options: `folder: 'menu-images'`, `quality: 'auto'`, `fetch_format: 'auto'`
- Old image deleted server-side as part of upload call via `oldPublicId` body field (best-effort, fire-and-forget)
- Client-side `_toWebP()` kept for payload reduction; Cloudinary also optimizes at serve time
- `extractCloudinaryPublicId(url)` parses `res.cloudinary.com` URLs to get publicId for delete; returns null for legacy Firebase Storage URLs
- SW cache must be bumped whenever `js/admin.js` or `js/cloudinary-upload.js` change
