import { PDFDocument } from 'pdf-lib';

/**
 * Merge multiple PDF buffers into one
 * @param {Buffer[]} pdfBuffers - Array of PDF buffers
 * @returns {Promise<Buffer>} - Merged PDF buffer
 * @throws {Error} - If all PDFs are invalid or merge fails
 */
export async function mergePDFs(pdfBuffers) {
    // 1. Validate input
    if (!Array.isArray(pdfBuffers) || pdfBuffers.length === 0) {
        throw new Error('PDF buffers must be a non-empty array');
    }

    // 2. Create new merged PDF document
    const mergedPdf = await PDFDocument.create();

    // 3. Track success/failure
    let successCount = 0;
    const failed = [];

    // 4. Process each PDF buffer
    for (let i = 0; i < pdfBuffers.length; i++) {
        try {
            // Load PDF from buffer
            const pdfDoc = await PDFDocument.load(pdfBuffers[i]);

            // Copy all pages from this PDF
            const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());

            // Add pages to merged document
            pages.forEach(page => mergedPdf.addPage(page));

            successCount++;
            console.log(`   ✅ Merged PDF #${i + 1} (${pages.length} pages)`);

        } catch (err) {
            // Log failure but continue processing others
            failed.push({ index: i, error: err.message });
            console.warn(`   ⚠️  PDF #${i + 1} failed to merge: ${err.message}`);
        }
    }

    // 5. Check if we have any valid PDFs
    if (successCount === 0) {
        throw new Error(`All ${pdfBuffers.length} PDFs failed to merge`);
    }

    // 6. Log summary
    console.log(`📄 Merged ${successCount}/${pdfBuffers.length} PDFs successfully`);
    if (failed.length > 0) {
        console.warn(`⚠️  ${failed.length} PDFs were skipped due to errors`);
    }

    // 7. Return merged PDF as buffer
    const mergedBytes = await mergedPdf.save();
    return Buffer.from(mergedBytes);
}

/**
 * Merge PDFs with size limit check
 * @param {Buffer[]} pdfBuffers - Array of PDF buffers
 * @param {number} maxSizeBytes - Max allowed size (default 100MB)
 * @returns {Promise<Buffer>} - Merged PDF buffer
 * @throws {Error} - If merge fails or exceeds size limit
 */
export async function mergePDFsWithLimit(pdfBuffers, maxSizeBytes = 100 * 1024 * 1024) {
    // 1. Calculate total size
    const totalSize = pdfBuffers.reduce((sum, buf) => sum + buf.length, 0);

    // 2. Check size limit BEFORE merging (fail fast)
    if (totalSize > maxSizeBytes) {
        const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
        const limitMB = (maxSizeBytes / 1024 / 1024).toFixed(2);
        throw new Error(`Total PDF size ${sizeMB}MB exceeds limit of ${limitMB}MB`);
    }

    // 3. Merge PDFs
    const mergedBuffer = await mergePDFs(pdfBuffers);

    // 4. Verify merged size (sanity check)
    const mergedSizeMB = (mergedBuffer.length / 1024 / 1024).toFixed(2);
    console.log(`📦 Merged PDF size: ${mergedSizeMB} MB`);

    return mergedBuffer;
}
