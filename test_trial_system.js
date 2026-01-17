/**
 * Test Script for Free Trial System
 *
 * This script tests the 1-month free trial with unlimited rendering.
 *
 * Usage:
 *   node test_trial_system.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { deductImageCredit } from './subscription_manager.js';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ANSI color codes for pretty output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function log(emoji, color, message) {
    console.log(`${colors[color]}${emoji} ${message}${colors.reset}`);
}

async function runTests() {
    console.log('\n' + '='.repeat(60));
    log('🧪', 'cyan', 'FREE TRIAL SYSTEM TEST');
    console.log('='.repeat(60) + '\n');

    // TEST 1: Client with Active Trial
    log('📋', 'blue', 'TEST 1: Client with Active Trial (Unlimited Rendering)');
    console.log('-'.repeat(60));

    try {
        // Create test client with active trial
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 15); // 15 days from now

        const { data: testClient, error: insertError } = await supabase
            .from('clients')
            .insert([{
                api_key: `test_trial_${Date.now()}`,
                company_name: 'Test Company (Active Trial)',
                email: `test_trial_${Date.now()}@example.com`,
                status: 'active',
                image_credits: 0, // Zero credits
                trial_ends_at: trialEnd.toISOString()
            }])
            .select()
            .single();

        if (insertError) throw insertError;

        log('✅', 'green', `Created test client: ${testClient.company_name}`);
        log('📅', 'yellow', `Trial ends: ${trialEnd.toLocaleDateString()} (${Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24))} days)`);
        log('💳', 'yellow', `Credits: ${testClient.image_credits}`);

        // Test rendering 5 times
        console.log('\n🎨 Testing 5 rendering attempts...');
        for (let i = 1; i <= 5; i++) {
            const canRender = await deductImageCredit(supabase, testClient.id);
            if (canRender) {
                log('✅', 'green', `  Render ${i}: SUCCESS (trial active, no credit deducted)`);
            } else {
                log('❌', 'red', `  Render ${i}: FAILED (should not happen during trial!)`);
            }
        }

        // Check credits unchanged
        const { data: afterClient } = await supabase
            .from('clients')
            .select('image_credits')
            .eq('id', testClient.id)
            .single();

        if (afterClient.image_credits === 0) {
            log('✅', 'green', `Credits unchanged: ${afterClient.image_credits} (correct!)`);
        } else {
            log('❌', 'red', `Credits changed: ${afterClient.image_credits} (should still be 0!)`);
        }

        // Cleanup
        await supabase.from('clients').delete().eq('id', testClient.id);

    } catch (error) {
        log('❌', 'red', `TEST 1 FAILED: ${error.message}`);
    }

    console.log('\n' + '='.repeat(60) + '\n');

    // TEST 2: Client with Expired Trial
    log('📋', 'blue', 'TEST 2: Client with Expired Trial (Credit-Based)');
    console.log('-'.repeat(60));

    try {
        // Create test client with expired trial
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() - 5); // 5 days ago

        const { data: testClient, error: insertError } = await supabase
            .from('clients')
            .insert([{
                api_key: `test_expired_${Date.now()}`,
                company_name: 'Test Company (Expired Trial)',
                email: `test_expired_${Date.now()}@example.com`,
                status: 'active',
                image_credits: 3, // 3 credits
                trial_ends_at: trialEnd.toISOString()
            }])
            .select()
            .single();

        if (insertError) throw insertError;

        log('✅', 'green', `Created test client: ${testClient.company_name}`);
        log('📅', 'yellow', `Trial ended: ${trialEnd.toLocaleDateString()} (expired)`);
        log('💳', 'yellow', `Credits: ${testClient.image_credits}`);

        // Test rendering 4 times (should succeed 3 times, fail once)
        console.log('\n🎨 Testing 4 rendering attempts (3 should succeed, 1 should fail)...');
        let successCount = 0;
        let failCount = 0;

        for (let i = 1; i <= 4; i++) {
            const canRender = await deductImageCredit(supabase, testClient.id);
            if (canRender) {
                successCount++;
                log('✅', 'green', `  Render ${i}: SUCCESS`);
            } else {
                failCount++;
                log('🚫', 'yellow', `  Render ${i}: BLOCKED (no credits)`);
            }
        }

        // Check results
        const { data: afterClient } = await supabase
            .from('clients')
            .select('image_credits')
            .eq('id', testClient.id)
            .single();

        if (successCount === 3 && failCount === 1 && afterClient.image_credits === 0) {
            log('✅', 'green', `Test passed: 3 succeeded, 1 failed, 0 credits remaining`);
        } else {
            log('❌', 'red', `Test failed: ${successCount} succeeded, ${failCount} failed, ${afterClient.image_credits} credits remaining`);
        }

        // Cleanup
        await supabase.from('clients').delete().eq('id', testClient.id);

    } catch (error) {
        log('❌', 'red', `TEST 2 FAILED: ${error.message}`);
    }

    console.log('\n' + '='.repeat(60) + '\n');

    // TEST 3: Client with No Trial
    log('📋', 'blue', 'TEST 3: Client with No Trial (Legacy Client)');
    console.log('-'.repeat(60));

    try {
        // Create test client without trial
        const { data: testClient, error: insertError } = await supabase
            .from('clients')
            .insert([{
                api_key: `test_legacy_${Date.now()}`,
                company_name: 'Test Company (No Trial)',
                email: `test_legacy_${Date.now()}@example.com`,
                status: 'active',
                image_credits: 2,
                trial_ends_at: null // No trial
            }])
            .select()
            .single();

        if (insertError) throw insertError;

        log('✅', 'green', `Created test client: ${testClient.company_name}`);
        log('📅', 'yellow', `Trial: None (legacy client)`);
        log('💳', 'yellow', `Credits: ${testClient.image_credits}`);

        // Test rendering 3 times (should succeed 2 times, fail once)
        console.log('\n🎨 Testing 3 rendering attempts (2 should succeed, 1 should fail)...');
        let successCount = 0;
        let failCount = 0;

        for (let i = 1; i <= 3; i++) {
            const canRender = await deductImageCredit(supabase, testClient.id);
            if (canRender) {
                successCount++;
                log('✅', 'green', `  Render ${i}: SUCCESS`);
            } else {
                failCount++;
                log('🚫', 'yellow', `  Render ${i}: BLOCKED (no credits)`);
            }
        }

        // Check results
        const { data: afterClient } = await supabase
            .from('clients')
            .select('image_credits')
            .eq('id', testClient.id)
            .single();

        if (successCount === 2 && failCount === 1 && afterClient.image_credits === 0) {
            log('✅', 'green', `Test passed: 2 succeeded, 1 failed, 0 credits remaining`);
        } else {
            log('❌', 'red', `Test failed: ${successCount} succeeded, ${failCount} failed, ${afterClient.image_credits} credits remaining`);
        }

        // Cleanup
        await supabase.from('clients').delete().eq('id', testClient.id);

    } catch (error) {
        log('❌', 'red', `TEST 3 FAILED: ${error.message}`);
    }

    console.log('\n' + '='.repeat(60));
    log('🎉', 'green', 'ALL TESTS COMPLETED');
    console.log('='.repeat(60) + '\n');
}

// Run tests
runTests().catch(console.error);
