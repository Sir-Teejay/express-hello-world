const express = require('express');
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Environment variables
const groqApiKey = process.env.GROQ_API_KEY;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;

// Function to call Groq API with Llama 3
async function callGroqLlama(userMessage, context = '') {
  try {
    const systemPrompt = `You are Adashina, an intelligent assistant for managing Adashi (rotating savings and credit) groups in Nigeria. 

Your role is to:
- Help users track monthly contributions
- Remind members about payment deadlines
- Track who should receive the pooled money each month
- Answer questions about the Adashi cycle
- Keep records of who has paid and who hasn't

Be friendly, clear, and helpful. Use simple language.${context ? '\n\nCurrent context: ' + context : ''}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 500
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content;
    } else {
      console.error('Unexpected Groq API response:', data);
      return 'Sorry, I encountered an error processing your request.';
    }
  } catch (error) {
    console.error('Error calling Groq API:', error);
    return 'Sorry, I am having trouble connecting right now. Please try again later.';
  }
}

// Function to send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${whatsappToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      })
    });

    const data = await response.json();
    console.log('WhatsApp message sent:', data);
    return data;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
}

// GET /webhook - Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('Verification failed');
    res.status(403).send('Verification failed');
  }
});

// POST /webhook - Handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  console.log('Received message from WhatsApp');
  console.log('Full Message Data:', JSON.stringify(req.body, null, 2));
  
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages?.[0];
    
    if (messages && messages.type === 'text') {
      const from = messages.from;
      const messageBody = messages.text.body;
      const senderName = value?.contacts?.[0]?.profile?.name || 'User';
      
      console.log('Message Type:', messages.type);
      console.log(`From ${from}: ${messageBody}`);
      
      // Call Groq Llama to generate response
      const aiResponse = await callGroqLlama(messageBody, '');
      console.log(`AI Response: ${aiResponse}`);
      
      // Send response back via WhatsApp
      await sendWhatsAppMessage(from, aiResponse);
      console.log('Response sent successfully');
      
      res.status(200).json({ success: true });
    } else {
      console.log('Not a text message, ignoring');
      res.status(200).json({ success: true });
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = app;
