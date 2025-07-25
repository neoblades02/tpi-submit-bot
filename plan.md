# Project Plan: TPI Suitcase Bot

This document outlines the development plan for the TPI Suitcase automation bot with both synchronous and asynchronous processing capabilities.

## Project Structure

- **`index.js`**: Express server with multiple endpoints for sync/async processing
- **`bot.js`**: Core Playwright automation logic for TPI Suitcase portal
- **`jobManager.js`**: Asynchronous job processing and queue management system
- **`package.json`**: Project dependencies (express, playwright, dotenv, axios, uuid)
- **`Dockerfile`**: Production-ready container configuration
- **`docker-compose.yml`**: Local development and testing environment
- **`.dockerignore`**: Docker build optimization
- **`sample.json`**: Example payload format for testing
- **`README.md`**: Complete setup and usage documentation
- **`DEPLOYMENT.md`**: Production deployment guide
- **`ASYNC_USAGE.md`**: Asynchronous processing usage guide
- **`.env.example`**: Environment variables template

## Core Logic & Features

### Processing Modes
- **Synchronous Processing**: `/trigger-bot` endpoint for small datasets (<50 records)
- **Asynchronous Processing**: `/trigger-bot-async` endpoint for large datasets (100+ records)
- **Job Management**: Real-time progress tracking, job cancellation, and result retrieval
- **Batch Processing**: Configurable batch sizes to prevent memory issues and platform timeouts (default: 50 records per batch)

### Technical Foundation
- **Browser Automation**: Uses Playwright with Chromium browser (headless: true for production) 
- **Secure Credentials**: Loads credentials from a `.env` file for security (USERNAME and PASSWORD)
- **Production Ready**: Security-hardened browser configuration with resource limits
- **Cloud Platform Optimized**: Perfect for Coolify, Google Cloud Run, and similar platforms

### Form Processing
- **Reservation Type**: All bookings are processed as "Tour FIT" for consistency
- **Advanced Form Processing**: For each record received, the bot performs comprehensive form automation:

### Client Search & Handling (`bot.js`)
1. **Client Name Validation**: Immediately marks records as "Not Submitted - Client Name Missing" if client name is blank or empty
2. **Secondary Customers Field Clearing**: Automatically clears any previously selected secondary customers to prevent confusion between main and secondary customer fields
3. **Smart Client Search**: Searches by last name using the search popup
4. **New Client Creation**: When client not found, creates new client with first name, last name, and "No Middle Name" checkbox, then performs F5-style page refresh
5. **Client Search Restart**: After creating a new client, performs complete page reload (F5) and restarts entire processing sequence for the same record with clean DOM
6. **Client Matching**: Matches clients by first name and last name from search results
7. **Close Button**: Uses close icon (`span.popupClose`) when no results found
8. **Done Button**: Clicks "Done" button (`#zc-adv-btn-finish`) after successful client selection
9. **Critical Field Check**: After successful client selection, performs basic validation of reservation title and booking number to ensure they weren't cleared

### Tour Operator Selection (`bot.js`)
1. **Dropdown Interaction**: Clicks tour operator dropdown (`span.select2-chosen#select2-chosen-18`)
2. **Progressive Word Search**: Implements intelligent search strategy starting with first word, then 2 words, continuing until match found
3. **Dynamic Search Input**: Uses `findDynamicSelector()` to locate vendor input field with multiple fallback strategies
4. **Results Validation**: Checks dropdown results in `ul#select2-results-18` using strict matching algorithms
5. **Strict All-Words Matching**: 
   - **Priority 1**: Exact matches (including text without parentheses)
   - **Priority 2**: All-words matches - EVERY word from tour operator must be present as complete words
   - **Priority 3**: Phrase matches - exact phrase found within dropdown option
   - **Rejection Logic**: Eliminates partial matches that could cause incorrect selections
6. **Enhanced Word Boundaries**: Uses regex word boundaries (`\b`) to ensure complete word matches, preventing false positives
7. **False Positive Prevention**: 
   - "Hilton Fast Pay" will match "Hilton Fast Pay Hotels" ✅
   - "Hilton Fast Pay" will NOT match "Hilton Hotels & Resorts" ❌ (missing "Fast" and "Pay")
   - "Viator" will NOT match "Aviator Hotel" ❌ (word boundaries prevent substring matches)
8. **Strict Fallback**: Marks as "Not Submitted - Tour Operator Not Found" if no dropdown option contains ALL required words

### Regional Settings (`bot.js`)
1. **Region Selection**: Automatically selects "United States" as destination region
2. **Dropdown Navigation**: Clicks region dropdown (`span.select2-chosen#select2-chosen-2`)
3. **Text Input**: Types "United States" in the destination input field
4. **Selection Confirmation**: Clicks on the United States option from dropdown

### Form Field Filling Sequence with Robustness (`bot.js`)
**Sequential field filling occurs ONCE in proper order after tour operator and region selection:**
1. **Start Date**: Fills booking start date with proper MM/DD/YYYY formatting using direct `page.fill()` method (no clicking to prevent calendar popup)
2. **End Date**: Fills booking end date with proper MM/DD/YYYY formatting using direct `page.fill()` method (no clicking to prevent calendar popup)
3. **Package Price**: Fills total price field with reliable field clearing, removes commas from currency values, and validates input
4. **Expected Commission**: Fills commission field with reliable field clearing and validates input
5. **Form Submission**: Immediately proceeds to "Submit and Duplicate" button after all fields are filled
6. **Field Validation**: Each field is validated after filling to ensure data persists and retries up to 3 times if validation fails
7. **Error Recovery**: Fallback error handling ensures form submission proceeds even if individual fields fail
8. **Calendar Popup Management**: Automatically detects and closes calendar popups before each field operation
9. **Dynamic Field Detection**: Uses `findDynamicSelector()` for all form fields to handle changing selectors after refresh
10. **Form State Preservation**: Preserves form data across retry attempts using `formState` object

### Form Submission & Status Tracking with Enhanced Reliability
- **Human-like Submit Process**: Uses natural delays and timing before clicking "Submit and Duplicate" button
- **Intelligent Popup Handling**: Waits for confirmation popup with extended timeout and handles various scenarios
- **Submission Validation**: Verifies form submission success through multiple methods (popup confirmation, URL changes)
- **Retry Logic**: Automatically retries submission up to 3 times if initial attempt fails
- **Invoice Number Extraction**: Extracts invoice number from updated reservation title (e.g., "Tour FIT - Invoice # 201425570 - Copy")
- **Dual Webhook Integration**: 
  - **Results Webhook**: Sends clean processed data to `https://n8n.collectgreatstories.com/webhook/bookings-from-tpi`
  - **Status Webhook**: Sends real-time error reports and job summaries to `https://n8n.collectgreatstories.com/webhook/tpi-status`
- **Real-Time Error Consolidation**: Individual record errors sent immediately to status webhook during processing
- **Job Completion Error Summary**: Complete error summary with statistics sent to status webhook at job completion
- **Enhanced Status Tracking**: Returns detailed status for each record:
  - `Submitted`: Successfully processed and saved with invoice number
  - `Not Submitted`: Client not found or tour operator not found
  - `Error`: Technical error during processing
- **JSON Response**: Adds `Submitted`, `InvoiceNumber` fields and posts complete data to results webhook
- **Comprehensive Error Reporting**: All errors tracked with client name, message, timestamp, context, and batch information

## Technical Implementation Details

### Browser Crash & Timeout Recovery (`bot.js`)
- **Crash Detection**: Monitors for browser/page crash error messages including "Target page, context or browser has been closed"
- **Timeout Detection**: Monitors for timeout error messages including "Timeout exceeded", "waiting for locator", "intercepts pointer events"
- **Timeout Recovery**: For unresponsive browsers, attempts to clear blocking elements (calendar popups), sends escape keys, then refreshes if needed
- **Crash Recovery**: For crashed browsers, attempts to refresh page or navigate back to Quick Submit form
- **Retry Logic**: Up to 3 attempts per record with full recovery between attempts
- **State Verification**: Ensures form accessibility after recovery before retrying record processing
- **Graceful Degradation**: Falls back to error status if recovery fails after maximum attempts

### Login Process (`bot.js`)
- Navigates to `https://my.tpisuitcase.com/`
- Waits for iframe with ID `signinFrame`
- Fills username and clicks "Next"
- Fills password and clicks "Sign In"
- Waits for redirect to `https://my.tpisuitcase.com/#Page:CORE`

### Enhanced Form Automation (`bot.js`)
- Processes data from `data[0].rows` array
- **Step-by-step processing for each record:**
  1. **Reservation Title**: All bookings are set to 'Tour FIT' for consistency
  2. **Booking Number**: Fills reservation number field
  3. **Client Search**: Advanced search with multiple fallback scenarios
  3a. **Critical Field Check**: After client selection, basic validation of reservation title and booking number
  4. **Tour Operator Selection**: Smart dropdown search with scrolling capability
  5. **Region Selection**: Automatic United States selection
  6. **Date Fields**: Start and end date population with format validation
  7. **Financial Data**: Package price and commission fields
  8. **Form Submission**: Submit and Duplicate button click with popup handling
  9. **Invoice Extraction**: Extract generated invoice number from reservation title
  10. **Webhook Transmission**: Send complete data to n8n webhook
  11. **Form Reset**: Page refresh to ensure completely clean form state for next record
- **Browser Crash & Timeout Recovery**: Automatically detects browser crashes and timeouts, recovers by clearing blocking elements and refreshing the page, then retries the current record (up to 3 attempts per record)

### Helper Functions (`bot.js`)
- **`clearSecondaryCustomersField()`**: Clears any previously selected secondary customers to prevent form confusion
- **`createNewClient()`**: Creates new client when not found in search results, handles dropdown interaction, form filling, and popup management
- **`searchAndSelectTourOperator()`**: Advanced tour operator search with scrolling and enhanced matching logic
- **`formatDate()`**: Date formatting utility for MM/DD/YYYY format
- **`sendToWebhook()`**: Automatically sends processed data to n8n webhook
- **`validateCriticalFieldsAfterClientSearch()`**: Basic validation of critical fields (title and booking number) after client search
- **`isBrowserCrashed()`**: Detects browser crash errors by analyzing error messages
- **`isBrowserTimeout()`**: Detects browser timeout/unresponsive errors by analyzing error messages
- **`recoverFromBrowserIssue()`**: Recovers from browser crashes and timeouts by clearing blocking elements, refreshing page, and verifying form accessibility
- **`findDynamicSelector()`**: Dynamic selector detection with multiple fallback strategies for form fields
- **`fillAndValidateRegion()`**: Enhanced region filling with dynamic input field detection
- **`verifyFormState()`**: Validates form data integrity before submission
- **Error Handling**: Comprehensive try-catch blocks with detailed logging and crash recovery

### API Server (`index.js`)
- Express server on configurable port (default: 3000)
- **Synchronous Endpoint**: `/trigger-bot` - Returns immediately with complete results
- **Asynchronous Endpoint**: `/trigger-bot-async` - Returns job ID immediately, processes in background
- **Job Management**: Multiple endpoints for job tracking and control
- **Health Monitoring**: Built-in health check and API information endpoints
- Validates incoming JSON array format
- Enhanced error handling with detailed status codes

## Task Checklist

### Phase 1: Setup & Core Logic (Completed)

- [x] Initialize Node.js project (`package.json`)
- [x] Install dependencies (`express`, `playwright`, `dotenv`)
- [x] Create project structure (`index.js`, `bot.js`, `.gitignore`, `Dockerfile`)
- [x] Implement secure login logic with iframe handling
- [x] Implement navigation to the "Quick Submit" form
- [x] Set up API server in `index.js` to receive data

### Phase 2: Basic Form Automation (Completed)

- [x] Implement logic to loop through each record in `data[0].rows`
- [x] Add logic to fill Reservation Title and Booking Number
- [x] Implement basic client search-and-select popup workflow
- [x] Add logic to click the final 'Save' button
- [x] Implement basic status tracking and error handling
- [x] Add logic to reload the form between submissions

### Phase 3: Advanced Form Automation (Completed)

- [x] **Enhanced Client Search Handling**
  - [x] Detect "no results" message (`#zc-advanced-search-table-nodata`)
  - [x] Handle close button click (`i.fa.fa-close`) for no results
  - [x] Implement "Done" button click after client selection
  - [x] Add "Submitted" field to JSON response

- [x] **Tour Operator Selection**
  - [x] Implement dropdown interaction (`span.select2-chosen#select2-chosen-18`)
  - [x] Add scrolling functionality for long operator lists
  - [x] Implement partial matching for operator names
  - [x] Handle operator not found scenarios

- [x] **Regional Settings**
  - [x] Implement region dropdown selection (`span.select2-chosen#select2-chosen-2`)
  - [x] Add United States auto-selection
  - [x] Handle region input field interaction

- [x] **Date & Financial Fields**
  - [x] Add start date field handling (`#Start_Date`)
  - [x] Add end date field handling (`#End_Date`)
  - [x] Implement package price field (`#zc-Total_Price`)
  - [x] Add commission field (`#zc-Expected_Commission`)
  - [x] Create date formatting utility function

- [x] **Enhanced Status Tracking**
  - [x] Implement three-state status system (Submitted/Not Submitted/Error)
  - [x] Add detailed console logging for debugging
  - [x] Improve error handling and recovery

### Phase 4: Finalization & Deployment (Completed)

- [x] Update `README.md` with comprehensive setup instructions
- [x] Update `sample.json` to include all required fields
- [x] Build and test the Docker image for deployment
- [x] Document the enhanced automation process
- [x] Update plan.md with complete feature documentation

### Phase 5: Asynchronous Processing & Production Readiness (Completed)

- [x] **Asynchronous Job Processing System**
  - [x] Implement JobManager class with queue management
  - [x] Add job status tracking and progress reporting
  - [x] Create batch processing for large datasets
  - [x] Add job cancellation and recovery mechanisms

- [x] **Enhanced API Endpoints**
  - [x] Add `/trigger-bot-async` endpoint for large datasets
  - [x] Implement job status tracking endpoints
  - [x] Add progress monitoring endpoints
  - [x] Create job results retrieval endpoints

- [x] **Production Deployment**
  - [x] Security-hardened browser configuration
  - [x] Docker production optimization
  - [x] Resource limits and memory management
  - [x] Health checks and monitoring

- [x] **Documentation & Guides**
  - [x] Complete async usage documentation
  - [x] Production deployment guide
  - [x] Docker and docker-compose configurations
  - [x] Environment configuration templates

- [x] **Platform Optimization**
  - [x] Coolify deployment readiness
  - [x] Timeout prevention for cloud platforms
  - [x] Batch processing for memory efficiency
  - [x] Background job processing

### Phase 6: Error Consolidation & Real-Time Monitoring (Completed)

- [x] **Comprehensive Error Consolidation System**
  - [x] Implement real-time individual record error reporting
  - [x] Add immediate error webhook notifications during processing
  - [x] Create job completion error summary with consolidated errors
  - [x] Integrate error statistics with performance metrics

- [x] **Dual Webhook Architecture**
  - [x] Status webhook for error reporting and job monitoring
  - [x] Results webhook for clean data delivery
  - [x] Standardized JSON schema for consistent webhook payloads
  - [x] Real-time progress and error status updates

- [x] **Error Tracking Implementation**
  - [x] Individual record error tracking with detailed context
  - [x] Error categorization (page readiness, client creation, tour operator selection)
  - [x] Batch-level error tracking and reporting
  - [x] Complete error consolidation in job summaries

- [x] **Documentation Updates**
  - [x] Update README.md with error consolidation features
  - [x] Enhance ASYNC_USAGE.md with error handling documentation
  - [x] Expand WEBHOOK_SCHEMA.md with error reporting schema
  - [x] Update plan.md with completed error consolidation implementation

- [x] **Code Quality & Verification**
  - [x] Fix missing variable declarations in error handling functions
  - [x] Implement comprehensive error webhook integration
  - [x] Complete code review and syntax validation
  - [x] Ensure production-ready error consolidation system

## Current Status

The TPI Suitcase Bot is fully implemented with comprehensive automation capabilities:

### Core Features
- ✅ Express API server with multiple endpoints
- ✅ **Synchronous Processing**: `/trigger-bot` for small datasets
- ✅ **Asynchronous Processing**: `/trigger-bot-async` for large datasets
- ✅ **Job Management System**: Real-time progress tracking and job control
- ✅ **Performance Statistics**: Login count, crash recovery, and batch retry tracking
- ✅ **Batch Processing**: Configurable batch sizes for memory efficiency
- ✅ Advanced Playwright automation for TPI Suitcase portal
- ✅ Secure login with iframe handling

### Form Automation
- ✅ **Consistent Reservation Type**: All bookings set to "Tour FIT"
- ✅ **Enhanced client search with no-results handling**
- ✅ **Advanced tour operator selection with scrolling**
- ✅ **Automatic region selection (United States)**
- ✅ **Complete date field automation**
- ✅ **Financial data handling (price & commission)**
- ✅ **Submit and Duplicate workflow with popup handling**
- ✅ **Invoice number extraction and tracking**

### Production Features
- ✅ **Browser crash and timeout detection and recovery system**
- ✅ **Performance monitoring with login count and crash recovery statistics**
- ✅ **Security-hardened browser configuration**
- ✅ **Resource management and memory limits**
- ✅ **Health monitoring and API information endpoints**
- ✅ **Dual webhook integration**: Results and status webhooks
- ✅ **Real-time error consolidation and reporting**
- ✅ **Individual record error tracking with immediate notifications**
- ✅ **Job completion error summaries with comprehensive statistics**
- ✅ **Comprehensive status tracking with "Submitted" and "InvoiceNumber" fields**
- ✅ **Real-time status webhooks with performance metrics**
- ✅ **Docker containerization with production optimization**
- ✅ **Coolify deployment readiness**
- ✅ **Complete documentation and deployment guides**

## Form Fields Automated

1. **Reservation Title** - All bookings set to "Tour FIT"
2. **Booking Number** - From data input
3. **Client Selection** - Advanced search with fallback handling
4. **Tour Operator** - Smart dropdown search with scrolling
5. **Destination Region** - Auto-set to United States
6. **Start Date** - Formatted booking start date
7. **End Date** - Formatted booking end date  
8. **Total Price** - Package price from data
9. **Expected Commission** - Commission projected from data
10. **Invoice Number** - Auto-extracted after submission

## Response Format

Each processed record returns with enhanced status information:

```json
{
  "Agent Name": "Alex Harmeyer",
  "Client Name": "Donna Duquaine", 
  "Booking Number": "E2495497481",
  "Tour Operator": "Allianz Travel Insurance",
  "Package Price": "848.00",
  "Commission Projected": "237.44",
  "status": "submitted",
  "Submitted": "Submitted",
  "InvoiceNumber": "201425570"
}
```

**Status Values:**
- `"submitted"` / `"Submitted"` - Successfully processed and saved (InvoiceNumber: actual number)
- `"not submitted"` / `"Not Submitted"` - Client or operator not found (InvoiceNumber: "Not Generated")
- `"error"` / `"Error"` - Technical error during processing (InvoiceNumber: "Error")

## Recent Improvements

### Strict Tour Operator Matching & Error Consolidation System (Latest Update)
- ✅ **Strict All-Words Matching**: Tour operator selection now requires ALL words to be present in dropdown option
- ✅ **False Positive Prevention**: Eliminates incorrect matches (e.g., "Hilton Fast Pay" won't select "Hilton Hotels & Resorts")
- ✅ **Word Boundary Protection**: Uses regex word boundaries to prevent substring false matches
- ✅ **Accurate Selection Logic**: Prioritizes exact matches, then all-words matches, then phrase matches
- ✅ **Client Name Validation**: Records with blank or empty client names marked as "Not Submitted - Client Name Missing" immediately
- ✅ **Fast Processing**: Invalid records skipped without browser automation to prevent timeouts and crashes
- ✅ **Real-Time Error Reporting**: Individual record errors sent immediately to status webhook during processing
- ✅ **Dual Webhook Architecture**: Status webhook for errors and monitoring, results webhook for all records with status
- ✅ **Comprehensive Error Tracking**: Client name, message, timestamp, context, and batch information for each error
- ✅ **Job Completion Error Summary**: Consolidated error report with statistics sent at job completion
- ✅ **Error Categorization**: Client name validation, page readiness, client creation, tour operator selection, form processing errors
- ✅ **Performance Integration**: Error count, login count, crash recoveries integrated in job summaries
- ✅ **Code Quality Improvements**: Fixed missing variable declarations and implemented comprehensive error handling
- ✅ **Documentation Updates**: Complete documentation updates across all files

### F5-Style Page Refresh Enhancement (Previous Update)
- ✅ **True Browser Refresh**: Replaced `page.goto()` with `page.reload()` for authentic F5-style page refresh after client creation
- ✅ **Complete DOM Reset**: Ensures all malformed DOM structures and JavaScript states are completely cleared
- ✅ **Network Idle Wait**: Uses `waitUntil: 'networkidle'` to ensure page is fully loaded before proceeding
- ✅ **Form Navigation**: Automatically navigates back to Quick Submit form after F5 refresh
- ✅ **Tour Operator Fix**: Resolves tour operator search freezing issues caused by malformed DOM after client creation
- ✅ **Fresh Browser Environment**: Provides completely clean browser state for continued processing

### Complete Interference Protection System (Previous Update)
- ✅ **Universal Popup Prevention**: Added `closeCalendarPopupIfOpen()` calls before all critical form interactions
- ✅ **Tour Operator Selection Enhancement**: Multiple click methods (Standard → Force → JavaScript) with dropdown closure verification
- ✅ **Client Creation Freeze Prevention**: Aggressive customer dropdown closure immediately after "Add New Customer" click
- ✅ **Region Selection Protection**: Popup-protected dropdown interaction to prevent calendar interference
- ✅ **Form Submission Safety**: Pre-submission popup clearing to ensure clean submit button access
- ✅ **Form Verification Protection**: Popup clearing before form state verification to prevent reading interference
- ✅ **Comprehensive Error Recovery**: Each step now has multiple fallback methods and proper error handling

### Client Creation Robustness Enhancement (Previous Update)
- ✅ **Dropdown Interference Prevention**: Force-closes customer dropdown and all masks immediately after "Add New Customer" click
- ✅ **Multiple Popup Closure Methods**: Uses DOM manipulation, Escape keys, and element removal for complete cleanup
- ✅ **Targeted Post-Creation Cleanup**: Only closes relevant popups while preserving normal form functionality
- ✅ **Form Flow Continuity**: Ensures seamless continuation from client creation to tour operator selection
- ✅ **Readonly Field Handling**: Proper detection and handling of readonly secondary customers field after client creation

### Secondary Customers Field Management (Previous Update)
- ✅ **Secondary Customers Field Clearing**: Added `clearSecondaryCustomersField()` function to prevent bot confusion between main and secondary customer fields
- ✅ **Multi-Select Dropdown Handling**: Properly handles Select2 multi-select containers with selected item removal
- ✅ **Form Field Isolation**: Ensures main customer field is used for client search instead of secondary customers field
- ✅ **Clean Form State**: Clears both selected items and input text from secondary customers field before processing each record
- ✅ **Readonly Input Detection**: Checks field editability before attempting to clear readonly inputs

### New Client Creation Enhancement (Earlier Update)
- ✅ **Automatic Client Creation**: When client not found in search, creates new client with first name, last name, and "No Middle Name" checkbox
- ✅ **F5-Style Page Refresh**: After creating new client, performs complete page reload (F5) to ensure completely clean DOM state
- ✅ **Form Processing Restart**: After F5 refresh, navigates back to Quick Submit form and restarts entire processing sequence for the same record
- ✅ **Loop Structure Fix**: Properly resets processing attempt counter to restart from beginning after client creation
- ✅ **Popup Management**: Comprehensive popup and overlay handling during client creation process

### Form Robustness Enhancement (Earlier Update)
- ✅ **Dynamic Selector Detection**: Implemented `findDynamicSelector()` function with multiple fallback strategies for form fields
- ✅ **Form State Preservation**: Added `formState` object to preserve data across retry attempts after form refresh
- ✅ **Enhanced Tour Operator Matching**: Improved matching logic with exact matches, word boundaries, and regex patterns
- ✅ **Retry Logic with Recovery**: Comprehensive retry system that handles form refresh and selector changes
- ✅ **Field Validation**: Added `verifyFormState()` function to validate form data before submission
- ✅ **Enhanced Input Detection**: Improved vendor and destination input field detection to avoid disabled elements

### Form Reset Strategy (Earlier Update)
- ✅ **Eliminated Form Field Clearing Issues**: Replaced individual field clearing with full page refresh
- ✅ **Prevented Browser Freeze**: Removed problematic selector-based clearing that caused browser unresponsiveness
- ✅ **Consistent Fresh State**: Each record now starts with a completely clean form (same as first record)
- ✅ **Simplified Logic**: No need to validate individual field selectors or handle dropdown resets
- ✅ **Improved Reliability**: Form refresh ensures all elements are in their initial state

## Complete Freeze Prevention Architecture

### **Protection Mechanisms Applied to Every Step:**
1. **Calendar Popup Prevention**: `closeCalendarPopupIfOpen()` called before critical interactions
2. **Multiple Click Approaches**: Standard → Force → JavaScript click methods for maximum reliability
3. **Dropdown State Verification**: Confirms proper closure after selections to prevent interference
4. **Aggressive Cleanup**: Force-closes interfering dropdowns and masks without affecting other functionality
5. **Targeted Escape Keys**: Specific popup closure that preserves normal form element functionality
6. **Dynamic Selector Detection**: Handles form refresh scenarios and changing element IDs
7. **Error Recovery**: Comprehensive retry logic with graceful degradation for all operations

### **Freeze-Resistant Steps:**
- ✅ **Login & Navigation**: Robust iframe handling and "I Understand" button detection
- ✅ **Secondary Customers Clearing**: Comprehensive popup management with readonly field detection
- ✅ **Client Search & Selection**: Multiple fallback popup closure methods
- ✅ **Client Creation**: Aggressive dropdown closure and complete popup cleanup
- ✅ **Tour Operator Selection**: Multi-method clicking with dropdown verification and closure
- ✅ **Region Selection**: Popup-protected dropdown interaction
- ✅ **Date Field Filling**: Calendar-safe filling with popup prevention
- ✅ **Price Field Filling**: Uses robust filling function with popup protection
- ✅ **Form State Verification**: Popup clearing before field validation
- ✅ **Form Submission**: Popup-protected submission process
- ✅ **Form Refresh**: Clean state preparation for next record

**Robustness Strategy:**
- **Challenge**: Popup interference causing form freezing, especially after client creation
- **Solution**: Universal popup prevention combined with aggressive cleanup and multiple interaction methods
- **Benefit**: Bot can handle any popup interference scenario without freezing at any step

## Latest Updates

### Enhanced Client Creation Logic (Latest Update)
- ✅ **Universal Client Creation**: Bot now creates new clients in both scenarios:
  - When no search results are found (empty results)
  - When search results exist but no exact name match is found (e.g., "Mikayla Clark" not found among other "Clark" clients)
- ✅ **Improved Client Handling**: Eliminates "Not Submitted - Client Not Found" errors by automatically creating missing clients
- ✅ **Exact Name Matching**: Only selects clients when first name AND last name match exactly
- ✅ **Aggressive Client Creation Retry Logic**: When client creation fails:
  - Page refresh to clear blocking elements and popups
  - Navigate back to Quick Submit form
  - Close all popups with Escape keys and popup cleanup
  - Retry client creation with fresh page state
  - F5 refresh after successful creation and restart entire form processing
  - Only fails with "Error - Client Creation Failed After Retry" if all attempts fail
- ✅ **Proper Status Classification**: 
  - Clients: Always created automatically with retry logic (never "not submitted")
  - Tour Operators: "Not Submitted - Tour Operator Not Found" when not found in system
  - Client Creation Failures: "Error - Client Creation Failed After Retry" (only after aggressive retry attempts)
- ✅ **Seamless Form Restart**: After client creation, performs F5 refresh and restarts processing with clean DOM state
- ✅ **Complete Documentation Update**: All documentation reflects new client creation behavior and status messages

### Single Login Architecture & Crash Recovery (Recent Update)
- ✅ **Single Login Per Job**: Reduced login frequency from 141 logins (one per batch) to 1 login per entire job for maximum efficiency
- ✅ **Session Reuse**: Browser session is created once and reused across all batches within a job
- ✅ **Automatic Browser Crash Recovery**: Detects browser crashes and automatically recreates sessions to continue processing
- ✅ **Session Recreation**: When crashes occur, closes the crashed browser and creates a new login session seamlessly
- ✅ **Batch-Level Recovery**: Automatically retries failed batches with new sessions without losing progress
- ✅ **Performance Optimization**: Dramatically reduces processing time and resource usage

### Real-Time Status Webhook Integration (Latest Update)
- ✅ **Comprehensive Status Updates**: Webhook integration to `https://n8n.collectgreatstories.com/webhook/tpi-status`
- ✅ **Job Lifecycle Tracking**: Status updates for job start, login, batch completion, completion, and failures
- ✅ **Performance Statistics**: Real-time tracking of login count, crash recoveries, and batch retries
- ✅ **Crash Recovery Monitoring**: Real-time notifications when crashes are detected and recovery is initiated
- ✅ **Progress Notifications**: Detailed progress updates including batch completion and estimated duration
- ✅ **Error Reporting**: Immediate notification of job failures with error details
- ✅ **Webhook Delivery Confirmation**: Status updates confirming successful webhook delivery to n8n

### Tour Operator Search Enhancement (Recent Update)
- ✅ **Priority-Based Matching**: Implemented progressive word matching system for better tour operator selection
- ✅ **Exact Match Priority**: Prioritizes exact matches over partial matches to prevent false positives
- ✅ **All Words Matching**: Ensures all words in tour operator name are matched for accurate selection
- ✅ **Word Boundary Detection**: Prevents "Tours 4 The World" from matching when searching for "Tours by Locals"

### Tour FIT Consistency (Previous Update)
- ✅ **Reservation Type Standardization**: All bookings now consistently use "Tour FIT" instead of dynamic detection
- ✅ **Simplified Logic**: Removed cruise detection logic for consistent processing
- ✅ **Code Cleanup**: Streamlined reservation title setting for better reliability

### Asynchronous Processing System (Previous Update)
- ✅ **Job Queue Management**: Added JobManager class for background processing
- ✅ **Progress Tracking**: Real-time progress updates with estimated completion times
- ✅ **Batch Processing**: Configurable batch sizes (default: 50 records per batch)
- ✅ **Job Control**: Cancel, monitor, and retrieve results for background jobs
- ✅ **Timeout Prevention**: Perfect solution for Coolify and cloud platform timeouts

### Large Dataset Optimization (Previous Update)
- ✅ **High-Volume Support**: Optimized for large datasets with hundreds to thousands of records
- ✅ **Memory Management**: Batch processing prevents memory overflow
- ✅ **Error Isolation**: Individual record failures don't stop entire job
- ✅ **Background Processing**: Jobs run completely independent of HTTP requests

**Production Ready:** Bot is now freeze-resistant, timeout-proof, crash-resilient, and ready for deployment to production environments (Coolify, Google Cloud Run, etc.) with comprehensive real-time monitoring.
