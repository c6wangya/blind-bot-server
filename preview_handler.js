// preview_handler.js
import axios from 'axios';

export function setupPreviewRoutes(app, supabase) {
    console.log("🖼️ Preview Module Loaded.");

    // 1. PREVIEW BY API KEY
    app.get('/preview/:apiKey', async (req, res) => {
        try {
            const { apiKey } = req.params;
            const { no_widget } = req.query; // <--- NEW: Check for flag

            // Fetch Client Info
            const { data: client } = await supabase
                .from('clients')
                .select('website_url')
                .eq('api_key', apiKey)
                .single();

            if (!client) return res.status(404).send("Client not found");

            // Define the Widget Script Tag
            const scriptTag = `<script src="https://blind-bot-server.onrender.com/widget.js" data-api-key="${apiKey}"></script>`;

            // SCENARIO A: Custom Website URL Exists
            if (client.website_url) {
                try {
                    const response = await axios.get(client.website_url, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                        responseType: 'text'
                    });
                    let html = String(response.data);

                    // INJECT <base> tag to fix relative links
                    if (!html.includes('<base')) {
                        html = html.replace('<head>', `<head><base href="${client.website_url}">`);
                    }

                    // INJECT Widget Script (ONLY IF no_widget is NOT true)
                    if (no_widget !== 'true') {
                         html = html.replace('</body>', `${scriptTag}</body>`);
                    }
                    
                    return res.send(html);

                } catch (fetchErr) {
                    console.error("Preview Fetch Error:", fetchErr.message);
                }
            }

            // SCENARIO B: iframe fallback (bypasses firewall blocking)
            const iframeHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Bot Preview</title>
                    <style>
                        body { margin: 0; padding: 0; }
                        iframe { width: 100vw; height: 100vh; border: none; }
                    </style>
                </head>
                <body>
                    ${client.website_url
                        ? `<iframe src="${client.website_url}"></iframe>`
                        : `<div style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f0f2f5;">
                               <div style="background:white;padding:40px;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;">
                                   <h1>Your Bot is Ready!</h1>
                                   <p>Add your website URL to see the preview.</p>
                               </div>
                           </div>`
                    }
                    ${no_widget !== 'true' ? scriptTag : ''}
                </body>
                </html>
            `;

            res.send(iframeHtml);

        } catch (err) {
            console.error("Preview Endpoint Error:", err);
            res.status(500).send("Error generating preview.");
        }
    });

    // 2. PREVIEW BY EMAIL (The Bridge for Softr)
    app.get('/preview-by-email/:email', async (req, res) => {
        try {
            const { email } = req.params;
            const { data: client } = await supabase
                .from('clients')
                .select('api_key')
                .eq('email', email)
                .single();

            if (!client) return res.send("<h3>Bot not found. Please complete onboarding.</h3>");

            res.redirect(`/preview/${client.api_key}`);

        } catch (err) {
            console.error("Email Preview Error:", err);
            res.status(500).send("Error loading preview.");
        }
    });
}