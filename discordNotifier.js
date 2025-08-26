/**
 * Discord Webhook Notifier for TPI Submit Bot
 * Sends formatted error notifications to Discord webhook
 */

const axios = require('axios');
const { config } = require('./config');

class DiscordNotifier {
    constructor(webhookUrl = null, botName = null) {
        this.webhookUrl = webhookUrl || config.discord.webhookUrl;
        this.botName = botName || config.discord.botName;
        this.enabled = config.discord.enabled && this.webhookUrl;
        this.rateLimitDelay = config.discord.rateLimitDelay;
        this.maxRetries = config.discord.maxRetries;
        this.timeout = config.discord.timeout;
        
        // Rate limiting
        this.lastSentTime = 0;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        
        // Error type filters
        this.notifyOnErrors = new Set(config.discord.notifyOnErrors);
        
        if (this.enabled) {
            console.log(`📢 Discord notifications enabled for bot: ${this.botName}`);
        } else if (!this.webhookUrl) {
            console.log('⚠️ Discord webhook URL not configured, notifications disabled');
        } else {
            console.log('📢 Discord notifications disabled via configuration');
        }
    }

    /**
     * Send error notification to Discord
     */
    async sendErrorNotification(error, context = {}) {
        if (!this.enabled) {
            return false;
        }

        // Check if we should notify about this error type
        const errorType = error.type || 'unknown';
        if (!this.notifyOnErrors.has(errorType) && !this.notifyOnErrors.has('all')) {
            console.log(`📢 Skipping Discord notification for error type: ${errorType}`);
            return false;
        }

        const embed = this.createErrorEmbed(error, context);
        return this.sendEmbed(embed);
    }

    /**
     * Send status update notification to Discord
     */
    async sendStatusNotification(status, message, context = {}) {
        if (!this.enabled) {
            return false;
        }

        const embed = this.createStatusEmbed(status, message, context);
        return this.sendEmbed(embed);
    }

    /**
     * Send recovery notification to Discord
     */
    async sendRecoveryNotification(recoveryType, message, context = {}) {
        if (!this.enabled) {
            return false;
        }

        const embed = this.createRecoveryEmbed(recoveryType, message, context);
        return this.sendEmbed(embed);
    }

    /**
     * Send critical alert notification to Discord
     */
    async sendCriticalAlert(alertType, message, context = {}) {
        if (!this.enabled) {
            return false;
        }

        const embed = this.createCriticalEmbed(alertType, message, context);
        return this.sendEmbed(embed);
    }

    /**
     * Create error embed
     */
    createErrorEmbed(error, context = {}) {
        const fields = [];

        // Error details
        fields.push({
            name: '🔍 Error Details',
            value: `**Type:** ${error.type || 'Unknown'}\n**Message:** ${error.message || 'No message'}`,
            inline: false
        });

        // Context information
        if (context.jobId) {
            fields.push({
                name: '🆔 Job ID',
                value: context.jobId,
                inline: true
            });
        }

        if (context.batchIndex !== undefined) {
            fields.push({
                name: '📦 Batch',
                value: `${context.batchIndex + 1}${context.totalBatches ? `/${context.totalBatches}` : ''}`,
                inline: true
            });
        }

        // Error-specific information
        if (error.attempt && error.maxAttempts) {
            fields.push({
                name: '🔄 Attempts',
                value: `${error.attempt}/${error.maxAttempts}`,
                inline: true
            });
        }

        if (error.timeout) {
            fields.push({
                name: '⏱️ Timeout',
                value: `${Math.round(error.timeout / 1000)}s`,
                inline: true
            });
        }

        if (error.memoryUsage) {
            fields.push({
                name: '💾 Memory Usage',
                value: `RSS: ${error.memoryUsage.rss}MB\nHeap: ${error.memoryUsage.heapUsed}MB`,
                inline: true
            });
        }

        // Recovery status
        fields.push({
            name: '🛠️ Recoverable',
            value: error.recoverable ? '✅ Yes' : '❌ No',
            inline: true
        });

        return {
            color: config.discord.colors.error,
            title: `🚨 ${error.name || 'Error'} Detected`,
            description: `An error has occurred in the TPI Submit Bot.`,
            fields: fields,
            timestamp: error.timestamp || new Date().toISOString(),
            footer: {
                text: this.botName,
                icon_url: 'https://cdn.discordapp.com/emojis/853331157911076864.png?v=1'
            }
        };
    }

    /**
     * Create status embed
     */
    createStatusEmbed(status, message, context = {}) {
        const color = this.getStatusColor(status);
        const emoji = this.getStatusEmoji(status);
        const fields = [];

        // Status details
        fields.push({
            name: '📊 Status',
            value: `**${status}**\n${message}`,
            inline: false
        });

        // Progress information
        if (context.progress) {
            const progress = context.progress;
            const percentage = progress.percentage || 0;
            const progressBar = this.createProgressBar(percentage);
            
            fields.push({
                name: '📈 Progress',
                value: `${progressBar} ${percentage}%\n**Completed:** ${progress.completed || 0}\n**Failed:** ${progress.failed || 0}\n**Total:** ${progress.total || 0}`,
                inline: false
            });
        }

        // Memory information
        if (context.memoryUsage) {
            fields.push({
                name: '💾 Memory',
                value: `RSS: ${context.memoryUsage.rss}MB\nHeap: ${context.memoryUsage.heapUsed}MB`,
                inline: true
            });
        }

        // Browser instances
        if (context.browserInstances !== undefined) {
            fields.push({
                name: '🌐 Browser Instances',
                value: context.browserInstances.toString(),
                inline: true
            });
        }

        return {
            color: color,
            title: `${emoji} ${status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')}`,
            description: context.jobId ? `Job ID: \`${context.jobId}\`` : 'System status update',
            fields: fields,
            timestamp: new Date().toISOString(),
            footer: {
                text: this.botName,
                icon_url: 'https://cdn.discordapp.com/emojis/853331157911076864.png?v=1'
            }
        };
    }

    /**
     * Create recovery embed
     */
    createRecoveryEmbed(recoveryType, message, context = {}) {
        const fields = [];

        fields.push({
            name: '🔄 Recovery Action',
            value: `**Type:** ${recoveryType}\n**Details:** ${message}`,
            inline: false
        });

        if (context.previousErrors) {
            fields.push({
                name: '📝 Previous Errors',
                value: context.previousErrors.slice(-3).map(err => `• ${err.message}`).join('\n'),
                inline: false
            });
        }

        if (context.recoveryStats) {
            const stats = context.recoveryStats;
            fields.push({
                name: '📊 Recovery Stats',
                value: `**Attempts:** ${stats.attempts || 1}\n**Success Rate:** ${stats.successRate || 'N/A'}\n**Duration:** ${stats.duration || 'N/A'}`,
                inline: true
            });
        }

        return {
            color: config.discord.colors.warning,
            title: `🛠️ Recovery Attempt: ${recoveryType.charAt(0).toUpperCase() + recoveryType.slice(1).replace(/_/g, ' ')}`,
            description: context.jobId ? `Attempting recovery for Job ID: \`${context.jobId}\`` : 'System recovery in progress',
            fields: fields,
            timestamp: new Date().toISOString(),
            footer: {
                text: this.botName,
                icon_url: 'https://cdn.discordapp.com/emojis/853331157911076864.png?v=1'
            }
        };
    }

    /**
     * Create critical alert embed
     */
    createCriticalEmbed(alertType, message, context = {}) {
        const fields = [];

        fields.push({
            name: '🚨 Critical Alert',
            value: `**Type:** ${alertType}\n**Message:** ${message}`,
            inline: false
        });

        fields.push({
            name: '⚡ Immediate Action Required',
            value: 'This alert indicates a critical system issue that requires immediate attention.',
            inline: false
        });

        if (context.systemMetrics) {
            const metrics = context.systemMetrics;
            fields.push({
                name: '📊 System Metrics',
                value: `**Memory:** ${metrics.memory?.rss}MB\n**Uptime:** ${metrics.uptime}s\n**Browsers:** ${metrics.browserInstances}`,
                inline: true
            });
        }

        if (context.recommendedActions) {
            fields.push({
                name: '💡 Recommended Actions',
                value: context.recommendedActions.map(action => `• ${action}`).join('\n'),
                inline: false
            });
        }

        return {
            color: config.discord.colors.error,
            title: `🚨 CRITICAL ALERT: ${alertType.toUpperCase()}`,
            description: '**This is a critical system alert requiring immediate attention.**',
            fields: fields,
            timestamp: new Date().toISOString(),
            footer: {
                text: this.botName,
                icon_url: 'https://cdn.discordapp.com/emojis/853331157911076864.png?v=1'
            }
        };
    }

    /**
     * Send embed to Discord with rate limiting and retries
     */
    async sendEmbed(embed) {
        if (!this.enabled || !this.webhookUrl) {
            return false;
        }

        const message = {
            username: this.botName,
            embeds: [embed]
        };

        // Add to queue for rate limiting
        return new Promise((resolve, reject) => {
            this.messageQueue.push({ message, resolve, reject });
            this.processMessageQueue();
        });
    }

    /**
     * Process message queue with rate limiting
     */
    async processMessageQueue() {
        if (this.isProcessingQueue || this.messageQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;

        while (this.messageQueue.length > 0) {
            const { message, resolve, reject } = this.messageQueue.shift();

            // Rate limiting
            const timeSinceLastSent = Date.now() - this.lastSentTime;
            if (timeSinceLastSent < this.rateLimitDelay) {
                await new Promise(r => setTimeout(r, this.rateLimitDelay - timeSinceLastSent));
            }

            try {
                const success = await this.sendMessageWithRetries(message);
                this.lastSentTime = Date.now();
                resolve(success);
            } catch (error) {
                reject(error);
            }

            // Small delay between messages
            await new Promise(r => setTimeout(r, 200));
        }

        this.isProcessingQueue = false;
    }

    /**
     * Send message with retry logic
     */
    async sendMessageWithRetries(message) {
        let lastError;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await axios.post(this.webhookUrl, message, {
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'TPI-Submit-Bot-Discord-Notifier/1.0'
                    },
                    timeout: this.timeout
                });

                if (response.status === 200 || response.status === 204) {
                    if (attempt > 1) {
                        console.log(`✅ Discord notification sent successfully (attempt ${attempt})`);
                    }
                    return true;
                }

                throw new Error(`HTTP ${response.status}: ${response.statusText}`);

            } catch (error) {
                lastError = error;
                console.log(`⚠️ Discord notification attempt ${attempt} failed: ${error.message}`);

                if (attempt < this.maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        console.error(`❌ Failed to send Discord notification after ${this.maxRetries} attempts:`, lastError.message);
        return false;
    }

    /**
     * Get color for status type
     */
    getStatusColor(status) {
        const colorMap = {
            'started': config.discord.colors.info,
            'processing': config.discord.colors.info,
            'completed': config.discord.colors.success,
            'success': config.discord.colors.success,
            'failed': config.discord.colors.error,
            'error': config.discord.colors.error,
            'warning': config.discord.colors.warning,
            'recovery': config.discord.colors.warning,
            'crashed': config.discord.colors.error,
            'timeout': config.discord.colors.warning
        };

        return colorMap[status.toLowerCase()] || config.discord.colors.info;
    }

    /**
     * Get emoji for status type
     */
    getStatusEmoji(status) {
        const emojiMap = {
            'started': '🚀',
            'processing': '⚙️',
            'completed': '✅',
            'success': '✅',
            'failed': '❌',
            'error': '🚨',
            'warning': '⚠️',
            'recovery': '🛠️',
            'crashed': '💥',
            'timeout': '⏱️',
            'login': '🔐',
            'browser_launch': '🌐',
            'memory_warning': '💾'
        };

        return emojiMap[status.toLowerCase()] || '📊';
    }

    /**
     * Create progress bar visualization
     */
    createProgressBar(percentage, length = 20) {
        const filled = Math.round((percentage / 100) * length);
        const empty = length - filled;
        const bar = '█'.repeat(filled) + '░'.repeat(empty);
        return `[${bar}]`;
    }

    /**
     * Test Discord webhook connection
     */
    async testConnection() {
        if (!this.enabled) {
            return { success: false, error: 'Discord notifications disabled' };
        }

        try {
            const testEmbed = {
                color: config.discord.colors.info,
                title: '🧪 Discord Webhook Test',
                description: 'This is a test notification to verify Discord webhook connectivity.',
                fields: [
                    {
                        name: '✅ Status',
                        value: 'Connection test successful',
                        inline: true
                    },
                    {
                        name: '🤖 Bot',
                        value: this.botName,
                        inline: true
                    }
                ],
                timestamp: new Date().toISOString(),
                footer: {
                    text: 'TPI Submit Bot - Test Message'
                }
            };

            const success = await this.sendEmbed(testEmbed);
            return { 
                success, 
                message: success ? 'Test notification sent successfully' : 'Failed to send test notification' 
            };

        } catch (error) {
            return { 
                success: false, 
                error: error.message 
            };
        }
    }
}

// Create singleton instance
const discordNotifier = new DiscordNotifier();

module.exports = {
    DiscordNotifier,
    discordNotifier
};