import { downloadPDFs } from './downloader.js';
import { mergePDFsWithLimit } from './merger.js';
import { extractPDFMetadata } from './utils.js';

/**
 * Complete PDF processing pipeline: Download → Merge → Analyze
 * @param {string[]} urls - Array of PDF URLs
 * @param {Object} options - Pipeline options
 * @param {number} options.maxSizeBytes - Max merged size (default 100MB)
 * @param {number} options.maxCount - Max PDF count (default 10)
 * @returns {Promise<{buffer: Buffer, metadata: Object, failed: Array}>}
 * @throws {Error} - If all downloads fail or merge fails
 */
export async function processPDFPipeline(urls, options = {}) {
    const maxSizeBytes = options.maxSizeBytes || 100 * 1024 * 1024;
    const maxCount = options.maxCount || 5;

    console.log('📥 Starting PDF Pipeline...');
    console.log(`   URLs: ${urls.length}`);
    console.log(`   Max Count: ${maxCount}`);
    console.log(`   Max Size: ${(maxSizeBytes / 1024 / 1024).toFixed(0)}MB`);

    // 1. Validate URL count
    if (urls.length > maxCount) {
        throw new Error(`Too many PDFs: ${urls.length} exceeds limit of ${maxCount}`);
    }

    // 2. Download all PDFs (with failure tolerance)
    const { buffers, failed } = await downloadPDFs(urls);

    // 3. Check if we have any valid PDFs
    if (buffers.length === 0) {
        throw new Error('All PDF downloads failed');
    }

    // 4. Merge PDFs (with size limit check)
    const mergedBuffer = await mergePDFsWithLimit(buffers, maxSizeBytes);

    // 5. Extract metadata from merged PDF
    const metadata = await extractPDFMetadata(mergedBuffer);

    console.log('✅ PDF Pipeline Complete');
    console.log(`   Total Pages: ${metadata.pageCount}`);
    console.log(`   Size: ${metadata.sizeKB}KB`);

    return {
        buffer: mergedBuffer,
        metadata,
        failed
    };
}
