// cloudinary-upload.js
// AI UPDATE [2026-08-02]: Switched to direct Cloudinary unsigned upload API so
// uploads work from any static host (GitHub Pages, Firebase Hosting, Replit).
// No API Secret or API Key is used here — unsigned uploads require only the
// cloud_name (public, in every CDN URL) and an upload_preset (not a secret).
//
// Public API:
//   uploadMenuImage(file, oldPublicId?)  → Promise<{ url, publicId }>
//   deleteMenuImage(publicId)            → Promise<void>  (best-effort, non-fatal)
//   extractCloudinaryPublicId(url)       → string | null

import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from './cloudinary-public.js';

/**
 * Upload an image file directly to Cloudinary using an unsigned upload preset.
 *
 * Works from any host — no server required. The browser posts multipart/form-data
 * directly to the Cloudinary API. The API Secret never reaches the browser.
 * Automatically times out after 30 seconds so the UI is never left stuck.
 *
 * If oldPublicId is provided, the previous image is deleted via the server-side
 * proxy (best-effort, fire-and-forget — silently skipped on static hosts).
 *
 * @param {File|Blob} file          - Image file to upload.
 * @param {string|null} oldPublicId - Cloudinary public_id of the image being replaced.
 * @returns {Promise<{ url: string, publicId: string }>}
 */
export async function uploadMenuImage(file, oldPublicId = null) {
    const formData = new FormData();
    formData.append('file', file, file.name || 'menu-image');
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    // folder is set by the upload preset on Cloudinary side — not passed here

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 30_000);

    try {
        const res = await fetch(
            `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
            { method: 'POST', body: formData, signal: controller.signal }
        );
        clearTimeout(timeout);

        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        if (!res.ok || !data.secure_url) {
            throw new Error(data.error?.message || `Upload failed (HTTP ${res.status})`);
        }

        // Best-effort delete old image via server proxy.
        // Silently skipped on static hosts (fetch fails → caught → ignored).
        if (oldPublicId) {
            fetch('/api/delete-menu-image', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ publicId: oldPublicId }),
            }).catch(() => {}); // fire-and-forget, non-fatal
        }

        return { url: data.secure_url, publicId: data.public_id };
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            throw new Error('Upload timed out after 30 s. Check internet connection and try again.');
        }
        throw err;
    }
}

/**
 * Delete an image from Cloudinary via the server-side proxy.
 * Best-effort: errors are logged but never thrown.
 *
 * @param {string} publicId - The Cloudinary public_id returned by uploadMenuImage.
 */
export async function deleteMenuImage(publicId) {
    if (!publicId) return;
    try {
        await fetch('/api/delete-menu-image', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ publicId }),
        });
    } catch (err) {
        console.warn('[cloudinary] delete request failed (non-fatal):', err.message);
    }
}

/**
 * Extract the Cloudinary public_id from a Cloudinary secure URL.
 * Returns null for non-Cloudinary URLs (e.g. old Firebase Storage URLs).
 *
 * Cloudinary URL format:
 *   https://res.cloudinary.com/{cloud}/image/upload/{transformations}/v{ver}/{public_id}.{ext}
 *
 * @param {string|null} url
 * @returns {string|null}
 */
export function extractCloudinaryPublicId(url) {
    if (!url || !url.includes('res.cloudinary.com')) return null;
    try {
        const parts     = new URL(url).pathname.split('/');
        const uploadIdx = parts.indexOf('upload');
        if (uploadIdx === -1) return null;

        // Skip transformation segments (they contain underscores/commas but are not
        // the version string). Walk forward until we find 'v' + digits-only segment.
        let i = uploadIdx + 1;
        while (i < parts.length && !/^v\d+$/.test(parts[i])) i++;
        if (i < parts.length && /^v\d+$/.test(parts[i])) i++; // skip version

        const rest = parts.slice(i);
        if (rest.length === 0) return null;

        // Remove file extension from the final segment
        rest[rest.length - 1] = rest[rest.length - 1].replace(/\.[^.]+$/, '');
        return rest.join('/') || null;
    } catch (_) {
        return null;
    }
}
