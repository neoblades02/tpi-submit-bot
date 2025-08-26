require('dotenv').config();
const express = require('express');
const { loginAndProcess } = require('./bot');
const JobManager = require('./jobManager');
const { discordNotifier } = require('./discordNotifier');

const app = express();
const port = process.env.PORT || 3000;
const jobManager = new JobManager();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.version
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'TPI Submit Bot API',
        version: '2.0.0',
        features: [
            'Asynchronous job processing',
            'Batch processing for large datasets',
            'Real-time progress tracking',
            'Job queue management'
        ],
        endpoints: {
            health: 'GET /health',
            triggerBot: 'POST /trigger-bot (sync - for small datasets)',
            triggerBotAsync: 'POST /trigger-bot-async (async - for large datasets)',
            jobStatus: 'GET /job/:jobId',
            jobProgress: 'GET /job/:jobId/progress',
            jobResults: 'GET /job/:jobId/results',
            cancelJob: 'POST /job/:jobId/cancel',
            allJobs: 'GET /jobs'
        },
        usage: {
            asyncProcessing: 'POST /trigger-bot-async with JSON data',
            checkProgress: 'GET /job/{jobId}/progress',
            getResults: 'GET /job/{jobId}/results (when completed)'
        }
    });
});

// Original synchronous endpoint (for backward compatibility or small datasets)
app.post('/trigger-bot', async (req, res) => {
    const receivedData = req.body;

    if (!receivedData || !Array.isArray(receivedData)) {
        return res.status(400).send('Request body must be a valid JSON array.');
    }

    try {
        console.log('Received data:', receivedData);

        // Pass the data to the bot and get the result
        const result = await loginAndProcess(receivedData);

        res.status(200).json(result);
    } catch (error) {
        console.error('Error processing request:', error);
        
        // Send error notification to Discord
        if (discordNotifier) {
            await discordNotifier.sendErrorNotification(error, {
                operation: 'sync_trigger_bot',
                endpoint: '/trigger-bot',
                timestamp: new Date().toISOString()
            }).catch(notifyError => {
                console.log('⚠️ Failed to send Discord notification:', notifyError.message);
            });
        }
        
        res.status(500).send('An error occurred while processing the request.');
    }
});

// New asynchronous endpoint for large datasets
app.post('/trigger-bot-async', async (req, res) => {
    const receivedData = req.body;

    // Debug logging
    console.log('Received data type:', typeof receivedData);
    console.log('Is array:', Array.isArray(receivedData));
    console.log('Received data:', JSON.stringify(receivedData, null, 2));

    if (!receivedData || !Array.isArray(receivedData)) {
        return res.status(400).json({
            error: 'Request body must be a valid JSON array.',
            code: 'INVALID_DATA',
            received: typeof receivedData,
            isArray: Array.isArray(receivedData)
        });
    }

    try {
        console.log('Received async job request with data:', {
            records: receivedData[0]?.rows?.length || 0,
            timestamp: new Date().toISOString()
        });
        console.log('First item structure:', receivedData[0]);
        console.log('First item rows:', receivedData[0]?.rows);

        // Transform data if needed - handle both formats
        let transformedData = receivedData;
        
        // If receivedData is an array of objects (records), wrap it in the expected format
        if (Array.isArray(receivedData) && receivedData.length > 0 && receivedData[0]['Agent Name']) {
            console.log('Detected raw records array, wrapping in expected format');
            transformedData = [{ rows: receivedData }];
        }

        console.log('Transformed data structure:', transformedData[0]);
        console.log('Record count:', transformedData[0]?.rows?.length || 0);

        // Extract options from query parameters
        const options = {
            batchSize: parseInt(req.query.batchSize) || 50,
            maxRetries: parseInt(req.query.maxRetries) || 3,
            timeout: parseInt(req.query.timeout) || 300000
        };

        // Create async job
        const jobResult = jobManager.createJob(transformedData, options);

        res.status(202).json({
            message: 'Job created successfully. Use the job ID to check progress.',
            ...jobResult,
            statusUrl: `/job/${jobResult.jobId}`,
            progressUrl: `/job/${jobResult.jobId}/progress`
        });

    } catch (error) {
        console.error('Error creating async job:', error);
        
        // Send error notification to Discord
        if (discordNotifier) {
            await discordNotifier.sendErrorNotification(error, {
                operation: 'async_trigger_bot',
                endpoint: '/trigger-bot-async',
                timestamp: new Date().toISOString()
            }).catch(notifyError => {
                console.log('⚠️ Failed to send Discord notification:', notifyError.message);
            });
        }
        
        res.status(500).json({
            error: 'An error occurred while creating the job.',
            code: 'JOB_CREATION_ERROR'
        });
    }
});

// Get job status
app.get('/job/:jobId', (req, res) => {
    const { jobId } = req.params;
    const status = jobManager.getJobStatus(jobId);
    
    if (status.error) {
        return res.status(404).json(status);
    }
    
    res.json(status);
});

// Get job progress (lightweight endpoint for frequent polling)
app.get('/job/:jobId/progress', (req, res) => {
    const { jobId } = req.params;
    const job = jobManager.jobs.get(jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json({
        jobId: jobId,
        status: job.status,
        progress: job.progress,
        stats: job.stats,
        estimatedTimeRemaining: jobManager.estimateTimeRemaining(job)
    });
});

// Get job results
app.get('/job/:jobId/results', (req, res) => {
    const { jobId } = req.params;
    const job = jobManager.jobs.get(jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status !== 'completed' && job.status !== 'failed') {
        return res.status(409).json({ 
            error: 'Job not completed yet',
            status: job.status,
            progress: job.progress
        });
    }
    
    res.json({
        jobId: jobId,
        status: job.status,
        progress: job.progress,
        stats: job.stats,
        results: job.results,
        errors: job.errors,
        completedAt: job.completedAt
    });
});

// Cancel a job
app.post('/job/:jobId/cancel', (req, res) => {
    const { jobId } = req.params;
    const result = jobManager.cancelJob(jobId);
    
    if (result.error) {
        return res.status(404).json(result);
    }
    
    res.json(result);
});

// Get all jobs
app.get('/jobs', (req, res) => {
    const jobs = jobManager.getAllJobs();
    res.json(jobs);
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
