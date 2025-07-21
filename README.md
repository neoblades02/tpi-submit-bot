# TPI Suitcase Submission Bot

This project is a comprehensive Node.js bot designed to automate client booking submissions to the TPI Suitcase web portal. It runs as an Express server with both **synchronous and asynchronous processing** capabilities, and uses Playwright to perform advanced browser automation tasks with complete form processing and webhook integration.

## Features

### Core Capabilities
- **API-Driven**: Multiple endpoints for different use cases
- **Synchronous Processing**: `/trigger-bot` - For small datasets (<50 records)
- **Asynchronous Processing**: `/trigger-bot-async` - For large datasets (100+ records)
- **Job Management**: Real-time progress tracking, job cancellation, and result retrieval
- **Batch Processing**: Configurable batch sizes to prevent memory issues and timeouts (default: 50 records per batch)
- **No Timeout Issues**: Perfect for Coolify and other cloud platforms with request limits

### Security & Authentication
- **Secure Login**: Uses environment variables (`.env` file) to securely handle portal credentials
- **Production-Ready**: Headless browser with security-hardened configuration
- **Resource Management**: Memory limits and automatic cleanup

### Form Processing
- **Complete Form Automation**: 
  - Navigates to the "Quick Submit" form after login
  - Sets all bookings as "Tour FIT" (consistent reservation type)
  - Fills reservation title, booking number, dates, pricing, and commission fields
- **Advanced Client Search**: 
  - Clears secondary customers field with readonly detection to prevent form confusion.
  - Uses the portal's search popup to find clients by last name.
  - Creates new clients with aggressive dropdown closure and popup cleanup.
  - Performs F5-style page refresh after client creation to ensure completely clean DOM state.
  - Restarts form processing after successful client creation with fresh browser environment.
  - Handles "no results found" scenarios with proper error messaging.
  - Selects the correct client from results table or closes popup if not found.
- **Freeze-Resistant Tour Operator Selection**:
  - Multi-method clicking (Standard → Force → JavaScript) for maximum reliability.
  - Enhanced matching logic with exact matches and word boundaries to prevent false positives.
  - Dropdown closure verification and automatic escape key fallback.
  - Handles cases where operator is not found in the system.
- **Popup-Protected Regional and Date Processing**:
  - Calendar popup prevention before all field interactions.
  - Automatically selects "United States" as destination region with popup protection.
  - Calendar-safe date filling using direct fill method (no clicking).
  - Robust price and commission field processing with interference prevention.
- **Interference-Free Submit and Duplicate Workflow**:
  - Pre-submission popup clearing to ensure clean submit button access.
  - Uses "Submit and Duplicate" button for form submission.
  - Handles confirmation popup with OK button.
  - Extracts generated invoice numbers from updated reservation titles.
- **Automatic Webhook Integration**:
  - Sends all processed data to configured n8n webhook endpoint.
  - Provides comprehensive error handling and logging.
- **Enhanced Status Tracking**: 
  - Returns detailed JSON response with status, submission state, and invoice numbers.
  - Tracks submitted, not submitted, and error states for each record.
- **Complete Freeze Prevention System**:
  - Universal popup prevention with `closeCalendarPopupIfOpen()` before all critical interactions.
  - Multiple click approaches (Standard → Force → JavaScript) for maximum reliability.
  - Aggressive dropdown closure and mask removal to prevent client creation freezing.
  - Dropdown state verification and automatic escape key fallbacks.
  - Targeted popup cleanup that preserves normal form functionality.
- **Form Robustness & Dynamic Adaptation**:
  - Handles form refresh scenarios where selector IDs change dynamically.
  - Implements dynamic selector detection with multiple fallback strategies.
  - Preserves form state across retry attempts after form refresh.
  - Comprehensive retry logic with form state recovery and error handling.
  - Readonly field detection and proper handling for secondary customers.
- **Containerized**: Includes updated `Dockerfile` for easy deployment to Google Cloud Run.

---

## Setup and Usage

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Docker](https://www.docker.com/) (for containerized deployment)

### 1. Installation

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd tpi-submit-bot
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Create Environment File:**
    Create a `.env` file in the project root and add your TPI Suitcase credentials:
    ```env
    USERNAME=your_email@example.com
    PASSWORD=your_secret_password
    ```

### 2. Running the Server

To start the API server locally:

```bash
npm start
```

The server will be running at `http://localhost:3000`.

### 3. Triggering the Bot

The bot offers two processing modes:

#### Option A: Synchronous Processing (Small Datasets)
For datasets with less than 50 records, use the synchronous endpoint:

**Endpoint:** `POST /trigger-bot`

#### Option B: Asynchronous Processing (Large Datasets)
For large datasets (100+ records) or to avoid platform timeouts, use the asynchronous endpoint:

**Endpoint:** `POST /trigger-bot-async`

*Recommended for Coolify deployment and large datasets*

**Payload Format:**
The body must be a JSON array containing a single object with a `rows` key. The `rows` key must hold an array of client records with complete booking information.

**Required Fields per Record:**
- `Agent Name`: Name of the booking agent
- `Client Name`: Full name of the client (first and last name)
- `Trip Description`: Description of the trip (all bookings processed as "Tour FIT")
- `Booking Number`: Unique booking identifier
- `Booking Status`: Current status of the booking
- `Booking Description`: Detailed description of the booking
- `Tour Operator`: Name of the tour operator/supplier
- `Booking Date`: Date when booking was made
- `Booking Start Date`: Trip start date (MM/DD/YYYY format)
- `Booking End Date`: Trip end date (MM/DD/YYYY format)
- `Package Price`: Total package price
- `Commission Projected`: Expected commission amount

**Example Payload:**
```json
[
  {
    "rows": [
      {
        "Agent Name": "Alex Harmeyer",
        "Client Name": "Donna Duquaine",
        "Trip Description": "Donna Duquaine | Location TBD | Month TBD",
        "Booking Number": "E2495497481",
        "Booking Status": "Active",
        "Booking Description": "Allianz Travel Protection - Classic Plan",
        "Tour Operator": "Allianz Travel Insurance",
        "Booking Date": "06/04/2025",
        "Booking Start Date": "09/01/2025",
        "Booking End Date": "09/12/2025",
        "Package Price": "848.00",
        "Commission Projected": "237.44"
      },
      {
        "Agent Name": "Alex Harmeyer",
        "Client Name": "Jane Smith",
        "Trip Description": "Mediterranean Cruise Adventure",
        "Booking Number": "CR67890",
        "Booking Status": "Confirmed",
        "Booking Description": "7-night cruise with balcony cabin",
        "Tour Operator": "Royal Caribbean",
        "Booking Date": "06/05/2025",
        "Booking Start Date": "10/15/2025",
        "Booking End Date": "10/22/2025",
        "Package Price": "3,200.00",
        "Commission Projected": "480.00"
      }
    ]
  }
]
```

#### Synchronous Response (POST /trigger-bot):
Returns immediately with complete results:

```json
[
  {
    "Agent Name": "Alex Harmeyer",
    "Client Name": "Donna Duquaine",
    "Trip Description": "Donna Duquaine | Location TBD | Month TBD",
    "Booking Number": "E2495497481",
    "Booking Status": "Active",
    "Booking Description": "Allianz Travel Protection - Classic Plan",
    "Tour Operator": "Allianz Travel Insurance",
    "Booking Date": "06/04/2025",
    "Booking Start Date": "09/01/2025",
    "Booking End Date": "09/12/2025",
    "Package Price": "848.00",
    "Commission Projected": "237.44",
    "status": "submitted",
    "Submitted": "Submitted",
    "InvoiceNumber": "201425570"
  },
  {
    "Agent Name": "Alex Harmeyer",
    "Client Name": "Jane Smith",
    "Trip Description": "Mediterranean Cruise Adventure",
    "Booking Number": "CR67890",
    "Booking Status": "Confirmed",
    "Booking Description": "7-night cruise with balcony cabin",
    "Tour Operator": "Royal Caribbean",
    "Booking Date": "06/05/2025",
    "Booking Start Date": "10/15/2025",
    "Booking End Date": "10/22/2025",
    "Package Price": "3,200.00",
    "Commission Projected": "480.00",
    "status": "not submitted",
    "Submitted": "Not Submitted",
    "InvoiceNumber": "Not Generated"
  }
]
```

#### Asynchronous Response (POST /trigger-bot-async):
Returns immediately with job tracking information:

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

**Then monitor progress:**
```bash
# Check progress
curl http://localhost:3000/job/{JOB_ID}/progress

# Get results when completed
curl http://localhost:3000/job/{JOB_ID}/results
```

### Status Values

- **`"submitted"` / `"Submitted"`**: Successfully processed and saved with invoice number generated
- **`"not submitted"` / `"Not Submitted - Client Name Missing"`**: When client name is blank or empty
- **`"not submitted"` / `"Not Submitted - Tour Operator Not Found"`**: When tour operator is not found in system
- **`"error"` / `"Error - Client Creation Failed After Retry"`**: Technical error after aggressive retry attempts

**Note**: Clients are automatically created with retry logic, except when client name is blank or missing.

### Invoice Number Values

- **Actual number** (e.g., `"201425570"`): Successfully submitted with generated invoice
- **`"Not Generated"`**: Record was not submitted due to tour operator not found
- **`"Error"`**: Technical error prevented processing after retry attempts

---

## Automated Workflow

### The bot performs these steps for each record with complete freeze prevention:

1. **Login** to TPI Suitcase portal using secure credentials with iframe handling
2. **Navigate** to Quick Submit form with "I Understand" button detection
3. **Set Reservation Type**: All bookings are set to "Tour FIT" for consistency
4. **Fill Basic Info**: Reservation title and booking number with dynamic selector detection
5. **Clear Secondary Customers**: Remove previously selected secondary customers with readonly field detection
6. **Client Name Validation**: Check if client name is blank or empty and mark as "not submitted" immediately if invalid
7. **Enhanced Client Search**: Search by last name with exact name matching
8. **Universal Client Creation**: Create new clients automatically in two scenarios:
   - When no search results are found (empty results)
   - When search results exist but no exact name match is found
9. **Aggressive Client Creation Retry**: If client creation fails:
   - Page refresh to clear blocking elements and popups
   - Navigate back to Quick Submit form with full form state reset
   - Close all popups using Escape keys and popup cleanup functions
   - Retry client creation with completely fresh page state
   - Never results in "not submitted" - always creates missing clients (unless client name is blank)
10. **Form Restart**: F5-style page refresh and restart processing with completely clean DOM state
11. **Tour Operator Selection**: Multi-method clicking (Standard → Force → JavaScript) with dropdown verification
12. **Region Selection**: Popup-protected dropdown interaction with calendar interference prevention
13. **Date Processing**: Calendar-safe filling with popup prevention before each field
14. **Financial Data**: Robust price and commission filling with popup protection
15. **Form Verification**: Pre-submission validation with popup clearing
16. **Submit and Duplicate**: Popup-protected submission with confirmation popup handling
17. **Invoice Extraction**: Extract generated invoice number from updated form
18. **Status Tracking**: Record success/failure status with detailed information
19. **Webhook Delivery**: Automatically send all processed data to n8n webhook
20. **Form Reset**: Navigate to fresh form for next record
21. **Freeze Prevention**: Universal popup prevention, multiple click methods, and comprehensive error recovery

---

## Webhook Integration

### Automatic Data Transmission

The bot automatically sends ALL processed records to the configured webhook endpoint:

**Webhook URL**: `https://n8n.collectgreatstories.com/webhook/bookings-from-tpi`

**Method**: POST  
**Content-Type**: application/json  
**Payload**: Complete array of processed records with status and invoice information

### Real-Time Status Updates

The bot also sends comprehensive status updates throughout job processing:

**Status Webhook URL**: `https://n8n.collectgreatstories.com/webhook/tpi-status`

**Status Updates Include**:
- Job started with record count and batch configuration
- Login progress and completion with login count statistics
- Batch completion with progress percentages
- Browser crash detection and recovery attempts with crash statistics
- Job completion with final statistics including total logins and recoveries
- Webhook delivery confirmation
- Error notifications with detailed context and performance metrics

### Webhook Features

- **Automatic Delivery**: Sends data after all records are processed
- **Real-Time Status**: Continuous status updates throughout job lifecycle
- **Complete Data**: Includes all original fields plus status and invoice numbers
- **Error Handling**: Comprehensive logging of webhook delivery status
- **Timeout Protection**: 10-second timeout for webhook requests
- **Retry Logic**: Built-in error handling with detailed response logging
- **Crash Recovery Monitoring**: Real-time notifications when browser crashes are detected and recovered

---

## Deployment

### Using Docker

1.  **Build the Docker image:**
    ```bash
    docker build -t tpi-submit-bot .
    ```

2.  **Run the Docker container:**
    Make sure to pass the `.env` file to the container so it can access the credentials.
    ```bash
    docker run --env-file ./.env -p 3000:3000 -d tpi-submit-bot
    ```

### Deploying to Google Cloud Run

This bot is optimized for Google Cloud Run deployment:

1. **Build and push to Google Container Registry:**
   ```bash
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/tpi-submit-bot
   ```

2. **Deploy to Cloud Run:**
   ```bash
   gcloud run deploy tpi-submit-bot \
     --image gcr.io/YOUR_PROJECT_ID/tpi-submit-bot \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars USERNAME=your_email@example.com,PASSWORD=your_password
   ```

### Deploying to Coolify

Coolify can deploy this project directly from your Git repository.

1.  In your Coolify dashboard, create a new **Application** resource.
2.  Connect it to your Git provider and select the repository.
3.  Coolify should automatically detect the `Dockerfile` and select the **Dockerfile** build pack.
4.  In the **Environment Variables** tab, add your `USERNAME` and `PASSWORD` secrets.
5.  Deploy the application.

### Example `curl` Commands

#### Synchronous Processing:
```bash
curl -X POST -H "Content-Type: application/json" --data-binary "@sample.json" http://localhost:3000/trigger-bot
```

#### Asynchronous Processing (Recommended for large datasets):
```bash
curl -X POST -H "Content-Type: application/json" --data-binary "@sample.json" http://localhost:3000/trigger-bot-async
```

#### n8n Integration Example:
Use these settings in your n8n HTTP Request node:
- **Method**: POST
- **URL**: `http://localhost:3000/trigger-bot-async`
- **Authentication**: None
- **Send Headers**: Enable
- **Send Body**: Enable
- **Body Content Type**: JSON
- **Specify Body**: Using Fields Below
- **Body Parameters**: 
  - **Name**: `@sample.json`
  - **Value**: `{{ $json.rows }}` (Expression mode)

**Note**: The bot expects a JSON array containing objects with `rows` property.

**Correct n8n Configuration:**
1. **Method**: POST
2. **URL**: `http://localhost:3000/trigger-bot-async`
3. **Body Content Type**: JSON
4. **Specify Body**: Using Fields Below
5. **Body Parameters**: 
   - **Name**: `@sample.json`
   - **Value**: `[{"rows": {{ $json.rows }}}]` (Expression mode)

**Alternative for JSON body field:**
If using "Specify Body: JSON", use:
```json
[{"rows": {{ $json.rows }}}]
```

**Expected n8n request format:**
```json
[
  {
    "rows": [
      {
        "Agent Name": "Alex Harmeyer",
        "Client Name": "Donna Duquaine",
        "Trip Description": "Donna Duquaine | Location TBD | Month TBD",
        "Booking Number": "35090693",
        "Booking Status": "Cancelled",
        "Booking Description": "Palacio de los Duques Madrid",
        "Tour Operator": "Rate Hawk",
        "Booking Date": "06/02/2025",
        "Booking Start Date": "09/01/2025",
        "Booking End Date": "09/12/2025",
        "Package Price": "1,776.00",
        "Commission Projected": "177.56"
      }
    ]
  }
]
```

**Alternative curl command:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '[{"rows":[{"Agent Name":"Alex Harmeyer","Client Name":"Donna Duquaine","Trip Description":"Donna Duquaine | Location TBD | Month TBD","Booking Number":"35090693","Booking Status":"Cancelled","Booking Description":"Palacio de los Duques Madrid","Tour Operator":"Rate Hawk","Booking Date":"06/02/2025","Booking Start Date":"09/01/2025","Booking End Date":"09/12/2025","Package Price":"1,776.00","Commission Projected":"177.56"}]}]' \
  http://localhost:3000/trigger-bot-async
```

### New API Endpoints

#### Job Management
- `GET /job/:jobId` - Get detailed job status
- `GET /job/:jobId/progress` - Get progress updates (lightweight)
- `GET /job/:jobId/results` - Get final results when completed
- `POST /job/:jobId/cancel` - Cancel a running job
- `GET /jobs` - List all jobs

#### Health & Info
- `GET /health` - Health check endpoint
- `GET /` - API information and available endpoints

For complete async usage examples, see [ASYNC_USAGE.md](ASYNC_USAGE.md)

---

## Error Handling & Logging

### Real-Time Error Reporting

The bot implements **comprehensive error consolidation** with immediate reporting and job-level summaries:

#### Individual Record Error Tracking
- **Immediate Notification**: Each record processing error is sent immediately to the status webhook
- **Detailed Context**: Errors include client name, error message, timestamp, and processing context
- **Error Categories**: Page readiness, client creation, tour operator selection, form processing, etc.
- **Real-Time Updates**: Errors are reported as they occur during processing

#### Job-Level Error Consolidation
- **Summary Reports**: Complete error summary sent at job completion
- **Statistics Tracking**: Total errors, login counts, crash recoveries, and batch retries
- **Performance Metrics**: Processing duration and batch-level statistics
- **Comprehensive Logging**: All errors consolidated for troubleshooting and analysis

### Error Webhook Integration

#### Status Webhook (Error Reporting)
**URL**: `https://n8n.collectgreatstories.com/webhook/tpi-status`
- Individual record errors (real-time)
- Job completion summaries with consolidated errors
- Progress updates and status changes
- Crash recovery notifications

#### Results Webhook (Clean Data)
**URL**: `https://n8n.collectgreatstories.com/webhook/bookings-from-tpi`
- Only successfully processed records
- Clean data without error information
- Invoice numbers and submission status

### Client Search Scenarios

- **Client Name Missing**: Records marked as "Not Submitted - Client Name Missing" immediately without processing
- **Client Found**: Proceeds with full automation workflow
- **No Search Results**: Automatically creates new client with retry logic
- **Client Not in Results**: Creates new client if no exact match found
- **Client Creation Success**: Records success and continues processing
- **Client Creation Failure**: Reports detailed error with context

### Tour Operator Scenarios

- **Operator Found**: Continues with workflow
- **Operator Not Found**: Searches with scrolling, marks as "Not Submitted" if not found after multiple attempts
- **False Positive Prevention**: Enhanced matching prevents "Viator" from matching "Aviator Hotel" using word boundaries
- **Selection Errors**: Reports tour operator selection failures with specific error details

### Form Robustness Scenarios

- **Form Refresh**: Handles dynamic selector changes with fallback strategies
- **Field State Loss**: Preserves form data across retry attempts using form state management
- **Selector Changes**: Uses dynamic selector detection with multiple fallback patterns
- **Input Field Detection**: Identifies active input fields while avoiding disabled elements
- **Processing Errors**: Each form interaction error is tracked and reported

### Technical Error Handling

- **Network Issues**: Comprehensive timeout handling and retry logic with error reporting
- **Element Not Found**: Detailed error logging with specific element information sent to webhook
- **Form Submission Errors**: Popup handling with fallback mechanisms and error tracking
- **Webhook Delivery**: Error logging with response status and data
- **Browser Recovery**: Crash detection and recovery with form state preservation and notification
- **Batch Processing Errors**: Individual batch failures reported without stopping entire job

---

## File Structure

```
tpi-submit-bot/
├── bot.js              # Main automation logic with Playwright
├── index.js            # Express server with sync/async endpoints
├── jobManager.js       # Async job processing and queue management
├── package.json        # Dependencies (express, playwright, dotenv, axios, uuid)
├── Dockerfile          # Container configuration for deployment
├── docker-compose.yml  # Docker Compose for local testing
├── .dockerignore       # Docker build optimization
├── sample.json         # Example payload for testing
├── plan.md             # Complete project documentation and status
├── README.md           # This file
├── DEPLOYMENT.md       # Production deployment guide
├── ASYNC_USAGE.md      # Asynchronous processing usage guide
├── .env                # Environment variables (create manually)
├── .env.example        # Environment variables template
└── .gitignore          # Git ignore patterns
```

---

## Dependencies

- **express**: Web server framework
- **playwright**: Browser automation library
- **dotenv**: Environment variable management
- **axios**: HTTP client for webhook requests
- **uuid**: Unique identifier generation for job management

---

## Development and Testing

### Local Development

1. Start the server: `npm start`
2. Test with sample data: Use the provided `sample.json`
3. Monitor console logs for detailed automation steps
4. Check webhook delivery in n8n workflow

### Production Considerations

- Set `headless: true` in browser launch options for production
- Ensure adequate timeout values for slower networks
- Monitor webhook delivery success rates
- Implement health check endpoints for container orchestration

---

## Support and Troubleshooting

### Common Issues

1. **Login Failures**: Verify USERNAME and PASSWORD in `.env` file
2. **Client Name Issues**: Ensure client names are not blank or empty in input data
3. **Client Issues**: No longer an issue - clients are automatically created with aggressive retry logic (except when name is blank)
4. **Tour Operator Issues**: Check operator name spelling and availability in dropdown (only cause of "not submitted" besides blank client names)
5. **Webhook Failures**: Verify n8n endpoint is accessible and accepting requests
6. **Date Format Errors**: Ensure dates are in MM/DD/YYYY format
7. **Client Creation Retry**: If you see "Error - Client Creation Failed After Retry", check for browser/network issues

### Debugging

Enable detailed logging by running with `headless: false` during development to visually observe the automation process.

---

## Key Features for Large Datasets

### Perfect for High-Volume Processing
- **Asynchronous Processing**: No timeout issues on Coolify or other cloud platforms
- **Single Login**: Login once per job (not per batch) for maximum efficiency
- **Automatic Crash Recovery**: Browser crashes are automatically recovered with new login session
- **Real-Time Status Webhooks**: Comprehensive status updates sent to `https://n8n.collectgreatstories.com/webhook/tpi-status`
- **Batch Processing**: Processes records in configurable batches (default: 50 records)
- **Scalable Performance**: Handles hundreds to thousands of records efficiently
- **Real-time Monitoring**: Track progress with estimated completion times
- **Error Resilience**: Individual failures don't stop the entire job
- **Background Operation**: Submit job and check progress anytime

### Production Ready
- **Docker Optimized**: Includes Dockerfile, docker-compose.yml, and deployment guides
- **Security Hardened**: Non-root user, resource limits, and security configurations
- **Health Monitoring**: Built-in health checks and logging
- **Memory Efficient**: Batch processing prevents memory overflow
- **Cloud Platform Ready**: Designed for Coolify, Google Cloud Run, and similar platforms

---

**The TPI Suitcase Submission Bot provides complete end-to-end automation with both synchronous and asynchronous processing capabilities, comprehensive error handling, real-time progress tracking, automatic crash recovery, and dual webhook integration (data delivery + status updates) for seamless workflow integration.**
