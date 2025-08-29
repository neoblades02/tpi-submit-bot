const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// Import enhanced stability and monitoring modules
const { config } = require('./config');
const { systemMonitor } = require('./monitor');
const { discordNotifier } = require('./discordNotifier');
const { autoRestartManager } = require('./circuitBreaker');
const { ErrorClassifier, BrowserLaunchError, BrowserCrashError, BrowserSessionTerminatedError, CircuitBreakerError } = require('./errors');

class JobManager extends EventEmitter {
    constructor() {
        super();
        this.jobs = new Map();
        this.processingQueue = [];
        this.isProcessing = false;
        this.maxConcurrentJobs = config.job.maxConcurrentJobs; // Use configurable value
        this.statusWebhookUrl = config.status.webhookUrl;
        
        // Initialize monitoring and stability systems
        this.initializeStabilitySystems();
        
        console.log('🎯 JobManager initialized with enhanced stability features');
        console.log(`   Max concurrent jobs: ${this.maxConcurrentJobs}`);
        console.log(`   Status webhook: ${this.statusWebhookUrl}`);
    }

    /**
     * Initialize stability and monitoring systems
     */
    initializeStabilitySystems() {
        // Start system monitoring
        if (!systemMonitor.isMonitoring) {
            systemMonitor.startMonitoring();
            console.log('🔍 System monitoring started');
        }

        // Set up system monitor event listeners
        systemMonitor.on('memory_warning', (data) => {
            console.log(`⚠️ Memory warning: ${data.usage.rss}MB (threshold: ${data.threshold}MB)`);
            this.handleMemoryWarning(data);
        });

        systemMonitor.on('memory_exhaustion', (data) => {
            console.log(`🚨 Memory exhaustion detected: ${data.usage.rss}MB`);
            this.handleMemoryExhaustion(data);
        });

        systemMonitor.on('browser_timeout', (data) => {
            console.log(`⏰ Browser timeout detected for instance ${data.id}`);
            this.handleBrowserTimeout(data);
        });

        systemMonitor.on('emergency_cleanup', (data) => {
            console.log(`🚨 Emergency cleanup performed, ${data.closedBrowsers} browsers closed`);
            this.handleEmergencyCleanup(data);
        });

        // Set up auto-restart manager event listeners
        autoRestartManager.on('restartRequested', (data) => {
            console.log(`🔄 Restart requested for service: ${data.service}`);
            this.handleRestartRequest(data);
        });

        autoRestartManager.on('circuitBreakerStateChange', (data) => {
            console.log(`🔒 Circuit breaker state changed: ${data.service} ${data.oldState} → ${data.newState}`);
            this.handleCircuitBreakerStateChange(data);
        });

        // Send startup notification
        discordNotifier.sendStatusNotification('job_manager_started', 
            'Job Manager initialized with enhanced stability features', {
            maxConcurrentJobs: this.maxConcurrentJobs,
            memoryThreshold: config.memory.threshold,
            circuitBreakerEnabled: config.circuitBreaker.enabled
        });
    }

    /**
     * Handle memory warning events
     */
    async handleMemoryWarning(data) {
        console.log('⚠️ Handling memory warning...');
        
        // Send Discord notification
        await discordNotifier.sendStatusNotification('memory_warning', 
            `Memory usage above threshold: ${data.usage.rss}MB`, {
            memoryUsage: data.usage,
            threshold: data.threshold,
            browserInstances: systemMonitor.getMetrics().browserInstances
        });
        
        // Trigger garbage collection
        systemMonitor.triggerGarbageCollection();
        
        // Pause new job processing if memory is critically high
        if (data.usage.rss > config.memory.threshold * 1.2) {
            console.log('⏸️ Pausing new job processing due to high memory usage');
            this.pauseJobProcessing('high_memory_usage');
        }
    }

    /**
     * Handle memory exhaustion events
     */
    async handleMemoryExhaustion(data) {
        console.log('🚨 Handling memory exhaustion...');
        
        // Send critical alert
        await discordNotifier.sendCriticalAlert('memory_exhaustion', 
            `Memory exhaustion detected: ${data.usage.rss}MB`, {
            memoryUsage: data.usage,
            systemMetrics: systemMonitor.getMetrics(),
            recommendedActions: [
                'Emergency cleanup has been triggered',
                'All browser instances will be closed',
                'Job processing is paused',
                'Manual intervention may be required'
            ]
        });
        
        // Emergency pause all job processing
        this.emergencyPause('memory_exhaustion');
    }

    /**
     * Handle browser timeout events
     */
    async handleBrowserTimeout(data) {
        console.log(`⏰ Handling browser timeout for instance: ${data.id}`);
        
        // Find jobs using this browser instance and mark for recovery
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.browserInstance === data.id && job.status === 'processing') {
                console.log(`🔄 Triggering recovery for job ${jobId} due to browser timeout`);
                job.stats.crashRecoveries++;
                
                // Send recovery notification
                await discordNotifier.sendRecoveryNotification('browser_timeout_recovery',
                    `Recovering job ${jobId} from browser timeout`, {
                    jobId,
                    browserInstance: data.id,
                    inactiveTime: data.inactiveTime
                });
            }
        }
    }

    /**
     * Handle emergency cleanup events
     */
    async handleEmergencyCleanup(data) {
        console.log('🚨 Handling emergency cleanup...');
        
        // Mark all processing jobs as requiring recovery
        const affectedJobs = [];
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.status === 'processing') {
                job.status = 'recovery_required';
                job.stats.crashRecoveries++;
                affectedJobs.push(jobId);
            }
        }
        
        if (affectedJobs.length > 0) {
            await discordNotifier.sendCriticalAlert('emergency_cleanup_recovery',
                `Emergency cleanup affected ${affectedJobs.length} jobs`, {
                affectedJobs,
                closedBrowsers: data.closedBrowsers,
                recommendedActions: [
                    'Jobs will be retried with new browser instances',
                    'Monitor system stability',
                    'Consider increasing resource limits'
                ]
            });
        }
    }

    /**
     * Handle restart request events
     */
    async handleRestartRequest(data) {
        console.log(`🔄 Handling restart request for service: ${data.service}`);
        
        if (data.service === 'browser') {
            // Implement browser service restart logic
            await this.restartBrowserService(data);
        }
        
        // Send restart notification
        await discordNotifier.sendRecoveryNotification('service_restart',
            `Restarting service: ${data.service}`, {
            service: data.service,
            reason: data.reason,
            attempt: data.attempt,
            maxAttempts: data.maxAttempts
        });
    }

    /**
     * Handle circuit breaker state changes
     */
    async handleCircuitBreakerStateChange(data) {
        console.log(`🔒 Circuit breaker state changed: ${data.service} ${data.oldState} → ${data.newState}`);
        
        if (data.newState === 'OPEN') {
            // Circuit breaker opened - pause relevant operations
            if (data.service === 'browser') {
                console.log('⏸️ Pausing job processing due to browser circuit breaker');
                this.pauseJobProcessing('circuit_breaker_open');
            }
            
            // Send critical alert
            await discordNotifier.sendCriticalAlert('circuit_breaker_opened',
                `Circuit breaker opened for service: ${data.service}`, {
                service: data.service,
                newState: data.newState,
                timestamp: data.timestamp
            });
        } else if (data.newState === 'CLOSED' && data.oldState === 'OPEN') {
            // Circuit breaker recovered - resume operations
            if (data.service === 'browser') {
                console.log('▶️ Resuming job processing - browser circuit breaker recovered');
                this.resumeJobProcessing('circuit_breaker_recovered');
            }
            
            // Send recovery notification
            await discordNotifier.sendRecoveryNotification('circuit_breaker_recovered',
                `Circuit breaker recovered for service: ${data.service}`, {
                service: data.service,
                newState: data.newState,
                recoveryTime: data.timestamp
            });
        }
    }

    /**
     * Pause job processing with reason
     */
    pauseJobProcessing(reason) {
        this.isProcessing = false;
        console.log(`⏸️ Job processing paused: ${reason}`);
        
        // Send status update for all active jobs
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.status === 'processing') {
                this.sendStatusUpdate(jobId, {
                    status: 'paused',
                    message: `Job processing paused: ${reason}`,
                    reason
                });
            }
        }
    }

    /**
     * Resume job processing with reason
     */
    resumeJobProcessing(reason) {
        console.log(`▶️ Job processing resumed: ${reason}`);
        
        // Resume processing queue
        if (this.processingQueue.length > 0) {
            this.processQueue();
        }
        
        // Send status update for paused jobs
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.status === 'paused' || job.status === 'recovery_required') {
                job.status = 'pending';
                this.sendStatusUpdate(jobId, {
                    status: 'resumed',
                    message: `Job processing resumed: ${reason}`,
                    reason
                });
                
                // Add back to queue if not already there
                if (!this.processingQueue.includes(jobId)) {
                    this.processingQueue.unshift(jobId); // Add to front of queue
                }
            }
        }
    }

    /**
     * Emergency pause all operations
     */
    emergencyPause(reason) {
        this.isProcessing = false;
        console.log(`🚨 Emergency pause activated: ${reason}`);
        
        // Clear processing queue
        this.processingQueue = [];
        
        // Mark all processing jobs as failed
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.status === 'processing' || job.status === 'pending') {
                job.status = 'emergency_paused';
                job.errors.push({
                    message: `Emergency pause: ${reason}`,
                    timestamp: new Date().toISOString(),
                    context: 'emergency_pause'
                });
                
                this.sendStatusUpdate(jobId, {
                    status: 'emergency_paused',
                    message: `Emergency pause activated: ${reason}`,
                    error: reason
                });
            }
        }
    }

    /**
     * Restart browser service
     */
    async restartBrowserService(data) {
        console.log('🔄 Restarting browser service...');
        
        try {
            // This would trigger a restart of browser-related services
            // Implementation depends on how the browser manager is structured
            
            // Reset restart counter on successful restart
            autoRestartManager.resetRestartCounter();
            
            console.log('✅ Browser service restart completed');
            
        } catch (error) {
            console.error('❌ Browser service restart failed:', error.message);
            
            // Classify and report the error
            const classifiedError = ErrorClassifier.classify(error, {
                operation: 'browser_service_restart',
                attempt: data.attempt
            });
            
            await discordNotifier.sendErrorNotification(classifiedError, {
                service: data.service,
                restartAttempt: data.attempt
            });
        }
    }

    // Send status update to webhook with standardized JSON schema
    async sendStatusUpdate(jobId, statusData) {
        try {
            console.log(`📡 Sending status update for job ${jobId}...`);
            
            const job = this.jobs.get(jobId);
            
            // Standardized JSON schema for consistent n8n workflow processing
            const payload = {
                // Core identifiers (always present)
                jobId: jobId,
                timestamp: new Date().toISOString(),
                status: statusData.status || 'unknown',
                message: statusData.message || '',
                
                // Progress information (always present with defaults)
                progress: {
                    total: job?.progress?.total || 0,
                    completed: job?.progress?.completed || 0,
                    failed: job?.progress?.failed || 0,
                    percentage: job?.progress?.percentage || 0
                },
                
                // Statistics (always present with defaults)
                stats: {
                    loginCount: job?.stats?.loginCount || 0,
                    crashRecoveries: job?.stats?.crashRecoveries || 0,
                    batchRetries: job?.stats?.batchRetries || 0
                },
                
                // Job timing (always present with null defaults)
                timing: {
                    startedAt: job?.startedAt || null,
                    completedAt: statusData.completedAt || job?.completedAt || null,
                    duration: statusData.duration || null
                },
                
                // Batch information (present when applicable)
                batch: {
                    current: statusData.batchIndex || statusData.batchCompleted || null,
                    total: statusData.totalBatches || null,
                    duration: statusData.batchDuration || null
                },
                
                // Job configuration (always present)
                config: {
                    batchSize: job?.options?.batchSize || null,
                    totalRecords: job?.progress?.total || statusData.totalRecords || 0
                },
                
                // Error information (present when applicable)
                error: statusData.error || null,
                errors: statusData.errors || null,
                
                // Additional metadata (present when applicable)
                metadata: {
                    recovered: statusData.recovered || false,
                    resultsCount: statusData.resultsCount || null
                }
            };
            
            const response = await axios.post(this.statusWebhookUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'TPI-Submit-Bot/1.0'
                },
                timeout: 10000 // 10 second timeout
            });

            if (response.status === 200 || response.status === 201) {
                console.log(`✅ Status update sent successfully for job ${jobId}`);
            } else {
                console.error(`❌ Status webhook failed: ${response.status} ${response.statusText}`);
            }
        } catch (error) {
            console.error(`❌ Error sending status update for job ${jobId}:`, error.message);
        }
    }

    // Create a new job
    createJob(data, options = {}) {
        const jobId = uuidv4();
        const job = {
            id: jobId,
            data: data,
            status: 'pending',
            progress: {
                total: data[0]?.rows?.length || 0,
                completed: 0,
                failed: 0,
                percentage: 0
            },
            results: [],
            errors: [],
            stats: {
                loginCount: 0,
                crashRecoveries: 0,
                batchRetries: 0
            },
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            estimatedDuration: null,
            options: {
                batchSize: options.batchSize || 50,
                maxRetries: options.maxRetries || 3,
                timeout: options.timeout || 300000, // 5 minutes per batch
                ...options
            }
        };

        this.jobs.set(jobId, job);
        this.processingQueue.push(jobId);
        
        // Start processing if not already running
        if (!this.isProcessing) {
            this.processQueue();
        }

        return {
            jobId: jobId,
            status: job.status,
            message: 'Job created successfully. Processing will begin shortly.',
            estimatedDuration: this.estimateJobDuration(job.progress.total)
        };
    }

    // Get job status
    getJobStatus(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) {
            return { error: 'Job not found' };
        }

        return {
            jobId: jobId,
            status: job.status,
            progress: job.progress,
            stats: job.stats,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            estimatedTimeRemaining: this.estimateTimeRemaining(job),
            errors: job.errors.length > 0 ? job.errors.slice(-5) : [], // Last 5 errors
            sampleResults: job.results.slice(0, 3) // First 3 results as sample
        };
    }

    // Get all jobs
    getAllJobs() {
        const jobsList = Array.from(this.jobs.values()).map(job => ({
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            stats: job.stats,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt
        }));

        return {
            jobs: jobsList,
            queue: {
                pending: this.processingQueue.length,
                processing: this.isProcessing
            }
        };
    }

    // Cancel a job
    cancelJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) {
            return { error: 'Job not found' };
        }

        if (job.status === 'completed' || job.status === 'failed') {
            return { error: 'Cannot cancel completed or failed job' };
        }

        job.status = 'cancelled';
        job.completedAt = new Date().toISOString();

        // Remove from queue if pending
        const queueIndex = this.processingQueue.indexOf(jobId);
        if (queueIndex > -1) {
            this.processingQueue.splice(queueIndex, 1);
        }

        return {
            jobId: jobId,
            status: job.status,
            message: 'Job cancelled successfully'
        };
    }

    // Process the job queue
    async processQueue() {
        if (this.isProcessing || this.processingQueue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.processingQueue.length > 0) {
            const jobId = this.processingQueue.shift();
            const job = this.jobs.get(jobId);

            if (!job || job.status === 'cancelled') {
                continue;
            }

            try {
                await this.processJob(job);
            } catch (error) {
                console.error(`Error processing job ${jobId}:`, error);
                job.status = 'failed';
                job.errors.push({
                    message: error.message,
                    timestamp: new Date().toISOString(),
                    context: 'processQueue'
                });
                job.completedAt = new Date().toISOString();
                
                // Send queue processing error status update with consolidated errors
                await this.sendStatusUpdate(jobId, {
                    status: 'queue_processing_failed',
                    message: `Queue processing failed: ${error.message}`,
                    error: error.message,
                    errors: job.errors.length > 0 ? job.errors : null
                });
            }
        }

        this.isProcessing = false;
    }

    // Process a single job
    async processJob(job) {
        console.log(`Starting job ${job.id} with ${job.progress.total} records`);
        
        job.status = 'processing';
        job.startedAt = new Date().toISOString();

        // Send job started status update
        await this.sendStatusUpdate(job.id, {
            status: 'started',
            message: `Job started with ${job.progress.total} records`
        });

        try {
            const { loginAndCreateSession, processRecordsWithSession } = require('./bot');
            
            // Process in batches to avoid memory issues and provide progress updates
            const data = job.data;
            const batchSize = job.options.batchSize;
            const totalRecords = data[0].rows;
            const batches = [];

            // Split data into batches
            for (let i = 0; i < totalRecords.length; i += batchSize) {
                const batchData = [{
                    ...data[0],
                    rows: totalRecords.slice(i, i + batchSize)
                }];
                batches.push(batchData);
            }

            console.log(`Processing ${batches.length} batches of ${batchSize} records each`);

            // LOGIN ONCE - Create browser session that will be reused
            console.log('🔑 Logging in once for entire job...');
            
            // Send login status update
            await this.sendStatusUpdate(job.id, {
                status: 'logging_in',
                message: 'Logging in to TPI Suitcase...'
            });
            
            let session = null;
            try {
                session = await loginAndCreateSession();
            } catch (loginError) {
                console.error('❌ Failed to create browser session:', loginError.message);
                
                // Classify error using enhanced error classification
                const classifiedError = ErrorClassifier.classify(loginError, {
                    operation: 'browser_session_creation',
                    jobId: job.id
                });
                
                // Add classified error to job
                job.errors.push({
                    message: `Browser session creation failed: ${classifiedError.message}`,
                    timestamp: classifiedError.timestamp,
                    context: classifiedError.type || 'session_creation_failure',
                    errorType: classifiedError.name,
                    recoverable: classifiedError.recoverable,
                    originalError: loginError.message
                });
                
                // Handle different error types appropriately
                if (classifiedError instanceof BrowserLaunchError) {
                    console.log('🚨 Browser launch error detected, checking circuit breaker...');
                    
                    // Trigger circuit breaker logic
                    const browserCircuitBreaker = autoRestartManager.getCircuitBreaker('browser');
                    
                    await this.sendStatusUpdate(job.id, {
                        status: 'browser_launch_failed',
                        message: `Browser launch failed: ${classifiedError.message}`,
                        error: classifiedError.toJSON(),
                        recoverable: classifiedError.recoverable
                    });
                    
                    // Send enhanced Discord notification
                    await discordNotifier.sendErrorNotification(classifiedError, {
                        jobId: job.id,
                        operation: 'browser_launch',
                        memoryUsage: systemMonitor.checkMemoryUsage(),
                        circuitBreakerStatus: browserCircuitBreaker.getMetrics().state
                    });
                    
                    // Consider automatic restart if error is recoverable
                    if (classifiedError.recoverable && autoRestartManager) {
                        await autoRestartManager.considerRestart('browser', 
                            `Browser launch failure: ${classifiedError.message}`);
                    }
                    
                } else if (classifiedError instanceof CircuitBreakerError) {
                    console.log('🔒 Circuit breaker error - service temporarily unavailable');
                    
                    await this.sendStatusUpdate(job.id, {
                        status: 'circuit_breaker_blocked',
                        message: 'Browser service temporarily unavailable due to circuit breaker',
                        error: classifiedError.toJSON()
                    });
                    
                    // Pause job processing until circuit breaker recovers
                    this.pauseJobProcessing('circuit_breaker_open');
                    
                } else {
                    // General session creation error
                    console.log('⚠️ General session creation error');
                    
                    await this.sendStatusUpdate(job.id, {
                        status: 'session_creation_failed',
                        message: `Could not establish session: ${classifiedError.message}`,
                        error: classifiedError.toJSON ? classifiedError.toJSON() : classifiedError.message,
                        recoverable: classifiedError.recoverable || false
                    });
                    
                    // Send error notification
                    await discordNotifier.sendErrorNotification(classifiedError, {
                        jobId: job.id,
                        operation: 'session_creation',
                        memoryUsage: systemMonitor.checkMemoryUsage()
                    });
                }
                
                throw loginError; // Re-throw to be caught by outer handler
            }
            
            // Increment login count
            job.stats.loginCount++;
            
            // Send login completed status update
            await this.sendStatusUpdate(job.id, {
                status: 'login_completed',
                message: 'Successfully logged in, starting batch processing'
            });
            
            try {
                // Process each batch using the same session
                for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                    if (job.status === 'cancelled') {
                        break;
                    }

                    const batchData = batches[batchIndex];
                    const batchStartTime = Date.now();
                    
                    try {
                        console.log(`Processing batch ${batchIndex + 1}/${batches.length} (using existing session)`);
                        
                        // Process batch using existing session - no login needed
                        const batchResults = await processRecordsWithSession(session, batchData, { 
                            sendWebhook: false,
                            jobId: job.id // Pass jobId for individual error reporting 
                        });
                        
                        // Handle return structure (bot returns just records)
                        const records = batchResults;
                        
                        // Count record-level errors and add to job errors for summary
                        const recordErrors = records.filter(r => r.status === 'error' || r.status === 'not submitted');
                        recordErrors.forEach(errorRecord => {
                            job.errors.push({
                                record: errorRecord['Client Name'] || 'Unknown',
                                message: errorRecord.Submitted || 'Processing failed',
                                timestamp: new Date().toISOString(),
                                context: 'record_processing_failure',
                                batch: batchIndex + 1
                            });
                        });
                        
                        // Update job progress
                        job.results = job.results.concat(records);
                        job.progress.completed += records.filter(r => r.status === 'submitted').length;
                        job.progress.failed += records.filter(r => r.status === 'error' || r.status === 'not submitted').length;
                        job.progress.percentage = Math.round((job.progress.completed + job.progress.failed) / job.progress.total * 100);

                        const batchDuration = Date.now() - batchStartTime;
                        console.log(`Batch ${batchIndex + 1} completed in ${batchDuration}ms`);

                        // Emit progress event
                        this.emit('progress', {
                            jobId: job.id,
                            progress: job.progress,
                            batchCompleted: batchIndex + 1,
                            totalBatches: batches.length
                        });

                        // Send batch progress status update
                        await this.sendStatusUpdate(job.id, {
                            status: 'batch_completed',
                            message: `Batch ${batchIndex + 1}/${batches.length} completed`,
                            batchCompleted: batchIndex + 1,
                            totalBatches: batches.length,
                            batchDuration: batchDuration
                        });

                        // Small delay between batches to prevent overwhelming the target system
                        if (batchIndex < batches.length - 1) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }

                    } catch (batchError) {
                        console.error(`Error processing batch ${batchIndex + 1}:`, batchError);
                        
                        // Classify the error to determine if it's recoverable
                        const classifiedBatchError = ErrorClassifier.classify(batchError, {
                            operation: 'batch_processing',
                            jobId: job.id,
                            batchIndex: batchIndex + 1,
                            attempt: 1,
                            maxAttempts: 2 // Allow one retry per batch
                        });
                        
                        // Add classified error to job errors
                        job.errors.push({
                            batch: batchIndex + 1,
                            message: classifiedBatchError.message,
                            timestamp: new Date().toISOString(),
                            context: classifiedBatchError.type || 'batch_processing',
                            errorType: classifiedBatchError.name,
                            recoverable: classifiedBatchError.recoverable || false,
                            retryStrategy: classifiedBatchError.retryStrategy,
                            stack: batchError.stack || null
                        });
                        
                        // Get retry recommendation based on error type
                        const retryRecommendation = ErrorClassifier.getRetryRecommendation(classifiedBatchError, 1);
                        console.log(`🔍 Retry recommendation for batch ${batchIndex + 1}: ${JSON.stringify(retryRecommendation)}`);
                        
                        // Check if error is recoverable and we should retry
                        if (retryRecommendation.shouldRetry && 
                            (classifiedBatchError instanceof BrowserCrashError || 
                             classifiedBatchError instanceof BrowserSessionTerminatedError ||
                             classifiedBatchError.recoverable)) {
                            
                            console.log(`🔄 ${classifiedBatchError.name} detected, attempting to recover...`);
                            
                            // Send enhanced crash notification
                            await discordNotifier.sendErrorNotification(classifiedBatchError, {
                                jobId: job.id,
                                batchIndex: batchIndex + 1,
                                totalBatches: batches.length,
                                recoverable: true
                            });
                            
                            // Send crash recovery status update
                            await this.sendStatusUpdate(job.id, {
                                status: 'crash_detected',
                                message: `Browser crash detected in batch ${batchIndex + 1}, attempting recovery...`,
                                batchIndex: batchIndex + 1,
                                error: batchError.message,
                                errors: job.errors.length > 0 ? job.errors.slice(-10) : null // Last 10 errors for context
                            });
                            
                            try {
                                // Enhanced cleanup based on error type and retry strategy
                                const cleanupDelay = retryRecommendation.delay || 1000;
                                console.log(`⏳ Waiting ${cleanupDelay}ms before cleanup (strategy: ${retryRecommendation.strategy})`);
                                await new Promise(resolve => setTimeout(resolve, cleanupDelay));
                                
                                if (classifiedBatchError instanceof BrowserSessionTerminatedError) {
                                    console.log(`🔄 Handling ${classifiedBatchError.terminalReason} session termination with ${classifiedBatchError.retryStrategy} strategy`);
                                    
                                    // Apply termination-specific cleanup delay
                                    if (classifiedBatchError.retryDelay > cleanupDelay) {
                                        const additionalDelay = classifiedBatchError.retryDelay - cleanupDelay;
                                        console.log(`⏳ Additional cleanup delay for termination: ${additionalDelay}ms`);
                                        await new Promise(resolve => setTimeout(resolve, additionalDelay));
                                    }
                                    
                                    // For session termination, browser is likely already closed
                                    if (session && session.browser) {
                                        try {
                                            if (session.browser.isConnected()) {
                                                await session.browser.close();
                                                console.log('🔐 Closed browser session');
                                            } else {
                                                console.log('ℹ️ Browser session already disconnected');
                                            }
                                        } catch (closeError) {
                                            console.log('⚠️ Browser session cleanup completed (connection already closed)');
                                        }
                                    }
                                } else {
                                    // Traditional crash handling with retry strategy awareness
                                    console.log(`🔄 Handling ${classifiedBatchError.name} with ${retryRecommendation.strategy} strategy`);
                                    
                                    if (session && session.browser) {
                                        try {
                                            await session.browser.close();
                                            console.log('🔐 Closed crashed browser session');
                                        } catch (closeError) {
                                            console.log('⚠️ Could not close crashed browser (already closed)');
                                        }
                                    }
                                }
                                
                                // Create a new login session with enhanced recovery strategy
                                const recoveryDelay = classifiedBatchError.retryDelay || retryRecommendation.delay || 1000;
                                console.log(`🔑 Creating new login session using ${retryRecommendation.strategy} strategy (delay: ${recoveryDelay}ms)`);
                                
                                // Apply strategy-specific delay if not already applied
                                if (retryRecommendation.strategy === 'progressive_backoff' || 
                                    classifiedBatchError.retryStrategy === 'progressive_backoff') {
                                    const progressiveDelay = Math.min(recoveryDelay * 2, 10000); // Cap at 10s
                                    console.log(`⏳ Progressive backoff delay: ${progressiveDelay}ms`);
                                    await new Promise(resolve => setTimeout(resolve, progressiveDelay));
                                } else if (!cleanupDelay || cleanupDelay < recoveryDelay) {
                                    const remainingDelay = Math.max(recoveryDelay - (cleanupDelay || 0), 0);
                                    if (remainingDelay > 0) {
                                        console.log(`⏳ Additional recovery delay: ${remainingDelay}ms`);
                                        await new Promise(resolve => setTimeout(resolve, remainingDelay));
                                    }
                                }
                                
                                session = await loginAndCreateSession();
                                
                                // Increment login count and crash recovery count
                                job.stats.loginCount++;
                                job.stats.crashRecoveries++;
                                
                                console.log('✅ New session created successfully');
                                
                                // Send recovery progress update
                                await this.sendStatusUpdate(job.id, {
                                    status: 'crash_recovery_login',
                                    message: `New session created, retrying batch ${batchIndex + 1}...`,
                                    batchIndex: batchIndex + 1
                                });
                                
                                // Retry the current batch with new session
                                console.log(`🔄 Retrying batch ${batchIndex + 1} with new session...`);
                                const retryResults = await processRecordsWithSession(session, batchData, { 
                                    sendWebhook: false,
                                    jobId: job.id // Pass jobId for individual error reporting
                                });
                                
                                // Handle retry results (bot returns just records)
                                const retryRecords = retryResults;
                                
                                // Count record-level errors from retry and add to job errors
                                const retryErrors = retryRecords.filter(r => r.status === 'error' || r.status === 'not submitted');
                                retryErrors.forEach(errorRecord => {
                                    job.errors.push({
                                        record: errorRecord['Client Name'] || 'Unknown',
                                        message: errorRecord.Submitted || 'Processing failed',
                                        timestamp: new Date().toISOString(),
                                        context: 'record_processing_failure_retry',
                                        batch: batchIndex + 1,
                                        retryAttempt: true
                                    });
                                });
                                
                                // Update job progress with retry results
                                job.results = job.results.concat(retryRecords);
                                job.progress.completed += retryRecords.filter(r => r.status === 'submitted').length;
                                job.progress.failed += retryRecords.filter(r => r.status === 'error' || r.status === 'not submitted').length;
                                job.progress.percentage = Math.round((job.progress.completed + job.progress.failed) / job.progress.total * 100);
                                
                                console.log(`✅ Batch ${batchIndex + 1} recovered successfully`);
                                
                                // Emit progress event for recovery
                                this.emit('progress', {
                                    jobId: job.id,
                                    progress: job.progress,
                                    batchCompleted: batchIndex + 1,
                                    totalBatches: batches.length,
                                    recovered: true
                                });

                                // Send enhanced recovery success status update
                                await this.sendStatusUpdate(job.id, {
                                    status: 'batch_recovery_success',
                                    message: `Batch ${batchIndex + 1} recovered successfully using ${retryRecommendation.strategy} strategy`,
                                    batchCompleted: batchIndex + 1,
                                    totalBatches: batches.length,
                                    recovered: true,
                                    recoveryStrategy: retryRecommendation.strategy,
                                    errorType: classifiedBatchError.name
                                });
                                
                            } catch (recoveryError) {
                                console.error('❌ Failed to recover from browser crash:', recoveryError);
                                
                                // Add recovery failure to errors
                                job.errors.push({
                                    batch: batchIndex + 1,
                                    message: `Recovery failed: ${recoveryError.message}`,
                                    timestamp: new Date().toISOString(),
                                    context: 'crash_recovery',
                                    stack: recoveryError.stack || null
                                });
                                
                                // Classify the recovery error and send enhanced failure update
                                const classifiedRecoveryError = ErrorClassifier.classify(recoveryError, {
                                    operation: 'batch_recovery',
                                    jobId: job.id,
                                    batchIndex: batchIndex + 1,
                                    originalError: classifiedBatchError
                                });
                                
                                await this.sendStatusUpdate(job.id, {
                                    status: 'batch_recovery_failed',
                                    message: `Batch ${batchIndex + 1} recovery failed: ${recoveryError.message}`,
                                    batchIndex: batchIndex + 1,
                                    error: classifiedRecoveryError.toJSON ? classifiedRecoveryError.toJSON() : recoveryError.message,
                                    originalError: classifiedBatchError.toJSON ? classifiedBatchError.toJSON() : classifiedBatchError.message,
                                    recoveryStrategy: retryRecommendation.strategy,
                                    errors: job.errors.length > 0 ? job.errors.slice(-10) : null // Last 10 errors
                                });
                                
                                // Stop processing if recovery fails
                                throw new Error(`Browser crash recovery failed for batch ${batchIndex + 1}: ${recoveryError.message}`);
                            }
                        } else {
                            // Non-recoverable error or retry not recommended
                            if (!retryRecommendation.shouldRetry) {
                                console.log(`❌ Error not retryable (${retryRecommendation.reason}), continuing with next batch`);
                                
                                await this.sendStatusUpdate(job.id, {
                                    status: 'batch_error_non_retryable',
                                    message: `Batch ${batchIndex + 1} failed with non-retryable error: ${classifiedBatchError.message}`,
                                    batchIndex: batchIndex + 1,
                                    error: classifiedBatchError.toJSON ? classifiedBatchError.toJSON() : classifiedBatchError.message,
                                    retryReason: retryRecommendation.reason
                                });
                            } else {
                                console.log(`⚠️ Recoverable error but retry conditions not met, continuing with next batch`);
                                
                                await this.sendStatusUpdate(job.id, {
                                    status: 'batch_error_retry_skipped',
                                    message: `Batch ${batchIndex + 1} error: ${classifiedBatchError.message}`,
                                    batchIndex: batchIndex + 1,
                                    error: classifiedBatchError.toJSON ? classifiedBatchError.toJSON() : classifiedBatchError.message,
                                    skipReason: 'retry_conditions_not_met'
                                });
                            }
                        }
                    }
                }
            } finally {
                // Set job completion status but don't close browser yet - post-processing may need it
                if (job.status !== 'cancelled') {
                    job.status = 'completed';
                }
                job.completedAt = new Date().toISOString();
                console.log(`Job ${job.id} completed. Processed: ${job.progress.completed}, Failed: ${job.progress.failed}`);
            }

            // Send job completion status update with consolidated errors
            await this.sendStatusUpdate(job.id, {
                status: job.status,
                message: `Job ${job.status}! Processed: ${job.progress.completed}, Failed: ${job.progress.failed}`,
                completedAt: job.completedAt,
                duration: Date.now() - new Date(job.startedAt).getTime(),
                errors: job.errors.length > 0 ? job.errors : null
            });

            // Send consolidated webhook with all results when job completes
            if (job.status === 'completed' && job.results.length > 0) {
                try {
                    console.log(`Sending consolidated webhook for job ${job.id} with ${job.results.length} results`);
                    const { sendToWebhook } = require('./bot');
                    await sendToWebhook(job.results);
                    console.log(`Webhook sent successfully for job ${job.id}`);
                    
                    // Send webhook delivery confirmation status update
                    await this.sendStatusUpdate(job.id, {
                        status: 'webhook_sent',
                        message: `Consolidated webhook sent with ${job.results.length} results`,
                        resultsCount: job.results.length
                    });
                } catch (webhookError) {
                    console.error(`Error sending webhook for job ${job.id}:`, webhookError);
                    job.errors.push({
                        message: `Webhook delivery failed: ${webhookError.message}`,
                        timestamp: new Date().toISOString(),
                        context: 'webhook_delivery',
                        stack: webhookError.stack || null
                    });
                    
                    // Send webhook error status update with all errors for logging
                    await this.sendStatusUpdate(job.id, {
                        status: 'webhook_error',
                        message: `Failed to send consolidated webhook: ${webhookError.message}`,
                        error: webhookError.message,
                        errors: job.errors.length > 0 ? job.errors : null
                    });
                }
            }

            // Send job completion summary to status webhook
            await this.sendStatusUpdate(job.id, {
                status: 'job_completed_summary',
                message: `Job processing complete. Total: ${job.progress.total}, Submitted: ${job.progress.completed}, Failed: ${job.progress.failed}`,
                summary: {
                    totalRecords: job.progress.total,
                    submittedRecords: job.progress.completed,
                    failedRecords: job.progress.failed,
                    errorCount: job.errors.length,
                    loginCount: job.stats.loginCount,
                    crashRecoveries: job.stats.crashRecoveries,
                    batchRetries: job.stats.batchRetries,
                    processingDuration: Date.now() - new Date(job.startedAt).getTime()
                },
                errors: job.errors.length > 0 ? job.errors : null
            });

            // Now that all post-processing is complete, safely close the browser session
            if (session && session.browser) {
                try {
                    await session.browser.close();
                    console.log('🔐 Browser session closed after job post-processing completion');
                } catch (browserCloseError) {
                    console.log(`⚠️ Error closing browser session: ${browserCloseError.message}`);
                }
            }

        } catch (error) {
            job.status = 'failed';
            job.errors.push({
                message: error.message,
                timestamp: new Date().toISOString(),
                context: 'job_processing',
                stack: error.stack || null
            });
            job.completedAt = new Date().toISOString();
            
            console.error(`Job ${job.id} failed:`, error);
            
            // Send job failure status update with consolidated errors
            await this.sendStatusUpdate(job.id, {
                status: 'failed',
                message: `Job failed: ${error.message}`,
                completedAt: job.completedAt,
                error: error.message,
                errors: job.errors.length > 0 ? job.errors : null
            });

            // Close browser session on job failure
            if (session && session.browser) {
                try {
                    await session.browser.close();
                    console.log('🔐 Browser session closed after job failure');
                } catch (browserCloseError) {
                    console.log(`⚠️ Error closing browser session after job failure: ${browserCloseError.message}`);
                }
            }
        }
    }

    // Estimate job duration based on historical data
    estimateJobDuration(totalRecords) {
        // Based on your data: 150 records in 1 hour = 24 seconds per record
        const secondsPerRecord = 24;
        const estimatedSeconds = totalRecords * secondsPerRecord;
        
        return {
            seconds: estimatedSeconds,
            formatted: this.formatDuration(estimatedSeconds)
        };
    }

    // Estimate remaining time for a job
    estimateTimeRemaining(job) {
        if (job.status !== 'processing' || !job.startedAt) {
            return null;
        }

        const elapsedMs = Date.now() - new Date(job.startedAt).getTime();
        const completedRecords = job.progress.completed + job.progress.failed;
        
        if (completedRecords === 0) {
            return this.estimateJobDuration(job.progress.total);
        }

        const msPerRecord = elapsedMs / completedRecords;
        const remainingRecords = job.progress.total - completedRecords;
        const remainingMs = remainingRecords * msPerRecord;
        
        return {
            seconds: Math.round(remainingMs / 1000),
            formatted: this.formatDuration(Math.round(remainingMs / 1000))
        };
    }

    // Format duration in human-readable format
    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = seconds % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m ${remainingSeconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${remainingSeconds}s`;
        } else {
            return `${remainingSeconds}s`;
        }
    }

    // Clean up old jobs (optional)
    cleanupOldJobs(maxAge = 24 * 60 * 60 * 1000) { // 24 hours
        const now = Date.now();
        for (const [jobId, job] of this.jobs.entries()) {
            const jobAge = now - new Date(job.createdAt).getTime();
            if (jobAge > maxAge && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
                this.jobs.delete(jobId);
            }
        }
    }

    /**
     * Enhanced health check with monitoring integration
     */
    getHealthStatus() {
        const systemMetrics = systemMonitor.getMetrics();
        const circuitBreakers = autoRestartManager.getMetrics().circuitBreakers;
        
        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            jobs: {
                total: this.jobs.size,
                pending: this.processingQueue.length,
                processing: Array.from(this.jobs.values()).filter(job => job.status === 'processing').length,
                failed: Array.from(this.jobs.values()).filter(job => job.status === 'failed').length,
                completed: Array.from(this.jobs.values()).filter(job => job.status === 'completed').length
            },
            system: {
                memory: systemMetrics.memory,
                browserInstances: systemMetrics.browserInstances,
                uptime: systemMetrics.uptime,
                warnings: systemMetrics.warnings
            },
            circuitBreakers: circuitBreakers,
            isProcessing: this.isProcessing
        };

        // Determine overall health status
        if (systemMetrics.warnings.memoryExhaustion) {
            health.status = 'critical';
            health.issues = ['Memory exhaustion detected'];
        } else if (systemMetrics.warnings.memoryThreshold) {
            health.status = 'warning';
            health.issues = ['Memory usage above threshold'];
        } else if (circuitBreakers.some(cb => cb.state === 'OPEN')) {
            health.status = 'degraded';
            health.issues = ['One or more circuit breakers are open'];
        }

        return health;
    }

    /**
     * Enhanced cleanup with monitoring integration
     */
    async cleanup() {
        console.log('🧹 JobManager cleanup starting...');
        
        try {
            // Send shutdown notification
            await discordNotifier.sendStatusNotification('job_manager_shutting_down',
                'Job Manager is shutting down gracefully', {
                activeJobs: this.jobs.size,
                pendingJobs: this.processingQueue.length
            });

            // Cancel all pending jobs
            for (const [jobId, job] of this.jobs.entries()) {
                if (job.status === 'pending' || job.status === 'processing') {
                    job.status = 'cancelled';
                    job.completedAt = new Date().toISOString();
                    
                    await this.sendStatusUpdate(jobId, {
                        status: 'cancelled',
                        message: 'Job cancelled due to system shutdown'
                    });
                }
            }

            // Stop system monitoring
            if (systemMonitor.isMonitoring) {
                await systemMonitor.cleanup();
            }

            // Cleanup auto-restart manager
            if (autoRestartManager) {
                autoRestartManager.destroy();
            }

            console.log('✅ JobManager cleanup completed');

        } catch (error) {
            console.error('❌ Error during JobManager cleanup:', error.message);
        }
    }
}

module.exports = JobManager;