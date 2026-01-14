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
 * @param {Object} client - Client record from database
 * @returns {string[]} - Array of PDF URLs (deduplicated)
 */
export function getPDFUrls(client) {
    const urls = [];

    // 1. Check new field first (training_pdfs array)
    if (client.training_pdfs && Array.isArray(client.training_pdfs)) {
        urls.push(...client.training_pdfs);
    }

    // 2. Check old field (training_pdf single URL)
    if (client.training_pdf && typeof client.training_pdf === 'string') {
        urls.push(client.training_pdf);
    }

    // 3. Deduplicate URLs (use Set)
    const uniqueUrls = [...new Set(urls)];

    return uniqueUrls;
}
