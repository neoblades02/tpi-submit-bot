const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

class JobManager extends EventEmitter {
    constructor() {
        super();
        this.jobs = new Map();
        this.processingQueue = [];
        this.isProcessing = false;
        this.maxConcurrentJobs = 1; // Process one job at a time to avoid browser conflicts
        this.statusWebhookUrl = 'https://n8n.collectgreatstories.com/webhook/tpi-status';
    }

    // Send status update to webhook
    async sendStatusUpdate(jobId, statusData) {
        try {
            console.log(`📡 Sending status update for job ${jobId}...`);
            
            const payload = {
                jobId: jobId,
                timestamp: new Date().toISOString(),
                ...statusData
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
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            estimatedDuration: null,
            options: {
                batchSize: options.batchSize || 10,
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
                    timestamp: new Date().toISOString()
                });
                job.completedAt = new Date().toISOString();
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
            message: `Job started with ${job.progress.total} records`,
            totalRecords: job.progress.total,
            batchSize: job.options.batchSize,
            startedAt: job.startedAt
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
                message: 'Logging in to TPI Suitcase...',
                progress: job.progress
            });
            
            const session = await loginAndCreateSession();
            
            // Send login completed status update
            await this.sendStatusUpdate(job.id, {
                status: 'login_completed',
                message: 'Successfully logged in, starting batch processing',
                progress: job.progress
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
                        const batchResults = await processRecordsWithSession(session, batchData, { sendWebhook: false });
                        
                        // Update job progress
                        job.results = job.results.concat(batchResults);
                        job.progress.completed += batchResults.filter(r => r.status === 'submitted').length;
                        job.progress.failed += batchResults.filter(r => r.status === 'error' || r.status === 'not submitted').length;
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
                            progress: job.progress,
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
                        job.errors.push({
                            batch: batchIndex + 1,
                            message: batchError.message,
                            timestamp: new Date().toISOString()
                        });
                        
                        // Check if this is a browser crash that we can recover from
                        if (batchError.message.includes('browser crash') || 
                            batchError.message.includes('navigation') || 
                            batchError.message.includes('Target page') ||
                            batchError.message.includes('Browser closed') ||
                            batchError.message.includes('Session closed')) {
                            
                            console.log('🔄 Browser crash detected, attempting to recover...');
                            
                            // Send crash recovery status update
                            await this.sendStatusUpdate(job.id, {
                                status: 'crash_detected',
                                message: `Browser crash detected in batch ${batchIndex + 1}, attempting recovery...`,
                                progress: job.progress,
                                batchIndex: batchIndex + 1,
                                error: batchError.message
                            });
                            
                            try {
                                // Close the crashed browser session
                                if (session && session.browser) {
                                    try {
                                        await session.browser.close();
                                        console.log('🔐 Closed crashed browser session');
                                    } catch (closeError) {
                                        console.log('⚠️ Could not close crashed browser (already closed)');
                                    }
                                }
                                
                                // Create a new login session
                                console.log('🔑 Creating new login session after crash...');
                                session = await loginAndCreateSession();
                                console.log('✅ New session created successfully');
                                
                                // Send recovery progress update
                                await this.sendStatusUpdate(job.id, {
                                    status: 'crash_recovery_login',
                                    message: `New session created, retrying batch ${batchIndex + 1}...`,
                                    progress: job.progress,
                                    batchIndex: batchIndex + 1
                                });
                                
                                // Retry the current batch with new session
                                console.log(`🔄 Retrying batch ${batchIndex + 1} with new session...`);
                                const retryResults = await processRecordsWithSession(session, batchData, { sendWebhook: false });
                                
                                // Update job progress with retry results
                                job.results = job.results.concat(retryResults);
                                job.progress.completed += retryResults.filter(r => r.status === 'submitted').length;
                                job.progress.failed += retryResults.filter(r => r.status === 'error' || r.status === 'not submitted').length;
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

                                // Send recovery success status update
                                await this.sendStatusUpdate(job.id, {
                                    status: 'crash_recovery_success',
                                    message: `Batch ${batchIndex + 1} recovered successfully after crash`,
                                    progress: job.progress,
                                    batchCompleted: batchIndex + 1,
                                    totalBatches: batches.length,
                                    recovered: true
                                });
                                
                            } catch (recoveryError) {
                                console.error('❌ Failed to recover from browser crash:', recoveryError);
                                
                                // Add recovery failure to errors
                                job.errors.push({
                                    batch: batchIndex + 1,
                                    message: `Recovery failed: ${recoveryError.message}`,
                                    timestamp: new Date().toISOString()
                                });
                                
                                // Stop processing if recovery fails
                                throw new Error(`Browser crash recovery failed for batch ${batchIndex + 1}: ${recoveryError.message}`);
                            }
                        } else {
                            // Non-crash error, continue with next batch
                            console.log('⚠️ Non-critical error, continuing with next batch');
                        }
                    }
                }
            } finally {
                // Always close the browser session
                if (session && session.browser) {
                    await session.browser.close();
                    console.log('🔐 Browser session closed after job completion');
                }
            }

            // Job completed
            job.status = job.status === 'cancelled' ? 'cancelled' : 'completed';
            job.completedAt = new Date().toISOString();

            console.log(`Job ${job.id} completed. Processed: ${job.progress.completed}, Failed: ${job.progress.failed}`);

            // Send job completion status update
            await this.sendStatusUpdate(job.id, {
                status: job.status,
                message: `Job ${job.status}! Processed: ${job.progress.completed}, Failed: ${job.progress.failed}`,
                progress: job.progress,
                completedAt: job.completedAt,
                duration: Date.now() - new Date(job.startedAt).getTime()
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
                        progress: job.progress,
                        resultsCount: job.results.length
                    });
                } catch (webhookError) {
                    console.error(`Error sending webhook for job ${job.id}:`, webhookError);
                    job.errors.push({
                        message: `Webhook delivery failed: ${webhookError.message}`,
                        timestamp: new Date().toISOString()
                    });
                    
                    // Send webhook error status update
                    await this.sendStatusUpdate(job.id, {
                        status: 'webhook_error',
                        message: `Failed to send consolidated webhook: ${webhookError.message}`,
                        progress: job.progress,
                        error: webhookError.message
                    });
                }
            }

        } catch (error) {
            job.status = 'failed';
            job.errors.push({
                message: error.message,
                timestamp: new Date().toISOString()
            });
            job.completedAt = new Date().toISOString();
            
            console.error(`Job ${job.id} failed:`, error);
            
            // Send job failure status update
            await this.sendStatusUpdate(job.id, {
                status: 'failed',
                message: `Job failed: ${error.message}`,
                progress: job.progress,
                completedAt: job.completedAt,
                error: error.message
            });
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
}

module.exports = JobManager;