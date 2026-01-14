import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { wrapGeminiCall } from './rate_limiter.js';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

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
    console.log("👷 Persona Worker: Started.");
    setInterval(async () => {
        try {
            // Only find clients who HAVE NO persona yet (First time setup)
            const { data: clients } = await supabase
                .from('clients')
                .select('*')
                .or('training_pdf.neq.null,sales_prompt_override.neq.null') 
                .is('bot_persona', null); 

            if (clients && clients.length > 0) {
                console.log(`📝 Found ${clients.length} new clients needing setup...`);
                for (const client of clients) {
                    // Call the new helper function
                    await generateClientPersona(client);
                }
            }
        } catch (err) {
            console.error("Persona Worker Error:", err.message);
        }
    }, 10000); 
}
// --- CORE LOGIC: Generate Persona for One Client ---
// We extracted this so the button can use it!
export async function generateClientPersona(client) {
    console.log(`   -> Processing Persona for: ${client.company_name}`);
    // Use 1.5 Flash for speed/PDFs or the model you prefer
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" }); 

    const inputs = [];
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

    // Add PDF if exists
    if (client.training_pdf) {
        const pdfPart = await downloadFileForGemini(client.training_pdf);
        if (pdfPart) inputs.push(pdfPart);
    }

    // Generate with rate limiting
    const result = await wrapGeminiCall(() => model.generateContent(inputs));
    const generatedPersona = result.response.text();

    // Save to DB
    const { error } = await supabase
        .from('clients')
        .update({ bot_persona: generatedPersona })
        .eq('id', client.id);

    if (error) {
        throw new Error(`DB Error: ${error.message}`);
    } else {
        console.log(`      ✅ Persona Saved for ${client.company_name}!`);
        return true;
    }
}

// --- MANUAL TRIGGER: Force Update ---
// This is what the button calls
export async function forceRetrainClient(apiKey) {
    const { data: client } = await supabase.from('clients').select('*').eq('api_key', apiKey).single();
    if (!client) throw new Error("Client not found");
    
    console.log(`🔄 Manual Retrain Triggered for ${client.company_name}`);
    await generateClientPersona(client);
    return true;
}