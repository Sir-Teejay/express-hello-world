const express = require('express');
const app = express();
const Airtable = require('airtable');

// Middleware to parse JSON bodies
app.use(express.json());

// Environment variables
const groqApiKey = process.env.GROQ_API_KEY;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const airtableApiKey = process.env.AIRTABLE_API_KEY;
const airtableBaseId = process.env.AIRTABLE_BASE_ID;

// Initialize Airtable (only if API key is provided)
let base = null;
if (airtableApiKey && airtableBaseId) {
  base = new Airtable({apiKey: airtableApiKey}).base(airtableBaseId);
  console.log('Airtable initialized');
}

// Airtable helper functions
async function logToAirtable(phoneNumber, message, response, intent = 'General') {
  if (!base) return;
  try {
    // Log to a ChatLogs table (you'll need to create this)
    // For now, we'll just console log
    console.log('Airtable logging:', { phoneNumber, message, response, intent });
  } catch (error) {
    console.error('Error logging to Airtable:', error);
  }
}

async function getMemberByPhone(phoneNumber) {
  if (!base) return null;
  try {
    const records = await base('Members').select({
      filterByFormula: `OR({Phone Number} = '${phoneNumber}', {WhatsApp Number} = '${phoneNumber}')`,
      maxRecords: 1
    }).firstPage();
    
    return records.length > 0 ? records[0] : null;
  } catch (error) {
    console.error('Error getting member:', error);
    return null;
  }
}

async function createOrUpdateMember(phoneNumber, name = 'Unknown') {
  if (!base) return null;
  try {
    let member = await getMemberByPhone(phoneNumber);
    
    if (member) {
      console.log('Member exists:', member.fields['Full Name']);
      return member;
    }
    
    // Create new member
    const records = await base('Members').create([{
      fields: {
        'Full Name': name,
        'Phone Number': phoneNumber,
        'WhatsApp Number': phoneNumber,
        'Join Date': new Date().toISOString().split('T')[0],
        'Status': 'Active'
      }
    }]);
    
    console.log('New member created:', name);
    return records[0];
  } catch (error) {
    console.error('Error creating/updating member:', error);
    return null;
  }
}

async function recordContribution(phoneNumber, amount, cycleMonth) {
  if (!base) return false;
  try {
    const member = await getMemberByPhone(phoneNumber);
    if (!member) {
      console.log('Member not found for contribution');
      return false;
    }

    await base('Contributions').create([{
      fields: {
        'Name': `${member.fields['Full Name']} - ${cycleMonth}`,
        'Contribution Amount': amount,
        'Contribution Date': new Date().toISOString().split('T')[0],
        'Payment Method': 'WhatsApp Bot'
      }
    }]);

    console.log(`Contribution recorded: ${amount} from ${phoneNumber}`);
    return true;
  } catch (error) {
    console.error('Error recording contribution:', error);
    return false;
  }
}

async function getCurrentCycle() {
  if (!base) return null;
  try {
    const today = new Date();
    const records = await base('Cycles').select({
      filterByFormula: `AND(IS_BEFORE({Start Date}, TODAY()), IS_AFTER({End Date}, TODAY()))`,
      maxRecords: 1,
      sort: [{field: 'Start Date', direction: 'desc'}]
    }).firstPage();
    
    return records.length > 0 ? records[0] : null;
  } catch (error) {
    console.error('Error getting current cycle:', error);
    return null;
  }
}

// Function to call Groq API with Llama 3
async function callGroqLlama(userMessage, context = '', memberInfo = null) {
  try {
    let systemPrompt = `You are Adashina, an intelligent assistant for managing Adashi (rotating savings) groups.

Your role is to:
- Help users track monthly contributions
- Remind members about payment deadlines  
- Track who should receive the pooled money each month
- Answer questions about the Adashi cycle
- Keep records of who has paid and who hasn't

Be friendly, clear, and helpful. Use simple language.${context ? '\n\nCurrent context: ' + context : ''}`;

    if (memberInfo) {
      systemPrompt += `\n\nMember Info:
- Name: ${memberInfo.name || 'Unknown'}
- Total Contributions: ${memberInfo.totalContributions || 0}
- Status: ${memberInfo.status || 'Unknown'}`;
    }

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
  try {
    console.log('Received message from WhatsApp');
    console.log('Full Message Data:', JSON.stringify(req.body, null, 2));

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

      // Get or create member in Airtable
      let member = null;
      let memberInfo = null;
      
      if (base) {
        member = await createOrUpdateMember(from, senderName);
        if (member) {
          memberInfo = {
            name: member.fields['Full Name'],
            totalContributions: member.fields['Total Contributions'] || 0,
            status: member.fields['Status']
          };
        }
      }

      // Detect intent
      let intent = 'General';
      let contextInfo = '';

      if (base) {
        // Check for payment/contribution intent
        const lowerMsg = messageBody.toLowerCase();
        if (lowerMsg.includes('paid') || lowerMsg.includes('contribution') || lowerMsg.includes('payment')) {
          intent = 'Payment';
          const currentCycle = await getCurrentCycle();
          if (currentCycle) {
            contextInfo = `Current cycle: ${currentCycle.fields['Cycle Name']}`;
          }
        }
      }

      // Call Groq Llama to generate response
      const aiResponse = await callGroqLlama(messageBody, contextInfo, memberInfo);
      console.log('AI Response:', aiResponse);

      // Send response back via WhatsApp
      await sendWhatsAppMessage(from, aiResponse);
      console.log('Response sent successfully');

      // Log to Airtable
      if (base) {
        await logToAirtable(from, messageBody, aiResponse, intent);
      }

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
