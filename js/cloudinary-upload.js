// cloudinary-upload.js
// AI UPDATE [2026-08-02]: Reusable client-side service for Cloudinary image
// uploads. All Cloudinary credentials stay server-side — this module only
// sends fetch requests to the Express server endpoints:
//   POST /api/upload-menu-image
//   POST /api/delete-menu-image
//
// Public API:
//   uploadMenuImage(file, oldPublicId?)  → Promise<{ url, publicId }>
//   deleteMenuImage(publicId)            → Promise<void>  (best-effort, non-fatal)
//   extractCloudinaryPublicId(url)       → string | null

/**
 * Upload an image file to Cloudinary via the server-side proxy.
 *
 * No Cloudinary credentials are used here — the server handles signing.
 * Automatically times out after 30 seconds so the UI is never left stuck.
 *
 * @param {File|Blob} file          - Image file to upload.
 * @param {string|null} oldPublicId - Cloudinary public_id of the image being
 *   replaced. The server will delete it as part of this call (best-effort).
 * @returns {Promise<{ url: string, publicId: string }>}
 */
export async function uploadMenuImage(file, oldPublicId = null) {
    const formData = new FormData();
    // Provide a filename so multer and Cloudinary get the correct MIME type
    formData.append('image', file, file.name || 'menu-image');
    if (oldPublicId) formData.append('oldPublicId', oldPublicId);

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 30_000);

    try {
        const res = await fetch('/api/upload-menu-image', {
            method: 'POST',
            body:   formData,
            signal: controller.signal,
        });
        clearTimeout(timeout);

        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        if (!res.ok || !data.ok) {
            throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
        }
        return { url: data.url, publicId: data.publicId };
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
