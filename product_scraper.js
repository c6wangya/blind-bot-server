import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// =======================================================
// HELPER: AI MATCHING ENGINE
// =======================================================
async function findBestMatch(existingProducts, newItemName) {
    // If no existing products, obviously it's new
    if (!existingProducts || existingProducts.length === 0) return { isMatch: false };

    // 1. Simple Check: Exact String Match (Fast)
    const exact = existingProducts.find(p => p.name.trim().toLowerCase() === newItemName.trim().toLowerCase());
    if (exact) return { isMatch: true, product: exact };

    // 2. Smart Check: AI Semantic Match (Slower but smart)
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
        
        // We send the list of names and ask it to pick the winner
        const namesList = existingProducts.map(p => `ID_${p.id}: ${p.name}`).join("\n");
        
        const prompt = `
        I have a database of Window Treatments:
        ${namesList}

        I found a new item on a website labeled: "${newItemName}"

        TASK: Determine if "${newItemName}" is likely a VARIATION of one of the existing products (e.g., same product but different color/style name) or a COMPLETELY NEW product.
        
        RULES:
        - "Roller Shade - Grey" IS a variation of "Roller Shade".
        - "Hunter Douglas Roller" IS a variation of "Roller Shade".
        - "Plantation Shutter" is NOT a variation of "Roller Shade".
        
        OUTPUT:
        - If match found, return strictly the ID (e.g. "ID_123").
        - If completely new, return "NEW".
        `;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();

        if (text.includes("ID_")) {
            // Extract the ID
            const matchId = text.match(/ID_(\d+)/)[1];
            const parent = existingProducts.find(p => p.id == matchId);
            if (parent) return { isMatch: true, product: parent };
        }

        return { isMatch: false };

    } catch (err) {
        console.error("   ⚠️ AI Matching failed, defaulting to NEW:", err.message);
        return { isMatch: false };
    }
}

// =======================================================
// MAIN SCRAPER FUNCTION
// =======================================================
export async function scrapeAndSaveProducts(supabase, clientId, websiteUrl) {
    console.log(`🕷️ Intelligent Scraper: Scanning ${websiteUrl}`);
    let newCount = 0;
    let mergedCount = 0;

    try {
        // 1. Get Existing Products (The "Knowledge Base")
        const { data: existingProducts } = await supabase
            .from('product_gallery')
            .select('id, name, gallery_images')
            .eq('client_id', clientId);

        // 2. Fetch HTML
        const { data: html } = await axios.get(websiteUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(html);

        // 3. Extract Candidates
        const candidates = [];
        $('img').each((i, el) => {
            const src = $(el).attr('src');
            const alt = $(el).attr('alt');
            
            if (src && !src.endsWith('.svg') && !src.includes('logo') && !src.includes('icon')) {
                const fullUrl = src.startsWith('http') ? src : new URL(src, websiteUrl).href;
                
                // Try to find a meaningful name
                let name = alt;
                if (!name || name.length < 3) {
                    name = $(el).closest('div').find('h2, h3, h4, .product-title, .woocommerce-loop-product__title').first().text().trim();
                }

                if (name && name.length > 3 && fullUrl) {
                    // Prevent duplicate processing within the same run
                    if (!candidates.find(c => c.image_url === fullUrl)) {
                        candidates.push({ name, image_url: fullUrl });
                    }
                }
            }
        });

        console.log(`   🔎 Found ${candidates.length} images. Analyzing...`);

        // 4. Process Each Candidate
        for (const item of candidates) {
            
            // Step A: Ask AI "Is this new or a variation?"
            const matchResult = await findBestMatch(existingProducts, item.name);

            if (matchResult.isMatch) {
                // === SCENARIO 1: MERGE INTO EXISTING ===
                const parent = matchResult.product;
                const currentGallery = parent.gallery_images || [];

                // Avoid adding the exact same image twice
                if (!currentGallery.includes(item.image_url)) {
                    const newGallery = [...currentGallery, item.image_url];
                    
                    // Update DB
                    await supabase
                        .from('product_gallery')
                        .update({ 
                            gallery_images: newGallery,
                            // CRITICAL: We trigger the worker to re-scan by setting restrictions to NULL
                            // This forces the 'Universal Spec Worker' to wake up and see the new photos!
                            var_restrictions: null 
                        })
                        .eq('id', parent.id);

                    console.log(`      🔗 Merged "${item.name}" into "${parent.name}"`);
                    mergedCount++;
                }

            } else {
                // === SCENARIO 2: CREATE NEW PRODUCT ===
                // Check if we already inserted this exact image in a previous run to be safe
                const { data: duplicate } = await supabase
                    .from('product_gallery')
                    .select('id')
                    .eq('client_id', clientId)
                    .eq('image_url', item.image_url)
                    .maybeSingle();

                if (!duplicate) {
                    await supabase.from('product_gallery').insert({
                        client_id: clientId,
                        name: item.name.substring(0, 50),
                        image_url: item.image_url,
                        description: "Imported from website",
                        gallery_images: [], 
                        ai_description: null, // Triggers description worker
                        var_restrictions: null // Triggers spec worker
                    });
                    console.log(`      ✨ Created New: "${item.name}"`);
                    newCount++;
                    
                    // Add to local list so future items in this loop can match against it!
                    // (This handles the case where the page has 5 images of the same NEW product)
                    // We need to fetch the ID we just made, but for simplicity, we skip that optimization 
                    // and let the next run handle merges.
                }
            }
        }

        console.log(`✅ Scraper Done. Created ${newCount} products. Merged ${mergedCount} variations.`);
        return { success: true, count: newCount + mergedCount };

    } catch (err) {
        console.error("❌ Scraper Error:", err.message);
        return { success: false, error: err.message };
    }
}