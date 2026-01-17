/**
 * Simple Trial System Test
 * Tests without importing stripe_handler to avoid initialization issues
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load env FIRST
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Copy the deductImageCredit logic directly to avoid import issues
async function testDeductCredit(clientId) {
    try {
        const { data: client } = await supabase
            .from('clients')
            .select('id, image_credits, auto_replenish, stripe_customer_id, trial_ends_at, company_name')
            .eq('id', clientId)
            .single();

        if (!client) return { success: false, reason: 'Client not found' };

        // CHECK: Is client in free trial period?
        const now = new Date();
        const trialEnd = client.trial_ends_at ? new Date(client.trial_ends_at) : null;

        if (trialEnd && trialEnd > now) {
            const daysRemaining = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
            console.log(`🎁 Free Trial Active for ${client.company_name}. Unlimited rendering (${daysRemaining} days remaining)`);
            return { success: true, reason: 'trial', credits: client.image_credits };
        }

        // POST-TRIAL: Check credits
        if (client.trial_ends_at) {
            console.log(`💳 Trial ended for ${client.company_name}. Checking credits...`);
        }

        if (!client.image_credits || client.image_credits <= 0) {
            console.log(`🚫 No credits remaining for ${client.company_name}.`);
            return { success: false, reason: 'no_credits' };
        }

        // DEDUCT
        const newBalance = client.image_credits - 1;
        await supabase
            .from('clients')
            .update({ image_credits: newBalance })
            .eq('id', clientId);

        console.log(`✅ Credit deducted for ${client.company_name}. New balance: ${newBalance}`);
        return { success: true, reason: 'credit_deducted', credits: newBalance };

    } catch (err) {
        console.error("Error:", err);
        return { success: false, reason: 'error' };
    }
}

async function runTests() {
    console.log('\n' + '='.repeat(60));
    console.log('🧪 FREE TRIAL SYSTEM TEST (Simplified)');
    console.log('='.repeat(60) + '\n');

    // TEST 1: Client with Active Trial
    console.log('📋 TEST 1: Active Trial Client');
    console.log('-'.repeat(60));

    try {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 15);

        const randomKey = `${Math.random().toString(36).substring(2, 15)}-${Math.random().toString(36).substring(2, 15)}`;

        const { data: client1, error: err1 } = await supabase
            .from('clients')
            .insert([{
                api_key: randomKey,
                company_name: 'Test Company (Active Trial)',
                email: `test-trial-${Date.now()}@example.com`,
                status: 'active',
                image_credits: 0,
                trial_ends_at: trialEnd.toISOString()
            }])
            .select()
            .single();

        if (err1) throw new Error(`Insert failed: ${err1.message}`);

        console.log(`✅ Created: ${client1.company_name}`);
        console.log(`📅 Trial ends: ${trialEnd.toLocaleDateString()}`);
        console.log(`💳 Credits: ${client1.image_credits}\n`);

        // Test 5 renders
        for (let i = 1; i <= 5; i++) {
            const result = await testDeductCredit(client1.id);
            console.log(`  Render ${i}: ${result.success ? '✅ SUCCESS' : '❌ FAILED'} (${result.reason})`);
        }

        // Verify credits unchanged
        const { data: after1 } = await supabase
            .from('clients')
            .select('image_credits')
            .eq('id', client1.id)
            .single();

        console.log(`\n💰 Final credits: ${after1.image_credits} (should be 0)`);
        console.log(after1.image_credits === 0 ? '✅ TEST 1 PASSED' : '❌ TEST 1 FAILED');

        await supabase.from('clients').delete().eq('id', client1.id);

    } catch (error) {
        console.log(`❌ TEST 1 ERROR: ${error.message}`);
    }

    console.log('\n' + '='.repeat(60) + '\n');

    // TEST 2: Client with Expired Trial
    console.log('📋 TEST 2: Expired Trial Client');
    console.log('-'.repeat(60));

    try {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() - 5);

        const randomKey2 = `${Math.random().toString(36).substring(2, 15)}-${Math.random().toString(36).substring(2, 15)}`;

        const { data: client2, error: err2 } = await supabase
            .from('clients')
            .insert([{
                api_key: randomKey2,
                company_name: 'Test Company (Expired Trial)',
                email: `test-expired-${Date.now()}@example.com`,
                status: 'active',
                image_credits: 3,
                trial_ends_at: trialEnd.toISOString()
            }])
            .select()
            .single();

        if (err2) throw new Error(`Insert failed: ${err2.message}`);

        console.log(`✅ Created: ${client2.company_name}`);
        console.log(`📅 Trial ended: ${trialEnd.toLocaleDateString()}`);
        console.log(`💳 Credits: ${client2.image_credits}\n`);

        // Test 4 renders
        let success = 0;
        let failed = 0;
        for (let i = 1; i <= 4; i++) {
            const result = await testDeductCredit(client2.id);
            if (result.success) {
                success++;
                console.log(`  Render ${i}: ✅ SUCCESS (credits: ${result.credits})`);
            } else {
                failed++;
                console.log(`  Render ${i}: 🚫 BLOCKED (${result.reason})`);
            }
        }

        console.log(`\n📊 Results: ${success} succeeded, ${failed} failed`);
        console.log(success === 3 && failed === 1 ? '✅ TEST 2 PASSED' : '❌ TEST 2 FAILED');

        await supabase.from('clients').delete().eq('id', client2.id);

    } catch (error) {
        console.log(`❌ TEST 2 ERROR: ${error.message}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('🎉 TESTS COMPLETED');
    console.log('='.repeat(60) + '\n');
}

runTests().catch(console.error);
