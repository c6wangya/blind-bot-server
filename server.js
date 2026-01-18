import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp';
import { createRequire } from 'module';
import { TaskType } from "@google/generative-ai";
import { startProductWorker } from './product_worker.js';
import { validateClientAccess, deductImageCredit } from './subscription_manager.js';
import { startPersonaWorker, forceRetrainClient } from './persona_worker.js';
import { setupStripeWebhook, createPortalSession, seedDemoData } from './stripe_handler.js';
import { handleLeadData } from './leads_manager.js';
import { setupPreviewRoutes } from './preview_handler.js';
import { scrapeAndSaveProducts } from './product_scraper.js';
import { setupStatsRoutes } from './stats_handler.js';
import { Resend } from 'resend';
import { testEmailConfiguration } from './email_handler.js';
import { wrapGeminiCall } from './rate_limiter.js';
import { downloadAndConvertImage, ensureBrowserCompatible, compressForRendering } from './image_utils.js';
import { processPDFPipeline } from './services/pdf/pipeline.js';
import { APP_ENV, corsOptions, EMAIL_FROM_SUPPORT, EMAIL_ADMIN_TO } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

dotenv.config();
const app = express();
app.use(cors(corsOptions));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
setupStripeWebhook(app, supabase);
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Dynamic widget route: /widget/API_KEY.js - for GTM compatibility
// GTM strips query params and data attributes, so embed the key in the URL path
app.get('/widget/:apiKey.js', (req, res) => {
    const apiKey = req.params.apiKey;
    const widgetPath = path.join(__dirname, 'public', 'widget.js');

    fs.readFile(widgetPath, 'utf8', (err, content) => {
        if (err) {
            return res.status(500).send('Error loading widget');
        }
        // Inject API key at the top of the script
        const injectedScript = `window.BLINDBOT_API_KEY = "${apiKey}";\n` + content;
        res.setHeader('Content-Type', 'application/javascript');
        res.send(injectedScript);
    });
});

setupStatsRoutes(app, supabase);
const resend = new Resend(process.env.RESEND_API_KEY);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==================================================================
// FIREPLACE DETECTION PROMPTS (Two-stage detection)
// ==================================================================
const FIREPLACE_DETECTION_SYSTEM_PROMPT = `You are a strict visual verifier. Your job is to decide whether a real fireplace is present in the provided room image.
A "fireplace" means an actual built-in fireplace structure with a clearly visible firebox opening (a cavity meant for fire) or unmistakable hearth + mantel + firebox opening.
Do NOT confuse fireplaces with: TVs, media consoles, shelves, cabinets, bookcases, wall niches, recessed shelves, radiators, vents, windows, mirrors, pictures, or decorative wall panels.
If you are not completely sure, you must answer NO_FIREPLACE.`;

const FIREPLACE_DETECTION_USER_PROMPT = `Analyze the provided room image and classify ONLY whether a real fireplace is clearly visible.

Output format (STRICT):
Return EXACTLY ONE token on a single line, with no punctuation and no extra words:
HAS_FIREPLACE
or
NO_FIREPLACE

Decision rules (STRICT):
- Only output HAS_FIREPLACE if you see an unmistakable built-in fireplace with a clearly visible firebox opening.
- If the image is ambiguous, partially occluded, low-quality, or could be a TV / cabinet / niche, output NO_FIREPLACE.
- Do not guess. Default to NO_FIREPLACE unless certain.`;

// ==================================================================
// 1. HELPER FUNCTIONS
// ==================================================================

async function urlToGenerativePart(url) {
    // Use the new helper that handles HEIC/HEIF conversion
    return await downloadAndConvertImage(url);
}

/**
 * Detect if a fireplace is present in the image using Flash model
 * Fail-safe: returns false on any error (no fireplace = no fire added)
 * @param {string} imageUrl - URL of the room image
 * @returns {Promise<boolean>} - true if fireplace detected
 */
async function detectFireplace(imageUrl) {
    try {
        const flashModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
        const imagePart = await urlToGenerativePart(imageUrl);

        if (!imagePart) {
            console.log("🔥 Fireplace detection: skipped (no image)");
            return false;
        }

        const result = await wrapGeminiCall(() =>
            flashModel.generateContent([
                FIREPLACE_DETECTION_SYSTEM_PROMPT,
                FIREPLACE_DETECTION_USER_PROMPT,
                imagePart
            ])
        );

        const response = result.response.text().trim().toUpperCase();
        // Use includes() to handle "HAS_FIREPLACE." or extra whitespace
        const hasFireplace = response.includes('HAS_FIREPLACE') && !response.includes('NO_FIREPLACE');

        console.log(`🔥 Fireplace detection: ${response} → ${hasFireplace ? 'YES' : 'NO'}`);
        return hasFireplace;

    } catch (err) {
        console.error("❌ Fireplace detection failed:", err.message);
        return false; // Fail-safe: error → no fireplace
    }
}

async function generateRendering(sourceImageUrl, promptText) {
    try {
        console.log("🎨 Generating with Nano Banana Pro (Gemini 3 Pro Image)...");

        // 1. Detect fireplace first (two-stage approach)
        const hasFireplace = await detectFireplace(sourceImageUrl);

        // 2. Prepare the model (Nano Banana Pro)
        const imageModel = genAI.getGenerativeModel({ model: "gemini-3-pro-image-preview" });

        // 3. Download the room image
        const imagePart = await urlToGenerativePart(sourceImageUrl);
        if (!imagePart) throw new Error("Could not download source image.");

        // 4. Construct Prompt based on fireplace detection
        const fullPrompt = hasFireplace
            ? `Turn this room image into a professional interior design photo.
               Apply the following window treatment strictly: ${promptText}.
               Keep the original room layout, furniture, and lighting.
               Add a subtle, realistic fire with soft flames and warm glow to the fireplace.
               High resolution, photorealistic, 8k.`
            : `Turn this room image into a professional interior design photo.
               Apply the following window treatment strictly: ${promptText}.
               Keep the original room layout, furniture, and lighting.
               High resolution, photorealistic, 8k.`;

        // 5. Generate (Image-to-Image) - with rate limiting
        const result = await wrapGeminiCall(
            () => imageModel.generateContent([fullPrompt, imagePart]),
            true // High priority - user interaction
        );
        const response = result.response;
        
        // 6. Extract Image
        if (!response.candidates || !response.candidates[0].content.parts) {
            throw new Error("No image generated.");
        }
        const generatedPart = response.candidates[0].content.parts.find(p => p.inlineData);
        if (!generatedPart) throw new Error("API returned text but no image.");

        const base64Image = generatedPart.inlineData.data;

        // 7. Upload to Supabase
        const fileName = `renderings/${Date.now()}_render.png`;
        const { error } = await supabase.storage.from('chat-uploads').upload(fileName, Buffer.from(base64Image, 'base64'), { contentType: 'image/png' });
        
        if (error) throw error;
        const { data: urlData } = supabase.storage.from('chat-uploads').getPublicUrl(fileName);
        return urlData.publicUrl;

    } catch (err) {
        console.error("Nano Banana Error:", err.message);
        return null;
    }
}

// ==================================================================
// 4. NEW: CLIENT CONFIG ENDPOINT
// ==================================================================
app.get('/client-config/:apiKey', async (req, res) => {
    try {
        const { apiKey } = req.params;
        // FIX 1: We added the new columns to the select list
        const { data: client, error } = await supabase
            .from('clients')
            .select('primary_color, logo_url, company_name, greeting_override, widget_alignment, widget_side_margin, widget_bottom_margin, widget_height, notification_emails, email, website_url') 
            .eq('api_key', apiKey)
            .single();

        if (error || !client) return res.status(404).json({ error: "Client not found" });

        // LOGIC: Send the text string. If null, send the main email as a string.
        const defaultEmails = client.notification_emails || client.email || "";

        res.json({
            // ... (other fields) ...
            color: client.primary_color || "#333333",
            logo: client.logo_url || "",
            name: client.company_name,
            greeting: client.greeting_override || "",
            alignment: client.widget_alignment || 'right',
            sideMargin: client.widget_side_margin ?? 20,
            bottomMargin: client.widget_bottom_margin ?? 20,
            height: client.widget_height ?? 600,
            emails: defaultEmails, // Sends "rob@test.com" or "rob@test.com, jim@test.com"
            websiteUrl: client.website_url || ""
        });
        
    } catch (err) {
        console.error("Config Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
}); // FIX 3: Closed the function properly

app.post('/update-widget-settings', async (req, res) => {
    try {
        const { clientApiKey, alignment, sideMargin, bottomMargin, height } = req.body;

        // Validation
        if (!['left', 'right'].includes(alignment)) return res.status(400).json({ error: "Invalid alignment" });

        const { error } = await supabase
            .from('clients')
            .update({
                widget_alignment: alignment,
                widget_side_margin: sideMargin,
                widget_bottom_margin: bottomMargin,
                widget_height: height
            })
            .eq('api_key', clientApiKey);

        if (error) throw error;
        res.json({ success: true });

    } catch (err) {
        console.error("Update Settings Error:", err.message);
        res.status(500).json({ error: "Update failed" });
    }
});
// ==================================================================
// 3. CHAT ENDPOINT (Unchanged)
// ==================================================================
app.post('/chat', async (req, res) => {
    try {
        const { history, clientApiKey } = req.body;
        const accessCheck = await validateClientAccess(supabase, clientApiKey);

        if (!accessCheck.allowed) {
            return res.json({ reply: accessCheck.error || "Service Suspended." });
        }
        
        const client = accessCheck.client;
        const { data: products } = await supabase
            .from('product_gallery')
            .select('name, description, ai_description, image_url, var_transparency, var_control, var_structure, var_hardware, var_extras, var_colors, var_restrictions')
            .eq('client_id', client.id);

        const productContext = products 
            ? products.map(p => {
                return `
                Product: "${p.name}"
                - Summary: ${p.ai_description || p.description}
                - Transparency: ${p.var_transparency || "N/A"}
                - Control/Lift: ${p.var_control || "Standard"}
                - Structure/Size: ${p.var_structure || "Standard"}
                - Hardware: ${p.var_hardware || "Standard"}
                - Extras: ${p.var_extras || "None"}
                - Colors: ${p.var_colors || "Various"}
                - CRITICAL RESTRICTIONS: ${p.var_restrictions || "None"}
                `; 
              }).join("\n----------------\n") 
            : "Standard Blinds";

        const productNames = products ? products.map(p => p.name).join(", ") : "Standard Blinds";
        
        const finalSystemPrompt = `
        CRITICAL: You DO NOT speak plain text. You ONLY speak JSON.
        Structure:
        {
          "reply": "text",
          "product_suggestions": [ { "name": "Exact Name From List", "image": "URL", "id": "index" } ],
          "visualize": boolean,
          "selected_product_name": "Exact Name From List" 
          "lead_data": {
              "name": "User Name (or null)",
              "phone": "Phone (or null)",
              "email": "Email (or null)",
              "address": "Address (or null)",
              "project_summary": "Brief summary of what they want (e.g. '3 zebra blinds for living room')",
              "appointment_request": "Requested time (or null)",
              "preferred_method": "text/call/email",
              "quality_score": 1-10 (judge their purchase intent),
              "ai_summary": "2 sentence summary of conversation so far"
          }
        }

        YOUR IDENTITY AND RULE:
        ${client.bot_persona || "You are a sales assistant."}
        
        AVAILABLE PRODUCTS: ${productNames}

        BEHAVIOR RULES:

        1. SALES GOAL (HIGH PRIORITY):
           - Your ultimate goal is to BOOK AN IN-HOME CONSULTATION.
           - Once the user shows interest or has seen a visualization, you MUST pivot to asking for contact details.
           - Key phrase to work towards: "I can have a designer bring these samples to your home. What is your Name and Phone Number to schedule a visit?"
           - If they ask for price, give a rough idea but say "Exact price depends on measurements. Can we stop by to measure?"
        
        2. WHEN TO SHOW PRODUCT MENU (product_suggestions):
           - DEFAULT: Keep "product_suggestions": [] (Empty Array). Do NOT show the menu for general chat, greetings, or when asking for contact info.
           - SHOW ONLY IF:
             A) The user explicitly asks to see options (e.g. "What styles do you have?", "Show me blinds").
             B) The user has uploaded an image but has NOT selected a product style yet (e.g. "Here is my room, what do you suggest?").
           - TO TRIGGER MENU: Return "product_suggestions": [{ "name": "trigger" }] in your JSON. The system will fill the real data.

        3. UNAVAILABLE PRODUCTS:
           If the user asks for a product NOT in the "AVAILABLE PRODUCTS" list (e.g., they ask for shutters but you only have rollers), you MUST reply:
           "Unfortunately we don't offer that option right now."

        4. VISUALIZATION LOGIC (The 2-Step Requirement):
           You can ONLY set "visualize": true if you have BOTH: (A) A User Uploaded Image in history, AND (B) A specific product selection.

           CASE A: User uploads an image but has NOT selected a product yet.
           - Action: You must ask for the product.
           - Reply: "I see your room! Please select a style below so I can generate a preview."
           - "product_suggestions": [List all items from AVAILABLE PRODUCTS]
           - "visualize": false

           CASE B: User selects a product (e.g. "I want Zebra Blinds") but has NOT uploaded an image.
           - Action: You must ask for the image.
           - Reply: "Great choice! Please upload a photo of your window so I can show you how it looks."
           - "product_suggestions": []
           - "visualize": false

           CASE C: User has BOTH (An image is in the chat history AND they just selected a product).
           - Action: Start generation.
           - Reply: "Generating a preview of [Product Name] in your room now..."
           - "visualize": true
           - "selected_product_name": "[Exact Name]"
           - "product_suggestions": []

           CASE D: General Conversation.
           - If the user is just asking questions and NOT trying to visualize, just answer helpfully. 
           - DO NOT send "product_suggestions" unless they explicitly ask to see options or upload an image.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview", systemInstruction: finalSystemPrompt, generationConfig: { responseMimeType: "application/json" } });

        // M2: Parse color selection protocol (doesn't modify history - keeps transcript clean)
        let userSelectedColor = null;
        let colorProductId = null;
        const lastMsgText = history[history.length - 1]?.parts?.[0]?.text || '';

        if (lastMsgText.startsWith('__BB_COLOR__::')) {
            const params = lastMsgText.substring('__BB_COLOR__::'.length);
            const match = params.match(/productId=(\d+);color=(.+)/);
            if (match) {
                colorProductId = parseInt(match[1]);
                userSelectedColor = match[2].trim();
                console.log(`🎨 Color selection: productId=${colorProductId}, color=${userSelectedColor}`);
            }
        }

        // C. Parse History for Image
        const pastHistory = history.slice(0, -1);
        const chat = model.startChat({ history: pastHistory });
        const lastTurn = history[history.length - 1];
        
        let currentParts = [];
        let sourceImageUrl = null;
        
        // --- OBJECTIVE FIX: LOOK BACK FOR IMAGE IF NOT IN LAST TURN ---
        for (const part of lastTurn.parts) {
            const imgMatch = part.text?.match(/\[IMAGE_URL: (.*?)\]/);
            if (imgMatch) sourceImageUrl = imgMatch[1];
        }

        if (!sourceImageUrl && history.length > 1) {
            for (let i = history.length - 2; i >= 0; i--) {
                const turn = history[i];
                if (turn.role === 'user') {
                    for (const part of turn.parts) {
                        const imgMatch = part.text?.match(/\[IMAGE_URL: (.*?)\]/);
                        if (imgMatch) {
                            sourceImageUrl = imgMatch[1];
                            break;
                        }
                    }
                }
                if (sourceImageUrl) break;
            }
        }
        // DEBUG: Log image search results for color protocol
        if (colorProductId !== null) {
            console.log(`🔍 Color protocol detected: productId=${colorProductId}, color=${userSelectedColor}`);
            console.log(`🔍 sourceImageUrl found: ${sourceImageUrl ? 'YES' : 'NO'}`);
            if (!sourceImageUrl) {
                console.log(`⚠️ No source image found! History (${history.length} turns):`);
                history.forEach((h, i) => {
                    const preview = h.parts?.[0]?.text?.substring(0, 80) || '[no text]';
                    console.log(`  [${i}] ${h.role}: ${preview}...`);
                });
            }
        }
        // -------------------------------------------------------------

        for (const part of lastTurn.parts) {
             if (part.text && !part.text.includes('[IMAGE_URL:')) {
                  currentParts.push({ text: part.text });
             }
        }
        if (sourceImageUrl) {
             const imagePart = await urlToGenerativePart(sourceImageUrl);
             if (imagePart) currentParts.push(imagePart);
             currentParts.push({ text: "Analyze this image context." });
        }

        const result = await wrapGeminiCall(
            () => chat.sendMessage(currentParts),
            true // High priority - user chat interaction
        );
        const jsonResponse = JSON.parse(result.response.text());
        
        if (jsonResponse.product_suggestions && jsonResponse.product_suggestions.length > 0 && products) {
            jsonResponse.product_suggestions = products.map((p, idx) => ({
                name: p.name,
                image: (p.image_url || '').split(/[,;\n|]/)[0].trim(), // First URL only
                id: idx,
                // M1: Return colors as array for frontend color selector
                colors: (p.var_colors || '').split(',').map(c => c.trim()).filter(c => c)
            }));
        } else {
            jsonResponse.product_suggestions = [];
        }
    let renderUrl = null;
    let selectedProductIndex = null;

    // M2 continued: If color selection protocol, force visualize and use product by ID
    if (colorProductId !== null && products && products[colorProductId]) {
        jsonResponse.visualize = true;
        jsonResponse.selected_product_name = products[colorProductId].name;
    }

    if (jsonResponse.visualize && jsonResponse.selected_product_name && sourceImageUrl) {
        // Find product - prefer ID from color protocol, fallback to name matching
        let selectedProduct;
        if (colorProductId !== null && products && products[colorProductId]) {
            selectedProduct = products[colorProductId];
            selectedProductIndex = colorProductId;
        } else {
            selectedProduct = products.find(p => p.name.toLowerCase() === jsonResponse.selected_product_name.toLowerCase());
            selectedProductIndex = products ? products.indexOf(selectedProduct) : null;
        }

        if (selectedProduct) {
            // --- NEW CHARGING LOGIC ---
            // We only charge IF we are about to generate
            const canGenerate = await deductImageCredit(supabase, client.id);

            if (canGenerate) {
                // 1. Success: Generate the Image
                const desc = selectedProduct.ai_description || selectedProduct.description;

                // M3: Build color instruction - stronger wording for user-selected colors
                const colorInstruction = userSelectedColor
                    ? `IMPORTANT: Use ${userSelectedColor} color for the blinds. If the reference product image shows a different color, you MUST override it to ${userSelectedColor}.`
                    : `Choose the most suitable color from available options: ${selectedProduct.var_colors || 'standard colors'}. Pick one that complements the room.`;

                const combinedPrompt = `Install ${selectedProduct.name} (${desc}) on the windows. ${colorInstruction}`;

                console.log(`🎨 Generating with prompt: ${combinedPrompt}`);

                renderUrl = await generateRendering(sourceImageUrl, combinedPrompt);
                if (renderUrl) jsonResponse.reply += `\n\n[RENDER_URL: ${renderUrl}]`;

                // M4: Add color_info for "Change Color" button
                if (renderUrl) {
                    jsonResponse.color_info = {
                        product_id: selectedProductIndex,
                        product_name: selectedProduct.name,
                        used_color: userSelectedColor || 'auto-selected',
                        available_colors: (selectedProduct.var_colors || '').split(',').map(c => c.trim()).filter(c => c)
                    };
                }

            } else {
                // 2. Failure: No Credits
                console.log(`🚫 Generation blocked: Insufficient credits for ${client.company_name}`);
                jsonResponse.reply += "\n\n(System: Preview generation skipped. Insufficient image credits. Please top up in Settings.)";
                // We turn off visualize so the UI doesn't try to show a broken image
                jsonResponse.visualize = false;
            }
        }
    }
        if (jsonResponse.lead_data) {
            const d = jsonResponse.lead_data;
            d.full_transcript = history;
            // Inject images into the data payload
            if (sourceImageUrl) d.new_customer_image = sourceImageUrl;
            if (renderUrl) d.new_ai_rendering = renderUrl; // Defined in the scope above

            // Only save if we have contact info or if we just generated valuable data
            if (d.name || d.phone || d.email) {
                const savedLead = await handleLeadData(supabase, client.id, d);

                if (!savedLead) {
                    // Lead save failed, notify user
                    console.error('⚠️ Lead save failed for client:', client.id);
                    jsonResponse.reply += "\n\n⚠️ We encountered a technical issue saving your information. Please contact us directly at: " + (client.email || "our support team") + ".";
                }
            }
        }
        res.json(jsonResponse);

    } catch (err) {
        console.error(err);
        res.status(500).json({ reply: "Error processing request." });
    }
});
app.get('/create-portal-session/:apiKey', async (req, res) => {
    try {
        const { apiKey } = req.params;
        const { data: client } = await supabase
            .from('clients')
            .select('stripe_customer_id')
            .eq('api_key', apiKey)
            .single();

        if (!client || !client.stripe_customer_id) {
            return res.status(404).send("No active subscription found. Please contact support.");
        }

        const url = await createPortalSession(client.stripe_customer_id);
        res.redirect(url);

    } catch (err) {
        console.error("Portal Error:", err);
        res.status(500).send("Error accessing subscription settings.");
    }
});
setupPreviewRoutes(app, supabase);
startPersonaWorker();
startProductWorker();
app.post('/train-agent', async (req, res) => {
    try {
        const { clientApiKey } = req.body;
        if (!clientApiKey) return res.status(400).json({ error: "Missing API Key" });

        // Get client ID for seeding check
        const { data: client } = await supabase
            .from('clients')
            .select('id')
            .eq('api_key', clientApiKey)
            .single();

        if (!client) return res.status(401).json({ error: "Invalid API Key" });

        // Seed demo data if product list is empty
        console.log(`🌱 Checking demo seed for client: ${client.id}`);
        await seedDemoData(supabase, client.id);

        // Trigger the manual retrain
        await forceRetrainClient(clientApiKey);

        res.json({ success: true });

    } catch (err) {
        console.error("Training Error:", err.message);
        res.status(500).json({ error: "Training failed. Please try again." });
    }
});
app.post('/scrape-products', async (req, res) => {
    try {
        const { clientApiKey, websiteUrl } = req.body;

        if (!websiteUrl) return res.status(400).json({ error: "Missing Website URL" });

        // 1. Verify Client
        const { data: client } = await supabase
            .from('clients')
            .select('id')
            .eq('api_key', clientApiKey)
            .single();

        if (!client) return res.status(401).json({ error: "Invalid API Key" });

        // 2. Run Scraper
        // We await this so the user knows when it's done
        const result = await scrapeAndSaveProducts(supabase, client.id, websiteUrl);

        res.json(result);

    } catch (err) {
        console.error("Scrape Route Error:", err);
        res.status(500).json({ error: "Scraping failed." });
    }
});
app.post('/update-notification-emails', async (req, res) => {
    try {
        const { clientApiKey, emails } = req.body;

        if (!Array.isArray(emails)) return res.status(400).json({ error: "Invalid format" });

        const { error } = await supabase
            .from('clients')
            .update({ notification_emails: emails })
            .eq('api_key', clientApiKey);

        if (error) throw error;
        res.json({ success: true });

    } catch (err) {
        console.error("Email Update Error:", err.message);
        res.status(500).json({ error: "Update failed" });
    }
});

// ==================================================================
// IMAGE UPLOAD ENDPOINT (with HEIC/HEIF conversion)
// ==================================================================
app.post('/upload-image', async (req, res) => {
    try {
        const { imageBase64, fileName, mimeType } = req.body;

        if (!imageBase64 || !fileName) {
            return res.status(400).json({ error: "Missing image data or filename" });
        }

        // Decode base64 to buffer
        let buffer = Buffer.from(imageBase64, 'base64');

        // Check file size (max 20MB)
        const MAX_SIZE_MB = 20;
        const fileSizeMB = buffer.length / (1024 * 1024);
        if (fileSizeMB > MAX_SIZE_MB) {
            console.log(`🚫 Image too large: ${fileSizeMB.toFixed(1)}MB (max ${MAX_SIZE_MB}MB)`);
            return res.status(413).json({
                error: `Image is too large (${fileSizeMB.toFixed(1)}MB). Please use an image smaller than ${MAX_SIZE_MB}MB.`
            });
        }

        // Convert HEIC/HEIF and other non-browser formats to JPEG
        // Pass fileName for fallback detection when browser doesn't report mimeType
        const converted = await ensureBrowserCompatible(buffer, mimeType, fileName);
        buffer = converted.buffer;
        let finalMimeType = converted.mimeType;

        // Generate safe filename (always .jpg for converted files)
        const ext = finalMimeType === 'image/png' ? '.png' : '.jpg';
        const safeFileName = `uploads/${Date.now()}_${fileName.replace(/\.[^/.]+$/, '')}${ext}`;

        // Upload to Supabase
        const { error } = await supabase.storage
            .from('chat-uploads')
            .upload(safeFileName, buffer, { contentType: finalMimeType });

        if (error) throw error;

        const { data: urlData } = supabase.storage
            .from('chat-uploads')
            .getPublicUrl(safeFileName);

        console.log(`✅ Image uploaded: ${safeFileName} (${finalMimeType})`);

        res.json({
            success: true,
            url: urlData.publicUrl
        });

    } catch (err) {
        console.error("Upload Error:", err.message);
        res.status(500).json({ error: "Upload failed: " + err.message });
    }
});

// ==================================================================
// TEST ENDPOINT: compressForRendering (for unittest HTML page)
// ==================================================================
app.post('/compress-for-rendering-test', async (req, res) => {
    try {
        const { imageBase64, fileName, mimeType } = req.body;

        if (!imageBase64) {
            return res.status(400).json({ error: "Missing image data" });
        }

        // Decode base64 to buffer
        let buffer = Buffer.from(imageBase64, 'base64');
        const originalSize = buffer.length;

        // First convert HEIC/HEIF if needed (using ensureBrowserCompatible)
        const converted = await ensureBrowserCompatible(buffer, mimeType, fileName);
        buffer = converted.buffer;
        const afterConvertSize = buffer.length;

        // Get original dimensions using sharp
        const originalMeta = await sharp(buffer).metadata();

        // Apply compressForRendering
        const compressedBuffer = await compressForRendering(buffer);
        const compressedMeta = await sharp(compressedBuffer).metadata();

        res.json({
            success: true,
            original: {
                width: originalMeta.width,
                height: originalMeta.height,
                size: afterConvertSize,
                format: originalMeta.format
            },
            compressed: {
                width: compressedMeta.width,
                height: compressedMeta.height,
                size: compressedBuffer.length,
                format: compressedMeta.format,
                base64: compressedBuffer.toString('base64')
            },
            heicConverted: mimeType?.includes('heic') || mimeType?.includes('heif') || fileName?.toLowerCase().includes('.heic')
        });

    } catch (err) {
        console.error("compressForRendering test error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==================================================================
// 4.5. TRAINING PDF UPLOAD (Multiple PDFs)
// ==================================================================
app.post('/upload-training-pdfs', async (req, res) => {
    try {
        const { apiKey, pdfFiles } = req.body;

        // 1. Validate input
        if (!apiKey) {
            return res.status(400).json({ error: "Missing API key" });
        }

        if (!pdfFiles || !Array.isArray(pdfFiles) || pdfFiles.length === 0) {
            return res.status(400).json({ error: "Missing PDF files or invalid format" });
        }

        // 2. Validate client exists
        const { data: client, error: clientError } = await supabase
            .from('clients')
            .select('id, company_name')
            .eq('api_key', apiKey)
            .single();

        if (clientError || !client) {
            return res.status(404).json({ error: "Client not found" });
        }

        console.log(`📚 Processing ${pdfFiles.length} PDFs for ${client.company_name}`);

        // 3. Validate PDF count (max 5)
        if (pdfFiles.length > 5) {
            return res.status(400).json({
                error: `Too many PDFs. Maximum 5 allowed, received ${pdfFiles.length}`
            });
        }

        // 4. Convert base64 PDFs to buffers
        const pdfBuffers = [];
        for (let i = 0; i < pdfFiles.length; i++) {
            const { data, fileName } = pdfFiles[i];

            if (!data || !fileName) {
                return res.status(400).json({
                    error: `PDF #${i + 1} missing data or fileName`
                });
            }

            try {
                const buffer = Buffer.from(data, 'base64');

                // Validate PDF magic bytes
                if (buffer.slice(0, 5).toString() !== '%PDF-') {
                    return res.status(400).json({
                        error: `File "${fileName}" is not a valid PDF`
                    });
                }

                pdfBuffers.push(buffer);
                console.log(`   ✅ Validated PDF #${i + 1}: ${fileName} (${(buffer.length / 1024).toFixed(2)} KB)`);

            } catch (err) {
                return res.status(400).json({
                    error: `Failed to decode PDF #${i + 1}: ${err.message}`
                });
            }
        }

        // 5. Check total size before merging (max 100MB)
        const totalSize = pdfBuffers.reduce((sum, buf) => sum + buf.length, 0);
        const totalSizeMB = totalSize / (1024 * 1024);

        if (totalSizeMB > 100) {
            return res.status(413).json({
                error: `Total PDF size ${totalSizeMB.toFixed(2)}MB exceeds 100MB limit`
            });
        }

        console.log(`   📦 Total size: ${totalSizeMB.toFixed(2)} MB`);

        // 6. Merge PDFs using our service
        const { mergePDFsWithLimit } = await import('./services/pdf/merger.js');
        const mergedBuffer = await mergePDFsWithLimit(pdfBuffers, 100 * 1024 * 1024);

        console.log(`   ✅ Merged into single PDF: ${(mergedBuffer.length / 1024).toFixed(2)} KB`);

        // 7. Upload merged PDF to Supabase Storage
        const timestamp = Date.now();
        const safeFileName = `training/${client.id}_${timestamp}.pdf`;

        const { error: uploadError } = await supabase.storage
            .from('chat-uploads')
            .upload(safeFileName, mergedBuffer, {
                contentType: 'application/pdf',
                upsert: true
            });

        if (uploadError) {
            throw new Error(`Upload failed: ${uploadError.message}`);
        }

        // 8. Get public URL
        const { data: urlData } = supabase.storage
            .from('chat-uploads')
            .getPublicUrl(safeFileName);

        console.log(`   ⬆️  Uploaded to: ${safeFileName}`);

        // 9. Update database with smart field detection
        // Try training_pdfs first, fallback to training_pdf if it doesn't exist
        let currentClient = null;
        let clientQueryError = null;

        // First attempt: try with training_pdfs
        const { data: clientData1, error: error1 } = await supabase
            .from('clients')
            .select('training_pdf, training_pdfs')
            .eq('id', client.id)
            .single();

        if (error1 && error1.message && error1.message.includes('training_pdfs')) {
            // Field doesn't exist, query without it
            const { data: clientData2, error: error2 } = await supabase
                .from('clients')
                .select('training_pdf')
                .eq('id', client.id)
                .single();

            currentClient = clientData2;
            clientQueryError = error2;
        } else {
            currentClient = clientData1;
            clientQueryError = error1;
        }

        if (clientQueryError || !currentClient) {
            throw new Error(`Failed to query current client: ${clientQueryError?.message || 'Client not found'}`);
        }

        let updatePayload = { bot_persona: null };  // Always reset persona
        let fieldUsed = '';
        let totalCount = 0;

        // Check if training_pdfs field exists (will be null or array)
        if (currentClient && 'training_pdfs' in currentClient) {
            // Field exists - use it
            const existingPdfs = currentClient.training_pdfs || [];
            const updatedPdfs = [...existingPdfs, urlData.publicUrl];
            updatePayload.training_pdfs = updatedPdfs;
            fieldUsed = 'training_pdfs';
            totalCount = updatedPdfs.length;
        } else {
            // Field doesn't exist - fallback to training_pdf
            updatePayload.training_pdf = urlData.publicUrl;
            fieldUsed = 'training_pdf';
            totalCount = 1;
        }

        const { error: updateError } = await supabase
            .from('clients')
            .update(updatePayload)
            .eq('id', client.id);

        if (updateError) {
            throw new Error(`Database update failed: ${updateError.message}`);
        }

        console.log(`   💾 Updated client ${fieldUsed} (now has ${totalCount} PDF(s))`);
        console.log(`   🔄 Persona reset - will regenerate on next worker cycle`);

        res.json({
            success: true,
            message: `Successfully uploaded and merged ${pdfFiles.length} PDFs`,
            url: urlData.publicUrl,
            totalPdfs: totalCount,
            mergedSizeKB: Math.round(mergedBuffer.length / 1024),
            fieldUsed: fieldUsed  // For debugging
        });

    } catch (err) {
        console.error("PDF Upload Error:", err.message);
        res.status(500).json({ error: "PDF upload failed: " + err.message });
    }
});

// Query endpoint to get training PDFs
app.get('/training-pdfs/:apiKey', async (req, res) => {
    try {
        const { apiKey } = req.params;

        // Try to get client - handle case where training_pdfs field may not exist
        let client = null;
        let clientError = null;

        // First attempt: try with training_pdfs field
        const { data: clientData1, error: error1 } = await supabase
            .from('clients')
            .select('id, company_name, training_pdf, training_pdfs')
            .eq('api_key', apiKey)
            .single();

        if (error1 && error1.message && error1.message.includes('training_pdfs')) {
            // Field doesn't exist in database, try without it
            const { data: clientData2, error: error2 } = await supabase
                .from('clients')
                .select('id, company_name, training_pdf')
                .eq('api_key', apiKey)
                .single();

            client = clientData2;
            clientError = error2;
        } else {
            client = clientData1;
            clientError = error1;
        }

        if (clientError || !client) {
            return res.status(404).json({ error: "Client not found" });
        }

        // Use getPDFUrls() for consistent fallback logic
        const { getPDFUrls } = await import('./services/pdf/utils.js');
        const urls = getPDFUrls(client);

        // Convert URLs to response format
        const pdfs = urls.map(url => {
            const fileName = url.split('/').pop();

            // Determine type based on which field is being used
            let type = 'unknown';
            if (client.training_pdfs && Array.isArray(client.training_pdfs) && client.training_pdfs.length > 0) {
                type = 'merged';  // Using new array field
            } else if (client.training_pdf) {
                type = 'single';  // Using old single field
            }

            return {
                url: url,
                fileName: fileName,
                uploadedAt: null,  // Can parse from filename if needed
                type: type
            };
        });

        res.json({
            success: true,
            companyName: client.company_name,
            pdfs: pdfs,
            totalCount: pdfs.length
        });

    } catch (err) {
        console.error("Query training PDFs error:", err.message);
        res.status(500).json({ error: "Failed to query PDFs: " + err.message });
    }
});

// ==================================================================
// 5. SAAS CLIENT SUPPORT (Smart Lookup: Key OR Email)
// ==================================================================
app.post('/contact-support', async (req, res) => {
    try {
        const { clientApiKey, message, topic, userEmail, priority } = req.body;

        // Validation: We need at least a Message and (Key OR Email)
        if (!message || (!clientApiKey && !userEmail)) {
            return res.status(400).json({ error: "Please provide your Registered Email or API Key." });
        }

        let client = null;
        let clientError = null;

        // STRATEGY 1: Try finding by API Key first (if provided)
        if (clientApiKey) {
            const { data, error } = await supabase
                .from('clients')
                .select('id, company_name, email, stripe_customer_id')
                .eq('api_key', clientApiKey)
                .maybeSingle(); // Use maybeSingle to avoid 406 errors if not found
            
            if (data) client = data;
        }

        // STRATEGY 2: If no client found yet, try finding by Email
        if (!client && userEmail) {
            // We search for the email in the 'clients' table
            // Note: This relies on the user typing the email exactly as registered
            const { data, error } = await supabase
                .from('clients')
                .select('id, company_name, email, stripe_customer_id')
                .ilike('email', userEmail) // Case-insensitive match
                .maybeSingle();

            if (data) client = data;
        }

        // If we still don't know who this is, we can't save to the specific client table
        if (!client) {
            return res.status(404).json({ error: "Account not found. Please use your registered company email." });
        }

        // 3. INSERT into 'client_support_tickets'
        const { data: ticket, error: dbError } = await supabase
            .from('client_support_tickets')
            .insert([
                {
                    client_id: client.id,
                    topic: topic || 'General',
                    priority: priority || 'Normal',
                    message: message,
                    user_email: userEmail || client.email, // Use what they typed, or fallback to DB email
                    status: 'new'
                }
            ])
            .select()
            .single();

        if (dbError) {
            console.error("Database Insert Error:", dbError);
            throw new Error("Failed to save ticket.");
        }
        console.log("Ticket saved. ID:", ticket.id);
        // 4. Send Notification Email
        const adminEmail = await resend.emails.send({
            from: EMAIL_FROM_SUPPORT,
            to: [EMAIL_ADMIN_TO],
            reply_to: userEmail,
            subject: `[New Ticket] ${client.company_name} - ${topic}`,
            html: `
                <h2>New Support Request</h2>
                <p><strong>Client:</strong> ${client.company_name}</p>
                <p><strong>Email:</strong> ${userEmail}</p>
                <p><strong>Message:</strong><br>${message}</p>
                <a href="https://supabase.com/dashboard">View in Supabase</a>
            `
        });

        if (adminEmail.error) console.error("Admin Email Failed:", adminEmail.error);
        else console.log("Admin Email Sent:", adminEmail.data);

        // 5. Send Client Confirmation (To THE USER)
        // NOTE: This will ONLY work if you have verified your domain on Resend.
        // If you are on the "onboarding" domain, this will fail for anyone except yourself.
        const clientConfirmation = await resend.emails.send({
            from: EMAIL_FROM_SUPPORT,
            to: [userEmail], 
            subject: `We received your request: ${topic}`,
            html: `
                <p>Hi there,</p>
                <p>We received your support request regarding <strong>${topic}</strong>.</p>
                <p>Our team will review it and get back to you shortly.</p>
                <hr>
                <p><em>Your Message:</em><br>${message}</p>
            `
        });

        if (clientConfirmation.error) console.error("Client Email Failed:", clientConfirmation.error);
        else console.log("Client Email Sent:", clientConfirmation.data);

        res.json({ success: true, ticketId: ticket.id });

    } catch (err) {
        console.error("Support Route Error:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', env: APP_ENV });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Gallery Agent Running on port ${PORT} (env: ${APP_ENV})`);

    // Test email configuration on startup
    await testEmailConfiguration();
});