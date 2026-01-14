import { PDFDocument } from 'pdf-lib';

/**
 * Extract metadata from PDF buffer
 * @param {Buffer} pdfBuffer - PDF buffer
 * @returns {Promise<{pageCount: number, sizeKB: number, title: string|null}>}
 * @throws {Error} - If PDF is invalid
 */
export async function extractPDFMetadata(pdfBuffer) {
    // 1. Validate input
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
        throw new Error('Invalid PDF buffer');
    }

    try {
        // 2. Load PDF
        const pdfDoc = await PDFDocument.load(pdfBuffer);

        // 3. Extract basic metadata
        const pageCount = pdfDoc.getPageCount();
        const sizeKB = Math.round(pdfBuffer.length / 1024);

        // 4. Try to extract title (may not exist)
        let title = null;
        try {
            title = pdfDoc.getTitle() || null;
        } catch (e) {
            // Title may not be set - not an error
        }

        return { pageCount, sizeKB, title };

    } catch (err) {
        throw new Error(`Failed to extract PDF metadata: ${err.message}`);
    }
}

/**
 * Get helper to retrieve PDF URLs from client record
 * Supports both old (training_pdf) and new (training_pdfs) fields
 * Priority: training_pdfs > training_pdf (if both exist, use training_pdfs only)
 * @param {Object} client - Client record from database
 * @returns {string[]} - Array of PDF URLs (deduplicated)
 */
export function getPDFUrls(client) {
    const urls = [];

    // Priority 1: Check new field (training_pdfs array)
    // If this field exists and has data, use it exclusively
    if (client.training_pdfs && Array.isArray(client.training_pdfs) && client.training_pdfs.length > 0) {
        urls.push(...client.training_pdfs);
    }
    // Priority 2: Fallback to old field (training_pdf single URL)
    // Only use if training_pdfs doesn't exist or is empty
    else if (client.training_pdf && typeof client.training_pdf === 'string') {
        urls.push(client.training_pdf);
    }

    // Deduplicate URLs (use Set)
    const uniqueUrls = [...new Set(urls)];

    return uniqueUrls;
}
