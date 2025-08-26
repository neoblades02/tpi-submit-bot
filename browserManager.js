/**
 * Enhanced Browser Manager for TPI Submit Bot
 * Provides robust browser launch with stability improvements and resource management
 */

const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');
const { config } = require('./config');
const { systemMonitor } = require('./monitor');
const { autoRestartManager } = require('./circuitBreaker');
const { discordNotifier } = require('./discordNotifier');
const { 
    BrowserLaunchError, 
    BrowserTimeoutError, 
    BrowserCrashError, 
    PageNavigationError,
    ResourceExhaustionError,
    ErrorClassifier 
} = require('./errors');

class BrowserManager {
    constructor() {
        this.activeBrowsers = new Map();
        this.launchAttempts = new Map(); // Track launch attempts per session
        this.browserCircuitBreaker = autoRestartManager.getCircuitBreaker('browser', {
            failureThreshold: 3,
            resetTimeout: 300000 // 5 minutes
        });

        // Statistics
        this.stats = {
            totalLaunches: 0,
            successfulLaunches: 0,
            failedLaunches: 0,
            totalCrashes: 0,
            totalTimeouts: 0,
            averageLaunchTime: 0,
            launchTimes: []
        };

        console.log('🌐 Browser Manager initialized with enhanced stability features');
    }

    /**
     * Launch browser with enhanced stability and circuit breaker protection
     */
    async launchBrowser(sessionId = null, options = {}) {
        const id = sessionId || uuidv4();
        const startTime = Date.now();
        
        console.log(`🚀 Starting enhanced browser launch for session: ${id}`);
        
        // Check circuit breaker
        if (!this.browserCircuitBreaker.canExecute()) {
            const error = new BrowserLaunchError(
                'Browser launch blocked by circuit breaker - too many recent failures',
                1, 1
            );
            await discordNotifier.sendErrorNotification(error, { sessionId: id });
            throw error;
        }

        // Check memory before launch
        const memoryMetrics = systemMonitor.getMetrics();
        if (memoryMetrics.warnings.memoryExhaustion) {
            const error = new ResourceExhaustionError(
                'Cannot launch browser: memory exhausted',
                memoryMetrics.memory,
                'memory'
            );
            await discordNotifier.sendErrorNotification(error, { sessionId: id });
            throw error;
        }

        return this.browserCircuitBreaker.execute(async () => {
            return this.performBrowserLaunch(id, options, startTime);
        }, { sessionId: id });
    }

    /**
     * Perform the actual browser launch with all stability improvements
     */
    async performBrowserLaunch(sessionId, options = {}, startTime) {
        const maxRetries = options.maxRetries || config.browser.maxRetries;
        const baseTimeout = options.timeout || config.browser.launchTimeout;
        let browser = null;
        let lastError = null;

        this.stats.totalLaunches++;
        this.launchAttempts.set(sessionId, { attempts: 0, startTime });

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const attemptInfo = this.launchAttempts.get(sessionId);
            attemptInfo.attempts = attempt;

            try {
                console.log(`🌐 Browser launch attempt ${attempt}/${maxRetries} for session ${sessionId}...`);
                
                // Dynamic timeout - increases with each attempt
                const launchTimeout = baseTimeout + ((attempt - 1) * 60000); // Add 1 minute per retry
                console.log(`   Timeout: ${launchTimeout / 1000}s`);

                // Pre-launch cleanup
                await this.preLaunchCleanup();

                // Check memory again before each attempt
                const memoryBefore = systemMonitor.checkMemoryUsage();
                if (memoryBefore.rss > config.memory.threshold) {
                    console.log(`⚠️ Memory usage high before launch: ${memoryBefore.rss}MB`);
                    
                    // Trigger garbage collection if available
                    systemMonitor.triggerGarbageCollection();
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                // Enhanced browser arguments with additional stability flags
                const browserArgs = [
                    ...config.browser.args,
                    
                    // Additional stability flags
                    '--disable-extensions-http-throttling',
                    '--disable-client-side-phishing-detection',
                    '--disable-sync',
                    '--disable-translate',
                    '--disable-default-apps',
                    '--no-default-browser-check',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-breakpad',
                    '--disable-crash-reporter',
                    
                    // Memory management
                    `--max-old-space-size=${Math.floor(config.memory.maxUsage * 0.7)}`,
                    '--memory-pressure-off',
                    
                    // Performance optimizations
                    '--disable-background-networking',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-ipc-flooding-protection',
                    
                    // Resource limits
                    '--max_active_webgl_contexts=1',
                    '--webgl-antialiasing-mode=none',
                    
                    // Add process isolation for stability
                    ...(attempt > 2 ? ['--disable-site-isolation-trials'] : [])
                ];

                const launchOptions = {
                    headless: config.browser.headless,
                    timeout: launchTimeout,
                    args: browserArgs,
                    slowMo: attempt > 2 ? 100 : 0, // Add delay for later attempts
                    chromiumSandbox: false,
                    
                    // Additional Playwright options for stability
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                };

                // Launch browser
                browser = await chromium.launch(launchOptions);
                
                // Verify browser is actually connected
                await this.verifyBrowserConnection(browser, sessionId);
                
                // Register with monitor
                systemMonitor.registerBrowserInstance(sessionId, browser, {
                    launchTime: Date.now() - startTime,
                    attempt,
                    memoryAtLaunch: systemMonitor.checkMemoryUsage()
                });

                // Track successful launch
                const launchTime = Date.now() - startTime;
                this.stats.successfulLaunches++;
                this.stats.launchTimes.push(launchTime);
                this.updateAverageLaunchTime();

                console.log(`✅ Browser launched successfully for session ${sessionId} (attempt ${attempt}, ${launchTime}ms)`);
                
                // Store browser instance
                this.activeBrowsers.set(sessionId, {
                    browser,
                    launchedAt: Date.now(),
                    sessionId,
                    attempt,
                    launchTime
                });

                // Clean up launch tracking
                this.launchAttempts.delete(sessionId);

                return { browser, sessionId, launchTime, attempt };

            } catch (error) {
                lastError = ErrorClassifier.classify(error, {
                    attempt,
                    maxAttempts: maxRetries,
                    operation: 'browser_launch',
                    sessionId
                });

                console.log(`⚠️ Browser launch attempt ${attempt} failed for session ${sessionId}: ${error.message}`);
                
                // Clean up failed browser instance
                if (browser) {
                    try {
                        await browser.close();
                        console.log(`🔐 Cleaned up failed browser instance for session ${sessionId}`);
                    } catch (closeError) {
                        console.log(`⚠️ Error cleaning up failed browser: ${closeError.message}`);
                    }
                    browser = null;
                }

                // Send error notification for critical failures
                if (lastError instanceof BrowserLaunchError && attempt === 1) {
                    await discordNotifier.sendErrorNotification(lastError, {
                        sessionId,
                        attempt,
                        maxAttempts: maxRetries
                    });
                }

                if (attempt === maxRetries) {
                    // All attempts failed
                    this.stats.failedLaunches++;
                    this.launchAttempts.delete(sessionId);
                    
                    // Send critical failure notification
                    await discordNotifier.sendCriticalAlert('browser_launch_failed', 
                        `Browser launch failed after ${maxRetries} attempts for session ${sessionId}`, {
                        sessionId,
                        error: lastError.message,
                        attempts: maxRetries,
                        launchTime: Date.now() - startTime,
                        memoryUsage: systemMonitor.checkMemoryUsage(),
                        recommendedActions: [
                            'Check available system memory',
                            'Verify browser dependencies are installed',
                            'Consider restarting the application',
                            'Check for system resource limits'
                        ]
                    });
                    
                    throw lastError;
                }

                // Wait before retry with progressive backoff
                const retryDelay = this.calculateRetryDelay(attempt, lastError);
                console.log(`⏳ Waiting ${retryDelay}ms before retry attempt ${attempt + 1}...`);
                
                // Perform cleanup between attempts
                await this.interAttemptCleanup(attempt);
                
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    /**
     * Verify browser connection and basic functionality
     */
    async verifyBrowserConnection(browser, sessionId) {
        try {
            // Test that we can create a context and page
            const context = await browser.newContext();
            const page = await context.newPage();
            
            // Navigate to a simple data URL to test navigation
            await page.goto('data:text/html,<html><body>Browser Test</body></html>', { 
                timeout: 10000 
            });
            
            // Clean up test resources
            await page.close();
            await context.close();
            
            console.log(`✅ Browser connection verified for session ${sessionId}`);
            
        } catch (error) {
            console.log(`❌ Browser connection verification failed for session ${sessionId}: ${error.message}`);
            throw new BrowserLaunchError(
                `Browser connection verification failed: ${error.message}`,
                1, 1, error
            );
        }
    }

    /**
     * Calculate retry delay with progressive backoff and jitter
     */
    calculateRetryDelay(attempt, error) {
        let baseDelay = config.browser.retryDelay;
        
        // Increase delay for specific error types
        if (error instanceof BrowserTimeoutError) {
            baseDelay *= 2; // Longer delay for timeout errors
        } else if (error instanceof ResourceExhaustionError) {
            baseDelay *= 3; // Much longer delay for memory issues
        }
        
        // Progressive backoff
        const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
        
        // Add jitter (±25%)
        const jitterRange = exponentialDelay * 0.25;
        const jitter = (Math.random() * 2 - 1) * jitterRange;
        
        // Cap at maximum delay
        const finalDelay = Math.min(exponentialDelay + jitter, config.browser.maxRetryDelay);
        
        return Math.max(finalDelay, 1000); // Minimum 1 second delay
    }

    /**
     * Pre-launch cleanup to improve success rate
     */
    async preLaunchCleanup() {
        // Force garbage collection if available
        systemMonitor.triggerGarbageCollection();
        
        // Small delay to let cleanup complete
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    /**
     * Cleanup between retry attempts
     */
    async interAttemptCleanup(attempt) {
        console.log(`🧹 Performing inter-attempt cleanup (attempt ${attempt})...`);
        
        // More aggressive cleanup for later attempts
        if (attempt >= 2) {
            // Check for zombie browser processes and clean up
            await this.cleanupZombieBrowsers();
            
            // Force garbage collection
            systemMonitor.triggerGarbageCollection();
            
            // Longer cleanup delay for later attempts
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    /**
     * Clean up zombie browser processes
     */
    async cleanupZombieBrowsers() {
        const zombieSessions = [];
        
        for (const [sessionId, browserInfo] of this.activeBrowsers.entries()) {
            try {
                // Check if browser is still connected
                if (!browserInfo.browser || !browserInfo.browser.isConnected()) {
                    console.log(`👻 Found zombie browser session: ${sessionId}`);
                    zombieSessions.push(sessionId);
                }
            } catch (error) {
                console.log(`👻 Browser session ${sessionId} appears to be zombie: ${error.message}`);
                zombieSessions.push(sessionId);
            }
        }
        
        // Clean up zombie sessions
        for (const sessionId of zombieSessions) {
            await this.closeBrowser(sessionId, 'zombie_cleanup');
        }
        
        if (zombieSessions.length > 0) {
            console.log(`🧹 Cleaned up ${zombieSessions.length} zombie browser sessions`);
        }
    }

    /**
     * Close browser with cleanup
     */
    async closeBrowser(sessionId, reason = 'normal_shutdown') {
        const browserInfo = this.activeBrowsers.get(sessionId);
        if (!browserInfo) {
            return false;
        }

        console.log(`🔐 Closing browser session ${sessionId} (reason: ${reason})`);

        try {
            // Update activity before closing
            systemMonitor.updateBrowserActivity(sessionId, { 
                status: 'closing',
                reason 
            });

            if (browserInfo.browser && browserInfo.browser.isConnected()) {
                await browserInfo.browser.close();
            }

            // Unregister from monitor
            await systemMonitor.unregisterBrowserInstance(sessionId);

            console.log(`✅ Browser session ${sessionId} closed successfully`);
            return true;

        } catch (error) {
            console.log(`⚠️ Error closing browser session ${sessionId}: ${error.message}`);
            return false;
        } finally {
            this.activeBrowsers.delete(sessionId);
        }
    }

    /**
     * Close all active browsers
     */
    async closeAllBrowsers(reason = 'shutdown') {
        console.log(`🔐 Closing all browser sessions (reason: ${reason})...`);
        
        const sessionIds = Array.from(this.activeBrowsers.keys());
        const closePromises = sessionIds.map(sessionId => 
            this.closeBrowser(sessionId, reason)
        );

        try {
            await Promise.allSettled(closePromises);
            console.log(`✅ All browser sessions closed`);
        } catch (error) {
            console.error(`❌ Error closing browsers: ${error.message}`);
        }
    }

    /**
     * Handle browser crash recovery
     */
    async handleBrowserCrash(sessionId, error) {
        console.log(`💥 Browser crash detected for session ${sessionId}: ${error.message}`);
        
        this.stats.totalCrashes++;
        
        // Close crashed browser
        await this.closeBrowser(sessionId, 'crash_detected');
        
        // Send crash notification
        const crashError = new BrowserCrashError(
            `Browser crashed for session ${sessionId}: ${error.message}`,
            'runtime',
            false,
            error
        );
        
        await discordNotifier.sendErrorNotification(crashError, {
            sessionId,
            recoverable: true
        });

        return crashError;
    }

    /**
     * Update average launch time statistic
     */
    updateAverageLaunchTime() {
        if (this.stats.launchTimes.length === 0) {
            this.stats.averageLaunchTime = 0;
            return;
        }

        // Keep only last 50 launch times for rolling average
        if (this.stats.launchTimes.length > 50) {
            this.stats.launchTimes = this.stats.launchTimes.slice(-50);
        }

        const sum = this.stats.launchTimes.reduce((a, b) => a + b, 0);
        this.stats.averageLaunchTime = Math.round(sum / this.stats.launchTimes.length);
    }

    /**
     * Get browser manager statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeBrowsers: this.activeBrowsers.size,
            circuitBreakerStatus: this.browserCircuitBreaker.getMetrics(),
            memoryMetrics: systemMonitor.getMetrics(),
            successRate: this.stats.totalLaunches > 0 ? 
                (this.stats.successfulLaunches / this.stats.totalLaunches) : 0
        };
    }

    /**
     * Health check for browser manager
     */
    async healthCheck() {
        const metrics = this.getStats();
        const issues = [];

        // Check success rate
        if (metrics.successRate < 0.8 && metrics.totalLaunches > 5) {
            issues.push(`Low success rate: ${Math.round(metrics.successRate * 100)}%`);
        }

        // Check memory usage
        if (metrics.memoryMetrics.warnings.memoryThreshold) {
            issues.push(`High memory usage: ${metrics.memoryMetrics.memory.rss}MB`);
        }

        // Check circuit breaker status
        if (metrics.circuitBreakerStatus.state !== 'CLOSED') {
            issues.push(`Circuit breaker ${metrics.circuitBreakerStatus.state}`);
        }

        // Check for too many active browsers
        if (metrics.activeBrowsers > 5) {
            issues.push(`Too many active browsers: ${metrics.activeBrowsers}`);
        }

        return {
            healthy: issues.length === 0,
            issues,
            metrics
        };
    }

    /**
     * Emergency shutdown procedure
     */
    async emergencyShutdown() {
        console.log('🚨 Emergency shutdown initiated for Browser Manager');
        
        await discordNotifier.sendCriticalAlert('browser_manager_emergency_shutdown',
            'Browser Manager is performing emergency shutdown due to critical issues', {
            activeBrowsers: this.activeBrowsers.size,
            stats: this.stats,
            recommendedActions: [
                'Check system resources',
                'Review error logs',
                'Consider manual restart',
                'Monitor system stability'
            ]
        });

        // Force close all browsers immediately
        await this.closeAllBrowsers('emergency_shutdown');
        
        // Force cleanup
        await systemMonitor.performEmergencyCleanup();
        
        console.log('🚨 Emergency shutdown completed');
    }

    /**
     * Cleanup resources
     */
    async cleanup() {
        console.log('🧹 Browser Manager cleanup starting...');
        
        await this.closeAllBrowsers('manager_cleanup');
        
        if (this.browserCircuitBreaker) {
            this.browserCircuitBreaker.destroy();
        }
        
        console.log('✅ Browser Manager cleanup completed');
    }
}

// Create singleton instance
const browserManager = new BrowserManager();

// Handle process cleanup
process.on('SIGINT', () => browserManager.cleanup());
process.on('SIGTERM', () => browserManager.cleanup());
process.on('exit', () => browserManager.cleanup());

module.exports = {
    BrowserManager,
    browserManager
};