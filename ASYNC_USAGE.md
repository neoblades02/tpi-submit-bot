# TPI Submit Bot - Async Processing Usage Guide

## Overview
The TPI Submit Bot now supports asynchronous processing to handle large datasets without timeout issues. This is perfect for processing hundreds or thousands of records that would otherwise timeout on cloud platforms.

## Key Features
- **Asynchronous Processing**: Submit jobs that run in the background
- **Single Login**: Login once per job for maximum efficiency
- **Automatic Crash Recovery**: Browser crashes are automatically recovered with new login session
- **Batch Processing**: Data is processed in configurable batches (default: 10 records)
- **Progress Tracking**: Real-time progress updates with estimated completion time
- **Job Management**: Cancel, monitor, and retrieve results for multiple jobs
- **No Timeouts**: Jobs run independently of HTTP request timeouts

## API Endpoints

### 1. Submit Async Job
**POST** `/trigger-bot-async`

Submit a large dataset for asynchronous processing.

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d @sample.json \
  "http://localhost:3000/trigger-bot-async?batchSize=10&maxRetries=3"
```

**Response:**
```json
{
  "message": "Job created successfully. Use the job ID to check progress.",
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "status": "pending",
  "estimatedDuration": {
    "seconds": 9360,
    "formatted": "2h 36m 0s"
  },
  "statusUrl": "/job/123e4567-e89b-12d3-a456-426614174000",
  "progressUrl": "/job/123e4567-e89b-12d3-a456-426614174000/progress"
}
```

**Query Parameters:**
- `batchSize`: Number of records to process per batch (default: 10)
- `maxRetries`: Maximum retry attempts per batch (default: 3)
- `timeout`: Timeout per batch in milliseconds (default: 300000)

### 2. Check Job Progress
**GET** `/job/:jobId/progress`

Get real-time progress updates (lightweight endpoint for frequent polling).

```bash
curl http://localhost:3000/job/123e4567-e89b-12d3-a456-426614174000/progress
```

**Response:**
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "status": "processing",
  "progress": {
    "total": 1407,
    "completed": 150,
    "failed": 5,
    "percentage": 11
  },
  "estimatedTimeRemaining": {
    "seconds": 8100,
    "formatted": "2h 15m 0s"
  }
}
```

### 3. Get Job Status (Detailed)
**GET** `/job/:jobId`

Get detailed job information including errors and sample results.

```bash
curl http://localhost:3000/job/123e4567-e89b-12d3-a456-426614174000
```

**Response:**
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "status": "processing",
  "progress": {
    "total": 1407,
    "completed": 150,
    "failed": 5,
    "percentage": 11
  },
  "createdAt": "2024-07-17T23:30:00.000Z",
  "startedAt": "2024-07-17T23:30:05.000Z",
  "completedAt": null,
  "estimatedTimeRemaining": {
    "seconds": 8100,
    "formatted": "2h 15m 0s"
  },
  "errors": [
    {
      "batch": 3,
      "message": "Client not found: John Doe",
      "timestamp": "2024-07-17T23:35:00.000Z"
    }
  ],
  "sampleResults": [
    {
      "Agent Name": "Alex Harmeyer",
      "Client Name": "Donna Duquaine",
      "status": "submitted",
      "InvoiceNumber": "201425570"
    }
  ]
}
```

### 4. Get Job Results
**GET** `/job/:jobId/results`

Get complete results when job is finished.

```bash
curl http://localhost:3000/job/123e4567-e89b-12d3-a456-426614174000/results
```

**Response:**
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "status": "completed",
  "progress": {
    "total": 1407,
    "completed": 1350,
    "failed": 57,
    "percentage": 100
  },
  "results": [
    {
      "Agent Name": "Alex Harmeyer",
      "Client Name": "Donna Duquaine",
      "status": "submitted",
      "InvoiceNumber": "201425570"
    }
  ],
  "errors": [],
  "completedAt": "2024-07-18T02:45:00.000Z"
}
```

### 5. Cancel Job
**POST** `/job/:jobId/cancel`

Cancel a running or pending job.

```bash
curl -X POST http://localhost:3000/job/123e4567-e89b-12d3-a456-426614174000/cancel
```

### 6. List All Jobs
**GET** `/jobs`

Get status of all jobs.

```bash
curl http://localhost:3000/jobs
```

## Usage Examples

### Processing Large Dataset
```bash
# 1. Submit the job
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d @sample.json \
  "http://localhost:3000/trigger-bot-async?batchSize=15")

# 2. Extract job ID
JOB_ID=$(echo $RESPONSE | jq -r '.jobId')
echo "Job ID: $JOB_ID"

# 3. Monitor progress
while true; do
  PROGRESS=$(curl -s "http://localhost:3000/job/$JOB_ID/progress")
  STATUS=$(echo $PROGRESS | jq -r '.status')
  PERCENTAGE=$(echo $PROGRESS | jq -r '.progress.percentage')
  
  echo "Status: $STATUS, Progress: $PERCENTAGE%"
  
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "cancelled" ]; then
    break
  fi
  
  sleep 30  # Check every 30 seconds
done

# 4. Get results
curl -s "http://localhost:3000/job/$JOB_ID/results" | jq '.'
```

### Processing with Custom Batch Size
```bash
# Process in smaller batches for better progress granularity
curl -X POST \
  -H "Content-Type: application/json" \
  -d @sample.json \
  "http://localhost:3000/trigger-bot-async?batchSize=5&maxRetries=2"
```

## Job States
- **pending**: Job is queued, waiting to start
- **processing**: Job is currently running
- **completed**: Job finished successfully
- **failed**: Job encountered a critical error
- **cancelled**: Job was cancelled by user

## Webhook Integration

### Consolidated Webhook Delivery
- **Single Webhook**: All results sent in one consolidated webhook when job completes
- **No Batch Webhooks**: Individual batches do not trigger separate webhooks
- **Complete Results**: Webhook contains all processed records with statuses and invoice numbers
- **Webhook URL**: `https://n8n.collectgreatstories.com/webhook/bookings-from-tpi`

### Webhook Timing
- **When**: Only sent when entire job status changes to "completed"
- **Content**: Array of all processed records with status tracking
- **Format**: Same as synchronous processing but with complete dataset

## Performance Expectations
Based on current performance (150 records in 1 hour):
- **Processing speed**: ~24 seconds per record
- **Batch size 10**: Progress updates every ~4 minutes
- **Batch size 15**: Progress updates every ~6 minutes
- **Large datasets**: Processing time scales linearly with record count
- **Webhook delivery**: Single webhook at completion

## Best Practices
1. **Use appropriate batch sizes**: 10-15 records per batch for good progress granularity
2. **Monitor progress**: Check `/progress` endpoint every 30-60 seconds
3. **Handle failures**: Check error messages and retry if needed
4. **Resource management**: Cancel jobs if no longer needed
5. **Backup results**: Save results once job completes

## Error Handling
- Individual record failures don't stop the job
- Batch failures are retried up to `maxRetries` times
- Critical errors (browser crashes) will fail the entire job
- All errors are logged with timestamps and context

## Deployment Considerations
- Jobs persist in memory (consider external queue for production)
- Multiple job processing is sequential (one at a time)
- No authentication required (add if needed for production)
- Resource usage: ~512MB-2GB RAM depending on batch size