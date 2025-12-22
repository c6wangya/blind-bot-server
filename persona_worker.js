import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
// Note: We NO LONGER need 'pdf-extraction'

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Use Service Key for database write permissions
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

// --- HELPER: Prepare File for Gemini (Native PDF Support) ---
async function downloadFileForGemini(url) {
    if (!url) return null;
    try {
        const safeUrl = encodeURI(url);
        console.log(`      📂 Downloading: ${safeUrl}`);
        const response = await axios.get(safeUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        const mimeType = url.toLowerCase().endsWith('.pdf') ? "application/pdf" : "image/jpeg";

        // Return the format Gemini expects for inline data
        return {
            inlineData: {
                data: buffer.toString('base64'),
                mimeType: mimeType
            }
        };
    } catch (e) {
        console.error("      ❌ File download failed:", e.message);
        return null;
    }
}

export async function startPersonaWorker() {
    console.log("👷 Persona Worker: Started. Using Gemini Native PDF Vision...");

    setInterval(async () => {
        try {
            // 1. Find clients who need an update
            const { data: clients } = await supabase
                .from('clients')
                .select('*')
                .or('training_pdf.neq.null,sales_prompt_override.neq.null') 
                .is('bot_persona', null); 

            if (clients && clients.length > 0) {
                console.log(`📝 Found ${clients.length} clients needing AI Persona generation...`);
                // Use the 2.5 Flash model (Great for documents)
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

                for (const client of clients) {
                    console.log(`   -> Processing: ${client.company_name}`);
                    
                    const inputs = [];

                    // 1. Add System Instructions
                    const override = client.sales_prompt_override || "No specific owner instructions.";
                    const promptText = `
                    You are an expert AI Sales System Architect.
                    
                    YOUR GOAL: 
                    Read the attached document (PDF) and the Owner Instructions below.
                    Write a "System Instruction" block for a Sales Chatbot.
                    
                    OWNER INSTRUCTIONS: "${override}"

                    RULES:
                    - The attached PDF contains the source of truth. READ IT VISUALLY.
                    - EXTRACT Policy, Discounts, Hours, Contact Info, and Company History.
                    - IF Owner Instructions contradict PDF, Owner Instructions WIN.
                    - Output format: "You are the sales assistant for [Company]..."
                    `;
                    inputs.push(promptText);

                    // 2. Add the PDF (If it exists)
                    if (client.training_pdf) {
                        const pdfPart = await downloadFileForGemini(client.training_pdf);
                        if (pdfPart) {
                            inputs.push(pdfPart);
                            console.log("      📄 Attached PDF to Prompt");
                        }
                    }

                    // 3. Generate
                    const result = await model.generateContent(inputs);
                    const generatedPersona = result.response.text();

                    // 4. Save
                    const { error } = await supabase
                        .from('clients')
                        .update({ bot_persona: generatedPersona })
                        .eq('id', client.id);

                    if (error) console.error(`      ❌ DB Error: ${error.message}`);
                    else console.log(`      ✅ Persona Saved for ${client.company_name}!`);
                }
            }
        } catch (err) {
            console.error("Persona Worker Error:", err.message);
        }
    }, 10000); 
}