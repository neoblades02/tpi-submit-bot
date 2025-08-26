/**
 * Circuit Breaker and Automatic Restart Logic for TPI Submit Bot
 * Prevents cascade failures and implements graceful degradation
 */

const EventEmitter = require('events');
const { config } = require('./config');
const { CircuitBreakerError } = require('./errors');
const { discordNotifier } = require('./discordNotifier');

/**
 * Circuit Breaker States
 */
const CIRCUIT_STATES = {
    CLOSED: 'CLOSED',       // Normal operation
    OPEN: 'OPEN',           // Circuit is open, requests are blocked
    HALF_OPEN: 'HALF_OPEN'  // Testing if service has recovered
};

class CircuitBreaker extends EventEmitter {
    constructor(service, options = {}) {
        super();
        
        this.service = service;
        this.state = CIRCUIT_STATES.CLOSED;
        
        // Configuration with fallbacks
        this.options = {
            failureThreshold: options.failureThreshold || config.circuitBreaker.failureThreshold,
            resetTimeout: options.resetTimeout || config.circuitBreaker.resetTimeout,
            monitoringPeriod: options.monitoringPeriod || config.circuitBreaker.monitoringPeriod,
            enabled: options.enabled !== undefined ? options.enabled : config.circuitBreaker.enabled,
            ...options
        };
        
        // State tracking
        this.failures = [];
        this.lastFailureTime = null;
        this.lastSuccessTime = null;
        this.nextAttemptTime = null;
        this.consecutiveSuccesses = 0;
        this.totalRequests = 0;
        this.totalFailures = 0;
        this.totalSuccesses = 0;
        
        // Monitoring timer
        this.monitoringTimer = null;
        
        if (this.options.enabled) {
            console.log(`🔒 Circuit breaker initialized for service: ${service}`);
            console.log(`   Failure threshold: ${this.options.failureThreshold}`);
            console.log(`   Reset timeout: ${this.options.resetTimeout}ms`);
            this.startMonitoring();
        } else {
            console.log(`⚠️ Circuit breaker disabled for service: ${service}`);
        }
    }

    /**
     * Execute a function through the circuit breaker
     */
    async execute(fn, context = {}) {
        if (!this.options.enabled) {
            return fn();
        }

        this.totalRequests++;

        // Check if circuit is open
        if (this.state === CIRCUIT_STATES.OPEN) {
            if (Date.now() < this.nextAttemptTime) {
                const error = new CircuitBreakerError(
                    `Circuit breaker is OPEN for service: ${this.service}. Next attempt allowed at: ${new Date(this.nextAttemptTime).toISOString()}`,
                    this.service,
                    this.failures.length,
                    this.options.failureThreshold
                );
                throw error;
            } else {
                // Transition to half-open state
                this.setState(CIRCUIT_STATES.HALF_OPEN);
                console.log(`🔓 Circuit breaker transitioning to HALF_OPEN for service: ${this.service}`);
            }
        }

        try {
            const result = await fn();
            this.onSuccess(context);
            return result;
        } catch (error) {
            this.onFailure(error, context);
            throw error;
        }
    }

    /**
     * Handle successful execution
     */
    onSuccess(context = {}) {
        this.lastSuccessTime = Date.now();
        this.totalSuccesses++;
        this.consecutiveSuccesses++;
        
        if (this.state === CIRCUIT_STATES.HALF_OPEN) {
            console.log(`✅ Service recovery confirmed for: ${this.service}`);
            this.setState(CIRCUIT_STATES.CLOSED);
            this.reset();
            
            // Notify about recovery
            discordNotifier.sendRecoveryNotification('circuit_breaker_recovered', 
                `Service ${this.service} has recovered and circuit breaker is now CLOSED`, {
                service: this.service,
                recoveryStats: {
                    attempts: this.consecutiveSuccesses,
                    duration: this.lastSuccessTime - (this.lastFailureTime || this.lastSuccessTime)
                }
            });
        }

        this.emit('success', { service: this.service, context });
    }

    /**
     * Handle failed execution
     */
    onFailure(error, context = {}) {
        this.lastFailureTime = Date.now();
        this.totalFailures++;
        this.consecutiveSuccesses = 0;
        
        // Add failure to tracking
        this.failures.push({
            timestamp: this.lastFailureTime,
            error: error.message,
            context
        });

        // Remove old failures outside monitoring period
        this.cleanupOldFailures();

        console.log(`❌ Circuit breaker recorded failure for ${this.service}: ${error.message} (${this.failures.length}/${this.options.failureThreshold})`);

        // Check if we should open the circuit
        if (this.failures.length >= this.options.failureThreshold && this.state !== CIRCUIT_STATES.OPEN) {
            this.setState(CIRCUIT_STATES.OPEN);
            this.nextAttemptTime = Date.now() + this.options.resetTimeout;
            
            console.log(`🔒 Circuit breaker OPENED for service: ${this.service}`);
            console.log(`   Next attempt allowed at: ${new Date(this.nextAttemptTime).toISOString()}`);
            
            // Send critical alert
            discordNotifier.sendCriticalAlert('circuit_breaker_opened', 
                `Circuit breaker has OPENED for service: ${this.service}`, {
                service: this.service,
                failureCount: this.failures.length,
                threshold: this.options.failureThreshold,
                nextAttemptTime: this.nextAttemptTime,
                recentFailures: this.failures.slice(-3).map(f => f.error),
                recommendedActions: [
                    'Check system resources and memory usage',
                    'Verify network connectivity',
                    'Review recent error logs',
                    'Consider manual intervention if pattern continues'
                ]
            });
        }

        this.emit('failure', { service: this.service, error, context, failures: this.failures.length });
    }

    /**
     * Set circuit breaker state
     */
    setState(newState) {
        const oldState = this.state;
        this.state = newState;
        
        if (oldState !== newState) {
            console.log(`🔄 Circuit breaker state changed for ${this.service}: ${oldState} → ${newState}`);
            this.emit('stateChange', { 
                service: this.service, 
                oldState, 
                newState, 
                timestamp: Date.now() 
            });
        }
    }

    /**
     * Reset circuit breaker to initial state
     */
    reset() {
        console.log(`🔄 Circuit breaker reset for service: ${this.service}`);
        this.failures = [];
        this.consecutiveSuccesses = 0;
        this.lastFailureTime = null;
        this.nextAttemptTime = null;
        this.setState(CIRCUIT_STATES.CLOSED);
    }

    /**
     * Force circuit breaker to open (emergency)
     */
    forceOpen(reason = 'Manual intervention') {
        console.log(`🚨 Force opening circuit breaker for ${this.service}: ${reason}`);
        this.setState(CIRCUIT_STATES.OPEN);
        this.nextAttemptTime = Date.now() + this.options.resetTimeout;
        
        discordNotifier.sendCriticalAlert('circuit_breaker_forced_open', 
            `Circuit breaker manually opened for service: ${this.service}`, {
            service: this.service,
            reason,
            nextAttemptTime: this.nextAttemptTime
        });
    }

    /**
     * Force circuit breaker to close (emergency)
     */
    forceClose(reason = 'Manual intervention') {
        console.log(`🔓 Force closing circuit breaker for ${this.service}: ${reason}`);
        this.reset();
        
        discordNotifier.sendStatusNotification('circuit_breaker_forced_closed', 
            `Circuit breaker manually closed for service: ${this.service}. Reason: ${reason}`, {
            service: this.service,
            reason
        });
    }

    /**
     * Clean up old failures outside monitoring period
     */
    cleanupOldFailures() {
        const cutoffTime = Date.now() - this.options.monitoringPeriod;
        this.failures = this.failures.filter(failure => failure.timestamp > cutoffTime);
    }

    /**
     * Start monitoring for automatic cleanup and reporting
     */
    startMonitoring() {
        if (this.monitoringTimer) {
            return;
        }

        this.monitoringTimer = setInterval(() => {
            this.cleanupOldFailures();
            
            // Check for stuck open state
            if (this.state === CIRCUIT_STATES.OPEN && this.nextAttemptTime && Date.now() > this.nextAttemptTime) {
                console.log(`⏰ Circuit breaker for ${this.service} is ready to attempt recovery`);
                this.emit('readyForRecovery', { service: this.service });
            }
        }, Math.min(this.options.monitoringPeriod / 4, 30000)); // Check every quarter period or 30s, whichever is smaller
    }

    /**
     * Stop monitoring
     */
    stopMonitoring() {
        if (this.monitoringTimer) {
            clearInterval(this.monitoringTimer);
            this.monitoringTimer = null;
        }
    }

    /**
     * Get current circuit breaker metrics
     */
    getMetrics() {
        return {
            service: this.service,
            state: this.state,
            enabled: this.options.enabled,
            failures: {
                current: this.failures.length,
                threshold: this.options.failureThreshold,
                recent: this.failures.slice(-5).map(f => ({
                    timestamp: f.timestamp,
                    error: f.error,
                    age: Date.now() - f.timestamp
                }))
            },
            timing: {
                lastFailure: this.lastFailureTime,
                lastSuccess: this.lastSuccessTime,
                nextAttempt: this.nextAttemptTime,
                resetTimeout: this.options.resetTimeout
            },
            statistics: {
                totalRequests: this.totalRequests,
                totalFailures: this.totalFailures,
                totalSuccesses: this.totalSuccesses,
                consecutiveSuccesses: this.consecutiveSuccesses,
                failureRate: this.totalRequests > 0 ? (this.totalFailures / this.totalRequests) : 0
            }
        };
    }

    /**
     * Check if circuit breaker allows execution
     */
    canExecute() {
        if (!this.options.enabled) {
            return true;
        }

        if (this.state === CIRCUIT_STATES.CLOSED || this.state === CIRCUIT_STATES.HALF_OPEN) {
            return true;
        }

        if (this.state === CIRCUIT_STATES.OPEN && this.nextAttemptTime && Date.now() >= this.nextAttemptTime) {
            return true;
        }

        return false;
    }

    /**
     * Cleanup resources
     */
    destroy() {
        this.stopMonitoring();
        this.removeAllListeners();
        console.log(`🧹 Circuit breaker destroyed for service: ${this.service}`);
    }
}

/**
 * Automatic Restart Manager
 * Manages automatic restarts with circuit breaker integration
 */
class AutoRestartManager extends EventEmitter {
    constructor() {
        super();
        
        this.config = config.restart;
        this.restartAttempts = 0;
        this.lastRestartTime = null;
        this.cooldownEndTime = null;
        this.restartHistory = [];
        
        // Create circuit breakers for different services
        this.circuitBreakers = new Map();
        
        if (this.config.enabled) {
            console.log('🔄 Automatic restart manager initialized');
            console.log(`   Max restarts: ${this.config.maxRestarts}`);
            console.log(`   Restart delay: ${this.config.restartDelay}ms`);
            console.log(`   Cooldown period: ${this.config.cooldownPeriod}ms`);
        } else {
            console.log('⚠️ Automatic restart manager disabled');
        }
    }

    /**
     * Get or create circuit breaker for a service
     */
    getCircuitBreaker(service, options = {}) {
        if (!this.circuitBreakers.has(service)) {
            const circuitBreaker = new CircuitBreaker(service, options);
            this.circuitBreakers.set(service, circuitBreaker);
            
            // Listen for circuit breaker events
            circuitBreaker.on('stateChange', (data) => {
                this.emit('circuitBreakerStateChange', data);
            });
            
            circuitBreaker.on('failure', (data) => {
                // Trigger restart logic if needed
                if (data.failures >= circuitBreaker.options.failureThreshold) {
                    this.considerRestart(service, `Circuit breaker threshold reached: ${data.failures} failures`);
                }
            });
        }
        
        return this.circuitBreakers.get(service);
    }

    /**
     * Consider whether to trigger an automatic restart
     */
    async considerRestart(service, reason) {
        if (!this.config.enabled) {
            console.log(`⚠️ Auto-restart disabled, manual intervention required for: ${reason}`);
            return false;
        }

        // Check if we're in cooldown period
        if (this.cooldownEndTime && Date.now() < this.cooldownEndTime) {
            const remainingCooldown = Math.round((this.cooldownEndTime - Date.now()) / 1000);
            console.log(`⏳ Auto-restart in cooldown period, ${remainingCooldown}s remaining`);
            return false;
        }

        // Check if we've exceeded max restart attempts
        if (this.restartAttempts >= this.config.maxRestarts) {
            console.log(`❌ Maximum auto-restart attempts reached (${this.restartAttempts}/${this.config.maxRestarts})`);
            
            // Send critical alert
            discordNotifier.sendCriticalAlert('max_restarts_exceeded', 
                `Maximum automatic restart attempts exceeded for service: ${service}`, {
                service,
                reason,
                restartAttempts: this.restartAttempts,
                maxRestarts: this.config.maxRestarts,
                recommendedActions: [
                    'Manual intervention required',
                    'Check system logs for persistent issues',
                    'Verify system resources and dependencies',
                    'Consider increasing resource limits or fixing underlying issues'
                ]
            });
            
            return false;
        }

        return this.performRestart(service, reason);
    }

    /**
     * Perform automatic restart
     */
    async performRestart(service, reason) {
        this.restartAttempts++;
        this.lastRestartTime = Date.now();
        
        console.log(`🔄 Initiating automatic restart ${this.restartAttempts}/${this.config.maxRestarts} for ${service}: ${reason}`);
        
        // Add to restart history
        this.restartHistory.push({
            timestamp: this.lastRestartTime,
            service,
            reason,
            attempt: this.restartAttempts
        });

        // Keep only last 10 restart records
        if (this.restartHistory.length > 10) {
            this.restartHistory.shift();
        }

        // Send restart notification
        discordNotifier.sendRecoveryNotification('automatic_restart', 
            `Attempting automatic restart for service: ${service}`, {
            service,
            reason,
            attempt: this.restartAttempts,
            maxAttempts: this.config.maxRestarts,
            restartHistory: this.restartHistory.slice(-3)
        });

        try {
            // Wait for restart delay
            if (this.config.restartDelay > 0) {
                console.log(`⏳ Waiting ${this.config.restartDelay}ms before restart...`);
                await new Promise(resolve => setTimeout(resolve, this.config.restartDelay));
            }

            // Emit restart event for handlers to implement actual restart logic
            this.emit('restartRequested', {
                service,
                reason,
                attempt: this.restartAttempts,
                maxAttempts: this.config.maxRestarts
            });

            // Reset circuit breaker for the service
            const circuitBreaker = this.circuitBreakers.get(service);
            if (circuitBreaker) {
                circuitBreaker.reset();
                console.log(`🔄 Circuit breaker reset for ${service} after restart`);
            }

            return true;

        } catch (error) {
            console.error(`❌ Restart failed for ${service}:`, error.message);
            
            // Send restart failure notification
            discordNotifier.sendErrorNotification(error, {
                service,
                reason: 'restart_failed',
                attempt: this.restartAttempts,
                originalReason: reason
            });

            return false;
        }
    }

    /**
     * Reset restart counter (call after successful operations)
     */
    resetRestartCounter() {
        if (this.restartAttempts > 0) {
            console.log(`✅ Restart counter reset (was ${this.restartAttempts})`);
            this.restartAttempts = 0;
            this.cooldownEndTime = null;
        }
    }

    /**
     * Enter cooldown period
     */
    enterCooldown() {
        this.cooldownEndTime = Date.now() + this.config.cooldownPeriod;
        console.log(`⏳ Entering restart cooldown period until: ${new Date(this.cooldownEndTime).toISOString()}`);
        
        discordNotifier.sendStatusNotification('restart_cooldown', 
            `Automatic restart system entering cooldown period`, {
            cooldownEnd: this.cooldownEndTime,
            duration: this.config.cooldownPeriod
        });
    }

    /**
     * Get restart manager metrics
     */
    getMetrics() {
        return {
            enabled: this.config.enabled,
            restartAttempts: this.restartAttempts,
            maxRestarts: this.config.maxRestarts,
            lastRestartTime: this.lastRestartTime,
            cooldownEndTime: this.cooldownEndTime,
            inCooldown: this.cooldownEndTime && Date.now() < this.cooldownEndTime,
            restartHistory: this.restartHistory.slice(),
            circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([service, cb]) => ({
                service,
                ...cb.getMetrics()
            }))
        };
    }

    /**
     * Cleanup resources
     */
    destroy() {
        // Destroy all circuit breakers
        for (const [service, circuitBreaker] of this.circuitBreakers.entries()) {
            circuitBreaker.destroy();
        }
        this.circuitBreakers.clear();
        
        this.removeAllListeners();
        console.log('🧹 Auto-restart manager destroyed');
    }
}

// Create singleton instance
const autoRestartManager = new AutoRestartManager();

module.exports = {
    CircuitBreaker,
    AutoRestartManager,
    CIRCUIT_STATES,
    autoRestartManager
};