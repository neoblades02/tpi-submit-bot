# Project Plan: TPI Suitcase Bot

This document outlines the development plan for the TPI Suitcase automation bot.

## Project Structure

- **`index.js`**: Express server that exposes a `/trigger-bot` POST endpoint
- **`bot.js`**: Core Playwright automation logic for TPI Suitcase portal with comprehensive form automation
- **`package.json`**: Project dependencies (express, playwright, dotenv, axios)
- **`Dockerfile`**: Container configuration using Microsoft's Playwright image
- **`sample.json`**: Example payload format for testing
- **`README.md`**: Complete setup and usage documentation

## Core Logic & Features

- **API Trigger**: The bot is triggered by a POST request to the `/trigger-bot` endpoint, designed for integration with n8n.
- **Browser Automation**: Uses Playwright with Chromium browser (headless: false for development) to automate interactions with the TPI Suitcase web portal.
- **Secure Credentials**: Loads credentials from a `.env` file for security (USERNAME and PASSWORD).
- **Advanced Form Processing**: For each record received, the bot performs comprehensive form automation:

### Client Search & Handling (`bot.js`)
1. **Smart Client Search**: Searches by last name using the search popup
2. **No Results Handling**: Detects "Sorry, we did not find any results for your keywords" message and marks as "Not Submitted"
3. **Client Matching**: Matches clients by first name and last name from search results
4. **Close Button**: Uses close icon (`span.popupClose`) when no results found
5. **Done Button**: Clicks "Done" button (`#zc-adv-btn-finish`) after successful client selection
6. **Critical Field Check**: After successful client selection, performs basic validation of reservation title and booking number to ensure they weren't cleared

### Tour Operator Selection (`bot.js`)
1. **Dropdown Interaction**: Clicks tour operator dropdown (`span.select2-chosen#select2-chosen-18`)
2. **Progressive Word Search**: Implements intelligent search strategy starting with first word, then 2 words, continuing until match found
3. **Dynamic Search Input**: Uses `findDynamicSelector()` to locate vendor input field with multiple fallback strategies
4. **Results Validation**: Checks dropdown results in `ul#select2-results-18` for exact or partial matches
5. **Enhanced Matching**: Prioritizes exact matches, uses word boundaries, and regex patterns to prevent false positives (e.g., "Viator" won't match "Aviator Hotel")
6. **Fallback Handling**: Marks as "Not Submitted" if tour operator not found after trying all word combinations

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
- **Webhook Integration**: Automatically sends all processed data to n8n webhook at `https://n8n.collectgreatstories.com/webhook/bookings-from-tpi`
- **Enhanced Error Recovery**: Gracefully handles form clearing issues and field validation failures
- **Enhanced Status Tracking**: Returns detailed status for each record:
  - `Submitted`: Successfully processed and saved with invoice number
  - `Not Submitted`: Client not found or tour operator not found
  - `Error`: Technical error during processing
- **JSON Response**: Adds `Submitted`, `InvoiceNumber` fields and posts complete data to webhook

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
  1. **Reservation Title**: Automatically determines 'Cruise FIT' or 'Tour FIT' based on description
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
- Express server on port 3000
- Validates incoming JSON array format
- Calls `loginAndProcess()` function
- Returns processed results with enhanced status codes

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

## Current Status

The TPI Suitcase Bot is fully implemented with comprehensive automation capabilities:

- ✅ Express API server with `/trigger-bot` endpoint
- ✅ Advanced Playwright automation for TPI Suitcase portal
- ✅ Secure login with iframe handling
- ✅ **Enhanced client search with no-results handling**
- ✅ **Advanced tour operator selection with scrolling**
- ✅ **Automatic region selection (United States)**
- ✅ **Complete date field automation**
- ✅ **Financial data handling (price & commission)**
- ✅ **Submit and Duplicate workflow with popup handling**
- ✅ **Invoice number extraction and tracking**
- ✅ **Automatic webhook integration to n8n**
- ✅ **Comprehensive status tracking with "Submitted" and "InvoiceNumber" fields**
- ✅ **Browser crash and timeout detection and recovery system**
- ✅ Robust error handling and recovery
- ✅ Docker containerization ready
- ✅ Complete documentation and examples

## Form Fields Automated

1. **Reservation Title** - Auto-determined (Cruise FIT/Tour FIT)
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

### Form Robustness Enhancement (Latest Update)
- ✅ **Dynamic Selector Detection**: Implemented `findDynamicSelector()` function with multiple fallback strategies for form fields
- ✅ **Form State Preservation**: Added `formState` object to preserve data across retry attempts after form refresh
- ✅ **Enhanced Tour Operator Matching**: Improved matching logic with exact matches, word boundaries, and regex patterns
- ✅ **Retry Logic with Recovery**: Comprehensive retry system that handles form refresh and selector changes
- ✅ **Field Validation**: Added `verifyFormState()` function to validate form data before submission
- ✅ **Enhanced Input Detection**: Improved vendor and destination input field detection to avoid disabled elements

### Form Reset Strategy (Previous Update)
- ✅ **Eliminated Form Field Clearing Issues**: Replaced individual field clearing with full page refresh
- ✅ **Prevented Browser Freeze**: Removed problematic selector-based clearing that caused browser unresponsiveness
- ✅ **Consistent Fresh State**: Each record now starts with a completely clean form (same as first record)
- ✅ **Simplified Logic**: No need to validate individual field selectors or handle dropdown resets
- ✅ **Improved Reliability**: Form refresh ensures all elements are in their initial state

**Robustness Strategy:**
- **Challenge**: Form refresh changes selector IDs and clears field data
- **Solution**: Dynamic selector detection with form state preservation across retries
- **Benefit**: Bot can handle form refreshes seamlessly without losing data or failing on selector changes

**Next Steps:** Deploy to production environment (Google Cloud Run) and monitor for optimization opportunities.
