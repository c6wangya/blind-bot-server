// preview_handler.js
import axios from 'axios';

export function setupPreviewRoutes(app, supabase) {
    console.log("🖼️ Preview Module Loaded.");

    // 1. PREVIEW BY API KEY (The Worker)
    app.get('/preview/:apiKey', async (req, res) => {
        try {
            const { apiKey } = req.params;

            // Fetch Client Info
            const { data: client } = await supabase
                .from('clients')
                .select('website_url')
                .eq('api_key', apiKey)
                .single();

            if (!client) return res.status(404).send("Client not found");

            // Define the Widget Script Tag (Pointing to your live server)
            const scriptTag = `<script src="https://blind-bot-server.onrender.com/widget.js" data-api-key="${apiKey}"></script>`;

            // SCENARIO A: Custom Website URL Exists
            if (client.website_url) {
                try {
                    const response = await axios.get(client.website_url);
                    let html = response.data;

                    // INJECT <base> tag to fix relative links
                    if (!html.includes('<base')) {
                        html = html.replace('<head>', `<head><base href="${client.website_url}">`);
                    }

                    // INJECT Widget Script
                    html = html.replace('</body>', `${scriptTag}</body>`);
                    return res.send(html);

                } catch (fetchErr) {
                    console.error("Preview Fetch Error:", fetchErr.message);
                    // Fall through to generic page if fetch fails
                }
            }

            // SCENARIO B: Generic Fallback Page (Keeps server.js clean!)
            const genericHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Bot Preview</title>
                    <style>
                        body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f0f2f5; margin: 0; }
                        .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                        h1 { color: #333; margin-bottom: 10px; }
                        p { color: #666; line-height: 1.6; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>Your Bot is Ready!</h1>
                        <p>This is a preview of how your AI Assistant behaves.</p>
                        <p>On your real website, it will float in the corner just like this.</p>
                    </div>
                    ${scriptTag}
                </body>
                </html>
            `;

            res.send(genericHtml);

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