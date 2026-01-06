import { sendLeadNotification } from './email_handler.js';

export async function handleLeadData(supabase, clientId, leadData) {
    // 1. Safety Check: Don't save empty ghosts
    if (!leadData.name && !leadData.phone && !leadData.email) return;

    try {
        // 2. DEDUPLICATION: Check if this person exists already
        // We search for a lead belonging to this Client that matches the Email OR Phone
        let query = supabase
            .from('leads')
            .select('*')
            .eq('client_id', clientId);

        const conditions = [];
        if (leadData.email) conditions.push(`customer_email.eq.${leadData.email}`);
        if (leadData.phone) conditions.push(`customer_phone.eq.${leadData.phone}`);

        let existingLead = null;

        // Only run the search if we have a phone or email to match against
        if (conditions.length > 0) {
            const { data: found } = await query.or(conditions.join(','));
            
            if (found && found.length > 0) {
                // If multiple matches (rare), grab the most recent one
                existingLead = found.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
            }
        }

        // 3. Prepare the data payload
        // We use "leadData.x || existing.x" to ensure we don't accidentally overwrite data with nulls
        const finalData = {
            client_id: clientId,
            customer_name: leadData.name || (existingLead ? existingLead.customer_name : null),
            customer_email: leadData.email || (existingLead ? existingLead.customer_email : null),
            customer_phone: leadData.phone || (existingLead ? existingLead.customer_phone : null),
            project_summary: leadData.project_summary || (existingLead ? existingLead.project_summary : null),
            // If there's a new render, use it; otherwise keep the old one
            ai_rendering_url: leadData.new_ai_rendering || (existingLead ? existingLead.ai_rendering_url : null),
            updated_at: new Date().toISOString()
        };

        let shouldNotify = false;

        if (existingLead) {
            // === UPDATE PATH (Existing Customer) ===
            
            // LOGIC: Only email if we gained NEW critical info
            const justGotEmail = leadData.email && !existingLead.customer_email;
            const justGotPhone = leadData.phone && !existingLead.customer_phone;
            const justGotRender = leadData.new_ai_rendering && !existingLead.ai_rendering_url;

            if (justGotEmail || justGotPhone || justGotRender) {
                shouldNotify = true;
                console.log(`🔔 Triggering notification: Lead added new info.`);
            } else {
                console.log(`🔕 Silent Update: No new contact details added.`);
            }

            const { error } = await supabase
                .from('leads')
                .update(finalData)
                .eq('id', existingLead.id);
            
            if (error) throw error;

        } else {
            // === INSERT PATH (Brand New Customer) ===
            shouldNotify = true; // Always notify for a brand new lead
            
            const { error } = await supabase
                .from('leads')
                .insert([finalData]);
                
            if (error) throw error;
            console.log(`✅ New Lead Created: ${finalData.customer_name}`);
        }

        // 4. Send Email (Only if flagged)
        if (shouldNotify) {
            const { data: client } = await supabase
                .from('clients')
                .select('notification_emails, email')
                .eq('id', clientId)
                .single();

            if (client) {
                const recipients = client.notification_emails || client.email;
                await sendLeadNotification(recipients, finalData);
            }
        }

    } catch (err) {
        console.error("❌ Lead Manager Error:", err.message);
    }
}