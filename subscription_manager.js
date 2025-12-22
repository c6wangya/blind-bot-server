// subscription_manager.js

/**
 * Validates if a client has access to the service.
 * Logic:
 * 1. Validates API Key.
 * 2. Checks if 'status' is 'active'.
 * 3. If NOT active, checks if 'credits' > 0.
 * 4. Deducts 1 credit if using the credit system.
 */
export async function validateClientAccess(supabase, apiKey) {
    try {
        // 1. Fetch Client Identity & Balance
        const { data: client, error } = await supabase
            .from('clients')
            .select('*') // Ensure your query selects 'credits' and 'status'
            .eq('api_key', apiKey)
            .single();

        if (error || !client) {
            return { allowed: false, error: "Invalid API Key or Client not found." };
        }

        // 2. Check Subscription Status (Priority access)
        // If subscription is 'active', we don't deduct credits.
        if (client.status === 'active') {
            return { allowed: true, client: client };
        }

        // 3. Fallback: Credit Check
        if (client.credits && client.credits > 0) {
            
            // DEDUCT CREDIT logic
            const { error: updateError } = await supabase
                .from('clients')
                .update({ credits: client.credits - 1 })
                .eq('id', client.id);

            if (updateError) {
                console.error("Failed to deduct credit:", updateError);
                // Depending on strictness, you might fail here or allow it. 
                // We will allow it but log the error.
            }

            return { allowed: true, client: client };
        }

        // 4. No Subscription and No Credits
        return { allowed: false, error: "Service Suspended: Insufficient credits or inactive subscription." };

    } catch (err) {
        console.error("Subscription Manager Error:", err);
        return { allowed: false, error: "Internal validation error." };
    }
}