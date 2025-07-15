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
        await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });

        const processedData = [];

        for (const record of data[0].rows) {
            try {
                console.log(`Processing record for: ${record['Client Name']}`);

                // 1. Determine Reservation Title
                const reservationTitle = record['Trip Description'].toLowerCase().includes('cruise') || record['Booking Description'].toLowerCase().includes('cruise')
                    ? 'Cruise FIT'
                    : 'Tour FIT';
                await page.fill('#zc-Reservation_Title', reservationTitle);
                console.log(`  - Set Reservation Title to: ${reservationTitle}`);

                // 2. Fill Booking Number
                await page.fill('#zc-Reservation_Number', record['Booking Number']);
                console.log(`  - Set Booking Number to: ${record['Booking Number']}`);

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
                    // Click close button to close the popup
                    await page.click('span.popupClose');
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

                        // 4. Select Tour Operator
                        console.log(`  - Selecting tour operator: ${record['Tour Operator']}`);
                        await page.click('span.select2-chosen#select2-chosen-18');
                        await page.waitForTimeout(1000);

                        // Search for the tour operator by typing and scrolling if needed
                        const tourOperatorFound = await searchAndSelectTourOperator(page, record['Tour Operator']);
                        
                        if (!tourOperatorFound) {
                            console.log(`  - Tour operator not found: ${record['Tour Operator']}`);
                            record.status = 'not submitted';
                            record.Submitted = 'Not Submitted';
                            record.InvoiceNumber = 'Not Generated';
                        } else {
                            console.log(`  - Selected tour operator: ${record['Tour Operator']}`);

                            // 5. Select Region (United States)
                            console.log(`  - Selecting region: United States`);
                            await page.click('span.select2-chosen#select2-chosen-2');
                            await page.waitForTimeout(1000);
                            
                            const regionInput = await page.waitForSelector('input[name="zc-sel2-inp-Destination"]', { timeout: 5000 });
                            await regionInput.fill('United States');
                            await page.waitForTimeout(1000);
                            
                            // Click on United States option
                            await page.click('div.select2-result-label:has-text("United States")');
                            await page.waitForTimeout(1000);

                            // 6. Fill Start Date
                            console.log(`  - Setting start date: ${record['Booking Start Date']}`);
                            await page.fill('#Start_Date', formatDate(record['Booking Start Date']));

                            // 7. Fill End Date
                            console.log(`  - Setting end date: ${record['Booking End Date']}`);
                            await page.fill('#End_Date', formatDate(record['Booking End Date']));

                            // 8. Fill Package Price
                            console.log(`  - Setting package price: ${record['Package Price']}`);
                            await page.fill('#zc-Total_Price', record['Package Price'].replace(/,/g, ''));

                            // 9. Fill Expected Commission
                            console.log(`  - Setting expected commission: ${record['Commission Projected']}`);
                            await page.fill('#zc-Expected_Commission', record['Commission Projected'].replace(/,/g, ''));

                            // 10. Click the 'Submit and Duplicate' button to submit the form
                            await page.click('input[name="Submit_and_Duplicate"]');
                            console.log('  - Clicked Submit and Duplicate button.');

                            // Wait for the form to process and popup to appear (5-10 seconds)
                            await page.waitForTimeout(8000);

                            // Handle the popup by clicking OK button
                            try {
                                await page.waitForSelector('#Ok', { timeout: 5000 });
                                await page.click('#Ok');
                                console.log('  - Clicked OK on popup.');
                                await page.waitForTimeout(2000);
                            } catch (e) {
                                console.log('  - No popup appeared or OK button not found.');
                            }

                            // Extract invoice number from reservation title
                            try {
                                const reservationTitleValue = await page.inputValue('#zc-Reservation_Title');
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
                            } catch (e) {
                                console.error('  - Error extracting invoice number:', e);
                                record.InvoiceNumber = 'Error';
                            }

                            record.status = 'submitted';
                            record.Submitted = 'Submitted';
                        }
                    } else {
                        console.log(`  - Client not found: ${clientName} (No matching client in results)`);
                        // Click close button to close the popup
                        await page.click('span.popupClose');
                        record.status = 'not submitted';
                        record.Submitted = 'Not Submitted';
                        record.InvoiceNumber = 'Not Generated';
                    }
                }

                // Navigate back to fresh form for next record
                if (data[0].rows.indexOf(record) < data[0].rows.length - 1) {
                    await page.goto('https://my.tpisuitcase.com/#Form:Quick_Submit');
                    await page.waitForSelector('#zc-Reservation_Title', { timeout: 60000 });
                }

            } catch (e) {
                console.error(`Error processing record for ${record['Client Name']}:`, e);
                record.status = 'error';
                record.Submitted = 'Error';
                record.InvoiceNumber = 'Error';
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

// Helper function to search and select tour operator with scrolling
async function searchAndSelectTourOperator(page, tourOperator) {
    try {
        // Wait for the dropdown to be visible
        await page.waitForSelector('ul.select2-results', { timeout: 10000 });
        
        let found = false;
        let attempts = 0;
        const maxAttempts = 10;

        while (!found && attempts < maxAttempts) {
            // Get all visible options
            const options = await page.locator('ul.select2-results li.select2-result').all();
            
            for (const option of options) {
                const text = await option.innerText();
                if (text.toLowerCase().includes(tourOperator.toLowerCase())) {
                    await option.click();
                    found = true;
                    break;
                }
            }

            if (!found) {
                // Scroll down to load more options
                const lastOption = options[options.length - 1];
                if (lastOption) {
                    await lastOption.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(1000);
                }
                attempts++;
            }
        }

        return found;
    } catch (error) {
        console.error('Error searching for tour operator:', error);
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
