import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp'; 
import { createRequire } from 'module'; 
import { TaskType } from "@google/generative-ai";

const require = createRequire(import.meta.url);
const pdfLib = require('pdf-parse');
const pdf = pdfLib.default || pdfLib;

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==================================================================
// 1. HELPER FUNCTIONS
// ==================================================================

async function urlToGenerativePart(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return {
            inlineData: {
                data: Buffer.from(response.data).toString('base64'),
                mimeType: "image/jpeg"
            }
        };
    } catch (e) { return null; }
}

async function smartResize(buffer) {
    // (Keep your existing smartResize logic here - omitted for brevity, copy from previous file)
    // ... [Copy existing smartResize code] ...
    return await sharp(buffer).resize(1024, 1024, { fit: 'cover' }).toBuffer(); // Simplified for example
}

async function generateRendering(sourceImageUrl, promptText) {
    try {
        console.log("🎨 Downloading customer room image...");
        const imageResponse = await axios.get(sourceImageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageResponse.data);

        console.log("💎 Sending to Stability AI...");
        const payload = new FormData();
        payload.append('image', buffer, 'source.jpg');
        payload.append('strength', 0.65); 
        
        // COMBINED PROMPT: Owner Desc + AI Summary + Standard Quality Tags
        const fullPrompt = `${promptText}, fully closed, covering window, interior design photography, 8k, professional lighting`;
        
        payload.append('prompt', fullPrompt);
        payload.append('output_format', 'png');
        payload.append('negative_prompt', 'distorted, blurry, open blinds, bad architecture');

        const response = await axios.post(
            'https://api.stability.ai/v2beta/stable-image/generate/core',
            payload,
            { headers: { ...payload.getHeaders(), Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'application/json' } }
        );

        const base64Image = response.data.image; 
        const fileName = `renderings/${Date.now()}_render.png`;
        const { error } = await supabase.storage.from('chat-uploads').upload(fileName, Buffer.from(base64Image, 'base64'), { contentType: 'image/png' });
        
        const { data: urlData } = supabase.storage.from('chat-uploads').getPublicUrl(fileName);
        return urlData.publicUrl;
    } catch (err) {
        console.error("Stability Error:", err.response ? err.response.data : err.message);
        return null;
    }
}

// ==================================================================
// 2. NEW ENDPOINT: UPLOAD PRODUCT TO GALLERY
// ==================================================================
app.post('/add-product', async (req, res) => {
    try {
        const { clientApiKey, name, description, imageUrl } = req.body;

        // 1. Verify Client
        const { data: client } = await supabase.from('clients').select('id').eq('api_key', clientApiKey).single();
        if (!client) return res.status(401).json({ error: "Invalid API Key" });

        // 2. Generate AI Description of the Product Image
        console.log(`🤖 Generating AI description for ${name}...`);
        const visionModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const imagePart = await urlToGenerativePart(imageUrl);
        
        const prompt = "Describe the window treatment in this image in detail. Focus on the texture, material, light filtering properties, and style. Keep it under 30 words.";
        const result = await visionModel.generateContent([prompt, imagePart]);
        const aiDescription = result.response.text();

        // 3. Save to Database
        const { error } = await supabase.from('product_gallery').insert({
            client_id: client.id,
            name: name,
            description: description, // Owner's Manual Description
            ai_description: aiDescription, // AI's Visual Analysis
            image_url: imageUrl
        });

        if (error) throw error;
        res.json({ success: true, ai_description: aiDescription });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to add product" });
    }
});

// ==================================================================
// 3. CHAT ENDPOINT
// ==================================================================
app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;
        
        const { data: client } = await supabase.from('clients').select('*').eq('api_key', clientApiKey).single();
        if (!client) return res.json({ reply: "Service Suspended." });

        // A. FETCH PRODUCTS FROM NEW GALLERY TABLE
        const { data: products } = await supabase
            .from('product_gallery')
            .select('name, description, ai_description, image_url')
            .eq('client_id', client.id);

        const productNames = products ? products.map(p => p.name).join(", ") : "Standard Blinds";
        
        // B. SYSTEM PROMPT
        const finalSystemPrompt = `
        CRITICAL: You DO NOT speak plain text. You ONLY speak JSON.
        Structure:
        {
          "reply": "text",
          "product_suggestions": [ { "name": "Exact Name From List", "image": "URL", "id": "index" } ],
          "visualize": boolean,
          "selected_product_name": "Exact Name From List" 
        }

        YOUR KNOWLEDGE:
        ${client.bot_persona || "You are a sales assistant."}
        
        AVAILABLE PRODUCTS: ${productNames}

        LOGIC:
        1. If user uploads a room image but NO style is selected -> Set "visualize": false. Reply "I see your room! Which style would you like?" and fill "product_suggestions" with the available products.
        2. If user selects a product (e.g. "I want Zebra Blinds") -> Set "visualize": true, and set "selected_product_name" to the exact name.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: finalSystemPrompt, generationConfig: { responseMimeType: "application/json" } });
        
        // C. Parse History for Image
        const pastHistory = history.slice(0, -1);
        const chat = model.startChat({ history: pastHistory });
        const lastTurn = history[history.length - 1];
        
        let currentParts = [];
        let sourceImageUrl = null;
        
        for (const part of lastTurn.parts) {
            const imgMatch = part.text.match(/\[IMAGE_URL: (.*?)\]/);
            if (imgMatch) sourceImageUrl = imgMatch[1];
            currentParts.push(part);
        }

        // D. Gemini Response
        const result = await chat.sendMessage(currentParts);
        const jsonResponse = JSON.parse(result.response.text());

        // E. Inject Images into Suggestions
        if (jsonResponse.product_suggestions && products) {
            jsonResponse.product_suggestions = products.map(p => ({
                name: p.name,
                image: p.image_url
            }));
        }

        // F. Handle Visualization
        if (jsonResponse.visualize && jsonResponse.selected_product_name && sourceImageUrl) {
            // FIND THE PRODUCT IN DB
            const selectedProduct = products.find(p => p.name.toLowerCase() === jsonResponse.selected_product_name.toLowerCase());
            
            if (selectedProduct) {
                // *** THE MAGIC PROMPT FORMULA ***
                // Owner's Description + AI's Description
                const combinedPrompt = `${selectedProduct.description}. ${selectedProduct.ai_description}`;
                
                console.log(`🎨 Generating with prompt: ${combinedPrompt}`);
                
                const renderUrl = await generateRendering(sourceImageUrl, combinedPrompt);
                if (renderUrl) jsonResponse.reply += `\n\n[RENDER_URL: ${renderUrl}]`;
            }
        }

        res.json(jsonResponse);

    } catch (err) {
        console.error(err);
        res.status(500).json({ reply: "Error processing request." });
    }
});

app.listen(3000, () => console.log('🚀 Gallery Agent Running'));