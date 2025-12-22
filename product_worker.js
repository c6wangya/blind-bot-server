// product_worker.js
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Use Service Key for database write permissions if available, otherwise fallback to standard key
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

// Helper to download image for Gemini
async function urlToGenerativePart(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return {
            inlineData: {
                data: Buffer.from(response.data).toString('base64'),
                mimeType: "image/jpeg"
            }
        };
    } catch (e) { 
        console.error("❌ Failed to download image for AI analysis:", e.message);
        return null; 
    }
}

export async function startProductWorker() {
    console.log("🛒 Product Worker: Started. Monitoring for new products...");

    // Run every 30 seconds
    setInterval(async () => {
        try {
            // 1. Find products where ai_description is NULL but image_url exists
            const { data: products, error } = await supabase
                .from('product_gallery')
                .select('*')
                .is('ai_description', null)
                .not('image_url', 'is', null);

            if (error) throw error;

            if (products && products.length > 0) {
                console.log(`🧹 Found ${products.length} products missing AI descriptions. Processing...`);
                const visionModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

                for (const product of products) {
                    console.log(`   -> Generating description for: ${product.name}`);
                    
                    const imagePart = await urlToGenerativePart(product.image_url);
                    
                    if (imagePart) {
                        // Prompt tailored for visual generation context
                        const prompt = "Describe the window treatment in this image specifically for an AI image generator. Focus on texture, color, material, style (e.g. zebra, roller), and light filtering. Keep it under 20 words.";
                        
                        try {
                            const result = await visionModel.generateContent([prompt, imagePart]);
                            const aiDesc = result.response.text();

                            // Update the database
                            const { error: updateError } = await supabase
                                .from('product_gallery')
                                .update({ ai_description: aiDesc })
                                .eq('id', product.id);
                                
                            if (updateError) console.error(`      ❌ DB Save Failed: ${updateError.message}`);
                            else console.log(`      ✅ Description Saved!`);
                            
                        } catch (aiErr) {
                            console.error(`      ❌ AI Generation Failed for ${product.name}:`, aiErr.message);
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Product Worker Error:", err.message);
        }
    }, 30000); 
}