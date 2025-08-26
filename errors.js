/**
 * Structured Error Classes for TPI Submit Bot
 * Provides better error classification and handling capabilities
 */

class BrowserLaunchError extends Error {
    constructor(message, attempt = 1, maxAttempts = 3, originalError = null) {
        super(message);
        this.name = 'BrowserLaunchError';
        this.type = 'browser_launch';
        this.attempt = attempt;
        this.maxAttempts = maxAttempts;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
        this.recoverable = attempt < maxAttempts;
        
        // Capture stack trace
        Error.captureStackTrace(this, BrowserLaunchError);
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            attempt: this.attempt,
            maxAttempts: this.maxAttempts,
            recoverable: this.recoverable,
            timestamp: this.timestamp,
            originalError: this.originalError ? this.originalError.message : null
        };
    }
}

class BrowserTimeoutError extends Error {
    constructor(message, timeout = 0, operation = 'unknown', originalError = null) {
        super(message);
        this.name = 'BrowserTimeoutError';
        this.type = 'browser_timeout';
        this.timeout = timeout;
        this.operation = operation;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
        this.recoverable = true; // Timeouts are generally recoverable
        
        Error.captureStackTrace(this, BrowserTimeoutError);
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            timeout: this.timeout,
            operation: this.operation,
            recoverable: this.recoverable,
            timestamp: this.timestamp,
            originalError: this.originalError ? this.originalError.message : null
        };
    }
}

class BrowserCrashError extends Error {
    constructor(message, context = 'unknown', recoveryAttempt = false, originalError = null) {
        super(message);
        this.name = 'BrowserCrashError';
        this.type = 'browser_crash';
        this.context = context;
        this.recoveryAttempt = recoveryAttempt;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
        this.recoverable = !recoveryAttempt; // Only recoverable if this isn't already a recovery attempt
        
        Error.captureStackTrace(this, BrowserCrashError);
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            context: this.context,
            recoveryAttempt: this.recoveryAttempt,
            recoverable: this.recoverable,
            timestamp: this.timestamp,
            originalError: this.originalError ? this.originalError.message : null
        };
    }
}

class PageNavigationError extends Error {
    constructor(message, url = '', attempt = 1, maxAttempts = 3, originalError = null) {
        super(message);
        this.name = 'PageNavigationError';
        this.type = 'page_navigation';
        this.url = url;
        this.attempt = attempt;
        this.maxAttempts = maxAttempts;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
        this.recoverable = attempt < maxAttempts;
        
        Error.captureStackTrace(this, PageNavigationError);
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            url: this.url,
            attempt: this.attempt,
            maxAttempts: this.maxAttempts,
            recoverable: this.recoverable,
            timestamp: this.timestamp,
            originalError: this.originalError ? this.originalError.message : null
        };
    }
}

class ResourceExhaustionError extends Error {
    constructor(message, memoryUsage = null, resourceType = 'memory', originalError = null) {
        super(message);
        this.name = 'ResourceExhaustionError';
        this.type = 'resource_exhaustion';
        this.memoryUsage = memoryUsage;
        this.resourceType = resourceType;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
        this.recoverable = true; // Resource issues are generally recoverable with cleanup
        
        Error.captureStackTrace(this, ResourceExhaustionError);
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            memoryUsage: this.memoryUsage,
            resourceType: this.resourceType,
            recoverable: this.recoverable,
            timestamp: this.timestamp,
            originalError: this.originalError ? this.originalError.message : null
        };
    }
}

class CircuitBreakerError extends Error {
    constructor(message, service = 'browser', failureCount = 0, threshold = 5) {
        super(message);
        this.name = 'CircuitBreakerError';
        this.type = 'circuit_breaker';
        this.service = service;
        this.failureCount = failureCount;
        this.threshold = threshold;
        this.timestamp = new Date().toISOString();
        this.recoverable = false; // Circuit breaker errors require manual intervention
        
        Error.captureStackTrace(this, CircuitBreakerError);
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            service: this.service,
            failureCount: this.failureCount,
            threshold: this.threshold,
            recoverable: this.recoverable,
            timestamp: this.timestamp
        };
    }
}

/**
 * Error Classification Utility
 * Analyzes error messages and classifies them into structured error types
 */
class ErrorClassifier {
    static classify(error, context = {}) {
        const message = error.message || error.toString();
        const { attempt = 1, maxAttempts = 3, operation = 'unknown' } = context;

        // Browser launch errors
        if (this.isBrowserLaunchError(message)) {
            return new BrowserLaunchError(message, attempt, maxAttempts, error);
        }

        // Browser timeout errors
        if (this.isBrowserTimeoutError(message)) {
            const timeout = this.extractTimeout(message);
            return new BrowserTimeoutError(message, timeout, operation, error);
        }

        // Browser crash errors
        if (this.isBrowserCrashError(message)) {
            return new BrowserCrashError(message, operation, context.recoveryAttempt || false, error);
        }

        // Page navigation errors
        if (this.isPageNavigationError(message)) {
            return new PageNavigationError(message, context.url || '', attempt, maxAttempts, error);
        }

        // Resource exhaustion errors
        if (this.isResourceExhaustionError(message)) {
            return new ResourceExhaustionError(message, context.memoryUsage, 'memory', error);
        }

        // Return original error if no classification matches
        return error;
    }

    static isBrowserLaunchError(message) {
        const patterns = [
            /browserType\.launch.*Timeout/i,
            /Failed to launch/i,
            /Could not start browser/i,
            /Browser process crashed/i,
            /ECONNREFUSED.*browser/i,
            /spawn.*ENOENT/i,
            /browser.*not found/i,
            /chromium.*launch.*failed/i
        ];
        return patterns.some(pattern => pattern.test(message));
    }

    static isBrowserTimeoutError(message) {
        const patterns = [
            /Timeout.*exceeded/i,
            /Navigation timeout/i,
            /Page timeout/i,
            /waiting for.*timed out/i,
            /element.*timeout/i,
            /selector.*timeout/i
        ];
        return patterns.some(pattern => pattern.test(message));
    }

    static isBrowserCrashError(message) {
        const patterns = [
            /browser.*crash/i,
            /Target page.*detached/i,
            /Session closed/i,
            /Connection closed/i,
            /Browser closed/i,
            /context.*closed/i,
            /page.*closed/i
        ];
        return patterns.some(pattern => pattern.test(message));
    }

    static isPageNavigationError(message) {
        const patterns = [
            /navigation.*failed/i,
            /net::ERR_/i,
            /Failed to load/i,
            /Cannot navigate/i,
            /page.*load.*failed/i
        ];
        return patterns.some(pattern => pattern.test(message));
    }

    static isResourceExhaustionError(message) {
        const patterns = [
            /out of memory/i,
            /memory.*exhausted/i,
            /resource.*exhausted/i,
            /ENOMEM/i,
            /heap.*exceeded/i
        ];
        return patterns.some(pattern => pattern.test(message));
    }

    static extractTimeout(message) {
        const timeoutMatch = message.match(/Timeout\s*(\d+)(?:ms)?/i);
        return timeoutMatch ? parseInt(timeoutMatch[1]) : 0;
    }
}

module.exports = {
    BrowserLaunchError,
    BrowserTimeoutError,
    BrowserCrashError,
    PageNavigationError,
    ResourceExhaustionError,
    CircuitBreakerError,
    ErrorClassifier
};