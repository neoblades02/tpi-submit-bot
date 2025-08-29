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

class BrowserSessionTerminatedError extends Error {
    constructor(message, terminalReason = 'unknown', sessionId = null, originalError = null) {
        super(message);
        this.name = 'BrowserSessionTerminatedError';
        this.type = 'browser_session_terminated';
        this.terminalReason = terminalReason;
        this.sessionId = sessionId;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
        this.recoverable = terminalReason !== 'manual_close' && terminalReason !== 'process_killed';
        
        // Enhanced recovery guidance
        this.retryStrategy = this.getRetryStrategy(terminalReason);
        this.retryDelay = this.getRetryDelay(terminalReason);
        
        Error.captureStackTrace(this, BrowserSessionTerminatedError);
    }

    getRetryStrategy(reason) {
        switch (reason) {
            case 'race_condition':
                return 'immediate_with_delay';
            case 'network_disconnection':
                return 'progressive_backoff';
            case 'context_destroyed':
                return 'session_recreation';
            case 'browser_crash':
                return 'full_restart';
            default:
                return 'standard_retry';
        }
    }

    getRetryDelay(reason) {
        switch (reason) {
            case 'race_condition':
                return 3000; // Wait longer for race conditions
            case 'network_disconnection':
                return 5000; // Wait for network stability
            case 'context_destroyed':
                return 2000; // Standard delay
            case 'browser_crash':
                return 1000; // Quick retry after crash cleanup
            default:
                return 1500; // Default delay
        }
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            terminalReason: this.terminalReason,
            sessionId: this.sessionId,
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

        // Form validation errors (recoverable)
        if (error.formValidationFailure || this.isFormValidationError(message)) {
            const formError = new Error(message);
            formError.name = 'FormValidationError';
            formError.type = 'form_validation';
            formError.recoverable = true;
            formError.retryStrategy = 'immediate_retry';
            formError.retryDelay = 1000;
            formError.formValidationFailure = true;
            return formError;
        }

        // Session validation errors (recoverable with session recovery)
        if (this.isSessionValidationError(message)) {
            const sessionError = new Error(message);
            sessionError.name = 'SessionValidationError';
            sessionError.type = 'session_validation';
            sessionError.recoverable = true;
            sessionError.retryStrategy = 'session_recovery';
            sessionError.retryDelay = 2000;
            sessionError.sessionValidationFailure = true;
            return sessionError;
        }

        // Browser launch errors
        if (this.isBrowserLaunchError(message)) {
            return new BrowserLaunchError(message, attempt, maxAttempts, error);
        }

        // Browser timeout errors
        if (this.isBrowserTimeoutError(message)) {
            const timeout = this.extractTimeout(message);
            return new BrowserTimeoutError(message, timeout, operation, error);
        }

        // Browser session termination errors (more specific than crash errors)
        if (this.isBrowserSessionTerminatedError(message)) {
            const terminalReason = this.determineTerminationReason(message);
            return new BrowserSessionTerminatedError(message, terminalReason, context.sessionId, error);
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

        // Return enhanced original error if no classification matches
        const enhancedError = error;
        enhancedError.classificationAttempted = true;
        enhancedError.recoverable = this.isGenerallyRecoverable(message);
        enhancedError.retryStrategy = enhancedError.recoverable ? 'standard_retry' : 'no_retry';
        enhancedError.retryDelay = 1500;
        return enhancedError;
    }

    static isFormValidationError(message) {
        const patterns = [
            /form validation failed/i,
            /form.*incomplete/i,
            /form.*invalid/i,
            /field.*missing/i,
            /field.*empty/i,
            /required.*field/i,
            /validation.*error/i
        ];
        return patterns.some(pattern => pattern.test(message));
    }

    static isSessionValidationError(message) {
        const patterns = [
            /session validation failed/i,
            /session.*invalid/i,
            /session.*expired/i,
            /session.*not.*found/i
        ];
        return patterns.some(pattern => pattern.test(message));
    }

    static isGenerallyRecoverable(message) {
        const nonRecoverablePatterns = [
            /permission.*denied/i,
            /access.*denied/i,
            /authentication.*failed/i,
            /unauthorized/i,
            /forbidden/i,
            /not.*found.*404/i,
            /syntax.*error/i,
            /configuration.*error/i
        ];
        
        return !nonRecoverablePatterns.some(pattern => pattern.test(message));
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

    static isBrowserSessionTerminatedError(message) {
        const patterns = [
            /target page, context or browser has been closed/i,
            /page closed/i,
            /browser has been closed/i,
            /execution context was destroyed/i,
            /session.*closed/i,
            /browser.*disconnected/i,
            /protocol error.*target closed/i,
            /websocket connection.*closed/i,
            /browser instance.*terminated/i,
            /context.*destroyed/i,
            /page.*detached/i,
            /connection.*terminated/i
        ];
        return patterns.some(pattern => pattern.test(message));
    }

    static determineTerminationReason(message) {
        const reasonPatterns = {
            'race_condition': [
                /target page, context or browser has been closed/i,
                /execution context was destroyed/i
            ],
            'manual_close': [
                /browser.*close.*manually/i,
                /session.*terminated.*by.*user/i
            ],
            'process_killed': [
                /process.*killed/i,
                /sigterm/i,
                /sigkill/i
            ],
            'network_disconnection': [
                /websocket connection.*closed/i,
                /connection.*terminated/i,
                /browser.*disconnected/i
            ],
            'context_destroyed': [
                /context.*destroyed/i,
                /execution context was destroyed/i
            ],
            'page_detached': [
                /page.*detached/i,
                /target.*detached/i
            ],
            'browser_crash': [
                /browser.*crash/i,
                /unexpected.*termination/i
            ]
        };

        for (const [reason, patterns] of Object.entries(reasonPatterns)) {
            if (patterns.some(pattern => pattern.test(message))) {
                return reason;
            }
        }

        return 'unknown';
    }

    static extractTimeout(message) {
        const timeoutMatch = message.match(/Timeout\s*(\d+)(?:ms)?/i);
        return timeoutMatch ? parseInt(timeoutMatch[1]) : 0;
    }

    /**
     * Get recommended retry strategy for an error
     * @param {Error} error - The classified error
     * @param {number} currentAttempt - Current retry attempt number
     * @returns {Object} Retry recommendation
     */
    static getRetryRecommendation(error, currentAttempt = 1) {
        const maxAttempts = error.maxAttempts || 3;
        
        if (currentAttempt >= maxAttempts) {
            return {
                shouldRetry: false,
                reason: 'max_attempts_reached',
                delay: 0
            };
        }

        if (!error.recoverable) {
            return {
                shouldRetry: false,
                reason: 'non_recoverable_error',
                delay: 0
            };
        }

        let delay = error.retryDelay || 1000;
        let strategy = error.retryStrategy || 'standard_retry';

        // Apply progressive backoff for certain error types
        if (strategy === 'progressive_backoff') {
            delay = delay * Math.pow(2, currentAttempt - 1);
        }

        // Cap the maximum delay
        delay = Math.min(delay, 30000); // Max 30 seconds

        return {
            shouldRetry: true,
            strategy,
            delay,
            reason: `${strategy}_attempt_${currentAttempt}`
        };
    }
}

/**
 * Form Validation Error - for recoverable form-related issues
 */
class FormValidationError extends Error {
    constructor(message, fieldName = null, expectedValue = null, actualValue = null) {
        super(message);
        this.name = 'FormValidationError';
        this.type = 'form_validation';
        this.fieldName = fieldName;
        this.expectedValue = expectedValue;
        this.actualValue = actualValue;
        this.timestamp = new Date().toISOString();
        this.recoverable = true;
        this.retryStrategy = 'immediate_retry';
        this.retryDelay = 1000;
        this.formValidationFailure = true;
        
        Error.captureStackTrace(this, FormValidationError);
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            fieldName: this.fieldName,
            expectedValue: this.expectedValue,
            actualValue: this.actualValue,
            recoverable: this.recoverable,
            retryStrategy: this.retryStrategy,
            retryDelay: this.retryDelay,
            timestamp: this.timestamp
        };
    }
}

/**
 * Session Validation Error - for recoverable session-related issues
 */
class SessionValidationError extends Error {
    constructor(message, sessionId = null, validationDetails = null) {
        super(message);
        this.name = 'SessionValidationError';
        this.type = 'session_validation';
        this.sessionId = sessionId;
        this.validationDetails = validationDetails;
        this.timestamp = new Date().toISOString();
        this.recoverable = true;
        this.retryStrategy = 'session_recovery';
        this.retryDelay = 2000;
        this.sessionValidationFailure = true;
        
        Error.captureStackTrace(this, SessionValidationError);
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            sessionId: this.sessionId,
            validationDetails: this.validationDetails,
            recoverable: this.recoverable,
            retryStrategy: this.retryStrategy,
            retryDelay: this.retryDelay,
            timestamp: this.timestamp
        };
    }
}

module.exports = {
    BrowserLaunchError,
    BrowserTimeoutError,
    BrowserCrashError,
    BrowserSessionTerminatedError,
    PageNavigationError,
    ResourceExhaustionError,
    CircuitBreakerError,
    FormValidationError,
    SessionValidationError,
    ErrorClassifier
};