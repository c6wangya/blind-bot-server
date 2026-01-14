import axios from 'axios';

/**
 * Download single PDF and validate format
 * @param {string} url - PDF URL
 * @returns {Promise<Buffer>} - PDF buffer
 * @throws {Error} - If download fails or not a valid PDF
 */
export async function downloadPDF(url) {
    // 1. Validate input
    if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL: must be a non-empty string');
    }

    try {
        // 2. Download with timeout and size limit
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,              // 30s timeout
            maxContentLength: 50 * 1024 * 1024  // 50MB max
        });

        const buffer = Buffer.from(response.data);

        // 3. Validate PDF format (magic bytes check)
        if (!isPDFBuffer(buffer)) {
            throw new Error('Downloaded file is not a valid PDF');
        }

        return buffer;

    } catch (err) {
        // 4. Explicit error handling - NO SILENT FAILURE
        if (err.response) {
            throw new Error(`HTTP ${err.response.status}: ${url}`);
        } else if (err.code === 'ECONNABORTED') {
            throw new Error(`Download timeout: ${url}`);
        } else {
            throw new Error(`Download failed: ${err.message}`);
        }
    }
}

/**
 * Download multiple PDFs concurrently (with failure tolerance)
 * @param {string[]} urls - Array of PDF URLs
 * @returns {Promise<{buffers: Buffer[], failed: {url: string, error: string}[]}>}
 */
export async function downloadPDFs(urls) {
    // 1. Validate input
    if (!Array.isArray(urls) || urls.length === 0) {
        throw new Error('URLs must be a non-empty array');
    }

    // 2. Download all concurrently with Promise.allSettled
    //    (partial failure is acceptable)
    const results = await Promise.allSettled(
        urls.map(url => downloadPDF(url))
    );

    // 3. Separate success and failure
    const buffers = [];
    const failed = [];

    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            buffers.push(result.value);
        } else {
            failed.push({
                url: urls[index],
                error: result.reason.message
            });
        }
    });

    // 4. Log results
    console.log(`📥 Downloaded ${buffers.length}/${urls.length} PDFs successfully`);
    if (failed.length > 0) {
        console.warn(`⚠️  ${failed.length} PDFs failed to download`);
        failed.forEach(f => console.warn(`   - ${f.url}: ${f.error}`));
    }

    return { buffers, failed };
}

/**
 * Check if buffer is valid PDF (magic bytes validation)
 * Helper function - single responsibility
 */
function isPDFBuffer(buffer) {
    if (!buffer || buffer.length < 5) return false;
    // PDF files start with %PDF-
    return buffer.slice(0, 5).toString() === '%PDF-';
}
