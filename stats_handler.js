import express from 'express';

export function setupStatsRoutes(app, supabase) {

    // ==================================================
    // 1. FIX FOR 404 LOGS (The General Health Check)
    // ==================================================
    // This stops the red errors in your Render logs
    app.get('/stats', (req, res) => {
        res.json({ status: 'ok', message: 'Stats module active' });
    });

    // ==================================================
    // 2. Client Stats (Specific Dashboard Data)
    // ==================================================
    app.get('/stats/client/:apiKey', async (req, res) => {
        try {
            const { apiKey } = req.params;

            // 1. Get Client ID
            const { data: client, error: clientError } = await supabase
                .from('clients')
                .select('id')
                .eq('api_key', apiKey)
                .single();

            if (clientError || !client) {
                return res.status(404).json({ error: 'Client not found' });
            }

            // 2. Fetch Aggregated Stats
            // (Example: Count leads, image generations, etc.)
            const { count: leadCount } = await supabase
                .from('leads')
                .select('*', { count: 'exact', head: true })
                .eq('client_id', client.id);

            const { count: chatCount } = await supabase
                .from('chat_logs') // Assuming you track logs
                .select('*', { count: 'exact', head: true })
                .eq('client_id', client.id);

            res.json({
                leads: leadCount || 0,
                conversations: chatCount || 0,
                credits: client.image_credits || 0
            });

        } catch (err) {
            console.error("Stats Error:", err.message);
            res.status(500).json({ error: "Failed to fetch stats" });
        }
    });

    // ==================================================
    // 3. Admin Stats (Optional - for you)
    // ==================================================
    app.get('/stats/admin', async (req, res) => {
        // Simple global count
        const { count } = await supabase
            .from('clients')
            .select('*', { count: 'exact', head: true });
        
        res.json({ total_clients: count });
    });
}