/**
 * Failed Record State Manager for TPI Submit Bot
 * Manages record processing state to prevent data loss and track retry attempts
 */

class RecordStateManager {
    constructor() {
        // Track record processing state across attempts
        this.recordStates = new Map();
        // Track processing sessions
        this.sessionRecords = new Map();
        // Failed records queue for potential recovery
        this.failedRecords = new Map();
        // Error correlation for retry tracking
        this.errorHistory = new Map();
    }

    /**
     * Initialize record for processing
     */
    initializeRecord(recordId, recordData, sessionId, jobId) {
        const recordState = {
            id: recordId,
            data: recordData,
            sessionId: sessionId,
            jobId: jobId,
            status: 'pending',
            attempts: [],
            currentAttempt: 0,
            maxAttempts: 3,
            errors: [],
            startTime: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            isProcessed: false,
            recoverable: true
        };

        this.recordStates.set(recordId, recordState);
        
        // Track records by session
        if (!this.sessionRecords.has(sessionId)) {
            this.sessionRecords.set(sessionId, new Set());
        }
        this.sessionRecords.get(sessionId).add(recordId);

        return recordState;
    }

    /**
     * Start a new processing attempt for a record
     */
    startAttempt(recordId, attemptNumber) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            throw new Error(`Record ${recordId} not found in state manager`);
        }

        const attempt = {
            number: attemptNumber,
            startTime: new Date().toISOString(),
            status: 'in_progress',
            errors: [],
            recoveryAttempts: []
        };

        recordState.currentAttempt = attemptNumber;
        recordState.attempts.push(attempt);
        recordState.lastUpdated = new Date().toISOString();
        recordState.status = 'processing';

        return attempt;
    }

    /**
     * Record an error during processing
     */
    recordError(recordId, error, context = {}) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            throw new Error(`Record ${recordId} not found in state manager`);
        }

        const errorEntry = {
            message: error.message || 'Unknown error',
            type: error.type || 'unknown',
            context: context,
            timestamp: new Date().toISOString(),
            stack: error.stack,
            recoverable: error.recoverable !== false,
            attempt: recordState.currentAttempt
        };

        // Add to current attempt
        const currentAttempt = recordState.attempts[recordState.attempts.length - 1];
        if (currentAttempt) {
            currentAttempt.errors.push(errorEntry);
        }

        // Add to overall record errors
        recordState.errors.push(errorEntry);
        recordState.lastUpdated = new Date().toISOString();

        // Track error correlation
        const errorKey = `${recordId}-${error.type}`;
        if (!this.errorHistory.has(errorKey)) {
            this.errorHistory.set(errorKey, []);
        }
        this.errorHistory.get(errorKey).push(errorEntry);

        return errorEntry;
    }

    /**
     * Record a recovery attempt
     */
    recordRecoveryAttempt(recordId, recoveryType, success, details = {}) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            throw new Error(`Record ${recordId} not found in state manager`);
        }

        const recoveryAttempt = {
            type: recoveryType,
            success: success,
            timestamp: new Date().toISOString(),
            details: details
        };

        // Add to current attempt
        const currentAttempt = recordState.attempts[recordState.attempts.length - 1];
        if (currentAttempt) {
            currentAttempt.recoveryAttempts.push(recoveryAttempt);
        }

        recordState.lastUpdated = new Date().toISOString();

        return recoveryAttempt;
    }

    /**
     * Mark record as successfully processed
     */
    markProcessed(recordId, result = {}) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            throw new Error(`Record ${recordId} not found in state manager`);
        }

        recordState.status = 'completed';
        recordState.isProcessed = true;
        recordState.completedAt = new Date().toISOString();
        recordState.lastUpdated = new Date().toISOString();
        recordState.result = result;

        // Mark current attempt as completed
        const currentAttempt = recordState.attempts[recordState.attempts.length - 1];
        if (currentAttempt) {
            currentAttempt.status = 'completed';
            currentAttempt.endTime = new Date().toISOString();
        }

        // Remove from failed records if it was there
        this.failedRecords.delete(recordId);

        return recordState;
    }

    /**
     * Mark record as failed (permanently or after max attempts)
     */
    markFailed(recordId, reason = 'Max attempts exceeded', recoverable = false) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            throw new Error(`Record ${recordId} not found in state manager`);
        }

        recordState.status = 'failed';
        recordState.isProcessed = true; // Failed is still "processed" in terms of job completion
        recordState.failedAt = new Date().toISOString();
        recordState.lastUpdated = new Date().toISOString();
        recordState.failureReason = reason;
        recordState.recoverable = recoverable;

        // Mark current attempt as failed
        const currentAttempt = recordState.attempts[recordState.attempts.length - 1];
        if (currentAttempt) {
            currentAttempt.status = 'failed';
            currentAttempt.endTime = new Date().toISOString();
        }

        // Add to failed records for potential manual review
        this.failedRecords.set(recordId, {
            recordState: recordState,
            failedAt: new Date().toISOString(),
            recoverable: recoverable
        });

        return recordState;
    }

    /**
     * Check if record should continue processing (not at max attempts)
     */
    shouldContinueProcessing(recordId) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            return false;
        }

        // Don't continue if already processed
        if (recordState.isProcessed) {
            return false;
        }

        // Don't continue if at max attempts
        if (recordState.currentAttempt >= recordState.maxAttempts) {
            return false;
        }

        // Don't continue if marked as unrecoverable
        if (recordState.recoverable === false) {
            return false;
        }

        return true;
    }

    /**
     * Check if record should be retried (recoverable error, attempts remaining)
     */
    shouldRetryRecord(recordId) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            return false;
        }

        // Already processed records should not be retried
        if (recordState.isProcessed) {
            return false;
        }

        // Check if we have attempts remaining
        if (recordState.currentAttempt >= recordState.maxAttempts) {
            return false;
        }

        // Check if last error was recoverable
        const lastError = recordState.errors[recordState.errors.length - 1];
        if (lastError && !lastError.recoverable) {
            return false;
        }

        return true;
    }

    /**
     * Get record processing statistics
     */
    getRecordStats(recordId) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            return null;
        }

        return {
            id: recordId,
            status: recordState.status,
            attempts: recordState.attempts.length,
            maxAttempts: recordState.maxAttempts,
            errors: recordState.errors.length,
            recoveryAttempts: recordState.attempts.reduce((total, attempt) => 
                total + (attempt.recoveryAttempts ? attempt.recoveryAttempts.length : 0), 0),
            isProcessed: recordState.isProcessed,
            recoverable: recordState.recoverable,
            processingTime: recordState.completedAt || recordState.failedAt ? 
                new Date(recordState.completedAt || recordState.failedAt) - new Date(recordState.startTime) : 
                new Date() - new Date(recordState.startTime)
        };
    }

    /**
     * Get session processing statistics
     */
    getSessionStats(sessionId) {
        const recordIds = this.sessionRecords.get(sessionId);
        if (!recordIds) {
            return null;
        }

        const stats = {
            sessionId: sessionId,
            totalRecords: recordIds.size,
            completed: 0,
            failed: 0,
            processing: 0,
            pending: 0,
            totalErrors: 0,
            totalRecoveryAttempts: 0
        };

        for (const recordId of recordIds) {
            const recordState = this.recordStates.get(recordId);
            if (recordState) {
                switch (recordState.status) {
                    case 'completed':
                        stats.completed++;
                        break;
                    case 'failed':
                        stats.failed++;
                        break;
                    case 'processing':
                        stats.processing++;
                        break;
                    case 'pending':
                        stats.pending++;
                        break;
                }
                stats.totalErrors += recordState.errors.length;
                stats.totalRecoveryAttempts += recordState.attempts.reduce((total, attempt) => 
                    total + (attempt.recoveryAttempts ? attempt.recoveryAttempts.length : 0), 0);
            }
        }

        return stats;
    }

    /**
     * Get failed records for potential manual review
     */
    getFailedRecords() {
        const failed = [];
        for (const [recordId, failedRecord] of this.failedRecords) {
            failed.push({
                recordId: recordId,
                recordName: failedRecord.recordState.data['Client Name'] || 'Unknown',
                failureReason: failedRecord.recordState.failureReason,
                failedAt: failedRecord.failedAt,
                recoverable: failedRecord.recoverable,
                attempts: failedRecord.recordState.attempts.length,
                lastError: failedRecord.recordState.errors[failedRecord.recordState.errors.length - 1]
            });
        }
        return failed;
    }

    /**
     * Clean up old record states (for memory management)
     */
    cleanup(olderThanHours = 24) {
        const cutoffTime = new Date(Date.now() - (olderThanHours * 60 * 60 * 1000));
        
        for (const [recordId, recordState] of this.recordStates) {
            if (new Date(recordState.lastUpdated) < cutoffTime) {
                this.recordStates.delete(recordId);
                
                // Clean up session records
                if (this.sessionRecords.has(recordState.sessionId)) {
                    this.sessionRecords.get(recordState.sessionId).delete(recordId);
                    if (this.sessionRecords.get(recordState.sessionId).size === 0) {
                        this.sessionRecords.delete(recordState.sessionId);
                    }
                }
                
                // Clean up failed records
                this.failedRecords.delete(recordId);
            }
        }

        // Clean up error history
        for (const [errorKey, errorEntries] of this.errorHistory) {
            const filteredEntries = errorEntries.filter(entry => 
                new Date(entry.timestamp) >= cutoffTime
            );
            if (filteredEntries.length === 0) {
                this.errorHistory.delete(errorKey);
            } else {
                this.errorHistory.set(errorKey, filteredEntries);
            }
        }
    }

    /**
     * Get correlation data for specific error patterns
     */
    getErrorCorrelation(recordId, errorType) {
        const errorKey = `${recordId}-${errorType}`;
        return this.errorHistory.get(errorKey) || [];
    }

    /**
     * Export record state for debugging/logging
     */
    exportRecordState(recordId) {
        const recordState = this.recordStates.get(recordId);
        if (!recordState) {
            return null;
        }

        return {
            ...recordState,
            stats: this.getRecordStats(recordId)
        };
    }
}

// Create singleton instance
const recordStateManager = new RecordStateManager();

module.exports = {
    RecordStateManager,
    recordStateManager
};