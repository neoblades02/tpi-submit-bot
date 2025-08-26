/**
 * System Monitoring and Resource Management for TPI Submit Bot
 * Tracks memory usage, browser resources, and prevents resource leaks
 */

const { ResourceExhaustionError } = require('./errors');
const EventEmitter = require('events');

class SystemMonitor extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Configuration with environment variable support
        this.config = {
            memoryThreshold: parseInt(process.env.MEMORY_THRESHOLD_MB) || options.memoryThreshold || 512, // MB
            memoryCheckInterval: parseInt(process.env.MEMORY_CHECK_INTERVAL_MS) || options.memoryCheckInterval || 30000, // 30 seconds
            maxMemoryUsage: parseInt(process.env.MAX_MEMORY_USAGE_MB) || options.maxMemoryUsage || 1024, // 1GB
            gcThreshold: parseInt(process.env.GC_THRESHOLD_MB) || options.gcThreshold || 256, // MB
            browserResourceTimeout: parseInt(process.env.BROWSER_RESOURCE_TIMEOUT_MS) || options.browserResourceTimeout || 300000, // 5 minutes
            enableGC: process.env.ENABLE_MANUAL_GC === 'true' || options.enableGC || true
        };
        
        // State tracking
        this.isMonitoring = false;
        this.monitoringInterval = null;
        this.browserInstances = new Map(); // Track browser instances and their resources
        this.memoryHistory = [];
        this.lastGCTime = Date.now();
        this.warningsSent = new Set(); // Track warnings to avoid spam
        
        // Bind methods
        this.checkMemoryUsage = this.checkMemoryUsage.bind(this);
        this.cleanup = this.cleanup.bind(this);
        
        // Handle process cleanup
        process.on('SIGINT', this.cleanup);
        process.on('SIGTERM', this.cleanup);
        process.on('exit', this.cleanup);
    }

    /**
     * Start monitoring system resources
     */
    startMonitoring() {
        if (this.isMonitoring) {
            console.log('⚠️ System monitor already running');
            return;
        }

        console.log('🔍 Starting system resource monitoring...');
        console.log(`Memory threshold: ${this.config.memoryThreshold}MB, Max usage: ${this.config.maxMemoryUsage}MB`);
        
        this.isMonitoring = true;
        this.monitoringInterval = setInterval(this.checkMemoryUsage, this.config.memoryCheckInterval);
        
        // Initial check
        this.checkMemoryUsage();
    }

    /**
     * Stop monitoring system resources
     */
    stopMonitoring() {
        if (!this.isMonitoring) {
            return;
        }

        console.log('⏹️ Stopping system resource monitoring...');
        this.isMonitoring = false;
        
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
    }

    /**
     * Check current memory usage and emit warnings if necessary
     */
    checkMemoryUsage() {
        const memUsage = process.memoryUsage();
        const memoryMB = {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024)
        };

        // Add to history (keep last 10 readings)
        this.memoryHistory.push({
            timestamp: Date.now(),
            ...memoryMB
        });
        if (this.memoryHistory.length > 10) {
            this.memoryHistory.shift();
        }

        const totalMemoryUsage = memoryMB.rss;
        
        // Log memory usage periodically
        if (this.memoryHistory.length % 10 === 0 || totalMemoryUsage > this.config.memoryThreshold) {
            console.log(`📊 Memory usage: RSS ${memoryMB.rss}MB, Heap ${memoryMB.heapUsed}/${memoryMB.heapTotal}MB, External ${memoryMB.external}MB, Browsers: ${this.browserInstances.size}`);
        }

        // Check for memory threshold warnings
        if (totalMemoryUsage > this.config.memoryThreshold) {
            const warningKey = `memory_threshold_${Math.floor(totalMemoryUsage / 100) * 100}`;
            if (!this.warningsSent.has(warningKey)) {
                console.log(`⚠️ Memory usage warning: ${totalMemoryUsage}MB (threshold: ${this.config.memoryThreshold}MB)`);
                this.emit('memory_warning', { usage: memoryMB, threshold: this.config.memoryThreshold });
                this.warningsSent.add(warningKey);
                
                // Clear old warnings to allow new ones
                setTimeout(() => this.warningsSent.delete(warningKey), 300000); // 5 minutes
            }
        }

        // Check for memory exhaustion
        if (totalMemoryUsage > this.config.maxMemoryUsage) {
            const error = new ResourceExhaustionError(
                `Memory usage exceeded maximum limit: ${totalMemoryUsage}MB > ${this.config.maxMemoryUsage}MB`,
                memoryMB,
                'memory'
            );
            console.error(`❌ ${error.message}`);
            this.emit('memory_exhaustion', { error, usage: memoryMB });
            
            // Force cleanup
            this.performEmergencyCleanup();
        }

        // Trigger garbage collection if needed
        if (this.config.enableGC && totalMemoryUsage > this.config.gcThreshold) {
            const timeSinceLastGC = Date.now() - this.lastGCTime;
            if (timeSinceLastGC > 60000) { // At least 1 minute between GC calls
                this.triggerGarbageCollection();
            }
        }

        // Check browser instances for timeout
        this.checkBrowserResourceTimeouts();

        return memoryMB;
    }

    /**
     * Register a browser instance for monitoring
     */
    registerBrowserInstance(id, browser, context = {}) {
        console.log(`🔍 Registering browser instance: ${id}`);
        
        this.browserInstances.set(id, {
            browser,
            createdAt: Date.now(),
            context,
            pages: 0,
            lastActivity: Date.now()
        });

        return id;
    }

    /**
     * Update browser instance activity
     */
    updateBrowserActivity(id, activity = {}) {
        const instance = this.browserInstances.get(id);
        if (instance) {
            instance.lastActivity = Date.now();
            if (activity.pages !== undefined) {
                instance.pages = activity.pages;
            }
            if (activity.context) {
                Object.assign(instance.context, activity.context);
            }
        }
    }

    /**
     * Unregister a browser instance
     */
    async unregisterBrowserInstance(id) {
        const instance = this.browserInstances.get(id);
        if (!instance) {
            return false;
        }

        console.log(`🔍 Unregistering browser instance: ${id}`);
        
        // Ensure browser is closed
        try {
            if (instance.browser && !instance.browser.isConnected || !instance.browser.isClosed) {
                await instance.browser.close();
                console.log(`🔐 Closed browser instance: ${id}`);
            }
        } catch (error) {
            console.log(`⚠️ Error closing browser instance ${id}: ${error.message}`);
        }

        this.browserInstances.delete(id);
        return true;
    }

    /**
     * Check for browser instances that have exceeded resource timeout
     */
    checkBrowserResourceTimeouts() {
        const now = Date.now();
        const timeoutThreshold = this.config.browserResourceTimeout;
        
        for (const [id, instance] of this.browserInstances.entries()) {
            const age = now - instance.createdAt;
            const inactiveTime = now - instance.lastActivity;
            
            if (age > timeoutThreshold || inactiveTime > timeoutThreshold) {
                console.log(`⚠️ Browser instance ${id} exceeded resource timeout (age: ${Math.round(age/1000)}s, inactive: ${Math.round(inactiveTime/1000)}s)`);
                
                this.emit('browser_timeout', { 
                    id, 
                    age: Math.round(age/1000), 
                    inactiveTime: Math.round(inactiveTime/1000),
                    instance 
                });
                
                // Force cleanup of timed out browser
                this.unregisterBrowserInstance(id).catch(error => {
                    console.error(`Error cleaning up timed out browser ${id}:`, error.message);
                });
            }
        }
    }

    /**
     * Trigger garbage collection if available
     */
    triggerGarbageCollection() {
        if (global.gc) {
            console.log('🗑️ Triggering garbage collection...');
            const beforeMemory = process.memoryUsage();
            
            global.gc();
            
            const afterMemory = process.memoryUsage();
            const freedMB = Math.round((beforeMemory.heapUsed - afterMemory.heapUsed) / 1024 / 1024);
            
            if (freedMB > 0) {
                console.log(`🗑️ Garbage collection freed ${freedMB}MB`);
            }
            
            this.lastGCTime = Date.now();
        } else if (this.config.enableGC) {
            console.log('⚠️ Garbage collection not available. Run with --expose-gc flag for manual GC');
        }
    }

    /**
     * Perform emergency cleanup when memory is critically low
     */
    async performEmergencyCleanup() {
        console.log('🚨 Performing emergency cleanup...');
        
        // Close all browser instances immediately
        const browserIds = Array.from(this.browserInstances.keys());
        const cleanupPromises = browserIds.map(id => this.unregisterBrowserInstance(id));
        
        try {
            await Promise.allSettled(cleanupPromises);
            console.log(`🚨 Emergency cleanup completed. Closed ${browserIds.length} browser instances.`);
        } catch (error) {
            console.error('🚨 Error during emergency cleanup:', error.message);
        }

        // Trigger garbage collection
        this.triggerGarbageCollection();
        
        // Emit cleanup event
        this.emit('emergency_cleanup', { closedBrowsers: browserIds.length });
    }

    /**
     * Get current system metrics
     */
    getMetrics() {
        const memUsage = process.memoryUsage();
        const memoryMB = {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024)
        };

        return {
            memory: memoryMB,
            browserInstances: this.browserInstances.size,
            memoryHistory: this.memoryHistory.slice(),
            uptime: Math.round(process.uptime()),
            thresholds: {
                memoryThreshold: this.config.memoryThreshold,
                maxMemoryUsage: this.config.maxMemoryUsage,
                gcThreshold: this.config.gcThreshold
            },
            warnings: {
                memoryThreshold: memoryMB.rss > this.config.memoryThreshold,
                memoryExhaustion: memoryMB.rss > this.config.maxMemoryUsage,
                gcNeeded: memoryMB.rss > this.config.gcThreshold
            }
        };
    }

    /**
     * Cleanup resources before shutdown
     */
    async cleanup() {
        if (!this.isMonitoring) {
            return;
        }

        console.log('🧹 Cleaning up system monitor...');
        
        this.stopMonitoring();
        
        // Close all remaining browser instances
        if (this.browserInstances.size > 0) {
            console.log(`🧹 Cleaning up ${this.browserInstances.size} browser instances...`);
            const cleanupPromises = Array.from(this.browserInstances.keys())
                .map(id => this.unregisterBrowserInstance(id));
            
            try {
                await Promise.allSettled(cleanupPromises);
                console.log('✅ Browser cleanup completed');
            } catch (error) {
                console.error('❌ Error during browser cleanup:', error.message);
            }
        }

        // Final garbage collection
        this.triggerGarbageCollection();
        
        console.log('✅ System monitor cleanup completed');
    }
}

// Create singleton instance
const systemMonitor = new SystemMonitor();

module.exports = {
    SystemMonitor,
    systemMonitor
};