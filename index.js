require('dotenv').config();
const express = require('express');
const { loginAndProcess } = require('./bot');

const app = express();
const port = 3000;

app.use(express.json());

app.post('/trigger-bot', async (req, res) => {
    const receivedData = req.body;

    if (!receivedData || !Array.isArray(receivedData)) {
        return res.status(400).send('Request body must be a valid JSON array.');
    }

    try {
        console.log('Received data:', receivedData);

        // Pass the data to the bot and get the result
        const result = await loginAndProcess(receivedData);

        res.status(200).json(result);
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('An error occurred while processing the request.');
    }
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
