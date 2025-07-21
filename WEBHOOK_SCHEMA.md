# TPI Status Webhook JSON Schema

This document defines the standardized JSON schema sent to `https://n8n.collectgreatstories.com/webhook/tpi-status` for all job status updates.

## Consistent JSON Structure

**Every webhook payload will have this exact structure** to ensure n8n workflow compatibility:

```json
{
  "jobId": "string",
  "timestamp": "ISO 8601 string",
  "status": "string",
  "message": "string",
  "progress": {
    "total": "number",
    "completed": "number", 
    "failed": "number",
    "percentage": "number"
  },
  "stats": {
    "loginCount": "number",
    "crashRecoveries": "number",
    "batchRetries": "number"
  },
  "timing": {
    "startedAt": "ISO 8601 string | null",
    "completedAt": "ISO 8601 string | null", 
    "duration": "number (milliseconds) | null"
  },
  "batch": {
    "current": "number | null",
    "total": "number | null",
    "duration": "number (milliseconds) | null"
  },
  "config": {
    "batchSize": "number | null",
    "totalRecords": "number"
  },
  "error": "string | null",
  "errors": "array | null",
  "metadata": {
    "recovered": "boolean",
    "resultsCount": "number | null"
  }
}
```

## Status Types

The `status` field will contain one of these exact values:

### Job Lifecycle Status
- `"started"` - Job has begun processing
- `"logging_in"` - Bot is logging into TPI Suitcase
- `"login_completed"` - Login successful, starting batch processing
- `"batch_completed"` - A batch has finished processing
- `"completed"` - Job finished successfully
- `"failed"` - Job failed with error

### Error Reporting Status
- `"record_error"` - Individual record processing error (real-time)
- `"queue_processing_failed"` - Queue processing error
- `"recovery_failed"` - Crash recovery attempt failed

### Crash Recovery Status
- `"crash_detected"` - Browser crash detected, attempting recovery
- `"crash_recovery_login"` - New session created after crash
- `"crash_recovery_success"` - Batch successfully recovered after crash

### Webhook Status
- `"webhook_sent"` - Data webhook delivery successful
- `"webhook_error"` - Data webhook delivery failed

### Job Summary Status
- `"job_completed_summary"` - Final job completion with consolidated error summary

**Note**: Clients are automatically created with aggressive retry logic, so "client not found" errors are eliminated.

## Example Payloads

### Job Started
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T10:30:00.000Z",
  "status": "started",
  "message": "Job started with 150 records",
  "progress": {
    "total": 150,
    "completed": 0,
    "failed": 0,
    "percentage": 0
  },
  "stats": {
    "loginCount": 0,
    "crashRecoveries": 0,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": null,
    "duration": null
  },
  "batch": {
    "current": null,
    "total": null,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": null,
  "metadata": {
    "recovered": false,
    "resultsCount": null
  }
}
```

### Login Completed
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T10:30:15.000Z",
  "status": "login_completed",
  "message": "Successfully logged in, starting batch processing",
  "progress": {
    "total": 150,
    "completed": 0,
    "failed": 0,
    "percentage": 0
  },
  "stats": {
    "loginCount": 1,
    "crashRecoveries": 0,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": null,
    "duration": null
  },
  "batch": {
    "current": null,
    "total": null,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": null,
  "metadata": {
    "recovered": false,
    "resultsCount": null
  }
}
```

### Batch Completed
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T10:34:30.000Z",
  "status": "batch_completed",
  "message": "Batch 1/15 completed",
  "progress": {
    "total": 150,
    "completed": 8,
    "failed": 2,
    "percentage": 7
  },
  "stats": {
    "loginCount": 1,
    "crashRecoveries": 0,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": null,
    "duration": null
  },
  "batch": {
    "current": 1,
    "total": 15,
    "duration": 240000
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": null,
  "metadata": {
    "recovered": false,
    "resultsCount": null
  }
}
```

### Crash Recovery
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T10:45:15.000Z",
  "status": "crash_recovery_success",
  "message": "Batch 5 recovered successfully after crash",
  "progress": {
    "total": 150,
    "completed": 38,
    "failed": 12,
    "percentage": 33
  },
  "stats": {
    "loginCount": 2,
    "crashRecoveries": 1,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": null,
    "duration": null
  },
  "batch": {
    "current": 5,
    "total": 15,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": null,
  "metadata": {
    "recovered": true,
    "resultsCount": null
  }
}
```

### Job Completed
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T11:30:00.000Z",
  "status": "completed",
  "message": "Job completed! Processed: 142, Failed: 8",
  "progress": {
    "total": 150,
    "completed": 142,
    "failed": 8,
    "percentage": 100
  },
  "stats": {
    "loginCount": 2,
    "crashRecoveries": 1,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": "2024-07-21T11:30:00.000Z",
    "duration": 3600000
  },
  "batch": {
    "current": null,
    "total": null,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": null,
  "metadata": {
    "recovered": false,
    "resultsCount": null
  }
}
```

### Webhook Delivery Confirmation
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T11:30:05.000Z",
  "status": "webhook_sent",
  "message": "Consolidated webhook sent with 142 results",
  "progress": {
    "total": 150,
    "completed": 142,
    "failed": 8,
    "percentage": 100
  },
  "stats": {
    "loginCount": 2,
    "crashRecoveries": 1,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": "2024-07-21T11:30:00.000Z",
    "duration": 3600000
  },
  "batch": {
    "current": null,
    "total": null,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": null,
  "metadata": {
    "recovered": false,
    "resultsCount": 142
  }
}
```

### Job Failed
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T10:45:00.000Z",
  "status": "failed",
  "message": "Job failed: Multiple login failures",
  "progress": {
    "total": 150,
    "completed": 25,
    "failed": 15,
    "percentage": 27
  },
  "stats": {
    "loginCount": 3,
    "crashRecoveries": 2,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": "2024-07-21T10:45:00.000Z",
    "duration": 900000
  },
  "batch": {
    "current": null,
    "total": null,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": "Multiple login failures",
  "metadata": {
    "recovered": false,
    "resultsCount": null
  }
}
```

## Key Consistency Features

1. **Always Present Fields**: All fields are always present in every payload (no missing fields)
2. **Null Values**: Fields use `null` when not applicable instead of being omitted
3. **Default Values**: Numbers default to 0, booleans to false, objects are never empty
4. **Standardized Types**: Consistent data types for all fields across all status updates
5. **Predictable Structure**: n8n workflows can rely on the exact same structure every time

## Implementation Benefits

- **n8n Workflow Reliability**: No "field not found" errors in workflow processing
- **Consistent Parsing**: All status updates can use the same parsing logic
- **Complete Information**: Every update contains full job context
- **Performance Monitoring**: Login count and crash recovery stats in every update
- **Progress Tracking**: Complete progress information always available
- **Error Handling**: Standardized error information when applicable

### Individual Record Error - Client Name Missing (Real-Time)
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T10:35:15.000Z",
  "status": "record_error",
  "message": "Record processing error: Unknown Client",
  "progress": {
    "total": 150,
    "completed": 10,
    "failed": 2,
    "percentage": 8
  },
  "stats": {
    "loginCount": 1,
    "crashRecoveries": 0,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": null,
    "duration": null
  },
  "batch": {
    "current": 1,
    "total": 15,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": "Client name is blank or missing",
  "errors": [
    {
      "record": "Unknown Client",
      "message": "Client name is blank or missing",
      "timestamp": "2024-07-21T10:35:15.000Z",
      "context": "client_name_validation",
      "batch": 1
    }
  ],
  "metadata": {
    "recovered": false,
    "resultsCount": null
  }
}
```

### Individual Record Error - Tour Operator Not Found (Real-Time)
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T10:35:30.000Z",
  "status": "record_error",
  "message": "Record processing error: John Doe",
  "progress": {
    "total": 150,
    "completed": 12,
    "failed": 3,
    "percentage": 10
  },
  "stats": {
    "loginCount": 1,
    "crashRecoveries": 0,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": null,
    "duration": null
  },
  "batch": {
    "current": 1,
    "total": 15,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": "Tour operator not found in dropdown",
  "errors": [
    {
      "record": "John Doe",
      "message": "Tour operator not found in dropdown",
      "timestamp": "2024-07-21T10:35:30.000Z",
      "context": "tour_operator_selection",
      "batch": 1
    }
  ],
  "metadata": {
    "recovered": false,
    "resultsCount": null
  }
}
```

### Job Completion Summary with Consolidated Errors
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2024-07-21T11:30:10.000Z",
  "status": "job_completed_summary",
  "message": "Job processing complete. Total: 150, Submitted: 142, Failed: 8",
  "progress": {
    "total": 150,
    "completed": 142,
    "failed": 8,
    "percentage": 100
  },
  "stats": {
    "loginCount": 2,
    "crashRecoveries": 1,
    "batchRetries": 0
  },
  "timing": {
    "startedAt": "2024-07-21T10:30:00.000Z",
    "completedAt": "2024-07-21T11:30:00.000Z",
    "duration": 3600000
  },
  "batch": {
    "current": null,
    "total": null,
    "duration": null
  },
  "config": {
    "batchSize": 50,
    "totalRecords": 150
  },
  "error": null,
  "errors": [
    {
      "record": "John Doe",
      "message": "Tour operator not found in dropdown",
      "timestamp": "2024-07-21T10:35:30.000Z",
      "context": "tour_operator_selection",
      "batch": 1
    },
    {
      "record": "Jane Smith",
      "message": "Page not ready for processing",
      "timestamp": "2024-07-21T10:42:15.000Z",
      "context": "page_readiness_check",
      "batch": 2
    }
  ],
  "metadata": {
    "recovered": false,
    "resultsCount": null
  },
  "summary": {
    "totalRecords": 150,
    "submittedRecords": 142,
    "failedRecords": 8,
    "errorCount": 8,
    "loginCount": 2,
    "crashRecoveries": 1,
    "batchRetries": 0,
    "processingDuration": 3600000
  }
}
```

## Error Consolidation Features

### Real-Time Error Reporting
- **Individual Record Errors**: Sent immediately when record processing fails
- **Detailed Context**: Each error includes client name, message, timestamp, and processing context
- **Batch Information**: Error tracking includes which batch the error occurred in
- **Error Categories**: Client name validation, page readiness, client creation, tour operator selection, form processing

### Job Summary Error Consolidation
- **Complete Error List**: All errors from the job consolidated in final summary
- **Statistics Integration**: Error count, login count, crash recoveries in summary
- **Performance Metrics**: Total processing duration and batch statistics
- **Comprehensive Logging**: All error details preserved for analysis and troubleshooting

### Dual Webhook Architecture
- **Status Webhook**: Receives both individual errors and job summaries for complete monitoring
- **Results Webhook**: Receives ALL records (successful and failed) with status information for data integration

This schema ensures that n8n workflows can process all status updates reliably without conditional logic for missing fields.