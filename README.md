# TPI Suitcase Submission Bot

This project is a comprehensive Node.js bot designed to automate client booking submissions to the TPI Suitcase web portal. It runs as an Express server, exposing an API endpoint to receive booking data, and uses Playwright to perform advanced browser automation tasks with complete form processing and webhook integration.

## Features

- **API-Driven**: Triggered by a `POST` request, making it easy to integrate with services like n8n.
- **Secure Login**: Uses environment variables (`.env` file) to securely handle portal credentials.
- **Complete Form Automation**: 
  - Navigates to the "Quick Submit" form after login.
  - Determines "Reservation Title" (`Cruise FIT` or `Tour FIT`) based on booking details.
  - Fills reservation title, booking number, dates, pricing, and commission fields.
- **Advanced Client Search**: 
  - Uses the portal's search popup to find clients by last name.
  - Handles "no results found" scenarios with proper error messaging.
  - Selects the correct client from results table or closes popup if not found.
- **Smart Tour Operator Selection**:
  - Searches through tour operator dropdown with automatic scrolling.
  - Uses enhanced matching logic with exact matches and word boundaries to prevent false positives.
  - Handles cases where operator is not found in the system.
- **Regional and Date Processing**:
  - Automatically selects "United States" as destination region.
  - Formats and fills booking start and end dates.
  - Processes package prices and commission amounts.
- **Submit and Duplicate Workflow**:
  - Uses "Submit and Duplicate" button for form submission.
  - Handles confirmation popup with OK button.
  - Extracts generated invoice numbers from updated reservation titles.
- **Automatic Webhook Integration**:
  - Sends all processed data to configured n8n webhook endpoint.
  - Provides comprehensive error handling and logging.
- **Enhanced Status Tracking**: 
  - Returns detailed JSON response with status, submission state, and invoice numbers.
  - Tracks submitted, not submitted, and error states for each record.
- **Form Robustness & Dynamic Adaptation**:
  - Handles form refresh scenarios where selector IDs change dynamically.
  - Implements dynamic selector detection with multiple fallback strategies.
  - Preserves form state across retry attempts after form refresh.
  - Comprehensive retry logic with form state recovery.
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

Send a `POST` request to the `/trigger-bot` endpoint with a JSON payload. 

**Endpoint:** `POST /trigger-bot`

**Payload Format:**
The body must be a JSON array containing a single object with a `rows` key. The `rows` key must hold an array of client records with complete booking information.

**Required Fields per Record:**
- `Agent Name`: Name of the booking agent
- `Client Name`: Full name of the client (first and last name)
- `Trip Description`: Description of the trip (used to determine Cruise vs Tour FIT)
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

**Success Response:**
The API will return a JSON array with enhanced processing status for each record, including all original data plus status tracking and invoice numbers.

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

### Status Values

- **`"submitted"` / `"Submitted"`**: Successfully processed and saved with invoice number generated
- **`"not submitted"` / `"Not Submitted"`**: Client not found or tour operator not found in system
- **`"error"` / `"Error"`**: Technical error occurred during processing

### Invoice Number Values

- **Actual number** (e.g., `"201425570"`): Successfully submitted with generated invoice
- **`"Not Generated"`**: Record was not submitted due to client/operator not found
- **`"Error"`**: Technical error prevented invoice number extraction

---

## Automated Workflow

### The bot performs these steps for each record:

1. **Login** to TPI Suitcase portal using secure credentials
2. **Navigate** to Quick Submit form
3. **Determine Reservation Type**: Auto-detect "Cruise FIT" or "Tour FIT" based on trip description
4. **Fill Basic Info**: Reservation title and booking number
5. **Client Search**: Search by last name, handle no results or select matching client
6. **Tour Operator Selection**: Smart dropdown search with scrolling and enhanced matching logic
7. **Region Selection**: Automatically set destination to "United States" with dynamic input detection
8. **Date Processing**: Fill formatted start and end dates
9. **Financial Data**: Enter package price and expected commission
10. **Submit and Duplicate**: Click submit button and handle confirmation popup
11. **Invoice Extraction**: Extract generated invoice number from updated form
12. **Status Tracking**: Record success/failure status with detailed information
13. **Webhook Delivery**: Automatically send all processed data to n8n webhook
14. **Form Reset**: Navigate to fresh form for next record
15. **Robustness Features**: Dynamic selector detection, form state preservation, and retry logic handle form refresh scenarios

---

## Webhook Integration

### Automatic Data Transmission

The bot automatically sends ALL processed records to the configured webhook endpoint:

**Webhook URL**: `https://n8n.collectgreatstories.com/webhook/bookings-from-tpi`

**Method**: POST  
**Content-Type**: application/json  
**Payload**: Complete array of processed records with status and invoice information

### Webhook Features

- **Automatic Delivery**: Sends data after all records are processed
- **Complete Data**: Includes all original fields plus status and invoice numbers
- **Error Handling**: Comprehensive logging of webhook delivery status
- **Timeout Protection**: 10-second timeout for webhook requests
- **Retry Logic**: Built-in error handling with detailed response logging

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

### Example `curl` Command

```bash
curl -X POST -H "Content-Type: application/json" --data-binary "@sample.json" http://localhost:3000/trigger-bot
```

---

## Error Handling

### Client Search Scenarios

- **Client Found**: Proceeds with full automation workflow
- **No Search Results**: Detects "Sorry, we did not find any results" message and marks as "Not Submitted"
- **Client Not in Results**: Searches through results table, marks as "Not Submitted" if no match

### Tour Operator Scenarios

- **Operator Found**: Continues with workflow
- **Operator Not Found**: Searches with scrolling, marks as "Not Submitted" if not found after multiple attempts
- **False Positive Prevention**: Enhanced matching prevents "Viator" from matching "Aviator Hotel" using word boundaries

### Form Robustness Scenarios

- **Form Refresh**: Handles dynamic selector changes with fallback strategies
- **Field State Loss**: Preserves form data across retry attempts using form state management
- **Selector Changes**: Uses dynamic selector detection with multiple fallback patterns
- **Input Field Detection**: Identifies active input fields while avoiding disabled elements

### Technical Error Handling

- **Network Issues**: Comprehensive timeout handling and retry logic
- **Element Not Found**: Detailed error logging with specific element information  
- **Form Submission Errors**: Popup handling with fallback mechanisms
- **Webhook Delivery**: Error logging with response status and data
- **Browser Recovery**: Crash detection and recovery with form state preservation

---

## File Structure

```
tpi-submit-bot/
├── bot.js              # Main automation logic with Playwright
├── index.js            # Express server API endpoint
├── package.json        # Dependencies (express, playwright, dotenv, axios)
├── Dockerfile          # Container configuration for deployment
├── sample.json         # Example payload for testing
├── plan.md             # Complete project documentation and status
├── README.md           # This file
├── .env                # Environment variables (create manually)
└── .gitignore          # Git ignore patterns
```

---

## Dependencies

- **express**: Web server framework
- **playwright**: Browser automation library
- **dotenv**: Environment variable management
- **axios**: HTTP client for webhook requests

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
2. **Client Not Found**: Ensure client exists in TPI Suitcase system with correct spelling
3. **Tour Operator Issues**: Check operator name spelling and availability in dropdown
4. **Webhook Failures**: Verify n8n endpoint is accessible and accepting requests
5. **Date Format Errors**: Ensure dates are in MM/DD/YYYY format

### Debugging

Enable detailed logging by running with `headless: false` during development to visually observe the automation process.

---

**The TPI Suitcase Submission Bot provides complete end-to-end automation with comprehensive error handling, status tracking, and automatic webhook integration for seamless n8n workflow integration.**
