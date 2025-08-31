const { ErrorClassifier, BrowserLaunchError, BrowserCrashError, BrowserSessionTerminatedError, CircuitBreakerError } = require('./errors');
const { discordNotifier } = require('./discordNotifier');
const { systemMonitor } = require('./monitor');

/**
 * Centralized Error Handler - Consolidates duplicate error handling logic
 * Reduces 400+ lines of redundant code across multiple modules
 */
class ErrorHandler {
    constructor() {
        this.errorCorrelationMap = new Map(); // Track related errors
        this.errorStats = {
            totalErrors: 0,
            errorsByType: new Map(),
            errorsByOperation: new Map(),
            lastErrorTime: null
        };
        
        console.log('🎯 ErrorHandler initialized');
    }

    /**
     * Handle any error with classification, Discord notification, and correlation
     * @param {Error} error - The error to handle
     * @param {Object} context - Context information
     * @returns {Object} Classified error with handling recommendations
     */
    async handleError(error, context = {}) {
        try {
            this.updateErrorStats(error, context);
            
            // Classify the error
            const classifiedError = ErrorClassifier.classify(error, context);
            
            // Add correlation ID for tracking related errors
            const correlationId = this.generateCorrelationId(error, context);
            classifiedError.correlationId = correlationId;
            
            // Send Discord notification if enabled for this error type
            await this.sendDiscordNotification(classifiedError, context);
            
            // Handle specific error type logic
            await this.handleSpecificErrorType(classifiedError, context);
            
            // Store for correlation tracking
            this.errorCorrelationMap.set(correlationId, {
                error: classifiedError,
                context,
                timestamp: Date.now()
            });
            
            console.log(`🔍 Error handled: ${classifiedError.name} (${correlationId})`);
            
            return {
                classifiedError,
                correlationId,
                recommendations: this.generateRecommendations(classifiedError, context)
            };
            
        } catch (handlingError) {
            console.error('❌ Error in ErrorHandler:', handlingError.message);
            // Fallback: return basic error info
            return {
                classifiedError: { name: 'UnclassifiedError', message: error.message },
                correlationId: 'error-handler-failure',
                recommendations: { action: 'retry', shouldNotify: true }
            };
        }
    }

    /**
     * Handle job-level errors with job state updates
     */
    async handleJobError(error, jobId, jobManager, context = {}) {
        const enhancedContext = { ...context, jobId, operation: 'job_processing' };
        const result = await this.handleError(error, enhancedContext);
        
        // Update job status based on error classification
        if (jobManager) {
            await this.updateJobForError(result.classifiedError, jobId, jobManager);
        }
        
        return result;
    }

    /**
     * Handle browser-related errors with session management
     */
    async handleBrowserError(error, sessionId, context = {}) {
        const enhancedContext = { ...context, sessionId, operation: 'browser_management' };
        const result = await this.handleError(error, enhancedContext);
        
        // Handle browser-specific recovery
        if (sessionId) {
            await this.handleBrowserErrorRecovery(result.classifiedError, sessionId);
        }
        
        return result;
    }

    /**
     * Handle record processing errors with state tracking
     */
    async handleRecordError(error, record, context = {}) {
        const enhancedContext = { 
            ...context, 
            record: record['Client Name'] || 'Unknown',
            operation: 'record_processing' 
        };
        const result = await this.handleError(error, enhancedContext);
        
        // Track record error in state manager
        const { recordStateManager } = require('./recordStateManager');
        if (recordStateManager) {
            recordStateManager.recordError(record, result.classifiedError);
        }
        
        return result;
    }

    /**
     * Send Discord notification based on error classification
     */
    async sendDiscordNotification(classifiedError, context) {
        try {
            if (!discordNotifier || !this.shouldNotifyForError(classifiedError)) {
                return;
            }

            // Determine notification type
            if (classifiedError.severity === 'critical') {
                await discordNotifier.sendCriticalAlert(
                    classifiedError.name,
                    classifiedError.message,
                    {
                        ...context,
                        errorDetails: classifiedError.toJSON ? classifiedError.toJSON() : classifiedError,
                        correlationId: classifiedError.correlationId,
                        timestamp: new Date().toISOString()
                    }
                );
            } else if (classifiedError.severity === 'high') {
                await discordNotifier.sendErrorNotification(classifiedError, context);
            } else {
                await discordNotifier.sendStatusNotification(
                    classifiedError.name,
                    classifiedError.message,
                    context
                );
            }
            
            console.log(`📢 Discord notification sent for ${classifiedError.name}`);
            
        } catch (notificationError) {
            console.error('❌ Failed to send Discord notification:', notificationError.message);
        }
    }

    /**
     * Handle specific error type logic
     */
    async handleSpecificErrorType(classifiedError, context) {
        try {
            if (classifiedError instanceof BrowserLaunchError) {
                await this.handleBrowserLaunchError(classifiedError, context);
            } else if (classifiedError instanceof BrowserCrashError) {
                await this.handleBrowserCrashError(classifiedError, context);
            } else if (classifiedError instanceof BrowserSessionTerminatedError) {
                await this.handleSessionTerminatedError(classifiedError, context);
            } else if (classifiedError instanceof CircuitBreakerError) {
                await this.handleCircuitBreakerError(classifiedError, context);
            }
        } catch (specificError) {
            console.error(`❌ Error handling ${classifiedError.name}:`, specificError.message);
        }
    }

    /**
     * Handle browser launch errors
     */
    async handleBrowserLaunchError(error, context) {
        console.log('🚀 Handling browser launch error...');
        
        // Trigger system monitoring
        if (systemMonitor) {
            systemMonitor.emit('browser_launch_error', { error, context });
        }
        
        // Consider automatic restart
        const { autoRestartManager } = require('./circuitBreaker');
        if (autoRestartManager && error.recoverable) {
            await autoRestartManager.considerRestart('browser', 
                `Browser launch failure: ${error.message}`);
        }
    }

    /**
     * Handle browser crash errors
     */
    async handleBrowserCrashError(error, context) {
        console.log('💥 Handling browser crash error...');
        
        // Clean up browser resources
        if (context.sessionId && systemMonitor) {
            systemMonitor.unregisterBrowserInstance(context.sessionId);
        }
        
        // Trigger emergency cleanup if necessary
        if (this.isEmergencyCleanupRequired(error, context)) {
            systemMonitor.emit('emergency_cleanup', { 
                reason: 'browser_crash',
                sessionId: context.sessionId 
            });
        }
    }

    /**
     * Update job status based on error
     */
    async updateJobForError(classifiedError, jobId, jobManager) {
        try {
            if (classifiedError.recoverable && classifiedError.retryRecommended) {
                // Mark for retry
                await jobManager.sendStatusUpdate(jobId, {
                    status: 'retry_required',
                    message: `Job requires retry due to ${classifiedError.name}`,
                    error: classifiedError.message
                });
            } else if (classifiedError.severity === 'critical') {
                // Mark as failed
                await jobManager.sendStatusUpdate(jobId, {
                    status: 'failed',
                    message: `Job failed due to ${classifiedError.name}`,
                    error: classifiedError.message
                });
            }
        } catch (updateError) {
            console.error('❌ Failed to update job status:', updateError.message);
        }
    }

    /**
     * Generate recommendations based on error
     */
    generateRecommendations(classifiedError, context) {
        const recommendations = {
            action: 'none',
            shouldRetry: false,
            shouldNotify: true,
            maxRetries: 0,
            retryDelay: 0
        };

        if (classifiedError.recoverable) {
            recommendations.shouldRetry = true;
            recommendations.action = 'retry';
            recommendations.maxRetries = classifiedError.retryLimit || 3;
            recommendations.retryDelay = classifiedError.retryDelay || 5000;
        }

        if (classifiedError.severity === 'critical') {
            recommendations.action = 'escalate';
            recommendations.shouldNotify = true;
        }

        return recommendations;
    }

    /**
     * Generate correlation ID for error tracking
     */
    generateCorrelationId(error, context) {
        const timestamp = Date.now();
        const errorType = error.constructor.name;
        const operation = context.operation || 'unknown';
        return `${errorType}-${operation}-${timestamp}`.toLowerCase();
    }

    /**
     * Check if should notify Discord for this error
     */
    shouldNotifyForError(error) {
        const { config } = require('./config');
        if (!config.discord.enabled || !config.discord.notifyOnErrors) {
            return false;
        }

        // Check if this error type should trigger notifications
        const errorTypes = config.discord.notifyOnErrors;
        if (errorTypes.includes('all')) {
            return true;
        }

        return errorTypes.some(type => 
            error.name.toLowerCase().includes(type.toLowerCase()) ||
            error.message.toLowerCase().includes(type.toLowerCase())
        );
    }

    /**
     * Update error statistics
     */
    updateErrorStats(error, context) {
        this.errorStats.totalErrors++;
        this.errorStats.lastErrorTime = Date.now();
        
        const errorType = error.constructor.name;
        const operation = context.operation || 'unknown';
        
        this.errorStats.errorsByType.set(errorType, 
            (this.errorStats.errorsByType.get(errorType) || 0) + 1);
        this.errorStats.errorsByOperation.set(operation, 
            (this.errorStats.errorsByOperation.get(operation) || 0) + 1);
    }

    /**
     * Get error statistics
     */
    getErrorStats() {
        return {
            ...this.errorStats,
            errorsByType: Object.fromEntries(this.errorStats.errorsByType),
            errorsByOperation: Object.fromEntries(this.errorStats.errorsByOperation)
        };
    }

    /**
     * Check if emergency cleanup is required
     */
    isEmergencyCleanupRequired(error, context) {
        // Logic to determine if emergency cleanup is needed
        return error.severity === 'critical' && 
               (context.operation === 'browser_management' || 
                context.operation === 'job_processing');
    }

    /**
     * Clean up old error correlation data
     */
    cleanupOldErrors() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        for (const [correlationId, errorData] of this.errorCorrelationMap.entries()) {
            if (now - errorData.timestamp > maxAge) {
                this.errorCorrelationMap.delete(correlationId);
            }
        }
    }
}

// Create singleton instance
const errorHandler = new ErrorHandler();

// Start periodic cleanup
setInterval(() => {
    errorHandler.cleanupOldErrors();
}, 60 * 60 * 1000); // Clean up every hour

module.exports = { errorHandler, ErrorHandler };