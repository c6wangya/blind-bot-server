import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Allow large payloads

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- HELPER: DOWNLOAD IMAGE & CONVERT TO BASE64 ---
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
        console.error("Failed to download image:", url);
        return null; // Skip broken images
    }
}

// --- SYSTEM INSTRUCTIONS ---
const systemPrompt = `
You are a senior sales agent for "The Window Valet". 
GOAL: Secure a lead by getting the customer's CONTACT INFO and a HOME VISIT TIME.

CORE INFO:
- Products: Roller Shades, Zebra Blinds, Shutters, Motorization.
- Owner: Josh LeClair.
- Location: Indianapolis, IN.

RULES:
1. **The Home Visit:** You MUST try to schedule a "Free In-Home Estimate." Ask: "When would be a good time for us to come out and measure?"
2. **Contact Info:** You MUST get their Name AND (Phone OR Email). 
3. **Preference:** Ask: "Do you prefer we contact you via phone, text, or email?"
4. **Validation:** If they give a time but no phone/email, keep asking for contact info. You cannot book a slot without a contact.

OUTPUT FORMAT:
Reply in valid JSON format ONLY. Structure:
{
  "reply": "Your response to the customer",
  "lead_captured": boolean, (TRUE only if you have Name AND (Phone OR Email)),
  "customer_name": "extracted name or null",
  "customer_phone": "extracted phone or null",
  "customer_email": "extracted email or null",
  "customer_address": "extracted address or null",
  "appointment_request": "extracted date/time preference or null",
  "preferred_method": "Phone, Text, or Email",
  "ai_summary": "A 2-sentence summary of what they want and their vibe (e.g. 'Customer wants zebra blinds for living room, very price conscious, requested Tuesday visit.')"
}
`;

app.get('/init', async (req, res) => {
    // ... (Keep this the same as before, or copy from previous code if lost) ...
    // For brevity, assuming you have the INIT code. If not, ask me and I'll paste it full.
    try {
        const apiKey = req.query.apiKey;
        if (!apiKey) return res.status(400).json({ error: "Missing API Key" });
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', apiKey).single();
        if (!client) return res.status(404).json({ error: "Client not found" });
        res.json({
            name: client.company_name, logo: client.logo_url || "", color: client.primary_color || "#007bff", title: client.bot_title || "Sales Assistant", website: client.website_url
        });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;

        // 1. Check Kill Switch
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client || client.status !== 'active') return res.json({ reply: "Service Suspended." });

        // 2. Setup Gemini
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: systemPrompt,
            generationConfig: { responseMimeType: "application/json" }
        });

        // 3. Image Handling (Keep your existing image logic here!)
        // ... (Copy the multi-image parsing logic from your previous server.js) ...
        // [For brevity, I assume you kept the image parsing code. If not, I can re-paste it].
        // Let's assume 'currentPromptParts' is built correctly here.
        
        // --- RE-INSERTING IMAGE LOGIC FOR SAFETY ---
        let currentPromptParts = [];
        const lastEntry = history[history.length - 1];
        let foundImage = false;
        
        for (const part of lastEntry.parts) {
            const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
            if (imgMatch) {
                foundImage = true;
                const imagePart = await urlToGenerativePart(imgMatch[1]); // Ensure helper function exists
                if (imagePart) currentPromptParts.push(imagePart);
            } else {
                currentPromptParts.push({ text: part.text });
            }
        }
        if (foundImage && currentPromptParts.every(p => p.inlineData)) {
            currentPromptParts.push({ text: "I have uploaded photos. Please analyze." });
        }
        // -------------------------------------------

        const result = await model.generateContent(currentPromptParts);
        const text = result.response.text();
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResponse = JSON.parse(cleanText);

        // 4. LEAD CAPTURE LOGIC (STRICT)
        // Only save if lead_captured is TRUE (which Gemini only sets if Name + Contact exists)
        if (jsonResponse.lead_captured === true) {
            
            // Double Validation: Code check
            const hasContact = jsonResponse.customer_phone || jsonResponse.customer_email;
            
            if (hasContact) {
                console.log("🔥 SAVING LEAD:", jsonResponse.customer_name);
                
                await supabase.from('leads').insert({
                    client_id: client.id,
                    customer_name: jsonResponse.customer_name,
                    customer_phone: jsonResponse.customer_phone,
                    customer_email: jsonResponse.customer_email,
                    customer_address: jsonResponse.customer_address,
                    
                    // NEW FIELDS
                    appointment_request: jsonResponse.appointment_request,
                    preferred_method: jsonResponse.preferred_method,
                    ai_summary: jsonResponse.ai_summary,
                    
                    full_transcript: JSON.stringify(history) 
                });
            }
        }

        res.json({ reply: jsonResponse.reply });

    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).json({ reply: "I'm having trouble connecting right now." });
    }
});

app.listen(3000, () => console.log('🚀 Multi-Vision Agent Running'));