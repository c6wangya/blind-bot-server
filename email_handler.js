import { Resend } from 'resend';
import dotenv from 'dotenv';
dotenv.config();

// Initialize Resend with your API Key
const resend = process.env.RESEND_API_KEY
    ? new Resend(process.env.RESEND_API_KEY)
    : null;

export async function sendLeadNotification(toEmails, leadData) {
    if (!resend) {
        console.error('❌ RESEND_API_KEY not configured. Email notification skipped.');
        return false;
    }

    let recipientList = [];

    // 1. Clean and Format Recipients
    if (Array.isArray(toEmails)) {
        recipientList = toEmails;
    } else if (typeof toEmails === 'string') {
        recipientList = toEmails.split(',').map(e => e.trim()).filter(e => e.length > 0);
    }

    if (recipientList.length === 0) {
        console.log("⚠️ No recipients defined for notification.");
        return;
    }

    console.log(`📧 Sending Resend Notification to: ${recipientList.join(', ')}`);

    // 2. Construct HTML (Cleaner Layout)
    const htmlBody = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 12px; overflow: hidden;">
        <div style="background-color: #333; padding: 20px; text-align: center;">
            <h2 style="color: #ffffff; margin: 0;">🔔 New Lead Captured</h2>
        </div>
        
        <div style="padding: 25px;">
            <p style="font-size: 16px; color: #555;">You have a new potential customer from your chat widget.</p>
            
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #333; margin: 20px 0;">
                <p style="margin: 8px 0;"><strong>👤 Name:</strong> ${leadData.name || 'N/A'}</p>
                <p style="margin: 8px 0;"><strong>📞 Phone:</strong> <a href="tel:${leadData.phone}" style="color: #333; font-weight: bold;">${leadData.phone || 'N/A'}</a></p>
                <p style="margin: 8px 0;"><strong>✉️ Email:</strong> <a href="mailto:${leadData.email}" style="color: #333; font-weight: bold;">${leadData.email || 'N/A'}</a></p>
            </div>

            <div style="margin-top: 20px;">
                <h3 style="font-size: 14px; text-transform: uppercase; color: #888; border-bottom: 1px solid #eee; padding-bottom: 5px;">Project Summary</h3>
                <p style="color: #333; line-height: 1.5;">${leadData.ai_summary || leadData.project_summary || 'No summary provided.'}</p>
            </div>

            ${leadData.new_customer_image ? `
            <div style="margin-top: 20px;">
                 <h3 style="font-size: 14px; text-transform: uppercase; color: #888; border-bottom: 1px solid #eee; padding-bottom: 5px;">📸 Customer's Room Photo</h3>
                 <img src="${leadData.new_customer_image}" style="width: 100%; border-radius: 8px; margin-top: 10px; border: 1px solid #ddd;" alt="Customer Room Photo" />
            </div>` : ''}

            ${leadData.new_ai_rendering ? `
            <div style="margin-top: 20px;">
                 <h3 style="font-size: 14px; text-transform: uppercase; color: #888; border-bottom: 1px solid #eee; padding-bottom: 5px;">✨ AI Preview with Product</h3>
                 <img src="${leadData.new_ai_rendering}" style="width: 100%; border-radius: 8px; margin-top: 10px; border: 2px solid #28a745;" alt="AI Generated Preview" />
                 <p style="font-size: 12px; color: #28a745; margin-top: 5px; text-align: center;">✨ AI-generated visualization</p>
            </div>` : ''}
        </div>
        
        <div style="background-color: #f1f1f1; padding: 15px; text-align: center; font-size: 12px; color: #888;">
            Sent by The Blinds Bot Automated System
        </div>
    </div>
    `;

    try {
        // 3. Send via Resend API
        // CRITICAL: The 'from' address MUST be a domain you verified on Resend (e.g., 'alerts@theblindsbot.com')
        // It CANNOT be a gmail/yahoo address.
        const data = await resend.emails.send({
            from: 'The Blinds Bot <leads@support.theblindbots.com>',
            to: recipientList,
            subject: `🎯 New Lead: ${leadData.name || 'Visitor'}`,
            html: htmlBody,
            reply_to: leadData.email // Helpful: hitting reply goes to the customer, not you
        });

        if (data.error) {
            console.error("   ❌ Resend API Error:", data.error);
        } else {
            console.log("   ✅ Email sent successfully via Resend. ID:", data.id);
        }

    } catch (err) {
        console.error("   ❌ Fatal Email Error:", err.message);
    }
}

/**
 * Test email configuration on server startup
 * Sends a silent test to verify RESEND_API_KEY works
 * @returns {Promise<boolean>} - true if test passed
 */
export async function testEmailConfiguration() {
    if (!resend) {
        console.warn('⚠️ RESEND_API_KEY not configured. Email notifications disabled.');
        return false;
    }

    console.log('🧪 Testing email configuration...');

    try {
        // Send test to Resend's dummy address (won't actually deliver)
        await resend.emails.send({
            from: 'The Blinds Bot <leads@support.theblindbots.com>',
            to: 'test@resend.dev', // Resend's official test address - accepts but doesn't deliver
            subject: '✅ Email Service Test',
            html: '<p>Email service is operational.</p>'
        });

        console.log('✅ Email configuration test passed. Notifications ready.');
        return true;

    } catch (err) {
        console.error('❌ Email configuration test FAILED:', err.message);
        console.error('   → Lead notifications will NOT work!');
        console.error('   → Please check RESEND_API_KEY and domain verification.');

        // Try to notify admin about the failure
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
            try {
                await resend.emails.send({
                    from: 'The Blinds Bot <alerts@support.theblindbots.com>',
                    to: adminEmail,
                    subject: '🚨 Blinds Bot Email Service DOWN',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 2px solid #ff6b6b; border-radius: 8px;">
                            <h2 style="color: #ff6b6b;">⚠️ Email Service Failed to Start</h2>
                            <p><strong>Error:</strong> ${err.message}</p>
                            <div style="background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0;">
                                <p><strong>Impact:</strong> Lead notifications are NOT working.</p>
                                <p>No emails will be sent until this is resolved.</p>
                            </div>
                            <p><strong>Next steps:</strong></p>
                            <ol>
                                <li>Check RESEND_API_KEY in .env file</li>
                                <li>Verify domain in Resend dashboard</li>
                                <li>Check server logs for details</li>
                                <li>Restart server after fixing</li>
                            </ol>
                        </div>
                    `
                });
                console.log('   ✅ Alert email sent to admin:', adminEmail);
            } catch (alertErr) {
                console.error('   ❌ Could not send alert to admin:', alertErr.message);
            }
        }

        return false;
    }
}