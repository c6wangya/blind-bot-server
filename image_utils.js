import sharp from 'sharp';
import axios from 'axios';

/**
 * Configuration constants
 */
const CONFIG = {
    DOWNLOAD_TIMEOUT_MS: 30000,     // 30 seconds max for download
    MAX_IMAGE_SIZE_MB: 20,          // 20MB max image size
    JPEG_QUALITY: 85                // JPEG compression quality
};

/**
 * Supported image formats that browsers can display
 */
const BROWSER_SAFE_FORMATS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Formats that need conversion (Apple HEIC, etc.)
 */
const NEEDS_CONVERSION = ['image/heic', 'image/heif', 'image/avif'];

/**
 * Detect mimeType from URL extension
 * @param {string} url - Image URL
 * @returns {string} - Detected mimeType
 */
export function detectMimeType(url) {
    if (!url) return 'image/jpeg';

    const lowerUrl = url.toLowerCase();

    if (lowerUrl.endsWith('.png')) return 'image/png';
    if (lowerUrl.endsWith('.gif')) return 'image/gif';
    if (lowerUrl.endsWith('.webp')) return 'image/webp';
    if (lowerUrl.endsWith('.heic')) return 'image/heic';
    if (lowerUrl.endsWith('.heif')) return 'image/heif';
    if (lowerUrl.endsWith('.avif')) return 'image/avif';
    if (lowerUrl.endsWith('.pdf')) return 'application/pdf';

    // Default to JPEG
    return 'image/jpeg';
}

/**
 * Convert image buffer to JPEG using sharp
 * Works with HEIC, HEIF, AVIF, PNG, WebP, etc.
 * @param {Buffer} buffer - Original image buffer
 * @returns {Promise<Buffer>} - JPEG buffer
 */
export async function convertToJpeg(buffer) {
    try {
        return await sharp(buffer)
            .jpeg({ quality: CONFIG.JPEG_QUALITY })
            .toBuffer();
    } catch (err) {
        console.error('❌ Image conversion failed:', err.message);

        // Check if it's a HEIF/HEIC support issue
        if (err.message.includes('heif') || err.message.includes('HEIF') ||
            err.message.includes('compression format has not been built')) {
            const heifError = new Error(
                'HEIC/HEIF format is not supported on this server. Please convert your image to JPEG or PNG before uploading.'
            );
            heifError.code = 'HEIF_NOT_SUPPORTED';
            throw heifError;
        }

        throw err;
    }
}

/**
 * Download image from URL and convert to Gemini-compatible format
 * Automatically converts HEIC/HEIF to JPEG
 * @param {string} url - Image URL
 * @returns {Promise<{inlineData: {data: string, mimeType: string}}|null>}
 */
export async function downloadAndConvertImage(url) {
    if (!url) return null;

    try {
        const cleanUrl = url.trim().replace(/["\[\]]/g, '');
        if (cleanUrl.length < 5) return null;

        console.log(`   ⬇️ Downloading: ${cleanUrl.substring(0, 50)}...`);

        const response = await axios.get(cleanUrl, {
            responseType: 'arraybuffer',
            timeout: CONFIG.DOWNLOAD_TIMEOUT_MS
        });
        let buffer = Buffer.from(response.data);
        let mimeType = detectMimeType(cleanUrl);

        // Check Content-Type header as backup
        const contentType = response.headers['content-type'];
        if (contentType && contentType.includes('image/')) {
            mimeType = contentType.split(';')[0].trim();
        }

        // Convert non-browser-safe formats to JPEG
        if (NEEDS_CONVERSION.includes(mimeType) || !BROWSER_SAFE_FORMATS.includes(mimeType)) {
            console.log(`   🔄 Converting ${mimeType} to JPEG...`);
            buffer = await convertToJpeg(buffer);
            mimeType = 'image/jpeg';
        }

        return {
            inlineData: {
                data: buffer.toString('base64'),
                mimeType: mimeType
            }
        };

    } catch (err) {
        console.error(`   ❌ Image download/convert failed:`, err.message);
        return null;
    }
}

/**
 * Detect mimeType from filename extension
 * @param {string} fileName - File name with extension
 * @returns {string|null} - Detected mimeType or null
 */
export function detectMimeTypeFromFileName(fileName) {
    if (!fileName) return null;

    const lowerName = fileName.toLowerCase();

    if (lowerName.endsWith('.heic')) return 'image/heic';
    if (lowerName.endsWith('.heif')) return 'image/heif';
    if (lowerName.endsWith('.avif')) return 'image/avif';
    if (lowerName.endsWith('.png')) return 'image/png';
    if (lowerName.endsWith('.gif')) return 'image/gif';
    if (lowerName.endsWith('.webp')) return 'image/webp';
    if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';

    return null;
}

/**
 * Convert uploaded file buffer to JPEG if needed
 * For use in upload endpoints
 * @param {Buffer} buffer - Original file buffer
 * @param {string} originalMimeType - Original file mimeType
 * @param {string} [fileName] - Optional filename for fallback detection
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
export async function ensureBrowserCompatible(buffer, originalMimeType, fileName = null) {
    // Handle empty/undefined mimeType - try to detect from filename
    let mimeType = (originalMimeType || '').toLowerCase().trim();

    if (!mimeType || mimeType === 'application/octet-stream') {
        // Browser didn't detect type, try filename
        const detected = detectMimeTypeFromFileName(fileName);
        if (detected) {
            mimeType = detected;
            console.log(`   📋 Detected mimeType from filename: ${mimeType}`);
        } else {
            // Last resort: assume it might need conversion (safer)
            mimeType = 'unknown';
        }
    }

    if (NEEDS_CONVERSION.includes(mimeType) || !BROWSER_SAFE_FORMATS.includes(mimeType)) {
        console.log(`   🔄 Converting ${mimeType} to JPEG for browser compatibility...`);
        const jpegBuffer = await convertToJpeg(buffer);
        return {
            buffer: jpegBuffer,
            mimeType: 'image/jpeg'
        };
    }

    // Return detected mimeType if original was empty/invalid
    return { buffer, mimeType: mimeType || originalMimeType };
}
