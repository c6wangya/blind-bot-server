import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { createRequire } from 'module'; 

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse'); // ✅ Simplified import

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- HELPER: Download & Parse File ---
async function extractContentFromUrl(url) {
    if (!url) return null;
    try {
        // ✅ Fix: Handle spaces in filenames (e.g. "home screen.pdf")
        const safeUrl = encodeURI(url);
        
        console.log(`      📂 Downloading PDF: ${safeUrl}`);
        const response = await axios.get(safeUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        // 1. If PDF -> Extract Text
        if (url.toLowerCase().includes('.pdf')) {
            // Safety Check: Ensure it's actually a PDF buffer
            if (buffer.lastIndexOf("%PDF-", 0) === 0) {
                 const data = await pdfParse(buffer);
                 return data.text.substring(0, 30000); // Limit text length
            } else {
                 console.log("      ⚠️ Warning: File extension is .pdf but content is not.");
                 return null;
            }
        } 
        // 2. If Image -> Prepare for Vision Model
        else {
             // For images, we skip text parsing and return a placeholder 
             // (or you can add Vision logic here if you want image analysis)
            return "[Image Content Not Parsed in this version]";
        }
    } catch (e) {
        console.error("      ❌ File parsing failed:", e.message);
        return null;
    }
}

// --- MAIN WORKER ---
export async function startPersonaWorker() {
    console.log("👷 Persona Worker: Watching 'training_pdf' and 'sales_prompt_override'...");

    setInterval(async () => {
        try {
            // 1. Find clients who need a Persona update
            const { data: clients, error } = await supabase
                .from('clients')
                .select('*')
                .or('training_pdf.neq.null,sales_prompt_override.neq.null') 
                .is('bot_persona', null); 

            if (clients && clients.length > 0) {
                console.log(`📝 Found ${clients.length} clients needing AI Persona generation...`);
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

                for (const client of clients) {
                    console.log(`   -> Processing: ${client.company_name}`);
                    
                    // A. Get PDF Content (if it exists)
                    let pdfContent = "No Training Document provided.";
                    if (client.training_pdf) {
                        const extracted = await extractContentFromUrl(client.training_pdf);
                        if (extracted) pdfContent = extracted;
                    }

                    // B. Get Override Instructions (if it exists)
                    const override = client.sales_prompt_override || "No specific owner instructions.";

                    // C. Build the Prompt for the AI Architect
                    const systemPrompt = `
                    You are an expert AI Sales System Architect.
                    
                    YOUR GOAL: 
                    Write a single, highly effective "System Instruction" block for a Sales Chatbot.
                    This instruction block will be fed into the chatbot later to tell it how to behave.
                    
                    INPUT DATA:
                    1. OWNER INSTRUCTIONS (High Priority): "${override}"
                    2. COMPANY DOCUMENTS (Background Info): "${pdfContent}"

                    CRITICAL RULES FOR THE OUTPUT:
                    - IGNORE visual descriptions in the PDF (logos, layout).
                    - EXTRACT Policy, Discounts, Hours, and Contact Info from the PDF.
                    - If the Owner Instructions contradict the PDF, the Owner Instructions WIN.
                    - The output must be written in the second person ("You are the sales assistant for...").
                    - Keep it concise (under 300 words) but include all hard facts.
                    
                    GENERATE THE SYSTEM INSTRUCTION NOW:
                    `;

                    // D. Generate the Persona
                    const result = await model.generateContent(systemPrompt);
                    const generatedPersona = result.response.text();

                    // E. Save to Supabase
                    await supabase
                        .from('clients')
                        .update({ bot_persona: generatedPersona })
                        .eq('id', client.id);

                    console.log(`      ✅ Persona Saved!`);
                }
            }
        } catch (err) {
            console.error("Persona Worker Error:", err.message);
        }
    }, 10000); // Check every 10 seconds
}