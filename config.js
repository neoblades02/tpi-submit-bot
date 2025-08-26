/**
 * Configuration Management for TPI Submit Bot
 * Centralizes all configuration with environment variable support and validation
 */

require('dotenv').config();

/**
 * Parse environment variable as integer with fallback
 */
function parseIntEnv(envVar, defaultValue) {
    const value = process.env[envVar];
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse environment variable as boolean with fallback
 */
function parseBoolEnv(envVar, defaultValue) {
    const value = process.env[envVar];
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse environment variable as array with fallback
 */
function parseArrayEnv(envVar, defaultValue = []) {
    const value = process.env[envVar];
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
}

const config = {
    // Server Configuration
    server: {
        port: parseIntEnv('PORT', 3000),
        nodeEnv: process.env.NODE_ENV || 'production',
        logLevel: process.env.LOG_LEVEL || 'info'
    },

    // TPI Suitcase Credentials
    tpi: {
        username: process.env.USERNAME || '',
        password: process.env.PASSWORD || '',
        baseUrl: process.env.TPI_BASE_URL || 'https://my.tpisuitcase.com/'
    },

    // Browser Configuration
    browser: {
        headless: parseBoolEnv('HEADLESS', true),
        timeout: parseIntEnv('BROWSER_TIMEOUT', 180000), // 3 minutes default (increased from 120000)
        launchTimeout: parseIntEnv('BROWSER_LAUNCH_TIMEOUT', 240000), // 4 minutes for launch specifically
        pageTimeout: parseIntEnv('PAGE_TIMEOUT', 60000),
        navigationTimeout: parseIntEnv('NAVIGATION_TIMEOUT', 60000),
        maxRetries: parseIntEnv('BROWSER_MAX_RETRIES', 5), // Increased from 3
        retryDelay: parseIntEnv('BROWSER_RETRY_DELAY', 5000),
        maxRetryDelay: parseIntEnv('BROWSER_MAX_RETRY_DELAY', 60000), // Max 1 minute between retries
        resourceTimeout: parseIntEnv('BROWSER_RESOURCE_TIMEOUT_MS', 600000), // 10 minutes
        
        // Browser launch arguments
        args: parseArrayEnv('BROWSER_ARGS', [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--memory-pressure-off'
        ])
    },

    // Job Management Configuration
    job: {
        maxConcurrentJobs: parseIntEnv('MAX_CONCURRENT_JOBS', 1),
        batchSize: parseIntEnv('BATCH_SIZE', 50),
        maxJobRetries: parseIntEnv('MAX_JOB_RETRIES', 3),
        jobTimeout: parseIntEnv('JOB_TIMEOUT_MS', 1800000), // 30 minutes
        batchTimeout: parseIntEnv('BATCH_TIMEOUT_MS', 300000), // 5 minutes per batch
        retryDelay: parseIntEnv('JOB_RETRY_DELAY_MS', 10000),
        cleanupInterval: parseIntEnv('JOB_CLEANUP_INTERVAL_MS', 86400000) // 24 hours
    },

    // Memory Monitoring Configuration
    memory: {
        threshold: parseIntEnv('MEMORY_THRESHOLD_MB', 512), // 512MB
        maxUsage: parseIntEnv('MAX_MEMORY_USAGE_MB', 1024), // 1GB
        checkInterval: parseIntEnv('MEMORY_CHECK_INTERVAL_MS', 30000), // 30 seconds
        gcThreshold: parseIntEnv('GC_THRESHOLD_MB', 256), // 256MB
        enableGC: parseBoolEnv('ENABLE_MANUAL_GC', true)
    },

    // Circuit Breaker Configuration
    circuitBreaker: {
        enabled: parseBoolEnv('CIRCUIT_BREAKER_ENABLED', true),
        failureThreshold: parseIntEnv('CIRCUIT_BREAKER_FAILURE_THRESHOLD', 5),
        resetTimeout: parseIntEnv('CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 300000), // 5 minutes
        monitoringPeriod: parseIntEnv('CIRCUIT_BREAKER_MONITORING_PERIOD_MS', 60000) // 1 minute
    },

    // Discord Webhook Configuration
    discord: {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
        botName: process.env.DISCORD_BOT_NAME || 'TPI Submit Bot (Coolify)',
        enabled: parseBoolEnv('DISCORD_NOTIFICATIONS_ENABLED', true),
        timeout: parseIntEnv('DISCORD_TIMEOUT_MS', 10000),
        rateLimitDelay: parseIntEnv('DISCORD_RATE_LIMIT_DELAY_MS', 1000),
        maxRetries: parseIntEnv('DISCORD_MAX_RETRIES', 3),
        
        // Error types to notify about
        notifyOnErrors: parseArrayEnv('DISCORD_NOTIFY_ERRORS', [
            'browser_launch',
            'browser_crash',
            'resource_exhaustion',
            'circuit_breaker',
            'job_failure'
        ]),
        
        // Colors for different message types
        colors: {
            error: 0xFF0000,      // Red
            warning: 0xFFA500,    // Orange
            success: 0x00FF00,    // Green
            info: 0x0099FF        // Blue
        }
    },

    // Webhook Configuration (for data submission)
    webhook: {
        url: process.env.WEBHOOK_URL || '',
        timeout: parseIntEnv('WEBHOOK_TIMEOUT_MS', 30000),
        maxRetries: parseIntEnv('WEBHOOK_MAX_RETRIES', 3),
        retryDelay: parseIntEnv('WEBHOOK_RETRY_DELAY_MS', 5000)
    },

    // Status Updates Configuration
    status: {
        webhookUrl: process.env.STATUS_WEBHOOK_URL || 'https://n8n.collectgreatstories.com/webhook/tpi-status',
        timeout: parseIntEnv('STATUS_WEBHOOK_TIMEOUT_MS', 10000),
        enabled: parseBoolEnv('STATUS_UPDATES_ENABLED', true)
    },

    // Automatic Restart Configuration
    restart: {
        enabled: parseBoolEnv('AUTO_RESTART_ENABLED', true),
        maxRestarts: parseIntEnv('MAX_AUTO_RESTARTS', 3),
        restartDelay: parseIntEnv('AUTO_RESTART_DELAY_MS', 30000), // 30 seconds
        cooldownPeriod: parseIntEnv('RESTART_COOLDOWN_MS', 300000) // 5 minutes
    },

    // Development/Debug Configuration
    debug: {
        enabled: parseBoolEnv('DEBUG_MODE', false),
        logBrowserConsole: parseBoolEnv('LOG_BROWSER_CONSOLE', false),
        saveBrowserLogs: parseBoolEnv('SAVE_BROWSER_LOGS', false),
        screenshotOnError: parseBoolEnv('SCREENSHOT_ON_ERROR', false),
        verboseLogging: parseBoolEnv('VERBOSE_LOGGING', false)
    }
};

/**
 * Validate critical configuration values
 */
function validateConfig() {
    const errors = [];
    const warnings = [];

    // Check required credentials - differentiate between production and development
    if (!config.tpi.username) {
        if (config.server.nodeEnv === 'production') {
            errors.push('TPI username is required in production (USERNAME environment variable)');
        } else {
            warnings.push('TPI username not set - some functionality will be limited (USERNAME environment variable)');
        }
    }
    if (!config.tpi.password) {
        if (config.server.nodeEnv === 'production') {
            errors.push('TPI password is required in production (PASSWORD environment variable)');
        } else {
            warnings.push('TPI password not set - some functionality will be limited (PASSWORD environment variable)');
        }
    }

    // Log warnings if any
    if (warnings.length > 0) {
        console.warn('⚠️ Configuration warnings:');
        warnings.forEach(warning => console.warn(`  - ${warning}`));
    }

    // Validate numeric ranges
    if (config.browser.timeout < 30000) {
        errors.push('Browser timeout must be at least 30 seconds');
    }
    if (config.browser.maxRetries < 1 || config.browser.maxRetries > 10) {
        errors.push('Browser max retries must be between 1 and 10');
    }
    if (config.memory.threshold > config.memory.maxUsage) {
        errors.push('Memory threshold cannot be higher than max memory usage');
    }
    if (config.job.batchSize < 1 || config.job.batchSize > 1000) {
        errors.push('Batch size must be between 1 and 1000');
    }

    // Validate Discord webhook URL format if notifications are enabled
    if (config.discord.enabled && config.discord.webhookUrl && !config.discord.webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
        errors.push('Discord webhook URL format is invalid');
    }

    return errors;
}

/**
 * Get configuration summary for logging
 */
function getConfigSummary() {
    return {
        environment: config.server.nodeEnv,
        browserTimeout: `${config.browser.timeout / 1000}s`,
        browserMaxRetries: config.browser.maxRetries,
        memoryThreshold: `${config.memory.threshold}MB`,
        maxMemoryUsage: `${config.memory.maxUsage}MB`,
        batchSize: config.job.batchSize,
        circuitBreakerEnabled: config.circuitBreaker.enabled,
        discordNotificationsEnabled: config.discord.enabled,
        autoRestartEnabled: config.restart.enabled,
        debugMode: config.debug.enabled
    };
}

// Validate configuration on module load
const validationErrors = validateConfig();
if (validationErrors.length > 0) {
    console.error('❌ Configuration validation errors:');
    validationErrors.forEach(error => console.error(`  - ${error}`));
    if (config.server.nodeEnv === 'production') {
        process.exit(1);
    }
}

// Log configuration summary
console.log('⚙️ Configuration loaded:', getConfigSummary());

module.exports = {
    config,
    validateConfig,
    getConfigSummary
};