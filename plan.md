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

### Tour Operator Selection (`bot.js`)
1. **Dropdown Interaction**: Clicks tour operator dropdown (`span.select2-chosen#select2-chosen-18`)
2. **Smart Search with Scrolling**: Searches through tour operator list with automatic scrolling
3. **Partial Matching**: Uses case-insensitive partial matching for tour operator names
4. **Fallback Handling**: Marks as "Not Submitted" if tour operator not found

### Regional Settings (`bot.js`)
1. **Region Selection**: Automatically selects "United States" as destination region
2. **Dropdown Navigation**: Clicks region dropdown (`span.select2-chosen#select2-chosen-2`)
3. **Text Input**: Types "United States" in the destination input field
4. **Selection Confirmation**: Clicks on the United States option from dropdown

### Date & Financial Data (`bot.js`)
1. **Start Date**: Fills booking start date with proper MM/DD/YYYY formatting
2. **End Date**: Fills booking end date with proper MM/DD/YYYY formatting  
3. **Package Price**: Fills total price field, removing commas from currency values
4. **Expected Commission**: Fills commission field with projected commission amount

### Form Submission & Status Tracking
- **Submit and Duplicate Process**: Clicks "Submit and Duplicate" button (`input[name="Submit_and_Duplicate"]`) to submit completed forms
- **Popup Handling**: Waits for confirmation popup and clicks OK button (`#Ok`) 
- **Invoice Number Extraction**: Extracts invoice number from updated reservation title (e.g., "Tour FIT - Invoice # 201425570 - Copy")
- **Webhook Integration**: Automatically sends all processed data to n8n webhook at `https://n8n.collectgreatstories.com/webhook/bookings-from-tpi`
- **Enhanced Status Tracking**: Returns detailed status for each record:
  - `Submitted`: Successfully processed and saved with invoice number
  - `Not Submitted`: Client not found or tour operator not found
  - `Error`: Technical error during processing
- **JSON Response**: Adds `Submitted`, `InvoiceNumber` fields and posts complete data to webhook

## Technical Implementation Details

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
  4. **Tour Operator Selection**: Smart dropdown search with scrolling capability
  5. **Region Selection**: Automatic United States selection
  6. **Date Fields**: Start and end date population with format validation
  7. **Financial Data**: Package price and commission fields
  8. **Form Submission**: Submit and Duplicate button click with popup handling
  9. **Invoice Extraction**: Extract generated invoice number from reservation title
  10. **Webhook Transmission**: Send complete data to n8n webhook
  11. **Form Reset**: Navigation to fresh form for next record

### Helper Functions (`bot.js`)
- **`searchAndSelectTourOperator()`**: Advanced tour operator search with scrolling  
- **`formatDate()`**: Date formatting utility for MM/DD/YYYY format
- **`sendToWebhook()`**: Automatically sends processed data to n8n webhook
- **Error Handling**: Comprehensive try-catch blocks with detailed logging

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

**Next Steps:** Deploy to production environment (Google Cloud Run) and monitor for optimization opportunities.
