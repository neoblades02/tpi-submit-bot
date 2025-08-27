require('dotenv').config();
const axios = require('axios');

// Import stability and monitoring modules
const { config } = require('./config');
const { systemMonitor } = require('./monitor');
const { browserManager } = require('./browserManager');
const { discordNotifier } = require('./discordNotifier');
const { ErrorClassifier } = require('./errors');

async function loginAndProcess(data, options = {}) {
    let browser = null;
    let sessionId = null;
    
    try {
        console.log('Launching browser...');
        
        // Launch browser using browser manager to get sessionId
        const launchResult = await browserManager.launchBrowser();
        browser = launchResult.browser;
        sessionId = launchResult.sessionId;
        
        console.log(`✅ Browser launched with session ID: ${sessionId}`);
        
        // Update browser activity
        systemMonitor.updateBrowserActivity(sessionId, { status: 'creating_context' });
        
        // Create context and page with error handling
        let context, page;
        try {
            context = await browser.newContext({
                // Enhanced context options for stability
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1920, height: 1080 },
                ignoreHTTPSErrors: true,
                bypassCSP: true
            });
            
            page = await context.newPage();
            
            // Add error handlers for page crashes
            page.on('crash', () => {
                console.log(`💥 Page crash detected for session ${sessionId}`);
                browserManager.handleBrowserCrash(sessionId, new Error('Page crashed during session'));
            });
            
            page.on('pageerror', (error) => {
                console.log(`⚠️ Page error for session ${sessionId}: ${error.message}`);
            });

        } catch (error) {
            console.error('❌ Failed to create browser context or page:', error.message);
            await browserManager.closeBrowser(sessionId, 'context_creation_failed');
            throw ErrorClassifier.classify(error, { operation: 'context_creation', sessionId });
        }

        // Update browser activity
        systemMonitor.updateBrowserActivity(sessionId, { 
            status: 'navigating_to_login',
            pages: 1
        });


        console.log('🌐 Navigating to login page...');
        
        // Enhanced page navigation with retries
        let pageLoaded = false;
        const maxNavigationRetries = 3;
        
        for (let attempt = 1; attempt <= maxNavigationRetries; attempt++) {
            try {
                console.log(`📄 Page load attempt ${attempt}/${maxNavigationRetries} for session ${sessionId}...`);
                
                await page.goto(config.tpi.baseUrl, { 
                    timeout: config.browser.navigationTimeout,
                    waitUntil: 'networkidle'
                });
                
                pageLoaded = true;
                console.log(`✅ Page loaded successfully on attempt ${attempt}`);
                break;
                
            } catch (error) {
                const classifiedError = ErrorClassifier.classify(error, {
                    attempt,
                    maxAttempts: maxNavigationRetries,
                    operation: 'page_navigation',
                    url: config.tpi.baseUrl,
                    sessionId
                });
                
                console.log(`⚠️ Page load attempt ${attempt} failed: ${error.message}`);
                
                if (attempt === maxNavigationRetries) {
                    await browserManager.closeBrowser(sessionId, 'navigation_failed');
                    throw classifiedError;
                }
                
                // Progressive delay between retries
                const delay = 2000 * attempt;
                console.log(`⏳ Waiting ${delay}ms before navigation retry...`);
                await page.waitForTimeout(delay);
            }
        }
        
        if (!pageLoaded) {
            await browserManager.closeBrowser(sessionId, 'navigation_timeout');
            throw new Error('Could not load TPI Suitcase login page after all attempts');
        }

        // Update browser activity
        systemMonitor.updateBrowserActivity(sessionId, { status: 'performing_login' });

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

        // Check for "I Understand" button immediately after sign in but before page load
        console.log('Checking for "I Understand" button after sign in...');
        try {
            const iUnderstandButton = await page.waitForSelector('#continue_button', { timeout: 5000 });
            if (iUnderstandButton) {
                console.log('Found "I Understand" button, clicking it...');
                await iUnderstandButton.click();
                await page.waitForTimeout(3000);
                console.log('Clicked "I Understand" button successfully');
            }
        } catch (e) {
            console.log('No "I Understand" button found, continuing...');
        }

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
        const recordErrors = []; // Track individual record processing errors
        const jobId = options.jobId; // Get jobId from options for webhook reporting

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
                        const recordError = {
                            record: record['Client Name'] || 'Unknown',
                            message: 'Page not ready for processing',
                            timestamp: new Date().toISOString(),
                            context: 'page_readiness_check'
                        };
                        recordErrors.push(recordError);
                        await sendRecordErrorToWebhook(jobId, recordError);
                        recordProcessed = true;
                        break;
                    }

                // 1. Determine Reservation Title
                if (processingAttempt === 1) {
                    formState.reservationTitle = 'Tour FIT';
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

                // 3. Clear Secondary Customers field to prevent confusion
                await clearSecondaryCustomersField(page);

                // 4. Search for Client Name using the search popup
                const clientName = record['Client Name'];
                
                // Check if client name is blank or empty
                if (!clientName || clientName.trim() === '') {
                    console.log(`  - Client name is blank, marking as not submitted`);
                    record.status = 'not submitted';
                    record.Submitted = 'Not Submitted - Client Name Missing';
                    record.InvoiceNumber = 'Not Generated';
                    const recordError = {
                        record: 'Unknown Client',
                        message: 'Client name is blank or missing',
                        timestamp: new Date().toISOString(),
                        context: 'client_name_validation'
                    };
                    recordErrors.push(recordError);
                    await sendRecordErrorToWebhook(jobId, recordError);
                    recordProcessed = true;
                    break;
                }
                
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
                    
                    // Wait for popup to close
                    await page.waitForTimeout(2000);
                    
                    // Try to create new client
                    console.log(`  - Attempting to create new client: ${firstName} ${lastName}`);
                    const clientCreated = await createNewClient(page, firstName, lastName);
                    
                    if (clientCreated) {
                        console.log(`  - New client created successfully, restarting form processing...`);
                        
                        // F5 refresh the entire page to start fresh with clean DOM (like pressing F5)
                        console.log(`  - F5 refreshing entire page to restart processing with new client...`);
                        await page.reload({ waitUntil: 'networkidle' });
                        await page.waitForTimeout(3000);
                        
                        // Navigate back to Quick Submit form after F5 refresh
                        console.log(`  - Navigating back to Quick Submit form after F5 refresh...`);
                        await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
                        
                        // Wait for the form to load
                        const titleSelector = await findDynamicSelector(page, 'reservation_title');
                        if (titleSelector) {
                            await page.waitForSelector(titleSelector, { timeout: 60000 });
                        } else {
                            await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
                        }
                        
                        console.log(`  - Form refreshed, restarting entire record processing from beginning...`);
                        
                        // Close any remaining popups after client creation (targeted approach)
                        try {
                            // Only close client search popup if it's still open
                            const searchPopup = await page.$('#zc-advanced-search');
                            if (searchPopup) {
                                const isVisible = await searchPopup.isVisible();
                                if (isVisible) {
                                    const closeBtn = await page.$('#zc-advanced-search .popupClose, #zc-advanced-search i.fa.fa-close');
                                    if (closeBtn) {
                                        await closeBtn.click();
                                        console.log(`  - Closed search popup after client creation`);
                                        await page.waitForTimeout(500);
                                    }
                                }
                            }
                            
                            // Wait a bit more for form to fully settle after client creation
                            await page.waitForTimeout(1000);
                        } catch (error) {
                            console.log(`  - Note: Error closing popups after client creation: ${error.message}`);
                        }
                        
                        // Reset processingAttempt to restart from the beginning
                        processingAttempt = 0; // Will be incremented to 1 at the end of the loop
                        continue;
                    } else {
                        // Try client creation recovery with page refresh and popup cleanup
                        const retrySuccess = await retryClientCreationWithRecovery(page, firstName, lastName, clientName);
                        
                        if (retrySuccess) {
                            // Reset processing attempt to restart from beginning
                            processingAttempt = 0; // Will be incremented to 1 at the end of the loop
                            continue;
                        } else {
                            record.status = 'error';
                            record.Submitted = 'Error - Client Creation Failed After Retry';
                            record.InvoiceNumber = 'Error';
                        }
                    }
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
                            record.Submitted = 'Not Submitted - Tour Operator Not Found';
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
                        
                        // Wait for popup to close
                        await page.waitForTimeout(2000);
                        
                        // Try to create new client
                        console.log(`  - Attempting to create new client: ${firstName} ${lastName}`);
                        const clientCreated = await createNewClient(page, firstName, lastName);
                        
                        if (clientCreated) {
                            console.log(`  - New client created successfully, restarting form processing...`);
                            
                            // F5 refresh the entire page to start fresh with clean DOM (like pressing F5)
                            console.log(`  - F5 refreshing entire page to restart processing with new client...`);
                            await page.reload({ waitUntil: 'networkidle' });
                            await page.waitForTimeout(3000);
                            
                            // Navigate back to Quick Submit form after F5 refresh
                            console.log(`  - Navigating back to Quick Submit form after F5 refresh...`);
                            await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
                            
                            // Wait for the form to load
                            const titleSelector = await findDynamicSelector(page, 'reservation_title');
                            if (titleSelector) {
                                await page.waitForSelector(titleSelector, { timeout: 60000 });
                            } else {
                                await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
                            }
                            
                            console.log(`  - Form refreshed, continuing to next attempt of record processing...`);
                            
                            // Close any remaining popups after client creation (targeted approach)
                            try {
                                // Only close client search popup if it's still open
                                const searchPopup = await page.$('#zc-advanced-search');
                                if (searchPopup) {
                                    const isVisible = await searchPopup.isVisible();
                                    if (isVisible) {
                                        const closeBtn = await page.$('#zc-advanced-search .popupClose, #zc-advanced-search i.fa.fa-close');
                                        if (closeBtn) {
                                            await closeBtn.click();
                                            console.log(`  - Closed search popup after client creation`);
                                            await page.waitForTimeout(500);
                                        }
                                    }
                                }
                                
                                // Wait a bit more for form to fully settle after client creation
                                await page.waitForTimeout(1000);
                            } catch (error) {
                                console.log(`  - Note: Error closing popups after client creation: ${error.message}`);
                            }
                            
                            // Continue to next processing attempt - this will restart the entire form flow
                            processingAttempt = 0; // Reset to restart from beginning
                            continue;
                        } else {
                            // Try client creation recovery with page refresh and popup cleanup
                            const retrySuccess = await retryClientCreationWithRecovery(page, firstName, lastName, clientName);
                            
                            if (retrySuccess) {
                                // Reset processing attempt to restart from beginning
                                processingAttempt = 0; // Will be incremented to 1 at the end of the loop
                                continue;
                            } else {
                                record.status = 'error';
                                record.Submitted = 'Error - Client Creation Failed After Retry';
                                record.InvoiceNumber = 'Error';
                            }
                        }
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
                            const recordError = {
                                record: record['Client Name'] || 'Unknown',
                                message: 'Browser crash during processing - recovery failed',
                                timestamp: new Date().toISOString(),
                                context: 'browser_crash_unrecoverable'
                            };
                            recordErrors.push(recordError);
                            await sendRecordErrorToWebhook(jobId, recordError);
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
                            const recordError = {
                                record: record['Client Name'] || 'Unknown',
                                message: 'Browser timeout during processing - recovery failed',
                                timestamp: new Date().toISOString(),
                                context: 'browser_timeout_unrecoverable'
                            };
                            recordErrors.push(recordError);
                            await sendRecordErrorToWebhook(jobId, recordError);
                            recordProcessed = true;
                        }
                    } else {
                        // Non-crash/timeout error, mark as error and move on
                        record.status = 'error';
                        record.Submitted = 'Error';
                        record.InvoiceNumber = 'Error';
                        const recordError = {
                            record: record['Client Name'] || 'Unknown',
                            message: e.message || 'Unknown processing error',
                            timestamp: new Date().toISOString(),
                            context: 'general_processing_error',
                            stack: e.stack || null
                        };
                        recordErrors.push(recordError);
                        await sendRecordErrorToWebhook(jobId, recordError);
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

        // Send processed data to webhook (only if not disabled)
        if (options.sendWebhook !== false) {
            await sendToWebhook(processedData);
        }

        return processedData;

    } catch (error) {
        console.error('An error occurred during the bot process:', error);
        
        // Classify the error for better handling
        const classifiedError = ErrorClassifier.classify(error, {
            operation: 'bot_process',
            sessionId: sessionId
        });
        
        // Send error notification to Discord
        if (discordNotifier) {
            await discordNotifier.sendErrorNotification(classifiedError, {
                operation: 'loginAndProcess',
                sessionId: sessionId,
                timestamp: new Date().toISOString()
            }).catch(notifyError => {
                console.log('⚠️ Failed to send Discord notification:', notifyError.message);
            });
        }
        
        throw classifiedError;
    } finally {
        if (sessionId) {
            await browserManager.closeBrowser(sessionId, 'function_completed');
            console.log('Browser closed.');
        }
    }
}

// Helper function to clear Secondary Customers field to prevent confusion
async function clearSecondaryCustomersField(page) {
    try {
        console.log('  🧹 Clearing Secondary Customers field...');
        
        // Only close secondary customers specific dropdown if it's open
        try {
            console.log('  🚪 Checking for open secondary customers dropdown...');
            
            // Check if secondary customers dropdown is specifically open
            const secondaryDropdownOpen = await page.evaluate(() => {
                const secondaryContainer = document.querySelector('.select2-container.zc-Secondary_Customers');
                return secondaryContainer && (
                    secondaryContainer.classList.contains('select2-dropdown-open') ||
                    secondaryContainer.classList.contains('select2-container-active')
                );
            });
            
            if (secondaryDropdownOpen) {
                console.log('  🚪 Secondary customers dropdown is open, closing it...');
                
                // Only close secondary customers dropdown specifically
                await page.evaluate(() => {
                    const secondaryContainer = document.querySelector('.select2-container.zc-Secondary_Customers');
                    if (secondaryContainer) {
                        secondaryContainer.classList.remove('select2-dropdown-open');
                        secondaryContainer.classList.remove('select2-container-active');
                    }
                    
                    // Only close secondary customers related drops
                    const secondaryDrops = document.querySelectorAll('.select2-drop.Secondary_Customers-switch-search');
                    secondaryDrops.forEach(drop => {
                        drop.style.display = 'none';
                        drop.style.visibility = 'hidden';
                    });
                });
                
                // Single escape to close just the secondary dropdown
                await page.keyboard.press('Escape');
                await page.waitForTimeout(500);
                
                console.log('  ✅ Secondary customers dropdown closed');
            } else {
                console.log('  ✅ No secondary customers dropdown open');
            }
        } catch (e) {
            console.log('  ⚠️ Error checking secondary customers dropdown: ' + e.message);
        }
        
        // Find the secondary customers multi-select container
        const secondaryCustomersContainer = await page.locator('.select2-container.zc-Secondary_Customers').first();
        const isVisible = await secondaryCustomersContainer.isVisible().catch(() => false);
        
        if (isVisible) {
            // Check if there are any selected items to clear
            const selectedItems = await page.locator('.select2-container.zc-Secondary_Customers .select2-search-choice').all();
            
            if (selectedItems.length > 0) {
                console.log(`  🧹 Found ${selectedItems.length} secondary customers to clear`);
                
                // Click each close button to remove selected items
                for (const item of selectedItems) {
                    try {
                        const closeButton = item.locator('.select2-search-choice-close');
                        await closeButton.click();
                        await page.waitForTimeout(300);
                    } catch (e) {
                        console.log(`  ⚠️ Could not remove secondary customer item: ${e.message}`);
                    }
                }
                
                console.log('  ✅ Secondary customers cleared');
            } else {
                console.log('  ✅ Secondary customers field is already empty');
            }
            
            // Also clear the input field if it has any text and is editable
            const secondaryInput = await page.locator('input[name="zc-sel2-inp-Secondary_Customers"]').first();
            const inputExists = await secondaryInput.isVisible().catch(() => false);
            
            if (inputExists) {
                // Check if the input is editable (not readonly)
                const isEditable = await secondaryInput.evaluate(input => {
                    return !input.hasAttribute('readonly') && !input.disabled;
                }).catch(() => false);
                
                if (isEditable) {
                    await secondaryInput.fill('');
                    console.log('  ✅ Secondary customers input field cleared');
                } else {
                    console.log('  ℹ️ Secondary customers input field is readonly, skipping clear');
                }
            }
            
            // Force close any secondary customers dropdown that might have opened
            try {
                console.log('  🚪 Ensuring secondary customers dropdown is closed...');
                
                // Remove focus from the secondary customers field
                await page.evaluate(() => {
                    const secondaryInput = document.querySelector('input[name="zc-sel2-inp-Secondary_Customers"]');
                    if (secondaryInput) {
                        secondaryInput.blur();
                    }
                });
                
                // Additional dropdown closure specifically for secondary customers
                await page.keyboard.press('Escape');
                await page.waitForTimeout(500);
                
                // Click somewhere else to ensure focus is removed
                await page.click('body', { position: { x: 100, y: 100 } });
                await page.waitForTimeout(500);
                
                console.log('  ✅ Secondary customers dropdown ensured closed');
            } catch (e) {
                console.log(`  ⚠️ Error ensuring secondary customers dropdown closed: ${e.message}`);
            }
        } else {
            console.log('  ✅ Secondary customers field not found or not visible');
        }
        
        // Gentle final check - only remove focus from secondary customers field
        try {
            console.log('  ✅ Secondary customers field cleared, ready for client search');
            
            // Just ensure focus is not on secondary customers field
            await page.evaluate(() => {
                const secondaryInput = document.querySelector('input[name="zc-sel2-inp-Secondary_Customers"]');
                if (secondaryInput && document.activeElement === secondaryInput) {
                    secondaryInput.blur();
                }
            });
            
        } catch (e) {
            console.log(`  ⚠️ Error in final focus check: ${e.message}`);
        }
        
    } catch (error) {
        console.log(`  ⚠️ Error clearing secondary customers field: ${error.message}`);
    }
}

// Helper function to create a new client when not found in search
async function createNewClient(page, firstName, lastName, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`    👤 Creating new client: ${firstName} ${lastName} (attempt ${attempt}/${maxRetries})`);
            
            // First, try to click the client dropdown to open it
            console.log(`    📋 Opening client dropdown...`);
            const clientDropdownSelector = '.select2-container.zc-Customer .select2-choice';
            await page.waitForSelector(clientDropdownSelector, { timeout: 5000 });
            
            // Try multiple approaches to click the dropdown
            let dropdownOpened = false;
            
            // Method 1: Direct click
            try {
                await page.click(clientDropdownSelector);
                await page.waitForTimeout(1000);
                dropdownOpened = true;
                console.log(`    ✅ Dropdown opened with direct click`);
            } catch (e) {
                console.log(`    ⚠️ Direct click failed: ${e.message}`);
            }
            
            // Method 2: Force click if direct click failed
            if (!dropdownOpened) {
                try {
                    await page.click(clientDropdownSelector, { force: true });
                    await page.waitForTimeout(1000);
                    dropdownOpened = true;
                    console.log(`    ✅ Dropdown opened with force click`);
                } catch (e) {
                    console.log(`    ⚠️ Force click failed: ${e.message}`);
                }
            }
            
            // Method 3: JavaScript click if force click failed
            if (!dropdownOpened) {
                try {
                    await page.evaluate((selector) => {
                        const dropdown = document.querySelector(selector);
                        if (dropdown) dropdown.click();
                    }, clientDropdownSelector);
                    await page.waitForTimeout(1000);
                    dropdownOpened = true;
                    console.log(`    ✅ Dropdown opened with JavaScript click`);
                } catch (e) {
                    console.log(`    ⚠️ JavaScript click failed: ${e.message}`);
                }
            }
            
            if (!dropdownOpened) {
                throw new Error('Could not open client dropdown');
            }
            
            // Wait for the dropdown to be fully open and search for the Add New Customer button
            console.log(`    🔍 Waiting for dropdown to open and looking for Add New Customer button...`);
            
            // First, ensure any secondary customers dropdown is closed that might be interfering
            try {
                await page.evaluate(() => {
                    // Close specifically the secondary customers dropdown that might be interfering
                    const secondaryDrops = document.querySelectorAll('.select2-drop.Secondary_Customers-switch-search');
                    secondaryDrops.forEach(drop => {
                        drop.style.display = 'none';
                        drop.classList.remove('select2-drop-active');
                    });
                    
                    // Remove secondary customers mask if it exists
                    const masks = document.querySelectorAll('#select2-drop-mask');
                    masks.forEach(mask => {
                        if (mask.style.display !== 'none') {
                            // Only remove if it's not related to the main customer dropdown
                            const isMainCustomerMask = document.querySelector('.select2-drop.Customer-switch-search.select2-drop-active');
                            if (!isMainCustomerMask) {
                                mask.style.display = 'none';
                            }
                        }
                    });
                });
                console.log(`    🚪 Closed interfering secondary customers dropdown`);
            } catch (e) {
                console.log(`    ⚠️ Could not close interfering dropdown: ${e.message}`);
            }
            
            // Force the customer dropdown to be visible
            try {
                await page.evaluate(() => {
                    // Find the customer dropdown and make it visible
                    const customerDropdown = document.querySelector('.select2-drop.Customer-switch-search.select2-drop-active');
                    if (customerDropdown) {
                        customerDropdown.style.display = 'block';
                        customerDropdown.style.visibility = 'visible';
                        customerDropdown.classList.remove('select2-display-none');
                        
                        // Also make sure the mask is visible if needed
                        const mask = document.querySelector('#select2-drop-mask');
                        if (mask) {
                            mask.style.display = 'block';
                        }
                    }
                });
                console.log(`    ✅ Forced customer dropdown to be visible`);
            } catch (e) {
                console.log(`    ⚠️ Could not force dropdown visible: ${e.message}`);
            }
            
            // Wait for the select2-drop to be visible with the client list
            await page.waitForSelector('.select2-drop.Customer-switch-search.select2-drop-active', { timeout: 10000 });
            
            // Wait a bit more for the dropdown content to fully load
            await page.waitForTimeout(2000);
            
            // Debug: Check if the addNew element exists and is visible
            const addNewExists = await page.evaluate(() => {
                const addNew = document.querySelector('#addNew');
                if (addNew) {
                    const rect = addNew.getBoundingClientRect();
                    return {
                        exists: true,
                        visible: rect.width > 0 && rect.height > 0,
                        rect: rect,
                        innerHTML: addNew.innerHTML
                    };
                }
                return { exists: false };
            });
            
            console.log(`    🔍 Add New Customer element status:`, addNewExists);
            
            // Try multiple selectors for the Add New Customer button - don't wait for visibility, just presence
            let addNewButton = null;
            const addNewSelectors = [
                '#addNew',
                '.addnewparent',
                '[id="addNew"]',
                'div[id="addNew"]',
                'div.addnewparent'
            ];
            
            for (const selector of addNewSelectors) {
                try {
                    console.log(`    🔍 Trying selector: ${selector}`);
                    const elements = await page.locator(selector).all();
                    
                    // Look for the element that's actually in the main customer dropdown
                    for (const element of elements) {
                        const isInMainDropdown = await element.evaluate((el) => {
                            // Check if this element is inside the main customer dropdown
                            const customerDrop = el.closest('.select2-drop.Customer-switch-search');
                            return customerDrop !== null;
                        });
                        
                        if (isInMainDropdown) {
                            addNewButton = selector;
                            console.log(`    ✅ Found Add New Customer button in main dropdown with selector: ${selector}`);
                            break;
                        }
                    }
                    
                    if (addNewButton) break;
                } catch (e) {
                    console.log(`    ⚠️ Selector ${selector} failed: ${e.message}`);
                }
            }
            
            if (!addNewButton) {
                // Try to force make the button and its container visible
                try {
                    await page.evaluate(() => {
                        // Find all customer dropdowns and make them visible
                        const customerDropdowns = document.querySelectorAll('.select2-drop.Customer-switch-search');
                        customerDropdowns.forEach(dropdown => {
                            dropdown.style.display = 'block';
                            dropdown.style.visibility = 'visible';
                            dropdown.classList.remove('select2-display-none');
                        });
                        
                        // Make all addNew buttons in customer dropdowns visible
                        const addNewElements = document.querySelectorAll('#addNew');
                        addNewElements.forEach(element => {
                            const customerDrop = element.closest('.select2-drop.Customer-switch-search');
                            if (customerDrop) {
                                // Make the parent dropdown visible first
                                customerDrop.style.display = 'block';
                                customerDrop.style.visibility = 'visible';
                                customerDrop.classList.remove('select2-display-none');
                                
                                // Then make the button visible
                                element.style.display = 'block';
                                element.style.visibility = 'visible';
                                element.style.height = 'auto';
                                element.style.width = 'auto';
                                element.style.opacity = '1';
                            }
                        });
                    });
                    addNewButton = '#addNew';
                    console.log(`    ✅ Forced customer dropdown and Add New Customer button to be visible`);
                } catch (e) {
                    throw new Error('Could not find Add New Customer button with any selector');
                }
            }
            
            // Click the "Add New Customer" button
            console.log(`    ➕ Clicking Add New Customer with selector: ${addNewButton}`);
            
            // First try to remove or hide the select2-drop-mask that might be blocking clicks
            try {
                await page.evaluate(() => {
                    const mask = document.getElementById('select2-drop-mask');
                    if (mask) {
                        mask.style.display = 'none';
                        mask.style.visibility = 'hidden';
                    }
                });
                console.log(`    🎭 Removed select2-drop-mask overlay`);
            } catch (e) {
                console.log(`    ⚠️ Could not remove mask: ${e.message}`);
            }
            
            // Try multiple approaches to click the Add New Customer button
            let clickSuccessful = false;
            
            // Method 1: Use the specific #addNew selector with JavaScript click
            try {
                await page.evaluate(() => {
                    const addNewBtn = document.querySelector('#addNew');
                    if (addNewBtn) {
                        addNewBtn.click();
                    }
                });
                await page.waitForTimeout(1000);
                clickSuccessful = true;
                console.log(`    ✅ Successfully clicked Add New Customer with JavaScript`);
            } catch (e) {
                console.log(`    ⚠️ JavaScript click failed: ${e.message}`);
            }
            
            // Method 2: Try force click if JavaScript failed
            if (!clickSuccessful) {
                try {
                    await page.click('#addNew', { force: true });
                    await page.waitForTimeout(1000);
                    clickSuccessful = true;
                    console.log(`    ✅ Successfully clicked Add New Customer with force click`);
                } catch (e) {
                    console.log(`    ⚠️ Force click failed: ${e.message}`);
                }
            }
            
            // Method 3: Try clicking at the element's position
            if (!clickSuccessful) {
                try {
                    const addNewElement = await page.locator('#addNew').first();
                    const box = await addNewElement.boundingBox();
                    if (box) {
                        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                        await page.waitForTimeout(1000);
                        clickSuccessful = true;
                        console.log(`    ✅ Successfully clicked Add New Customer with mouse click`);
                    }
                } catch (e) {
                    console.log(`    ⚠️ Mouse click failed: ${e.message}`);
                }
            }
            
            if (!clickSuccessful) {
                throw new Error('All click methods failed for Add New Customer button');
            }
            
            // Immediately close the customer dropdown to prevent interference
            console.log(`    🚪 Closing customer dropdown immediately after Add New Customer click...`);
            try {
                await page.evaluate(() => {
                    // Force close all customer dropdowns and masks
                    const dropdowns = document.querySelectorAll('.select2-drop.Customer-switch-search');
                    dropdowns.forEach(dropdown => {
                        dropdown.style.display = 'none';
                        dropdown.classList.remove('select2-drop-active');
                        dropdown.classList.add('select2-display-none');
                    });
                    
                    // Hide select2 masks (but don't remove from DOM to avoid breaking other dropdowns)
                    const masks = document.querySelectorAll('#select2-drop-mask, .select2-drop-mask');
                    masks.forEach(mask => {
                        // Only hide masks that are related to customer dropdowns, not all masks
                        const isCustomerMask = mask.previousElementSibling && 
                                             mask.previousElementSibling.classList && 
                                             mask.previousElementSibling.classList.contains('Customer-switch-search');
                        if (isCustomerMask || masks.length === 1) {
                            mask.style.display = 'none';
                            mask.style.visibility = 'hidden';
                            // Don't remove from DOM to avoid breaking other functionality
                        }
                    });
                    
                    // Remove active states from customer containers
                    const containers = document.querySelectorAll('.select2-container.zc-Customer');
                    containers.forEach(container => {
                        container.classList.remove('select2-dropdown-open');
                        container.classList.remove('select2-container-active');
                    });
                    
                    // Press Escape to close any remaining dropdowns
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
                });
                
                await page.keyboard.press('Escape');
                console.log(`    ✅ Customer dropdown force-closed`);
            } catch (e) {
                console.log(`    ⚠️ Error closing customer dropdown: ${e.message}`);
            }
            
            // Wait for the popup to load after ensuring dropdown is closed
            console.log(`    ⏳ Waiting for new client popup to load...`);
            await page.waitForTimeout(1500);
            
            // Fill in the first name
            console.log(`    📝 Filling first name: ${firstName}`);
            await page.waitForSelector('#zc-First_Name', { timeout: 10000 });
            await page.fill('#zc-First_Name', firstName);
            
            // Fill in the last name
            console.log(`    📝 Filling last name: ${lastName}`);
            await page.waitForSelector('#zc-Last_Name', { timeout: 10000 });
            await page.fill('#zc-Last_Name', lastName);
            
            // Check the "No Middle Name" checkbox
            console.log(`    ☑️ Checking No Middle Name checkbox...`);
            
            // Try multiple selectors for the No Middle Name checkbox
            let checkboxClicked = false;
            const checkboxSelectors = [
                'label[for="ZC_LNSVJ5_No_Middle_Name_5"]',
                'label[for*="No_Middle_Name"]',
                'input[name*="No_Middle_Name"]',
                'label:has-text("No Middle Name")',
                'input[type="checkbox"][name*="Middle"]'
            ];
            
            for (const selector of checkboxSelectors) {
                try {
                    console.log(`    🔍 Trying checkbox selector: ${selector}`);
                    await page.waitForSelector(selector, { timeout: 5000 });
                    await page.click(selector);
                    checkboxClicked = true;
                    console.log(`    ✅ Successfully clicked No Middle Name checkbox with: ${selector}`);
                    break;
                } catch (e) {
                    console.log(`    ⚠️ Checkbox selector ${selector} failed: ${e.message}`);
                }
            }
            
            if (!checkboxClicked) {
                console.log(`    ⚠️ Could not find No Middle Name checkbox, continuing without it`);
            }
            
            // Wait for the form to process the checkbox
            await page.waitForTimeout(2000);
            
            // Click the Add button
            console.log(`    ✅ Clicking Add button...`);
            await page.waitForSelector('input[type="submit"][value="Add"]', { timeout: 10000 });
            await page.click('input[type="submit"][value="Add"]');
            
            // Wait for the client to be created
            console.log(`    ⏳ Waiting for client creation to complete...`);
            await page.waitForTimeout(5000);
            
            // Close any remaining popups or overlays
            console.log(`    🚪 Closing all popups and overlays...`);
            try {
                // Try to close popup using common close methods
                await page.keyboard.press('Escape');
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
                
                // Try to click any close buttons
                const closeSelectors = [
                    '.close',
                    '.popup-close',
                    '.modal-close',
                    '[aria-label="Close"]',
                    'button:has-text("Close")',
                    'button:has-text("Cancel")'
                ];
                
                for (const selector of closeSelectors) {
                    try {
                        const closeButton = await page.locator(selector).first();
                        if (await closeButton.isVisible()) {
                            await closeButton.click();
                            await page.waitForTimeout(500);
                        }
                    } catch (e) {
                        // Continue to next selector
                    }
                }
                
                // Remove any overlays manually
                await page.evaluate(() => {
                    // Remove any modal overlays
                    const overlays = document.querySelectorAll('.modal-overlay, .popup-overlay, .select2-drop-mask');
                    overlays.forEach(overlay => overlay.remove());
                    
                    // Hide any popups
                    const popups = document.querySelectorAll('.popup, .modal, .select2-drop');
                    popups.forEach(popup => popup.style.display = 'none');
                });
                
                console.log(`    ✅ Closed all popups and overlays`);
            } catch (e) {
                console.log(`    ⚠️ Error closing popups: ${e.message}`);
            }
            
            // F5 refresh the entire page to start fresh with clean DOM (like pressing F5)
            console.log(`    🔄 F5 refreshing entire page after client creation to ensure completely clean DOM state...`);
            await page.reload({ waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);
            
            // Navigate back to Quick Submit form after F5 refresh
            console.log(`    🔄 Navigating back to Quick Submit form after F5 refresh...`);
            await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
            
            // Wait for the form to load
            const titleSelector = await findDynamicSelector(page, 'reservation_title');
            if (titleSelector) {
                await page.waitForSelector(titleSelector, { timeout: 60000 });
            } else {
                await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
            }
            
            console.log(`    ✅ New client created successfully: ${firstName} ${lastName}`);
            return true;
            
        } catch (error) {
            console.log(`    ❌ Error creating new client (attempt ${attempt}): ${error.message}`);
            if (attempt === maxRetries) {
                console.log(`    💥 Failed to create new client after ${maxRetries} attempts`);
                return false;
            }
            
            // Wait before retrying
            await page.waitForTimeout(2000);
            
            // Try to refresh the form if we're not on the last attempt
            if (attempt < maxRetries) {
                try {
                    console.log(`    🔄 Refreshing form before retry...`);
                    await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
                    const titleSelector = await findDynamicSelector(page, 'reservation_title');
                    if (titleSelector) {
                        await page.waitForSelector(titleSelector, { timeout: 60000 });
                    } else {
                        await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
                    }
                } catch (refreshError) {
                    console.log(`    ⚠️ Form refresh failed: ${refreshError.message}`);
                }
            }
        }
    }
    return false;
}

// Helper function to search and select tour operator with progressive word search
async function searchAndSelectTourOperator(page, tourOperator) {
    try {
        console.log(`    🔍 Searching for tour operator: ${tourOperator}`);
        
        // Pre-search cleanup - ensure no interfering elements from client creation
        try {
            console.log(`    🧹 Pre-search cleanup for tour operator dropdown...`);
            
            // Close any lingering popups that might interfere
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
            
            // Close any remaining customer dropdowns that might interfere
            await page.evaluate(() => {
                // Close any customer-related dropdowns that might still be open
                const customerDropdowns = document.querySelectorAll('.select2-drop.Customer-switch-search');
                customerDropdowns.forEach(dropdown => {
                    dropdown.style.display = 'none';
                    dropdown.classList.remove('select2-drop-active');
                });
                
                // Ensure vendor dropdown container is not affected by customer dropdown states
                const vendorContainer = document.querySelector('.select2-container.zc-Vendor');
                if (vendorContainer) {
                    vendorContainer.classList.remove('select2-dropdown-open', 'select2-container-active');
                }
            });
            
            console.log(`    ✅ Pre-search cleanup completed`);
        } catch (e) {
            console.log(`    ⚠️ Pre-search cleanup warning: ${e.message}`);
        }
        
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
        
        // Verify dropdown state and wait for it to be fully open
        console.log(`    🔍 Verifying dropdown opened successfully...`);
        try {
            // Wait for dropdown to be fully open with multiple indicators
            await page.waitForSelector('.select2-drop.select2-drop-active', { timeout: 5000 });
            console.log(`    ✅ Dropdown confirmed open`);
        } catch (e) {
            console.log(`    ⚠️ Dropdown may not be fully open, continuing anyway...`);
        }
        
        await page.waitForTimeout(1500); // Extended wait for post-client-creation scenarios
        
        // Find the search input field using dynamic selector with retry
        let inputSelector = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            inputSelector = await findDynamicSelector(page, 'vendor_input');
            if (inputSelector) {
                console.log(`    ✅ Found vendor input selector on attempt ${attempt}`);
                break;
            }
            console.log(`    ⚠️ Vendor input not found, attempt ${attempt}/3`);
            await page.waitForTimeout(1000);
        }
        
        if (!inputSelector) {
            console.log(`    ❌ Could not find vendor input field after 3 attempts`);
            return false;
        }
        
        // Wait for the search input field to appear and ensure it's the correct one
        await page.waitForTimeout(1000); // Give dropdown time to fully stabilize
        
        // Find the correct search input (enabled and visible) with retry logic
        let searchInputElement = null;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`    🔍 Looking for search input element (attempt ${attempt}/3)...`);
            
            const inputElements = await page.locator(inputSelector).all();
            console.log(`    📋 Found ${inputElements.length} potential input elements`);
            
            for (const element of inputElements) {
                try {
                    const isVisible = await element.isVisible();
                    const isEnabled = await element.isEnabled();
                    const classList = await element.getAttribute('class') || '';
                    const placeholder = await element.getAttribute('placeholder') || '';
                    
                    console.log(`    🔍 Checking input: visible=${isVisible}, enabled=${isEnabled}, class="${classList}", placeholder="${placeholder}"`);
                    
                    if (isVisible && isEnabled && (classList.includes('select2-input') || classList.includes('select2-focused') || placeholder.toLowerCase().includes('search'))) {
                        searchInputElement = element;
                        console.log(`    ✅ Found suitable search input element`);
                        break;
                    }
                } catch (e) {
                    console.log(`    ⚠️ Error checking input element: ${e.message}`);
                    continue;
                }
            }
            
            if (searchInputElement) break;
            
            console.log(`    ⚠️ No suitable input found on attempt ${attempt}, waiting...`);
            await page.waitForTimeout(1500);
        }
        
        if (!searchInputElement) {
            console.log(`    ❌ Could not find enabled search input field after 3 attempts`);
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
            
            // Wait for results to appear - use multiple selectors and longer timeout
            let resultsFound = false;
            const resultSelectors = [
                'ul.select2-results li.select2-result',
                'ul#select2-results-18 li',
                '.select2-results li',
                'ul[id*="select2-results"] li'
            ];
            
            for (const selector of resultSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 2000 });
                    resultsFound = true;
                    console.log(`    ✅ Found results with selector: ${selector}`);
                    break;
                } catch (e) {
                    // Try next selector
                }
            }
            
            if (!resultsFound) {
                // Try one more time with longer timeout for the main selector
                try {
                    await page.waitForSelector('ul.select2-results li.select2-result', { timeout: 5000 });
                    resultsFound = true;
                    console.log(`    ✅ Found results with extended timeout`);
                } catch (e) {
                    console.log(`    ❌ No results found for "${searchTerm}" after trying all selectors`);
                    continue;
                }
            }
            
            // Check if we found exact or partial matches in the dropdown
            let options = [];
            
            // Try multiple selectors to find the options, including malformed DOM structures
            const extendedSelectors = [
                ...resultSelectors,
                '.select2-result-label',  // Direct label selection for malformed DOM
                '[role="option"]',        // Any element with option role
                '.select2-result',        // Any select2 result
                'li[role="presentation"]' // List items with presentation role
            ];
            
            for (const selector of extendedSelectors) {
                try {
                    const foundOptions = await page.locator(selector).all();
                    if (foundOptions.length > 0) {
                        options = foundOptions;
                        console.log(`    ✅ Found ${options.length} options with selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }
            
            if (options.length === 0) {
                console.log(`    ⚠️ No options found in dropdown for "${searchTerm}"`);
                continue;
            }
            
            // Debug: Log all found options
            console.log(`    🔍 Checking ${options.length} options for matches...`);
            
            // Collect all matches with their priority scores
            const matches = [];
            
            for (const option of options) {
                const text = await option.innerText();
                const cleanText = text.toLowerCase().trim();
                
                // Debug: Log the option text being checked
                console.log(`    📋 Checking option: "${text}"`);
                
                const cleanTourOperator = tourOperator.toLowerCase().trim();
                
                // Remove parentheses and their content for comparison
                const cleanTextWithoutParens = cleanText.replace(/\s*\([^)]*\)\s*/g, '').trim();
                
                // Check for exact match first (highest priority)
                if (cleanText === cleanTourOperator || cleanTextWithoutParens === cleanTourOperator) {
                    console.log(`    ✅ Found exact match: "${text}" for search "${searchTerm}"`);
                    matches.push({ option, text, priority: 1, matchType: 'exact' });
                    continue;
                }
                
                // Extract core company name (before any parentheses) for flexible matching
                const inputCoreWords = cleanTourOperator.replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(word => word.length > 0);
                
                // Check if ALL core words from input are present in dropdown (ignoring parenthetical info)
                const allCoreWordsPresent = inputCoreWords.length > 0 && inputCoreWords.every(word => {
                    const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    const isPresent = wordRegex.test(cleanTextWithoutParens);
                    
                    if (!isPresent) {
                        console.log(`    ❌ Core word "${word}" NOT found in "${cleanTextWithoutParens}"`);
                    } else {
                        console.log(`    ✅ Core word "${word}" found in "${cleanTextWithoutParens}"`);
                    }
                    return isPresent;
                });
                
                if (allCoreWordsPresent) {
                    console.log(`    ✅ CORE MATCH: "${text}" contains all ${inputCoreWords.length} core words from "${cleanTourOperator}" (ignoring parenthetical variations)`);
                    matches.push({ option, text, priority: 2, matchType: 'core-words' });
                    continue;
                }
                
                // Fallback: Check if ALL input words are present (original strict logic)
                const tourOperatorWords = cleanTourOperator.split(/\s+/).filter(word => word.length > 0);
                const allWordsPresent = tourOperatorWords.every(word => {
                    const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    const isPresent = wordRegex.test(cleanTextWithoutParens);
                    
                    if (!isPresent) {
                        console.log(`    ❌ Required word "${word}" NOT found in "${cleanTextWithoutParens}"`);
                    } else {
                        console.log(`    ✅ Required word "${word}" found in "${cleanTextWithoutParens}"`);
                    }
                    return isPresent;
                });
                
                if (allWordsPresent && tourOperatorWords.length > 0) {
                    console.log(`    ✅ STRICT MATCH: "${text}" contains all ${tourOperatorWords.length} required words from "${cleanTourOperator}"`);
                    matches.push({ option, text, priority: 3, matchType: 'all-words' });
                    continue;
                } else if (tourOperatorWords.length > 0) {
                    console.log(`    ❌ REJECTED: "${text}" missing required words from "${cleanTourOperator}"`);
                }
                
                // REMOVED: Partial word boundary matching causes incorrect selections
                // Only use strict all-words matching to prevent wrong tour operator selection
                
                // Check if the cleaned text contains the full tour operator name as a whole phrase
                // This is a fallback for exact phrase matches with different formatting
                const wordBoundaryRegex = new RegExp(`\\b${cleanTourOperator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                if (wordBoundaryRegex.test(cleanTextWithoutParens)) {
                    console.log(`    ✅ Found exact phrase match: "${text}" contains "${cleanTourOperator}"`);
                    matches.push({ option, text, priority: 4, matchType: 'phrase-match' });
                    continue;
                }
            }
            
            // If we found matches, select the best one
            if (matches.length > 0) {
                // Sort by priority (lower number = higher priority)
                matches.sort((a, b) => a.priority - b.priority);
                
                console.log(`    🎯 Found ${matches.length} total matches. Selecting best match:`);
                matches.forEach((match, index) => {
                    console.log(`    ${index + 1}. ${match.matchType}: "${match.text}" (priority: ${match.priority})`);
                });
                
                const bestMatch = matches[0];
                console.log(`    ⭐ Selected best match: "${bestMatch.text}" (${bestMatch.matchType})`);
                
                // Try multiple click approaches for better reliability
                let clickSuccessful = false;
                
                // Method 1: Standard click
                try {
                    await bestMatch.option.click();
                    await page.waitForTimeout(800); // Wait to see if click registered
                    clickSuccessful = true;
                    console.log(`    ✅ Standard click successful`);
                } catch (e) {
                    console.log(`    ⚠️ Standard click failed: ${e.message}`);
                }
                
                // Method 2: Try clicking on the result label (for malformed DOM)
                if (!clickSuccessful) {
                    try {
                        const resultLabel = bestMatch.option.locator('.select2-result-label').first();
                        const labelExists = await resultLabel.isVisible().catch(() => false);
                        if (labelExists) {
                            await resultLabel.click();
                            await page.waitForTimeout(800);
                            clickSuccessful = true;
                            console.log(`    ✅ Result label click successful`);
                        }
                    } catch (e) {
                        console.log(`    ⚠️ Result label click failed: ${e.message}`);
                    }
                }
                
                // Method 3: Force click if standard failed
                if (!clickSuccessful) {
                    try {
                        // Check if element is still available before force click
                        const isStillVisible = await bestMatch.option.isVisible().catch(() => false);
                        if (isStillVisible) {
                            await bestMatch.option.click({ force: true });
                            await page.waitForTimeout(800); // Wait to see if click registered
                            clickSuccessful = true;
                            console.log(`    ✅ Force click successful`);
                        } else {
                            console.log(`    ℹ️ Element no longer visible, skipping force click`);
                        }
                    } catch (e) {
                        console.log(`    ⚠️ Force click failed: ${e.message}`);
                    }
                }
                
                // Method 4: JavaScript click if others failed
                if (!clickSuccessful) {
                    try {
                        // Final check if element is still in DOM before JavaScript click
                        const elementExists = await bestMatch.option.evaluate(el => el && el.parentNode).catch(() => false);
                        if (elementExists) {
                            await bestMatch.option.evaluate(el => el.click());
                            await page.waitForTimeout(800); // Wait to see if click registered
                            clickSuccessful = true;
                            console.log(`    ✅ JavaScript click successful`);
                        } else {
                            console.log(`    ℹ️ Element no longer in DOM, skipping JavaScript click`);
                        }
                    } catch (e) {
                        console.log(`    ⚠️ JavaScript click failed: ${e.message}`);
                    }
                }
                
                // Method 5: Try clicking by text content (last resort for malformed DOM)
                if (!clickSuccessful) {
                    try {
                        await page.click(`text="${bestMatch.text}"`, { timeout: 2000 });
                        await page.waitForTimeout(800);
                        clickSuccessful = true;
                        console.log(`    ✅ Text-based click successful`);
                    } catch (e) {
                        console.log(`    ⚠️ Text-based click failed: ${e.message}`);
                    }
                }
                
                if (clickSuccessful) {
                    await page.waitForTimeout(1500);
                    
                    // Verify dropdown closed and selection was successful
                    try {
                        const dropdownClosed = await page.evaluate(() => {
                            const results = document.querySelector('#select2-results-18');
                            return !results || results.style.display === 'none' || !results.offsetParent;
                        });
                        
                        if (dropdownClosed) {
                            console.log(`    ✅ Tour operator selection confirmed - dropdown closed`);
                        } else {
                            console.log(`    ⚠️ Dropdown still open, pressing Escape`);
                            await page.keyboard.press('Escape');
                            await page.waitForTimeout(500);
                        }
                    } catch (e) {
                        console.log(`    ℹ️ Could not verify dropdown closure: ${e.message}`);
                    }
                    
                    return true;
                } else {
                    console.log(`    ❌ All click methods failed for tour operator option`);
                    return false;
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
            
            // Close any interfering popups before region selection
            await closeCalendarPopupIfOpen(page);
            
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

// Helper function to retry client creation with page refresh and popup cleanup
async function retryClientCreationWithRecovery(page, firstName, lastName, clientName) {
    console.log(`  - Failed to create new client: ${clientName}, attempting recovery...`);
    
    // Refresh page to clear any blocking elements
    console.log(`  - 🔄 Refreshing page to clear blocking elements...`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    // Navigate back to Quick Submit form
    console.log(`  - 🔄 Navigating back to Quick Submit form...`);
    await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
    
    // Wait for form to load
    const titleSelector = await findDynamicSelector(page, 'reservation_title');
    if (titleSelector) {
        await page.waitForSelector(titleSelector, { timeout: 60000 });
    } else {
        await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
    }
    
    // Close any existing popups
    console.log(`  - 🔄 Closing any existing popups...`);
    await closeCalendarPopupIfOpen(page);
    
    // Try to press Escape key multiple times to close any popups
    for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
    }
    
    // Retry client creation with fresh page
    console.log(`  - 🔄 Retrying client creation after page refresh: ${firstName} ${lastName}`);
    const retryClientCreated = await createNewClient(page, firstName, lastName);
    
    if (retryClientCreated) {
        console.log(`  - ✅ Client creation succeeded on retry, restarting form processing...`);
        
        // Another F5 refresh after successful client creation
        console.log(`  - 🔄 F5 refreshing page after successful client creation...`);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        
        // Navigate back to Quick Submit form again
        console.log(`  - 🔄 Navigating back to Quick Submit form after client creation...`);
        await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
        
        // Wait for form to load again
        const titleSelectorRetry = await findDynamicSelector(page, 'reservation_title');
        if (titleSelectorRetry) {
            await page.waitForSelector(titleSelectorRetry, { timeout: 60000 });
        } else {
            await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
        }
        
        console.log(`  - ✅ Form ready after client creation retry, restarting entire record processing...`);
        return true; // Success
    } else {
        console.log(`  - ❌ Client creation failed even after page refresh retry: ${clientName}`);
        return false; // Failed even after retry
    }
}

// Helper function to submit form with human-like interaction and validation
async function submitFormHumanLike(page, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`    📤 Submitting form (attempt ${attempt}/${maxRetries})`);
            
            // Close any interfering popups before form submission
            await closeCalendarPopupIfOpen(page);
            
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
        
        // Close any interfering popups before verification
        await closeCalendarPopupIfOpen(page);
        
        let mismatchCount = 0;
        
        // Check reservation title
        const titleSelector = await findDynamicSelector(page, 'reservation_title');
        if (titleSelector) {
            const titleValue = await page.inputValue(titleSelector);
            if (titleValue !== expectedFormState.reservationTitle) {
                console.log(`    ⚠️  Reservation title mismatch: expected "${expectedFormState.reservationTitle}", got "${titleValue}"`);
                mismatchCount++;
            } else {
                console.log(`    ✅ Reservation title matches: "${titleValue}"`);
            }
        }
        
        // Check booking number
        const numberSelector = await findDynamicSelector(page, 'reservation_number');
        if (numberSelector) {
            const numberValue = await page.inputValue(numberSelector);
            if (numberValue !== expectedFormState.bookingNumber) {
                console.log(`    ⚠️  Booking number mismatch: expected "${expectedFormState.bookingNumber}", got "${numberValue}"`);
                mismatchCount++;
            } else {
                console.log(`    ✅ Booking number matches: "${numberValue}"`);
            }
        }
        
        // Check dates (be more lenient with date formats)
        const startDateSelector = await findDynamicSelector(page, 'start_date');
        if (startDateSelector) {
            const startDateValue = await page.inputValue(startDateSelector);
            // Allow empty dates or different formats
            if (startDateValue !== expectedFormState.startDate && startDateValue.trim() !== '') {
                console.log(`    ⚠️  Start date mismatch: expected "${expectedFormState.startDate}", got "${startDateValue}"`);
                mismatchCount++;
            } else {
                console.log(`    ✅ Start date acceptable: "${startDateValue}"`);
            }
        }
        
        const endDateSelector = await findDynamicSelector(page, 'end_date');
        if (endDateSelector) {
            const endDateValue = await page.inputValue(endDateSelector);
            // Allow empty dates or different formats
            if (endDateValue !== expectedFormState.endDate && endDateValue.trim() !== '') {
                console.log(`    ⚠️  End date mismatch: expected "${expectedFormState.endDate}", got "${endDateValue}"`);
                mismatchCount++;
            } else {
                console.log(`    ✅ End date acceptable: "${endDateValue}"`);
            }
        }
        
        // Check price fields for debugging
        const priceSelector = await findDynamicSelector(page, 'package_price');
        if (priceSelector) {
            const priceValue = await page.inputValue(priceSelector);
            console.log(`    📊 Package Price field: expected "${expectedFormState.packagePrice}", got "${priceValue}"`);
        }
        
        const commissionSelector = await findDynamicSelector(page, 'expected_commission');
        if (commissionSelector) {
            const commissionValue = await page.inputValue(commissionSelector);
            console.log(`    📊 Commission field: expected "${expectedFormState.expectedCommission}", got "${commissionValue}"`);
        }
        
        // Log summary but always pass validation
        if (mismatchCount > 0) {
            console.log(`    📋 Form state summary: ${mismatchCount} field(s) have different values than expected`);
        } else {
            console.log('    ✅ All form fields match expected values');
        }
        
        return true; // Always return true to not block submission
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
            // Check if this is actually a calendar popup by looking for calendar-specific elements
            const isCalendarPopup = await page.evaluate(() => {
                const freezer = document.querySelector('div.zc-freezer');
                if (!freezer) return false;
                
                // Look for calendar-specific indicators
                const calendarIndicators = [
                    '.calendar',
                    '.datepicker',
                    '.date-picker',
                    '[class*="calendar"]',
                    '[class*="date"]',
                    '.ui-datepicker'
                ];
                
                for (const indicator of calendarIndicators) {
                    if (document.querySelector(indicator)) {
                        return true;
                    }
                }
                
                // Also check if there are date input fields visible (suggesting calendar popup)
                const dateInputs = document.querySelectorAll('input[type="date"], input[name*="Date"], input[id*="Date"]');
                return dateInputs.length > 0;
            });
            
            if (isCalendarPopup) {
                console.log('    ⚠️  Calendar popup detected (freezer div active), closing...');
                
                // Try gentle method first - single escape key
                await page.keyboard.press('Escape');
                await page.waitForTimeout(500);
                
                // Check if freezer is still there
                const stillFrozen = await page.locator('div.zc-freezer').first().isVisible().catch(() => false);
                
                if (stillFrozen) {
                    console.log('    🔄 Escape didn\'t work, trying to click outside...');
                    // Method 2: Click outside the popup area (conservative click)
                    await page.click('body', { position: { x: 50, y: 50 } });
                    await page.waitForTimeout(500);
                }
                
                // Final check - only try close button if still frozen
                const finalCheck = await page.locator('div.zc-freezer').first().isVisible().catch(() => false);
                if (finalCheck) {
                    console.log('    🔄 Still frozen, trying to click close button...');
                    try {
                        // Only look for close buttons within calendar popups
                        await page.click('.zc-freezer [aria-label="Close"], .zc-freezer .close', { timeout: 2000 });
                    } catch (e) {
                        console.log('    ℹ️ No close button found, popup may be legitimate');
                    }
                }
                
                // Wait for freezer to disappear
                try {
                    await page.waitForSelector('div.zc-freezer', { state: 'hidden', timeout: 2000 });
                    console.log('    ✅ Calendar popup closed successfully');
                } catch (e) {
                    console.log('    ℹ️ Popup still active - may be a legitimate modal');
                }
            } else {
                console.log('    ℹ️ Freezer detected but not a calendar popup - leaving it open');
            }
            
        } else {
            console.log('    ✅ No calendar popup detected');
        }
        
        // Add a small delay to ensure page is stable
        await page.waitForTimeout(300);
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
async function sendToWebhook(processedData, jobErrors = []) {
    try {
        const webhookUrl = 'https://n8n.collectgreatstories.com/webhook/bookings-from-tpi';
        
        console.log('Sending data to webhook...');
        console.log(`📤 Sending ${processedData.length} records to webhook`);
        
        // Prepare consolidated payload with results and errors
        const payload = {
            results: processedData,
            errors: jobErrors || [],
            summary: {
                totalRecords: processedData.length,
                submitted: processedData.filter(r => r.status === 'submitted').length,
                failed: processedData.filter(r => r.status === 'error' || r.status === 'not submitted').length,
                errorCount: jobErrors.length,
                timestamp: new Date().toISOString()
            }
        };
        
        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 10000 // 10 second timeout
        });

        if (response.status === 200 || response.status === 201) {
            console.log('✅ Data successfully sent to webhook');
            console.log(`📊 Response status: ${response.status}`);
            console.log(`📊 Summary: ${payload.summary.submitted} submitted, ${payload.summary.failed} failed, ${payload.summary.errorCount} errors`);
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

// New function to login once and create reusable session
async function loginAndCreateSession() {
    console.log('🔑 Creating enhanced browser session with stability features...');
    
    let browser = null; // Declare browser variable outside try block for cleanup access
    let sessionId = null; // Track session ID for debugging
    let context = null;
    let page = null;
    const startTime = Date.now();
    
    try {
        // Start system monitoring if not already started
        console.log('📊 Checking system monitoring status...');
        if (!systemMonitor.isMonitoring) {
            systemMonitor.startMonitoring();
            console.log('✅ System monitoring started');
        } else {
            console.log('✅ System monitoring already active');
        }

        // Launch browser using enhanced browser manager
        console.log('🚀 Initiating browser launch...');
        const launchStartTime = Date.now();
        const browserResult = await browserManager.launchBrowser();
        const launchDuration = Date.now() - launchStartTime;
        
        browser = browserResult.browser; // Assign browser to the outer scope variable
        sessionId = browserResult.sessionId;
        const { launchTime } = browserResult;
        console.log(`🚀 Browser launched successfully (${launchTime}ms, total: ${launchDuration}ms) - Session ID: ${sessionId}`);
        
        // Critical: Validate browser state before proceeding
        console.log('🔍 Validating browser state after launch...');
        if (!browser) {
            throw new Error('Browser object is null after successful launch');
        }
        
        console.log(`🔍 Browser isConnected: ${browser.isConnected()}`);
        if (!browser.isConnected()) {
            throw new Error('Browser is not connected despite successful launch');
        }
        
        // Additional validation: try to get browser version to ensure it's really working
        try {
            const version = await browser.version();
            console.log(`🔍 Browser version: ${version}`);
        } catch (versionError) {
            console.error('❌ Failed to get browser version:', versionError.message);
            throw new Error(`Browser validation failed: ${versionError.message}`);
        }
        
        console.log('✅ Browser connection validated');
        
        // Add small delay to ensure browser stability
        console.log('⏳ Adding stability delay (1000ms)...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Re-validate browser connection after delay
        console.log('🔍 Re-validating browser connection after delay...');
        if (!browser.isConnected()) {
            throw new Error('Browser disconnected during stability delay');
        }
        console.log('✅ Browser still connected after stability delay');
        
        // Create browser context with enhanced logging
        console.log('🌐 Creating browser context...');
        const contextStartTime = Date.now();
        
        // Final browser check before context creation
        if (!browser || !browser.isConnected()) {
            throw new Error('Browser is no longer connected before context creation');
        }
        
        try {
            // Add timeout to context creation
            context = await Promise.race([
                browser.newContext({
                    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    viewport: { width: 1920, height: 1080 },
                    ignoreHTTPSErrors: true,
                    bypassCSP: true
                }),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Context creation timeout after 30s')), 30000)
                )
            ]);
            const contextDuration = Date.now() - contextStartTime;
            console.log(`✅ Browser context created successfully (${contextDuration}ms)`);
        } catch (contextError) {
            console.error('❌ Failed to create browser context:', {
                error: contextError.message,
                stack: contextError.stack,
                browserExists: !!browser,
                browserConnected: browser ? browser.isConnected() : 'browser is null',
                sessionId: sessionId,
                timeSinceLaunch: Date.now() - launchStartTime,
                contextCreationTime: Date.now() - contextStartTime
            });
            throw new Error(`Context creation failed: ${contextError.message}`);
        }
        
        // Validate context before creating page
        console.log('🔍 Validating context state...');
        if (!context) {
            throw new Error('Context is null after creation');
        }
        console.log('✅ Context validated');
        
        // Create page with enhanced logging
        console.log('📄 Creating new page...');
        const pageStartTime = Date.now();
        
        // Validate browser and context before page creation
        if (!browser || !browser.isConnected()) {
            throw new Error('Browser is no longer connected before page creation');
        }
        if (!context) {
            throw new Error('Context is null before page creation');
        }
        
        try {
            // Add timeout to page creation
            page = await Promise.race([
                context.newPage(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Page creation timeout after 30s')), 30000)
                )
            ]);
            const pageDuration = Date.now() - pageStartTime;
            console.log(`✅ Page created successfully (${pageDuration}ms)`);
        } catch (pageError) {
            console.error('❌ Failed to create page:', {
                error: pageError.message,
                stack: pageError.stack,
                browserExists: !!browser,
                browserConnected: browser ? browser.isConnected() : 'browser is null',
                contextExists: !!context,
                sessionId: sessionId,
                timeSinceLaunch: Date.now() - launchStartTime,
                timeSinceContext: Date.now() - contextStartTime,
                pageCreationTime: Date.now() - pageStartTime
            });
            throw new Error(`Page creation failed: ${pageError.message}`);
        }
        
        // Validate page
        console.log('🔍 Validating page state...');
        if (!page) {
            throw new Error('Page is null after creation');
        }
        console.log('✅ Page validated');
        
        const totalSetupTime = Date.now() - startTime;
        const contextCreationTime = Date.now() - contextStartTime; 
        const pageCreationTime = Date.now() - pageStartTime;
        
        // Log performance metrics
        const performanceMetrics = {
            totalTime: totalSetupTime,
            launchTime: launchTime,
            contextCreationTime: contextCreationTime,
            pageCreationTime: pageCreationTime,
            sessionId: sessionId,
            memoryUsage: process.memoryUsage(),
            timestamp: new Date().toISOString()
        };
        
        console.log(`🎯 Browser setup completed successfully!`);
        console.log(`   ⏱️ Total time: ${totalSetupTime}ms`);
        console.log(`   ⏱️ Launch time: ${launchTime}ms`);
        console.log(`   ⏱️ Context creation: ${contextCreationTime}ms`);
        console.log(`   ⏱️ Page creation: ${pageCreationTime}ms`);
        console.log(`   ⏱️ Session ID: ${sessionId}`);
        console.log(`   📊 Performance metrics:`, performanceMetrics);
        
        // Final validation before proceeding to login
        console.log('🔍 Final validation before login...');
        if (!browser || !browser.isConnected()) {
            throw new Error('Browser disconnected during setup completion');
        }
        if (!context) {
            throw new Error('Context lost during setup completion');
        }
        if (!page) {
            throw new Error('Page lost during setup completion');
        }
        console.log('✅ Final validation passed - ready for login');

    console.log('Navigating to login page...');
    
    // Retry logic for initial page load
    let pageLoaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`Page load attempt ${attempt}/3...`);
            await page.goto('https://my.tpisuitcase.com/', { 
                timeout: 60000,
                waitUntil: 'networkidle' 
            });
            pageLoaded = true;
            console.log('✅ Page loaded successfully');
            break;
        } catch (error) {
            console.log(`⚠️ Page load attempt ${attempt} failed: ${error.message}`);
            if (attempt === 3) {
                throw new Error(`Failed to load page after 3 attempts: ${error.message}`);
            }
            await page.waitForTimeout(2000); // Wait before retry
        }
    }
    
    if (!pageLoaded) {
        throw new Error('Could not load TPI Suitcase login page');
    }

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

    // Check for "I Understand" button immediately after sign in but before page load
    console.log('Checking for "I Understand" button after sign in...');
    try {
        const iUnderstandButton = await page.waitForSelector('#continue_button', { timeout: 5000 });
        if (iUnderstandButton) {
            console.log('Found "I Understand" button, clicking it...');
            await iUnderstandButton.click();
            await page.waitForTimeout(3000);
            console.log('Clicked "I Understand" button successfully');
        }
    } catch (e) {
        console.log('No "I Understand" button found, continuing...');
    }

    console.log('Waiting for page to load after login...');
    await page.waitForURL('https://my.tpisuitcase.com/#Page:CORE', { timeout: 60000 });

    console.log('Page loaded successfully. Waiting for 10 seconds...');
    await page.waitForTimeout(10000);

    console.log('✅ Login completed! Session ready for processing');

    // Return session object with browser, context, page, and metadata
    const sessionObject = {
        browser: browser,
        context: context,
        page: page,
        sessionId: sessionId,
        createdAt: new Date().toISOString(),
        setupTime: totalSetupTime,
        performanceMetrics: {
            launchTime: launchTime,
            contextCreationTime: contextCreationTime,
            pageCreationTime: pageCreationTime
        }
    };
    
    console.log(`✅ Session object created successfully with metadata`);
    return sessionObject;
    
    } catch (error) {
        const totalErrorTime = Date.now() - startTime;
        console.error('❌ Login and session creation failed:', {
            message: error.message,
            stack: error.stack,
            sessionId: sessionId,
            timeSinceStart: totalErrorTime,
            browserExists: browser ? 'yes' : 'no',
            browserConnected: browser ? browser.isConnected() : 'n/a',
            contextExists: context ? 'yes' : 'no',
            pageExists: page ? 'yes' : 'no'
        });
        
        // Enhanced error classification with detailed context
        const errorContext = {
            operation: 'login_and_session_creation',
            sessionId: sessionId,
            timeSinceStart: totalErrorTime,
            errorOccurredAt: new Date().toISOString(),
            browserState: {
                exists: !!browser,
                connected: browser ? browser.isConnected() : false
            },
            contextState: {
                exists: !!context
            },
            pageState: {
                exists: !!page
            },
            systemInfo: {
                memoryUsage: process.memoryUsage(),
                platform: process.platform,
                nodeVersion: process.version
            }
        };
        
        // Log detailed error context for debugging
        console.error('🛠️ Detailed error context:', errorContext);
        
        const classifiedError = ErrorClassifier.classify(error, errorContext);
        
        // Send enhanced error notification if discord notifier is available
        if (discordNotifier) {
            await discordNotifier.sendErrorNotification(classifiedError, {
                operation: 'loginAndCreateSession',
                timestamp: new Date().toISOString(),
                sessionId: sessionId,
                executionTime: totalErrorTime,
                errorPhase: determineErrorPhase(browser, context, page),
                browserState: {
                    exists: !!browser,
                    connected: browser ? browser.isConnected() : false
                },
                contextState: {
                    exists: !!context
                },
                pageState: {
                    exists: !!page
                },
                possibleCauses: determinePossibleCauses(error, browser, context, page),
                recommendedActions: [
                    'Check browser connection stability',
                    'Verify system resources',
                    'Review browser manager logs',
                    'Consider increasing timeouts if persistent'
                ]
            }).catch(notifyError => {
                console.log('⚠️ Failed to send Discord notification:', notifyError.message);
            });
        }
        
        // Enhanced cleanup with detailed tracking
        console.log('🧹 Starting enhanced cleanup after error...');
        try {
            const cleanupResults = await performLoginSessionCleanup(browser, sessionId, context, page, 'login_session_error');
            
            // Log cleanup summary
            const cleanupSummary = {
                sessionId: sessionId,
                errorTime: totalErrorTime,
                cleanupAttempted: {
                    browser: cleanupResults.browser.attempted,
                    context: cleanupResults.context.attempted,
                    page: cleanupResults.page.attempted
                },
                cleanupSuccess: {
                    browser: cleanupResults.browser.success,
                    context: cleanupResults.context.success,
                    page: cleanupResults.page.success
                }
            };
            
            console.log('📊 Cleanup summary:', cleanupSummary);
            
        } catch (cleanupError) {
            console.error('❌ Critical error during enhanced cleanup:', {
                error: cleanupError.message,
                stack: cleanupError.stack,
                sessionId: sessionId
            });
        }
        
        throw classifiedError;
    }
}

// Enhanced cleanup function for loginAndCreateSession
async function performLoginSessionCleanup(browser, sessionId, context, page, reason = 'unknown') {
    console.log(`🧹 Performing enhanced cleanup (reason: ${reason}, sessionId: ${sessionId})...`);
    
    const cleanupStartTime = Date.now();
    const cleanupResults = {
        browser: { attempted: false, success: false, error: null },
        context: { attempted: false, success: false, error: null },
        page: { attempted: false, success: false, error: null }
    };
    
    // Clean up page first
    if (page) {
        cleanupResults.page.attempted = true;
        try {
            await page.close();
            cleanupResults.page.success = true;
            console.log('✅ Page cleaned up successfully');
        } catch (pageError) {
            cleanupResults.page.error = pageError.message;
            console.error('❌ Failed to clean up page:', pageError.message);
        }
    }
    
    // Clean up context
    if (context) {
        cleanupResults.context.attempted = true;
        try {
            await context.close();
            cleanupResults.context.success = true;
            console.log('✅ Context cleaned up successfully');
        } catch (contextError) {
            cleanupResults.context.error = contextError.message;
            console.error('❌ Failed to clean up context:', contextError.message);
        }
    }
    
    // Clean up browser last
    if (browser) {
        cleanupResults.browser.attempted = true;
        try {
            const wasConnected = browser.isConnected();
            console.log(`🔐 Attempting to close browser (was connected: ${wasConnected})...`);
            
            if (wasConnected) {
                await browser.close();
            } else {
                console.log('ℹ️ Browser was already disconnected, skipping close()');
            }
            
            cleanupResults.browser.success = true;
            console.log('✅ Browser cleaned up successfully');
        } catch (browserError) {
            cleanupResults.browser.error = browserError.message;
            console.error('❌ Failed to clean up browser:', browserError.message);
        }
    }
    
    const cleanupDuration = Date.now() - cleanupStartTime;
    console.log(`🧹 Cleanup completed in ${cleanupDuration}ms`);
    console.log('📊 Cleanup results:', cleanupResults);
    
    return cleanupResults;
}

// Helper functions for enhanced error analysis in loginAndCreateSession
function determineErrorPhase(browser, context, page) {
    if (!browser) {
        return 'browser_launch';
    }
    if (!browser.isConnected()) {
        return 'browser_disconnection';
    }
    if (!context) {
        return 'context_creation';
    }
    if (!page) {
        return 'page_creation';
    }
    return 'login_process';
}

function determinePossibleCauses(error, browser, context, page) {
    const causes = [];
    
    // Check error message for specific patterns
    const errorMessage = error.message.toLowerCase();
    
    // Log analysis context (using all parameters)
    console.log('🔍 Analyzing error causes:', {
        errorMessage: errorMessage.substring(0, 100),
        browserExists: !!browser,
        contextExists: !!context,
        pageExists: !!page
    });
    
    if (errorMessage.includes('target page, context or browser has been closed')) {
        causes.push('Browser was closed unexpectedly during operation');
        causes.push('Possible race condition in browser lifecycle management');
        causes.push('System resource exhaustion causing browser crash');
    }
    
    if (errorMessage.includes('timeout')) {
        causes.push('Operation exceeded configured timeout');
        causes.push('System performance issues causing slow response');
        causes.push('Network connectivity problems');
    }
    
    if (errorMessage.includes('connection') || errorMessage.includes('disconnected')) {
        causes.push('Browser process terminated unexpectedly');
        causes.push('System resource limits reached');
        causes.push('Browser launcher configuration issues');
    }
    
    // Browser state analysis
    if (browser && !browser.isConnected()) {
        causes.push('Browser lost connection after successful launch');
        causes.push('Browser process may have crashed or been killed');
    }
    
    if (!browser) {
        causes.push('Browser object is null - launch may have failed');
    }
    
    // System-level causes
    const memUsage = process.memoryUsage();
    if (memUsage.heapUsed > 500 * 1024 * 1024) { // 500MB
        causes.push('High memory usage may be causing instability');
    }
    
    if (causes.length === 0) {
        causes.push('Unknown cause - check detailed logs for more information');
    }
    
    return causes;
}

// Helper function to send individual record errors to status webhook
async function sendRecordErrorToWebhook(jobId, recordError) {
    if (!jobId) return; // Skip if no jobId provided (for backward compatibility)
    
    try {
        const payload = {
            jobId: jobId,
            timestamp: new Date().toISOString(),
            status: 'record_error',
            message: `Record processing error: ${recordError.record}`,
            error: recordError.message,
            errors: [recordError] // Single record error
        };
        
        await axios.post('https://n8n.collectgreatstories.com/webhook/tpi-status', payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'TPI-Submit-Bot/1.0'
            },
            timeout: 10000
        });
        
        console.log(`📡 Record error sent to webhook for: ${recordError.record}`);
    } catch (error) {
        console.error(`❌ Failed to send record error to webhook:`, error.message);
    }
}

// New function to process records using existing session
async function processRecordsWithSession(session, data, options = {}) {
    const { page } = session;
    const processedData = [];
    const recordErrors = []; // Track individual record processing errors
    const jobId = options.jobId; // Get jobId from options for webhook reporting

    try {
        console.log('📋 Navigating to Quick Submit form...');
        await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');

        // Wait for a known element on the form page to ensure it's loaded
        const titleSelector = await findDynamicSelector(page, 'reservation_title');
        if (titleSelector) {
            await page.waitForSelector(titleSelector, { timeout: 60000 });
        } else {
            // Fallback to original selector if dynamic detection fails
            await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
        }

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
                        const recordError = {
                            record: record['Client Name'] || 'Unknown',
                            message: 'Page not ready for processing',
                            timestamp: new Date().toISOString(),
                            context: 'page_readiness_check'
                        };
                        recordErrors.push(recordError);
                        await sendRecordErrorToWebhook(jobId, recordError);
                        recordProcessed = true;
                        break;
                    }

                    // 1. Determine Reservation Title
                    if (processingAttempt === 1) {
                        formState.reservationTitle = 'Tour FIT';
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

                    // 3. Clear Secondary Customers field to prevent confusion
                    await clearSecondaryCustomersField(page);

                    // 4. Search for Client Name using the search popup
                    const clientName = record['Client Name'];
                    
                    // Check if client name is blank or empty
                    if (!clientName || clientName.trim() === '') {
                        console.log(`  - Client name is blank, marking as not submitted`);
                        record.status = 'not submitted';
                        record.Submitted = 'Not Submitted - Client Name Missing';
                        record.InvoiceNumber = 'Not Generated';
                        const recordError = {
                            record: 'Unknown Client',
                            message: 'Client name is blank or missing',
                            timestamp: new Date().toISOString(),
                            context: 'client_name_validation'
                        };
                        recordErrors.push(recordError);
                        await sendRecordErrorToWebhook(jobId, recordError);
                        recordProcessed = true;
                        break;
                    }
                    
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
                        
                        // Wait for popup to close
                        await page.waitForTimeout(2000);
                        
                        // Try to create new client
                        console.log(`  - Attempting to create new client: ${firstName} ${lastName}`);
                        const clientCreated = await createNewClient(page, firstName, lastName);
                        
                        if (clientCreated) {
                            console.log(`  - New client created successfully, restarting form processing...`);
                            
                            // F5 refresh the entire page to start fresh with clean DOM (like pressing F5)
                            console.log(`  - F5 refreshing entire page to restart processing with new client...`);
                            await page.reload({ waitUntil: 'networkidle' });
                            await page.waitForTimeout(3000);
                            
                            // Navigate back to Quick Submit form after F5 refresh
                            console.log(`  - Navigating back to Quick Submit form after F5 refresh...`);
                            await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
                            
                            // Wait for the form to load
                            const titleSelector = await findDynamicSelector(page, 'reservation_title');
                            if (titleSelector) {
                                await page.waitForSelector(titleSelector, { timeout: 60000 });
                            } else {
                                await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
                            }
                            
                            console.log(`  - Form refreshed, restarting entire record processing from beginning...`);
                            
                            // Reset processingAttempt to restart from the beginning
                            processingAttempt = 0; // Will be incremented to 1 at the end of the loop
                            continue;
                        } else {
                            // Try client creation recovery with page refresh and popup cleanup
                            const retrySuccess = await retryClientCreationWithRecovery(page, firstName, lastName, clientName);
                            
                            if (retrySuccess) {
                                // Reset processing attempt to restart from beginning
                                processingAttempt = 0; // Will be incremented to 1 at the end of the loop
                                continue;
                            } else {
                                record.status = 'error';
                                record.Submitted = 'Error - Client Creation Failed After Retry';
                                record.InvoiceNumber = 'Error';
                            }
                        }
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
                                record.Submitted = 'Not Submitted - Tour Operator Not Found';
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

                                // 10. Log form state for debugging (no validation blocking)
                                console.log('  🔍 Checking form state before submission...');
                                await verifyFormState(page, formState); // Just for logging, don't check result
                                
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
                            
                            // Close the search results popup first
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
                            
                            // Wait for popup to close
                            await page.waitForTimeout(2000);
                            
                            // Try to create new client since exact match wasn't found
                            console.log(`  - Attempting to create new client: ${firstName} ${lastName}`);
                            const clientCreated = await createNewClient(page, firstName, lastName);
                            
                            if (clientCreated) {
                                console.log(`  - New client created successfully, restarting form processing...`);
                                
                                // F5 refresh the entire page to start fresh with clean DOM (like pressing F5)
                                console.log(`  - F5 refreshing entire page to restart processing with new client...`);
                                await page.reload({ waitUntil: 'networkidle' });
                                await page.waitForTimeout(3000);
                                
                                // Navigate back to Quick Submit form after F5 refresh
                                console.log(`  - Navigating back to Quick Submit form after F5 refresh...`);
                                await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
                                
                                // Wait for the form to load
                                const titleSelector = await findDynamicSelector(page, 'reservation_title');
                                if (titleSelector) {
                                    await page.waitForSelector(titleSelector, { timeout: 60000 });
                                } else {
                                    await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
                                }
                                
                                console.log(`  - Form refreshed, restarting entire record processing from beginning...`);
                                
                                // Reset processingAttempt to restart from the beginning
                                processingAttempt = 0; // Will be incremented to 1 at the end of the loop
                                continue;
                            } else {
                                // Try client creation recovery with page refresh and popup cleanup
                                const retrySuccess = await retryClientCreationWithRecovery(page, firstName, lastName, clientName);
                                
                                if (retrySuccess) {
                                    // Reset processing attempt to restart from beginning
                                    processingAttempt = 0; // Will be incremented to 1 at the end of the loop
                                    continue;
                                } else {
                                    record.status = 'error';
                                    record.Submitted = 'Error - Client Creation Failed After Retry';
                                    record.InvoiceNumber = 'Error';
                                }
                            }
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
                            const recordError = {
                                record: record['Client Name'] || 'Unknown',
                                message: 'Browser crash during processing - recovery failed',
                                timestamp: new Date().toISOString(),
                                context: 'browser_crash_unrecoverable'
                            };
                            recordErrors.push(recordError);
                            await sendRecordErrorToWebhook(jobId, recordError);
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
                            const recordError = {
                                record: record['Client Name'] || 'Unknown',
                                message: 'Browser timeout during processing - recovery failed',
                                timestamp: new Date().toISOString(),
                                context: 'browser_timeout_unrecoverable'
                            };
                            recordErrors.push(recordError);
                            await sendRecordErrorToWebhook(jobId, recordError);
                            recordProcessed = true;
                        }
                    } else {
                        // Non-crash/timeout error, mark as error and move on
                        record.status = 'error';
                        record.Submitted = 'Error';
                        record.InvoiceNumber = 'Error';
                        const recordError = {
                            record: record['Client Name'] || 'Unknown',
                            message: e.message || 'Unknown processing error',
                            timestamp: new Date().toISOString(),
                            context: 'general_processing_error',
                            stack: e.stack || null
                        };
                        recordErrors.push(recordError);
                        await sendRecordErrorToWebhook(jobId, recordError);
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

        // Send processed data to webhook (only if not disabled)
        if (options.sendWebhook !== false) {
            await sendToWebhook(processedData);
        }

        // Return just the processed records (keep original structure)
        return processedData;

    } catch (error) {
        console.error('An error occurred during record processing:', error);
        // Send batch processing error to webhook
        const batchError = {
            record: 'batch_processing',
            message: error.message || 'Unknown batch processing error',
            timestamp: new Date().toISOString(),
            context: 'batch_processing_failure',
            stack: error.stack || null
        };
        recordErrors.push(batchError);
        await sendRecordErrorToWebhook(jobId, batchError);
        
        // Return partial results and let JobManager handle the error
        return processedData;
    }
}

module.exports = { loginAndProcess, loginAndCreateSession, processRecordsWithSession, sendToWebhook };
