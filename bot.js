require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');

async function loginAndProcess(data) {
    let browser = null;
    try {
        console.log('Launching browser...');
        browser = await chromium.launch({ headless: false }); // Use headless: true in production
        const context = await browser.newContext();
        const page = await context.newPage();

        console.log('Navigating to login page...');
        await page.goto('https://my.tpisuitcase.com/');

        console.log('Waiting for iframe...');
        // Wait for the iframe to be present and visible
        const iframeElement = await page.waitForSelector('iframe#signinFrame', { timeout: 60000 });
        const frame = await iframeElement.contentFrame();

        if (!frame) {
            throw new Error('Could not find the sign-in iframe.');
        }

        console.log('Filling in username...');
        // Wait for the email field inside the iframe
        const emailInput = await frame.waitForSelector('#login_id', { timeout: 60000 });
        await emailInput.fill(process.env.USERNAME);

        console.log('Clicking next...');
        const nextButton = await frame.waitForSelector('#nextbtn', { timeout: 60000 });
        await nextButton.click();

        console.log('Filling in password...');
        // Wait for the password field to appear
        const passwordInput = await frame.waitForSelector('#password', { timeout: 60000 });
        await passwordInput.fill(process.env.PASSWORD);

        console.log('Clicking sign in...');
        const signInButton = await frame.waitForSelector('#nextbtn:has-text("Sign In")', { timeout: 60000 });
        await signInButton.click();

        console.log('Waiting for page to load after login...');
        await page.waitForURL('https://my.tpisuitcase.com/#Page:CORE', { timeout: 60000 });

        console.log('Page loaded successfully. Waiting for 10 seconds...');
        await page.waitForTimeout(10000);

        console.log('Login and initial wait complete!');

        console.log('Navigating to the Quick Submit form...');
        await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');

        // Wait for a known element on the form page to ensure it's loaded
        const titleSelector = await findDynamicSelector(page, 'reservation_title');
        if (titleSelector) {
            await page.waitForSelector(titleSelector, { timeout: 60000 });
        } else {
            // Fallback to original selector if dynamic detection fails
            await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
        }

        const processedData = [];

        for (const record of data[0].rows) {
            let processingAttempt = 1;
            const maxProcessingAttempts = 3;
            let recordProcessed = false;
            
            // Store form state for retry attempts
            let formState = {
                reservationTitle: '',
                bookingNumber: '',
                startDate: '',
                endDate: '',
                packagePrice: '',
                expectedCommission: '',
                tourOperator: '',
                region: 'United States'
            };
            
            while (!recordProcessed && processingAttempt <= maxProcessingAttempts) {
                try {
                    if (processingAttempt > 1) {
                        console.log(`Processing record for: ${record['Client Name']} (attempt ${processingAttempt}/${maxProcessingAttempts})`);
                    } else {
                        console.log(`Processing record for: ${record['Client Name']}`);
                    }

                    // Ensure page is ready before processing this record
                    const pageReady = await ensurePageReady(page);
                    if (!pageReady) {
                        console.log(`  - Page not ready, skipping record: ${record['Client Name']}`);
                        record.status = 'error';
                        record.Submitted = 'Error - Page Not Ready';
                        record.InvoiceNumber = 'Not Generated';
                        recordProcessed = true;
                        break;
                    }

                // 1. Determine Reservation Title
                if (processingAttempt === 1) {
                    formState.reservationTitle = record['Trip Description'].toLowerCase().includes('cruise') || record['Booking Description'].toLowerCase().includes('cruise')
                        ? 'Cruise FIT'
                        : 'Tour FIT';
                    formState.bookingNumber = record['Booking Number'];
                    formState.tourOperator = record['Tour Operator'];
                    formState.startDate = formatDate(record['Booking Start Date']);
                    formState.endDate = formatDate(record['Booking End Date']);
                    formState.packagePrice = record['Package Price'].replace(/,/g, '');
                    formState.expectedCommission = record['Commission Projected'].replace(/,/g, '');
                }
                
                const titleSelector = await findDynamicSelector(page, 'reservation_title');
                if (!titleSelector) {
                    throw new Error('Could not find reservation title field');
                }
                await page.fill(titleSelector, formState.reservationTitle);
                console.log(`  - Set Reservation Title to: ${formState.reservationTitle}`);

                // 2. Fill Booking Number
                const numberSelector = await findDynamicSelector(page, 'reservation_number');
                if (!numberSelector) {
                    throw new Error('Could not find reservation number field');
                }
                await page.fill(numberSelector, formState.bookingNumber);
                console.log(`  - Set Booking Number to: ${formState.bookingNumber}`);

                // 3. Search for Client Name using the search popup
                const clientName = record['Client Name'];
                const [firstName, ...lastNameParts] = clientName.split(' ');
                const lastName = lastNameParts.join(' ');

                console.log(`  - Searching for client: ${firstName} ${lastName}`);

                // Click the search icon next to the client field
                await page.click('i.ui-3-search');

                // Wait for the search popup and enter the last name
                const searchInput = await page.waitForSelector('input[name="zc_search_Last_Name"]', { timeout: 10000 });
                await searchInput.fill(lastName);
                await page.click('input#searchBtn');

                // Add a static wait for the search results to load
                await page.waitForTimeout(5000);

                // Check if no results message is displayed
                const noDataElement = await page.locator('#zc-advanced-search-table-nodata').first();
                const isNoDataVisible = await noDataElement.isVisible().catch(() => false);

                let clientFound = false;

                if (isNoDataVisible) {
                    console.log(`  - Client not found: ${clientName} (No search results)`);
                    // Click close button to close the popup - try multiple selectors
                    try {
                        await page.waitForSelector('span.popupClose[aria-label="Close"]', { timeout: 5000 });
                        await page.click('span.popupClose[aria-label="Close"]');
                    } catch (e) {
                        console.log('  - Trying alternative close button selector...');
                        try {
                            await page.click('span.popupClose');
                        } catch (e2) {
                            console.log('  - Trying escape key...');
                            await page.keyboard.press('Escape');
                        }
                    }
                    record.status = 'not submitted';
                    record.Submitted = 'Not Submitted';
                    record.InvoiceNumber = 'Not Generated';
                } else {
                    // Check if results were returned
                    const rows = await page.locator('.ht_master .htCore tbody tr').all();

                    if (rows.length > 0) {
                        // Find the correct row and click it
                        for (const row of rows) {
                            const rowFirstName = await row.locator('td:nth-child(2)').innerText();
                            const rowLastName = await row.locator('td:nth-child(4)').innerText();

                            if (rowFirstName.trim().toLowerCase() === firstName.toLowerCase() && rowLastName.trim().toLowerCase() === lastName.toLowerCase()) {
                                // Click the first cell (checkbox column) to select the row
                                await row.locator('td:first-child').click();
                                clientFound = true;
                                console.log(`  - Found and selected client: ${clientName}`);
                                break;
                            }
                        }
                    }

                    if (clientFound) {
                        // Click the 'Done' button to confirm client selection
                        await page.click('#zc-adv-btn-finish');
                        await page.waitForTimeout(2000);

                        // Validate critical fields after client search (basic check only)
                        const validationResult = await validateCriticalFieldsAfterClientSearch(page);
                        if (!validationResult) {
                            console.log('  ❌ Critical field validation failed, skipping record');
                            record.status = 'error';
                            record.Submitted = 'Error';
                            record.InvoiceNumber = 'Error';
                        } else {

                        // Close any remaining popups before tour operator selection
                        await closeCalendarPopupIfOpen(page);

                        // 4. Select Tour Operator
                        console.log(`  - Selecting tour operator: ${formState.tourOperator}`);
                        
                        // Use a more flexible selector that works with dynamic IDs
                        const tourOperatorFound = await searchAndSelectTourOperator(page, formState.tourOperator);
                        
                        if (!tourOperatorFound) {
                            console.log(`  - Tour operator not found: ${formState.tourOperator}`);
                            record.status = 'not submitted';
                            record.Submitted = 'Not Submitted';
                            record.InvoiceNumber = 'Not Generated';
                        } else {
                            console.log(`  - Selected tour operator: ${formState.tourOperator}`);

                            // 5. Select Region (United States) with validation
                            console.log(`  - Selecting region: ${formState.region}`);
                            await fillAndValidateRegion(page, formState.region);

                            // 6. Fill Start Date with validation
                            console.log(`  - Setting start date: ${formState.startDate}`);
                            await fillAndValidateField(page, 'start_date', formState.startDate, 'Start Date');

                            // 7. Fill End Date with validation
                            console.log(`  - Setting end date: ${formState.endDate}`);
                            await fillAndValidateField(page, 'end_date', formState.endDate, 'End Date');

                            // 8. Fill Package Price with validation
                            try {
                                console.log(`  - Setting package price: ${formState.packagePrice}`);
                                await fillAndValidateField(page, 'total_price', formState.packagePrice, 'Package Price');
                            } catch (e) {
                                console.log(`  ⚠️  Warning: Package Price filling failed: ${e.message}`);
                            }

                            // 9. Fill Expected Commission with validation
                            try {
                                console.log(`  - Setting expected commission: ${formState.expectedCommission}`);
                                await fillAndValidateField(page, 'expected_commission', formState.expectedCommission, 'Expected Commission');
                            } catch (e) {
                                console.log(`  ⚠️  Warning: Expected Commission filling failed: ${e.message}`);
                            }

                            // 10. Verify all form fields are populated before submission
                            const formValid = await verifyFormState(page, formState);
                            if (!formValid) {
                                console.log('  ⚠️  Form validation failed, fields may be incomplete');
                                // Don't submit if form is invalid, continue to next attempt
                                throw new Error('Form validation failed');
                            }
                            
                            // 11. Submit the form with human-like interaction
                            console.log('  - Submitting form...');
                            await submitFormHumanLike(page);

                            // Extract invoice number from reservation title
                            try {
                                const titleSelector = await findDynamicSelector(page, 'reservation_title');
                                if (titleSelector) {
                                    const reservationTitleValue = await page.inputValue(titleSelector);
                                    console.log(`  - Reservation title after submit: ${reservationTitleValue}`);
                                    
                                    // Extract invoice number using regex (e.g., "Tour FIT - Invoice # 201425570 - Copy")
                                    const invoiceMatch = reservationTitleValue.match(/Invoice\s*#\s*(\d+)/i);
                                    const invoiceNumber = invoiceMatch ? invoiceMatch[1] : null;
                                    
                                    if (invoiceNumber) {
                                        record.InvoiceNumber = invoiceNumber;
                                        console.log(`  - Extracted invoice number: ${invoiceNumber}`);
                                    } else {
                                        record.InvoiceNumber = 'Not Generated';
                                        console.log('  - No invoice number found in reservation title.');
                                    }
                                } else {
                                    record.InvoiceNumber = 'Not Generated';
                                    console.log('  - Could not find reservation title field to extract invoice number.');
                                }
                            } catch (e) {
                                console.error('  - Error extracting invoice number:', e);
                                record.InvoiceNumber = 'Error';
                            }

                            record.status = 'submitted';
                            record.Submitted = 'Submitted';
                        }
                        }
                    } else {
                        console.log(`  - Client not found: ${clientName} (No matching client in results)`);
                        // Click close button to close the popup - try multiple selectors
                        try {
                            await page.waitForSelector('span.popupClose[aria-label="Close"]', { timeout: 5000 });
                            await page.click('span.popupClose[aria-label="Close"]');
                        } catch (e) {
                            console.log('  - Trying alternative close button selector...');
                            try {
                                await page.click('span.popupClose');
                            } catch (e2) {
                                console.log('  - Trying escape key...');
                                await page.keyboard.press('Escape');
                            }
                        }
                        record.status = 'not submitted';
                        record.Submitted = 'Not Submitted';
                        record.InvoiceNumber = 'Not Generated';
                    }
                }

                // Refresh form page after successful submission to ensure clean state for next record
                console.log('  🔄 Refreshing form page to start fresh...');
                await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
                
                // Wait for the form to load using dynamic selector detection
                let formReady = false;
                try {
                    const titleSelector = await findDynamicSelector(page, 'reservation_title');
                    if (titleSelector) {
                        await page.waitForSelector(titleSelector, { timeout: 60000 });
                        formReady = true;
                    }
                } catch (e) {
                    console.log('  ⚠️  Dynamic selector detection failed, using fallback');
                }
                
                if (!formReady) {
                    // Fallback to original selector if dynamic detection fails
                    await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
                }
                
                console.log('  ✅ Form page refreshed and ready for next operation');

                    // If we reach here, record was processed successfully
                    recordProcessed = true;

                } catch (e) {
                    console.error(`Error processing record for ${record['Client Name']}:`, e);
                    
                    // Check if this is a browser crash or timeout
                    if (isBrowserCrashed(e)) {
                        console.log(`  🚨 Browser crash detected for ${record['Client Name']}`);
                        
                        // Attempt to recover from browser crash
                        const recoverySuccess = await recoverFromBrowserIssue(page, record, 'crash', processingAttempt);
                        
                        if (recoverySuccess && processingAttempt < maxProcessingAttempts) {
                            console.log(`  ✅ Recovery successful, retrying record: ${record['Client Name']}`);
                            processingAttempt++;
                            continue; // Retry the record
                        } else {
                            console.log(`  ❌ Recovery failed or max attempts reached for: ${record['Client Name']}`);
                            record.status = 'error';
                            record.Submitted = 'Error - Browser Crash';
                            record.InvoiceNumber = 'Error';
                            recordProcessed = true;
                        }
                    } else if (isBrowserTimeout(e)) {
                        console.log(`  ⏰ Browser timeout detected for ${record['Client Name']}`);
                        
                        // Attempt to recover from browser timeout
                        const recoverySuccess = await recoverFromBrowserIssue(page, record, 'timeout', processingAttempt);
                        
                        if (recoverySuccess && processingAttempt < maxProcessingAttempts) {
                            console.log(`  ✅ Recovery successful, retrying record: ${record['Client Name']}`);
                            processingAttempt++;
                            continue; // Retry the record
                        } else {
                            console.log(`  ❌ Recovery failed or max attempts reached for: ${record['Client Name']}`);
                            record.status = 'error';
                            record.Submitted = 'Error - Browser Timeout';
                            record.InvoiceNumber = 'Error';
                            recordProcessed = true;
                        }
                    } else {
                        // Non-crash/timeout error, mark as error and move on
                        record.status = 'error';
                        record.Submitted = 'Error';
                        record.InvoiceNumber = 'Error';
                        recordProcessed = true;
                    }
                }
                
                // Increment attempt counter for non-crash errors
                if (!recordProcessed) {
                    processingAttempt++;
                }
            }
            
            processedData.push(record);
        }

        // Send processed data to webhook
        await sendToWebhook(processedData);

        return processedData;

    } catch (error) {
        console.error('An error occurred during the bot process:', error);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
    }
}

// Helper function to search and select tour operator with progressive word search
async function searchAndSelectTourOperator(page, tourOperator) {
    try {
        console.log(`    🔍 Searching for tour operator: ${tourOperator}`);
        
        // Find the dropdown using dynamic selector
        const dropdownSelector = await findDynamicSelector(page, 'vendor_dropdown');
        if (!dropdownSelector) {
            console.log(`    ❌ Could not find tour operator dropdown`);
            return false;
        }
        
        const tourOperatorDropdown = await page.locator(dropdownSelector);
        
        // Try multiple approaches to click the dropdown
        let clickSuccessful = false;
        
        // Method 1: Direct click
        try {
            await tourOperatorDropdown.click();
            clickSuccessful = true;
            console.log(`    ✅ Successfully clicked dropdown directly`);
        } catch (e) {
            console.log(`    ⚠️  Direct click failed: ${e.message}`);
        }
        
        // Method 2: Force click
        if (!clickSuccessful) {
            try {
                await tourOperatorDropdown.click({ force: true });
                clickSuccessful = true;
                console.log(`    ✅ Successfully clicked dropdown with force`);
            } catch (e) {
                console.log(`    ⚠️  Force click failed: ${e.message}`);
            }
        }
        
        // Method 3: Use JavaScript click if force click failed
        if (!clickSuccessful) {
            try {
                await page.evaluate((selector) => {
                    const dropdown = document.querySelector(selector);
                    if (dropdown) dropdown.click();
                }, dropdownSelector);
                clickSuccessful = true;
                console.log(`    ✅ Successfully clicked dropdown with JavaScript`);
            } catch (e) {
                console.log(`    ⚠️  JavaScript click failed: ${e.message}`);
            }
        }
        
        if (!clickSuccessful) {
            console.log(`    ❌ All click methods failed for tour operator dropdown`);
            return false;
        }
        
        await page.waitForTimeout(1000);
        
        // Find the search input field using dynamic selector
        const inputSelector = await findDynamicSelector(page, 'vendor_input');
        if (!inputSelector) {
            console.log(`    ❌ Could not find vendor input field`);
            return false;
        }
        
        // Wait for the search input field to appear and ensure it's the correct one
        await page.waitForTimeout(1000); // Give dropdown time to fully open
        
        // Find the correct search input (enabled and visible)
        let searchInputElement = null;
        const inputElements = await page.locator(inputSelector).all();
        
        for (const element of inputElements) {
            try {
                const isVisible = await element.isVisible();
                const isEnabled = await element.isEnabled();
                const classList = await element.getAttribute('class') || '';
                
                if (isVisible && isEnabled && (classList.includes('select2-input') || classList.includes('select2-focused'))) {
                    searchInputElement = element;
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!searchInputElement) {
            console.log(`    ❌ Could not find enabled search input field`);
            return false;
        }
        
        // Clear any existing value in the search field that might be from previous form state
        try {
            await searchInputElement.fill('');
            await page.waitForTimeout(500);
        } catch (e) {
            console.log(`    ⚠️  Could not clear search input: ${e.message}`);
        }
        
        // Split tour operator into words for progressive search
        const words = tourOperator.trim().split(/\s+/);
        
        // Try progressive word search: 1 word, then 2 words, then 3, etc.
        for (let wordCount = 1; wordCount <= words.length; wordCount++) {
            const searchTerm = words.slice(0, wordCount).join(' ');
            console.log(`    📝 Trying search term: "${searchTerm}"`);
            
            // Clear and type the search term using the correct element
            await searchInputElement.fill('');
            await page.waitForTimeout(300);
            await searchInputElement.fill(searchTerm);
            await page.waitForTimeout(1500); // Wait for search results to load
            
            // Wait for results to appear - use a more flexible selector
            try {
                await page.waitForSelector('ul.select2-results li.select2-result', { timeout: 3000 });
            } catch (e) {
                console.log(`    ❌ No results found for "${searchTerm}"`);
                continue;
            }
            
            // Check if we found exact or partial matches in the dropdown
            const options = await page.locator('ul.select2-results li.select2-result').all();
            
            for (const option of options) {
                const text = await option.innerText();
                const cleanText = text.toLowerCase().trim();
                const cleanTourOperator = tourOperator.toLowerCase().trim();
                
                // Remove parentheses and their content for comparison
                const cleanTextWithoutParens = cleanText.replace(/\s*\([^)]*\)\s*/g, '').trim();
                
                // Check for exact match first (highest priority)
                if (cleanText === cleanTourOperator || cleanTextWithoutParens === cleanTourOperator) {
                    console.log(`    ✅ Found exact match: "${text}" for search "${searchTerm}"`);
                    await option.click();
                    await page.waitForTimeout(1000);
                    return true;
                }
                
                // Check if the tour operator name starts with the search term (word boundary)
                const searchTermLower = searchTerm.toLowerCase().trim();
                if (cleanTextWithoutParens.startsWith(searchTermLower + ' ') || 
                    cleanTextWithoutParens === searchTermLower ||
                    cleanTextWithoutParens.startsWith(searchTermLower + '-') ||
                    cleanTextWithoutParens.startsWith(searchTermLower + '.')) {
                    console.log(`    ✅ Found word boundary match: "${text}" for search "${searchTerm}"`);
                    await option.click();
                    await page.waitForTimeout(1000);
                    return true;
                }
                
                // Check if the cleaned text contains the full tour operator name as a whole word
                const wordBoundaryRegex = new RegExp(`\\b${cleanTourOperator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                if (wordBoundaryRegex.test(cleanTextWithoutParens)) {
                    console.log(`    ✅ Found word match: "${text}" for search "${searchTerm}"`);
                    await option.click();
                    await page.waitForTimeout(1000);
                    return true;
                }
            }
            
            console.log(`    ⚠️  No match found in results for "${searchTerm}"`);
        }
        
        console.log(`    ❌ Tour operator "${tourOperator}" not found after trying all word combinations`);
        return false;
        
    } catch (error) {
        console.error(`    💥 Error searching for tour operator "${tourOperator}":`, error);
        return false;
    }
}

// Helper function to format dates (assumes MM/DD/YYYY format)
function formatDate(dateString) {
    try {
        // If date is already in MM/DD/YYYY format, return as is
        if (dateString.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
            return dateString;
        }
        
        // Convert from other formats if needed
        const date = new Date(dateString);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = date.getFullYear();
        
        return `${month}/${day}/${year}`;
    } catch (error) {
        console.error('Error formatting date:', error);
        return dateString; // Return original if formatting fails
    }
}

// Helper function to fill and validate form fields with human-like interactions
async function fillAndValidateField(page, fieldType, value, fieldName, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`    📝 Filling ${fieldName} (attempt ${attempt}/${maxRetries})`);
            
            // Close any calendar popup before attempting to fill fields
            await closeCalendarPopupIfOpen(page);
            
            // Find dynamic selector for the field
            const selector = await findDynamicSelector(page, fieldType);
            if (!selector) {
                throw new Error(`Could not find selector for ${fieldType}`);
            }
            
            // Determine if this is a date field by field type
            const isDateField = fieldType === 'start_date' || fieldType === 'end_date';
            
            if (isDateField) {
                // For date fields, ONLY use page.fill() - NO clicking to prevent calendar popup
                console.log(`    📅 Using direct fill for date field: ${selector}`);
                await page.fill(selector, ''); // Clear first
                await page.fill(selector, value); // Then fill
                await page.waitForTimeout(500 + Math.random() * 300);
            } else {
                // For non-date fields, use reliable fill method
                console.log(`    💰 Using reliable fill for field: ${selector}`);
                await page.fill(selector, ''); // Clear first
                await page.fill(selector, value); // Then fill
                await page.waitForTimeout(300 + Math.random() * 200);
            }
            
            // Validate the field was filled correctly
            const actualValue = await page.inputValue(selector);
            if (actualValue === value) {
                console.log(`    ✅ ${fieldName} validated successfully: "${actualValue}"`);
                return true;
            } else {
                console.log(`    ⚠️  ${fieldName} validation failed. Expected: "${value}", Got: "${actualValue}"`);
                if (attempt === maxRetries) {
                    console.log(`    ❌ ${fieldName} failed after ${maxRetries} attempts`);
                    return false;
                }
                await page.waitForTimeout(1000);
            }
        } catch (error) {
            console.log(`    💥 Error filling ${fieldName} (attempt ${attempt}): ${error.message}`);
            if (attempt === maxRetries) {
                return false;
            }
            await page.waitForTimeout(1000);
        }
    }
    return false;
}

// Helper function to select region with validation
async function fillAndValidateRegion(page, regionName, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`    🌍 Selecting region: ${regionName} (attempt ${attempt}/${maxRetries})`);
            
            // Find the dropdown using dynamic selector
            const dropdownSelector = await findDynamicSelector(page, 'destination_dropdown');
            if (!dropdownSelector) {
                console.log(`    ❌ Could not find destination dropdown`);
                if (attempt === maxRetries) {
                    return false;
                }
                await page.waitForTimeout(1000);
                continue;
            }
            
            const regionDropdown = await page.locator(dropdownSelector);
            
            // Try multiple approaches to click the dropdown
            let clickSuccessful = false;
            
            // Method 1: Direct click
            try {
                await regionDropdown.click();
                clickSuccessful = true;
                console.log(`    ✅ Successfully clicked region dropdown directly`);
            } catch (e) {
                console.log(`    ⚠️  Direct click failed: ${e.message}`);
            }
            
            // Method 2: Force click
            if (!clickSuccessful) {
                try {
                    await regionDropdown.click({ force: true });
                    clickSuccessful = true;
                    console.log(`    ✅ Successfully clicked region dropdown with force`);
                } catch (e) {
                    console.log(`    ⚠️  Force click failed: ${e.message}`);
                }
            }
            
            // Method 3: Use JavaScript click if force click failed
            if (!clickSuccessful) {
                try {
                    await page.evaluate((selector) => {
                        const dropdown = document.querySelector(selector);
                        if (dropdown) dropdown.click();
                    }, dropdownSelector);
                    clickSuccessful = true;
                    console.log(`    ✅ Successfully clicked region dropdown with JavaScript`);
                } catch (e) {
                    console.log(`    ⚠️  JavaScript click failed: ${e.message}`);
                }
            }
            
            if (!clickSuccessful) {
                console.log(`    ❌ All click methods failed for region dropdown`);
                if (attempt === maxRetries) {
                    return false;
                }
                await page.waitForTimeout(1000);
                continue;
            }
            
            await page.waitForTimeout(500 + Math.random() * 300);
            
            // Find the input field using dynamic selector
            const inputSelector = await findDynamicSelector(page, 'destination_input');
            if (!inputSelector) {
                console.log(`    ❌ Could not find destination input field`);
                if (attempt === maxRetries) {
                    return false;
                }
                await page.waitForTimeout(1000);
                continue;
            }
            
            // Find the correct region input (enabled and visible)
            let regionInputElement = null;
            const regionInputElements = await page.locator(inputSelector).all();
            
            for (const element of regionInputElements) {
                try {
                    const isVisible = await element.isVisible();
                    const isEnabled = await element.isEnabled();
                    const classList = await element.getAttribute('class') || '';
                    
                    if (isVisible && isEnabled && (classList.includes('select2-input') || classList.includes('select2-focused'))) {
                        regionInputElement = element;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (!regionInputElement) {
                console.log(`    ❌ Could not find enabled region input field`);
                if (attempt === maxRetries) {
                    return false;
                }
                await page.waitForTimeout(1000);
                continue;
            }
            
            // Wait for input field and type region name
            await regionInputElement.fill(regionName);
            await page.waitForTimeout(800 + Math.random() * 400);
            
            // Click on the region option
            await page.click(`div.select2-result-label:has-text("${regionName}")`);
            await page.waitForTimeout(600 + Math.random() * 300);
            
            // Validate the selection using dynamic selector
            try {
                const chosenSelector = dropdownSelector.replace('.select2-choice', ' .select2-chosen');
                const selectedText = await page.textContent(chosenSelector);
                if (selectedText && selectedText.includes(regionName)) {
                    console.log(`    ✅ Region selected successfully: "${selectedText}"`);
                    return true;
                } else {
                    console.log(`    ⚠️  Region validation failed. Expected: "${regionName}", Got: "${selectedText}"`);
                }
            } catch (e) {
                console.log(`    ⚠️  Could not validate region selection`);
            }
            
            if (attempt === maxRetries) {
                console.log(`    ❌ Region selection failed after ${maxRetries} attempts`);
                return false;
            }
            await page.waitForTimeout(1000);
            
        } catch (error) {
            console.log(`    💥 Error selecting region (attempt ${attempt}): ${error.message}`);
            if (attempt === maxRetries) {
                return false;
            }
            await page.waitForTimeout(1000);
        }
    }
    return false;
}



// Helper function to find dynamic form selectors
async function findDynamicSelector(page, fieldType, maxRetries = 3) {
    const selectorMap = {
        'reservation_title': [
            '#zc-Reservation_Title',
            '[name*="Reservation_Title"]',
            'input[placeholder*="Reservation Title"]',
            'input[label*="Reservation Title"]',
            'input[data-field*="Reservation_Title"]'
        ],
        'reservation_number': [
            '#zc-Reservation_Number',
            '[name*="Reservation_Number"]',
            'input[placeholder*="Reservation Number"]',
            'input[label*="Reservation Number"]',
            'input[data-field*="Reservation_Number"]'
        ],
        'start_date': [
            '#Start_Date',
            '[name*="Start_Date"]',
            'input[placeholder*="Start Date"]',
            'input[label*="Start Date"]',
            'input[data-field*="Start_Date"]'
        ],
        'end_date': [
            '#End_Date',
            '[name*="End_Date"]',
            'input[placeholder*="End Date"]',
            'input[label*="End Date"]',
            'input[data-field*="End_Date"]'
        ],
        'total_price': [
            '#zc-Total_Price',
            '[name*="Total_Price"]',
            'input[placeholder*="Total Price"]',
            'input[label*="Total Price"]',
            'input[data-field*="Total_Price"]'
        ],
        'expected_commission': [
            '#zc-Expected_Commission',
            '[name*="Expected_Commission"]',
            'input[placeholder*="Expected Commission"]',
            'input[label*="Expected Commission"]',
            'input[data-field*="Expected_Commission"]'
        ],
        'vendor_dropdown': [
            '.select2-container.zc-Vendor .select2-choice',
            '.select2-container[class*="Vendor"] .select2-choice',
            '.select2-container[data-field*="Vendor"] .select2-choice',
            '[class*="vendor"] .select2-choice',
            '[data-field*="vendor"] .select2-choice'
        ],
        'vendor_input': [
            'input[name="zc-sel2-inp-Vendor"]',
            'input[name*="zc-sel2-inp-Vendor"]',
            'input[autocomplete*="zc-sel2-inp-Vendor"]',
            'input.select2-input[name*="Vendor"]:not([disabled])',
            'input[role="combobox"][name*="Vendor"]:not([disabled])',
            'input[type="text"][name*="Vendor"]:not([disabled])'
        ],
        'destination_dropdown': [
            '.select2-container.zc-Destination .select2-choice',
            '.select2-container[class*="Destination"] .select2-choice',
            '.select2-container[data-field*="Destination"] .select2-choice',
            '[class*="destination"] .select2-choice',
            '[data-field*="destination"] .select2-choice'
        ],
        'destination_input': [
            'input[name="zc-sel2-inp-Destination"]',
            'input[name*="zc-sel2-inp-Destination"]',
            'input[autocomplete*="zc-sel2-inp-Destination"]',
            'input.select2-input[name*="Destination"]:not([disabled])',
            'input[role="combobox"][name*="Destination"]:not([disabled])',
            'input[type="text"][name*="Destination"]:not([disabled])'
        ]
    };

    const selectors = selectorMap[fieldType];
    if (!selectors) {
        console.log(`    ❌ Unknown field type: ${fieldType}`);
        return null;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (const selector of selectors) {
            try {
                const elements = await page.locator(selector).all();
                
                // For input fields, find the first enabled and visible element
                for (const element of elements) {
                    const isVisible = await element.isVisible({ timeout: 1000 });
                    if (!isVisible) continue;
                    
                    // For input fields, check if element is enabled
                    if (fieldType.includes('input') || fieldType.includes('vendor_input') || fieldType.includes('destination_input')) {
                        const isEnabled = await element.isEnabled({ timeout: 1000 });
                        if (!isEnabled) continue;
                        
                        // Additional check for select2 input fields
                        const classList = await element.getAttribute('class') || '';
                        if (classList.includes('select2-input') || classList.includes('select2-focused')) {
                            console.log(`    ✅ Found dynamic selector for ${fieldType}: ${selector}`);
                            return selector;
                        }
                    } else {
                        // For non-input fields, just check visibility
                        console.log(`    ✅ Found dynamic selector for ${fieldType}: ${selector}`);
                        return selector;
                    }
                }
            } catch (e) {
                // Continue to next selector
            }
        }
        
        if (attempt < maxRetries) {
            console.log(`    🔄 Retrying dynamic selector search for ${fieldType} (attempt ${attempt + 1}/${maxRetries})`);
            await page.waitForTimeout(1000);
        }
    }
    
    console.log(`    ❌ Could not find dynamic selector for ${fieldType}`);
    return null;
}

// Helper function to ensure page is ready for next record
async function ensurePageReady(page, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`  🔄 Checking page state (attempt ${attempt}/${maxRetries})`);
            
            // Wait for any overlays or popups to disappear
            await page.waitForTimeout(2000);
            
            // Use dynamic selector detection for critical elements
            const titleSelector = await findDynamicSelector(page, 'reservation_title');
            const numberSelector = await findDynamicSelector(page, 'reservation_number');
            
            if (!titleSelector || !numberSelector) {
                throw new Error('Could not find critical form elements');
            }
            
            // Check if main form elements are accessible
            await page.waitForSelector(titleSelector, { timeout: 5000, state: 'visible' });
            await page.waitForSelector(numberSelector, { timeout: 5000, state: 'visible' });
            
            // Try to interact with a simple element to verify page responsiveness
            const titleElement = await page.locator(titleSelector);
            await titleElement.focus({ timeout: 3000 });
            
            console.log('  ✅ Page is ready for next record');
            return true;
            
        } catch (error) {
            console.log(`  ⚠️  Page not ready (attempt ${attempt}): ${error.message}`);
            if (attempt === maxRetries) {
                console.log('  ❌ Page state verification failed');
                return false;
            }
            await page.waitForTimeout(3000);
        }
    }
    return false;
}

// Helper function to submit form with human-like interaction and validation
async function submitFormHumanLike(page, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`    📤 Submitting form (attempt ${attempt}/${maxRetries})`);
            
            // Human-like pause before clicking submit
            await page.waitForTimeout(1000 + Math.random() * 1000);
            
            // Click the Submit and Duplicate button
            await page.click('input[name="Submit_and_Duplicate"]');
            console.log('    ✅ Clicked Submit and Duplicate button');
            
            // Wait for form processing with human-like patience
            await page.waitForTimeout(6000 + Math.random() * 4000); // 6-10 seconds
            
            // Handle the confirmation popup
            try {
                await page.waitForSelector('#Ok', { timeout: 8000 });
                await page.waitForTimeout(500 + Math.random() * 500); // Human-like pause before clicking OK
                await page.click('#Ok');
                console.log('    ✅ Clicked OK on confirmation popup');
                
                // Wait for page to process the submission
                await page.waitForTimeout(2000 + Math.random() * 1000);
                return true;
                
            } catch (e) {
                console.log('    ⚠️  No confirmation popup appeared - form may have submitted without popup');
                
                // Check if form was submitted by looking for changes in the page
                try {
                    await page.waitForTimeout(2000);
                    const currentUrl = page.url();
                    if (currentUrl.includes('CORE')) {
                        console.log('    ✅ Form appears to have submitted successfully');
                        return true;
                    }
                } catch (urlError) {
                    console.log('    ⚠️  Could not verify form submission by URL');
                }
                
                if (attempt === maxRetries) {
                    console.log('    ❌ No confirmation popup found after submit');
                    return false;
                }
            }
            
        } catch (error) {
            console.log(`    💥 Error submitting form (attempt ${attempt}): ${error.message}`);
            if (attempt === maxRetries) {
                return false;
            }
            await page.waitForTimeout(2000); // Wait before retry
        }
    }
    return false;
}

// Helper function to verify all form fields are populated correctly
async function verifyFormState(page, expectedFormState) {
    try {
        console.log('    🔍 Verifying form state before submission...');
        
        // Check reservation title
        const titleSelector = await findDynamicSelector(page, 'reservation_title');
        if (titleSelector) {
            const titleValue = await page.inputValue(titleSelector);
            if (titleValue !== expectedFormState.reservationTitle) {
                console.log(`    ⚠️  Reservation title mismatch: expected "${expectedFormState.reservationTitle}", got "${titleValue}"`);
                return false;
            }
        }
        
        // Check booking number
        const numberSelector = await findDynamicSelector(page, 'reservation_number');
        if (numberSelector) {
            const numberValue = await page.inputValue(numberSelector);
            if (numberValue !== expectedFormState.bookingNumber) {
                console.log(`    ⚠️  Booking number mismatch: expected "${expectedFormState.bookingNumber}", got "${numberValue}"`);
                return false;
            }
        }
        
        // Check dates
        const startDateSelector = await findDynamicSelector(page, 'start_date');
        if (startDateSelector) {
            const startDateValue = await page.inputValue(startDateSelector);
            if (startDateValue !== expectedFormState.startDate) {
                console.log(`    ⚠️  Start date mismatch: expected "${expectedFormState.startDate}", got "${startDateValue}"`);
                return false;
            }
        }
        
        const endDateSelector = await findDynamicSelector(page, 'end_date');
        if (endDateSelector) {
            const endDateValue = await page.inputValue(endDateSelector);
            if (endDateValue !== expectedFormState.endDate) {
                console.log(`    ⚠️  End date mismatch: expected "${expectedFormState.endDate}", got "${endDateValue}"`);
                return false;
            }
        }
        
        console.log('    ✅ Form state verification passed');
        return true;
    } catch (error) {
        console.log(`    ❌ Form state verification failed: ${error.message}`);
        return false;
    }
}

// Helper function to validate critical form fields after client search (basic check only)
async function validateCriticalFieldsAfterClientSearch(page) {
    try {
        console.log('  🔍 Validating critical fields after client search...');
        
        // First, close any calendar popup that might be blocking interactions
        await closeCalendarPopupIfOpen(page);
        
        // Find dynamic selectors for critical fields
        const titleSelector = await findDynamicSelector(page, 'reservation_title');
        const numberSelector = await findDynamicSelector(page, 'reservation_number');
        
        if (!titleSelector || !numberSelector) {
            console.log('  ⚠️  Could not find critical field selectors - form may have changed');
            return false;
        }
        
        // Check only reservation title and booking number (the most critical ones)
        const reservationTitleValue = await page.inputValue(titleSelector);
        const bookingNumberValue = await page.inputValue(numberSelector);
        
        const titleOk = reservationTitleValue && reservationTitleValue.trim() !== '';
        const bookingOk = bookingNumberValue && bookingNumberValue.trim() !== '';
        
        if (titleOk && bookingOk) {
            console.log('  ✅ Critical fields validated - reservation title and booking number intact');
        } else {
            console.log('  ⚠️  Critical fields may have been cleared - proceeding with caution');
        }
        
        return true;
    } catch (error) {
        console.error('  ❌ Error during critical field validation:', error);
        return false;
    }
}

// Helper function to close any active calendar popups and remove freezer overlay
async function closeCalendarPopupIfOpen(page) {
    try {
        console.log('    🗓️ Checking for active calendar popups...');
        
        // Check if freezer div is present (indicates modal/popup is open)
        const freezerDiv = await page.locator('div.zc-freezer').first();
        const isFreezerVisible = await freezerDiv.isVisible().catch(() => false);
        
        if (isFreezerVisible) {
            console.log('    ⚠️  Calendar popup detected (freezer div active), closing...');
            
            // Try multiple methods to close the calendar popup
            // Method 1: Press Escape key
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
            
            // Check if freezer is still there
            const stillFrozen = await page.locator('div.zc-freezer').first().isVisible().catch(() => false);
            
            if (stillFrozen) {
                console.log('    🔄 Escape didn\'t work, trying to click outside...');
                // Method 2: Click outside the popup area
                await page.click('body', { position: { x: 50, y: 50 } });
                await page.waitForTimeout(500);
            }
            
            // Check again
            const finalCheck = await page.locator('div.zc-freezer').first().isVisible().catch(() => false);
            if (finalCheck) {
                console.log('    🔄 Still frozen, trying to click close button...');
                // Method 3: Try to find and click any close button
                try {
                    await page.click('[aria-label="Close"]', { timeout: 2000 });
                } catch (e) {
                    try {
                        await page.click('.close', { timeout: 2000 });
                    } catch (e2) {
                        // Final attempt - multiple escape presses
                        await page.keyboard.press('Escape');
                        await page.keyboard.press('Escape');
                        await page.waitForTimeout(1000);
                    }
                }
            }
            
            // Wait for freezer to disappear
            try {
                await page.waitForSelector('div.zc-freezer', { state: 'hidden', timeout: 3000 });
                console.log('    ✅ Calendar popup closed successfully');
            } catch (e) {
                console.log('    ⚠️  Calendar popup may still be active');
            }
            
        } else {
            console.log('    ✅ No calendar popup detected');
        }
        
        // Add a small delay to ensure page is stable
        await page.waitForTimeout(500);
        return true;
        
    } catch (error) {
        console.log('    ⚠️  Error checking/closing calendar popup:', error.message);
        return false;
    }
}

// Helper function to detect if browser/page has crashed
function isBrowserCrashed(error) {
    const crashMessages = [
        'Target page, context or browser has been closed',
        'Page closed',
        'Browser closed',
        'Context closed',
        'Protocol error',
        'Connection closed'
    ];
    
    return crashMessages.some(msg => error.message.includes(msg));
}

// Helper function to detect if browser/page has timed out (unresponsive)
function isBrowserTimeout(error) {
    const timeoutMessages = [
        'Timeout',
        'timeout',
        'exceeded',
        'waiting for',
        'locator',
        'element to be visible',
        'element to be enabled',
        'intercepts pointer events',
        'waiting for element'
    ];
    
    return timeoutMessages.some(msg => error.message.includes(msg));
}

// Helper function to recover from browser crash or timeout
async function recoverFromBrowserIssue(page, record, issueType, attempt = 1, maxAttempts = 2) {
    try {
        console.log(`  🔄 Browser ${issueType} detected, attempting recovery (attempt ${attempt}/${maxAttempts})...`);
        
        if (attempt > maxAttempts) {
            console.log(`  ❌ Maximum recovery attempts reached for ${record['Client Name']}`);
            return false;
        }
        
        // For timeouts, try to clear any blocking elements first
        if (issueType === 'timeout') {
            console.log('  🔄 Timeout detected, attempting to clear blocking elements...');
            try {
                // Close any calendar popups that might be blocking
                await closeCalendarPopupIfOpen(page);
                
                // Try multiple escape keys to close any modals/popups
                await page.keyboard.press('Escape');
                await page.keyboard.press('Escape');
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
                
                // Test if page is responsive now
                const titleSelector = await findDynamicSelector(page, 'reservation_title');
                if (titleSelector) {
                    await page.waitForSelector(titleSelector, { timeout: 5000 });
                } else {
                    await page.waitForSelector('#zc-Reservation_Title', { timeout: 5000 });
                }
                console.log('  ✅ Page responsive after clearing blocking elements');
                return true;
            } catch (e) {
                console.log('  🔄 Page still unresponsive, attempting refresh...');
            }
        }
        
        // Check if page is still responsive (for crashes)
        if (issueType === 'crash') {
            try {
                await page.waitForTimeout(1000);
                await page.url(); // This will throw if page is closed
                console.log('  ✅ Page is actually still responsive, continuing...');
                return true;
            } catch (e) {
                console.log('  🔄 Page is indeed crashed, attempting to refresh...');
            }
        }
        
        // Try to refresh the page
        try {
            console.log('  🔄 Attempting page reload...');
            await page.reload({ waitUntil: 'networkidle', timeout: 15000 });
            await page.waitForTimeout(3000);
            console.log('  🔄 Page reloaded, checking for login state...');
        } catch (e) {
            console.log('  🔄 Reload failed, navigating to Quick Submit form...');
            await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit', { waitUntil: 'networkidle', timeout: 15000 });
            await page.waitForTimeout(5000);
        }
        
        // Verify we're on the right page and logged in
        try {
            const titleSelector = await findDynamicSelector(page, 'reservation_title');
            if (titleSelector) {
                await page.waitForSelector(titleSelector, { timeout: 15000 });
            } else {
                await page.waitForSelector('#zc-Reservation_Title', { timeout: 15000 });
            }
            console.log('  ✅ Successfully recovered to Quick Submit form');
            
            // Ensure the form is in a clean state after recovery
            await page.waitForTimeout(2000); // Allow form to fully load
            
            return true;
        } catch (e) {
            console.log('  ⚠️  Form not found after refresh, may need to re-login');
            // Try to navigate to the form again
            try {
                await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
                const titleSelector = await findDynamicSelector(page, 'reservation_title');
                if (titleSelector) {
                    await page.waitForSelector(titleSelector, { timeout: 15000 });
                } else {
                    await page.waitForSelector('#zc-Reservation_Title', { timeout: 15000 });
                }
                console.log('  ✅ Successfully navigated to Quick Submit form');
                
                // Ensure the form is in a clean state after navigation
                await page.waitForTimeout(2000); // Allow form to fully load
                
                return true;
            } catch (e2) {
                console.log('  ❌ Failed to recover, form not accessible');
                return false;
            }
        }
        
    } catch (error) {
        console.log(`  ❌ Recovery attempt failed: ${error.message}`);
        return false;
    }
}

// Function to send processed data to webhook
async function sendToWebhook(processedData) {
    try {
        const webhookUrl = 'https://n8n.collectgreatstories.com/webhook/bookings-from-tpi';
        
        console.log('Sending data to webhook...');
        console.log(`📤 Sending ${processedData.length} records to webhook`);
        
        const response = await axios.post(webhookUrl, processedData, {
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 10000 // 10 second timeout
        });

        if (response.status === 200 || response.status === 201) {
            console.log('✅ Data successfully sent to webhook');
            console.log(`📊 Response status: ${response.status}`);
        } else {
            console.error('❌ Webhook request failed:', response.status, response.statusText);
        }
    } catch (error) {
        console.error('❌ Error sending data to webhook:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
            console.error('Response status:', error.response.status);
        }
    }
}

module.exports = { loginAndProcess };
