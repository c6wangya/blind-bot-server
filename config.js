// config.js - Environment-aware configuration module
// Centralizes all environment variables and URL generation

/**
 * Environment Variables:
 * - APP_ENV: "prod" | "beta" (default: "prod")
 * - FRONTEND_ORIGINS: comma-separated allowed origins for CORS
 * - FRONTEND_BASE_URL: base URL for frontend links/redirects
 * - PUBLIC_BASE_URL: base URL for backend absolute URLs (widget.js, etc.)
 * - EMAIL_FROM_LEADS, EMAIL_FROM_ALERTS, EMAIL_FROM_SUPPORT, EMAIL_ADMIN_TO
 */

const APP_ENV = process.env.APP_ENV || 'prod';
const isProd = APP_ENV === 'prod';
const isBeta = APP_ENV === 'beta';

// Parse FRONTEND_ORIGINS from comma-separated string
// Default to theblindbots.com if not specified
const DEFAULT_ORIGINS = 'https://www.theblindbots.com';
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || DEFAULT_ORIGINS)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Base URLs for link generation
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://www.theblindbots.com';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://blind-bot-server.onrender.com';

// Email configuration
const EMAIL_FROM_LEADS = process.env.EMAIL_FROM_LEADS || 'The Blinds Bot <leads@support.theblindbots.com>';
const EMAIL_FROM_ALERTS = process.env.EMAIL_FROM_ALERTS || 'The Blinds Bot <alerts@support.theblindbots.com>';
const EMAIL_FROM_SUPPORT = process.env.EMAIL_FROM_SUPPORT || 'Client Support <help@support.theblindbots.com>';
const EMAIL_ADMIN_TO = process.env.EMAIL_ADMIN_TO || 'rob.wen@theblindbots.com';

/**
 * Check if origin is allowed for CORS
 * - Always allow requests with no Origin (curl, health checks)
 * - Check exact match in FRONTEND_ORIGINS allowlist
 * - Beta mode: additionally allow Softr preview origins
 */
function isAllowedOrigin(origin) {
    // No origin = server-to-server or curl, always allow
    if (!origin) return true;

    // Check exact match in allowlist
    if (FRONTEND_ORIGINS.includes(origin)) return true;

    // Beta mode: allow Softr preview origins
    if (isBeta) {
        try {
            const url = new URL(origin);
            const hostname = url.hostname;

            // Allow studio.softr.io explicitly
            if (hostname === 'studio.softr.io') return true;

            // Allow *.softr.app and *.softr.io
            if (hostname.endsWith('.softr.app') || hostname.endsWith('.softr.io')) {
                return true;
            }
        } catch (e) {
            // Invalid URL, reject
            return false;
        }
    }

    return false;
}

/**
 * CORS middleware configuration function
 * Pass this to cors() middleware
 */
function corsOptions(req, callback) {
    const origin = req.header('Origin');

    if (isAllowedOrigin(origin)) {
        callback(null, {
            origin: true,
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
        });
    } else {
        console.warn(`[CORS] Rejected origin: ${origin} (env: ${APP_ENV})`);
        callback(null, { origin: false });
    }
}

/**
 * Generate widget script tag for injection
 */
function getWidgetScriptTag(apiKey) {
    return `<script src="${PUBLIC_BASE_URL}/widget.js" data-api-key="${apiKey}"></script>`;
}

/**
 * Get server URL for client-side usage
 */
function getServerUrl() {
    return PUBLIC_BASE_URL;
}

/**
 * Get frontend URL for redirects
 */
function getFrontendUrl(path = '') {
    return `${FRONTEND_BASE_URL}${path}`;
}

export {
    APP_ENV,
    isProd,
    isBeta,
    FRONTEND_ORIGINS,
    FRONTEND_BASE_URL,
    PUBLIC_BASE_URL,
    EMAIL_FROM_LEADS,
    EMAIL_FROM_ALERTS,
    EMAIL_FROM_SUPPORT,
    EMAIL_ADMIN_TO,
    isAllowedOrigin,
    corsOptions,
    getWidgetScriptTag,
    getServerUrl,
    getFrontendUrl
};
