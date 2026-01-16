import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { wrapGeminiCall } from './rate_limiter.js';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

// Helper: Parse URL field that may contain multiple URLs
// Supports: comma, semicolon, newline, pipe separators
// Also handles JSON array strings like ["url1", "url2"]
function parseUrlField(urlField) {
    if (!urlField) return [];

    let urlString = String(urlField).trim();

    // Handle JSON array format: ["url1", "url2"]
    if (urlString.startsWith('[')) {
        try {
            const parsed = JSON.parse(urlString);
            if (Array.isArray(parsed)) {
                return parsed.map(u => String(u).trim()).filter(u => u.length > 5);
            }
        } catch (e) {
            // Not valid JSON, continue with string parsing
        }
    }

    // Split by common separators: comma, semicolon, newline, pipe
    // But be careful not to split URLs that contain commas in query params
    const urls = urlString
        .split(/[,;\n|]+/)
        .map(u => u.trim())
        .filter(u => u.length > 5 && (u.startsWith('http://') || u.startsWith('https://')));

    return urls;
}

// Helper: Download single media file (images/PDFs only)
async function downloadSingleMedia(url) {
    if (!url) return null;
    try {
        const cleanUrl = url.trim().replace(/["\[\]]/g, '');
        if (cleanUrl.length < 5) return null;

        // Skip non-image/PDF files
        const lowerUrl = cleanUrl.toLowerCase().split('?')[0]; // Remove query params
        const validExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf'];
        if (!validExts.some(ext => lowerUrl.endsWith(ext))) {
            console.log(`      ⏭️ Skipping non-image: ${cleanUrl.substring(0, 50)}...`);
            return null;
        }

        console.log(`      ⬇️ Downloading: ${cleanUrl.substring(0, 50)}...`);
        const response = await axios.get(cleanUrl, { responseType: 'arraybuffer', timeout: 30000 });
        let mimeType = "image/jpeg";
        if (lowerUrl.endsWith('.png')) mimeType = "image/png";
        if (lowerUrl.endsWith('.pdf')) mimeType = "application/pdf";
        if (lowerUrl.endsWith('.webp')) mimeType = "image/webp";
        if (lowerUrl.endsWith('.gif')) mimeType = "image/gif";

        return {
            inlineData: {
                data: Buffer.from(response.data).toString('base64'),
                mimeType: mimeType
            }
        };
    } catch (e) {
        console.error("      ❌ Download failed:", e.message);
        return null;
    }
}

// Helper: Download Media - supports single URL or multiple URLs
async function downloadMedia(urlField) {
    if (!urlField) return [];

    const urls = parseUrlField(urlField);

    // If no valid URLs found, try as single URL (backward compat)
    if (urls.length === 0) {
        const result = await downloadSingleMedia(urlField);
        return result ? [result] : [];
    }

    // Download all URLs
    const results = [];
    for (const url of urls) {
        const result = await downloadSingleMedia(url);
        if (result) results.push(result);
    }
    return results;
}

export async function startProductWorker() {
    console.log("🏭 Universal Spec Worker (With Restrictions): Running...");

    setInterval(async () => {
        try {
            // Find products needing processing (checking 'var_restrictions' as the flag now)
            // If restrictions are null, we assume we need to re-scan this item.
            const { data: products, error } = await supabase
                .from('product_gallery')
                .select('*')
                .is('var_restrictions', null); 

            if (error) throw error;

            if (products && products.length > 0) {
                console.log(`📝 Analyzing ${products.length} products...`);
                
                const model = genAI.getGenerativeModel({ 
                    model: "gemini-3-flash-preview",
                    generationConfig: { responseMimeType: "application/json" } 
                });

                for (const product of products) {
                    console.log(`   👉 Processing: ${product.name}`);
                    
                    const inputs = [];

                    // 1. PRIMARY SOURCES (now returns arrays)
                    const fileParts = await downloadMedia(product.product_file_url);
                    const mainImageParts = await downloadMedia(product.image_url);
                    inputs.push(...fileParts);
                    inputs.push(...mainImageParts);

                    // 2. GALLERY SOURCES
                    if (product.gallery_images && Array.isArray(product.gallery_images)) {
                        const extraImages = product.gallery_images.slice(0, 5); // increased to 5
                        for (const imgUrl of extraImages) {
                            const galleryParts = await downloadMedia(imgUrl);
                            inputs.push(...galleryParts);
                        }
                    }

                    if (inputs.length > 0) {
                        const prompt = `
                        You are a Window Treatment Technical Specifier.
                        Analyze ALL attached images and documents for "${product.name}".
                        
                        Your goal is to extract the CONFIGURATIONS and RESTRICTIONS.
                        Output strictly JSON.

                        JSON Structure:
                        {
                          "var_transparency": "List opacity/openness options (e.g., '1%, 3%, 5%', 'Blackout').",
                          "var_control": "List operation systems (e.g., 'Cordless, Wand Tilt, Motorized').",
                          "var_structure": "List structure variations (e.g. '2-inch Slat', 'Double Cell', 'Flat Fold').",
                          "var_hardware": "List hardware/valance styles (e.g. 'Square Fascia', 'Cassette', 'Z-Frame').",
                          "var_extras": "List add-ons (e.g. 'Top-Down/Bottom-Up', 'Cloth Tapes').",
                          "var_colors": "List primary colors/finishes.",
                          "var_restrictions": "List CRITICAL limitations. (e.g. 'Max width 96 inches', 'Not for humid areas', 'Indoor use only', 'Requires 3 inch depth'). If none found, write 'Standard installation'.",
                          "ai_description": "A Complete sales summary."
                        }
                        `;
                        
                        inputs.push(prompt);

                        try {
                            const result = await wrapGeminiCall(() => model.generateContent(inputs));
                            const data = JSON.parse(result.response.text());

                            await supabase
                                .from('product_gallery')
                                .update({
                                    var_transparency: data.var_transparency,
                                    var_control: data.var_control,
                                    var_structure: data.var_structure,
                                    var_hardware: data.var_hardware,
                                    var_extras: data.var_extras,
                                    var_colors: data.var_colors,
                                    var_restrictions: data.var_restrictions, // <--- New Field
                                    ai_description: data.ai_description
                                })
                                .eq('id', product.id);
                                
                            console.log(`      ✅ Specs & Restrictions Updated.`);
                            
                        } catch (aiErr) {
                            console.error(`      ❌ AI Analysis Failed:`, aiErr.message);
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Worker Error:", err.message);
        }
    }, 15000); 
}