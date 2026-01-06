import { Resend } from 'resend';
import dotenv from 'dotenv';
dotenv.config();

// Initialize Resend with your API Key
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendLeadNotification(toEmails, leadData) {
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
                <p style="margin: 8px 0;"><strong>👤 Name:</strong> ${leadData.customer_name || 'N/A'}</p>
                <p style="margin: 8px 0;"><strong>📞 Phone:</strong> <a href="tel:${leadData.customer_phone}" style="color: #333; font-weight: bold;">${leadData.customer_phone || 'N/A'}</a></p>
                <p style="margin: 8px 0;"><strong>✉️ Email:</strong> <a href="mailto:${leadData.customer_email}" style="color: #333; font-weight: bold;">${leadData.customer_email || 'N/A'}</a></p>
            </div>

            <div style="margin-top: 20px;">
                <h3 style="font-size: 14px; text-transform: uppercase; color: #888; border-bottom: 1px solid #eee; padding-bottom: 5px;">Project Summary</h3>
                <p style="color: #333; line-height: 1.5;">${leadData.ai_summary || leadData.project_summary || 'No summary provided.'}</p>
            </div>
            
            ${leadData.new_ai_rendering ? `
            <div style="margin-top: 20px;">
                 <h3 style="font-size: 14px; text-transform: uppercase; color: #888; border-bottom: 1px solid #eee; padding-bottom: 5px;">AI Rendering Generated</h3>
                 <img src="${leadData.new_ai_rendering}" style="width: 100%; border-radius: 8px; margin-top: 10px; border: 1px solid #ddd;" alt="Room Preview" />
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
            subject: `🎯 New Lead: ${leadData.customer_name || 'Visitor'}`,
            html: htmlBody,
            reply_to: leadData.customer_email // Helpful: hitting reply goes to the customer, not you
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