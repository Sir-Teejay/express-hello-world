const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Environment variables
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'your_secure_token_here';
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Root endpoint
app.get('/', (req, res) => {
  res.send('WhatsApp Webhook is ready!');
});

// Webhook verification endpoint (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Verify the token
  if (mode && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    console.log('Webhook verified successfully');
  } else {
    res.status(403).send('Verification failed');
    console.log('Webhook verification failed');
  }
});

// Webhook event receiver endpoint (POST)
app.post('/webhook', (req, res) => {
  const body = req.body;

  // Check if this is a Webhook event
  if (body.object) {
    // Iterate over each entry in the webhook event
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const messages = body.entry[0].changes[0].value.messages;
      const contacts = body.entry[0].changes[0].value.contacts;

      console.log('Received message from WhatsApp');
      console.log('Full Message Data:', JSON.stringify(body, null, 2));

      // Handle incoming messages here
      if (messages && messages.length > 0) {
        messages.forEach((message) => {
          const phoneNumber = contacts[0].wa_id;
          const messageText = message.text ? message.text.body : 'No text';
          const messageType = message.type;
          
          console.log(`Message Type: ${messageType}`);
          console.log(`From ${phoneNumber}: ${messageText}`);
          
          // You can add your message processing logic here
          // For example: save to database, trigger automated responses, etc.
        });
      }
    }

    // Always return a 200 OK response
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.status(404).send('Not found');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Webhook server is running on port ${PORT}`);
  console.log(`Webhook URL: https://express-hello-world-kappa-two.vercel.app/webhook`);
});

module.exports = app;
