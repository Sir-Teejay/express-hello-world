const express = require('express');
const app = express();
const Airtable = require('airtable');
const path = require('path');

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Environment variables
const groqApiKey = process.env.GROQ_API_KEY;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const airtableApiKey = process.env.AIRTABLE_API_KEY;
const airtableBaseId = process.env.AIRTABLE_BASE_ID;

// Initialize Airtable
let base = null;
if (airtableApiKey && airtableBaseId) {
  base = new Airtable({apiKey: airtableApiKey}).base(airtableBaseId);
  console.log('Airtable initialized');
}

// In-memory conversation store (use Redis in production)
const conversationStore = new Map();

// Pending actions store for two-step confirmation
const pendingActions = new Map();

// Conversation memory functions
function getConversationHistory(phoneNumber) {
  if (!conversationStore.has(phoneNumber)) {
    conversationStore.set(phoneNumber, []);
  }
  return conversationStore.get(phoneNumber);
}

function addToConversationHistory(phoneNumber, role, content) {
  const history = getConversationHistory(phoneNumber);
  history.push({ role, content, timestamp: Date.now() });
  
  // Keep only last 20 messages (10 exchanges)
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }

   conversationStore.set(phoneNumber, history);
}

// Pending actions helper functions
function setPendingAction(phoneNumber, action) {
  pendingActions.set(phoneNumber, {
    ...action,
    timestamp: Date.now(),
    expiresAt: Date.now() + (5 * 60 * 1000) // 5 minutes expiry
  });
  console.log(`Pending action set for ${phoneNumber}:`, action.type);
}

function getPendingAction(phoneNumber) {
  const action = pendingActions.get(phoneNumber);
  if (!action) return null;
  
  // Check if expired
  if (Date.now() > action.expiresAt) {
    pendingActions.delete(phoneNumber);
    console.log(`Pending action expired for ${phoneNumber}`);
    return null;
  }
  
  return action;
}

function clearPendingAction(phoneNumber) {
  pendingActions.delete(phoneNumber);
  console.log(`Pending action cleared for ${phoneNumber}`);
}

// Detect intents from user messages
function detectIntent(message) {
  const lowerMsg = message.toLowerCase();
  
  // Detect payment intent
  const amountMatch = message.match(/(\d+(?:,\d{3})*(?:\.\d{2})?)\s*(naira|₦|ngn|k)?/i);
  if (amountMatch) {
    const hasPaymentKeyword = /\b(paid|pay|sent|send|transferred|transfer|deposited|deposit|contribute|contribution)\b/i.test(lowerMsg);
    
    if (hasPaymentKeyword) {
      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      // Handle 'k' as thousand
      const finalAmount = amountMatch[2] && amountMatch[2].toLowerCase() === 'k' ? amount * 1000 : amount;
      
      if (finalAmount > 0 && finalAmount < 1000000) {
        return {
          type: 'payment',
          amount: finalAmount,
          confidence: 'high'
        };
      }
    }
  }
  
  // Detect name update intent
  const nameMatch = message.match(/(?:my name is|i am|i'm|call me|this is|name:?)\s+([a-zA-Z][a-zA-Z\s]{2,40})/i);
  if (nameMatch) {
    const extractedName = nameMatch[1].trim();
    if (extractedName && extractedName.length > 2 && !/\b(user|unknown|member)\b/i.test(extractedName)) {
      return {
        type: 'name_update',
        name: extractedName,
        confidence: 'high'
      };
    }
  }
  
  return null;
}
  
  conversationStore.set(phoneNumber, history);
}

// Airtable helper functions
async function logToAirtable(phoneNumber, message, response, intent = 'General') {
  if (!base) return;
  try {
    await base('ConversationHistory').create([{
      fields: {
        'Phone Number': phoneNumber,
        'User Message': message,
        'Bot Response': response,
        'Intent': intent,
        'Timestamp': new Date().toISOString()
      }
    }]);
    console.log('Conversation logged to Airtable');
  } catch (error) {
    console.error('Error logging to Airtable:', error.message);
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

async function updateMemberName(phoneNumber, newName) {
  if (!base) return false;
  try {
    const member = await getMemberByPhone(phoneNumber);
    if (member && (member.fields['Full Name'] === 'Unknown' || member.fields['Full Name'] === phoneNumber)) {
      await base('Members').update([{
        id: member.id,
        fields: { 'Full Name': newName }
      }]);
      console.log(`Updated member name to: ${newName}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error updating member name:', error);
    return false;
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

// Intelligent data extraction from conversations
async function extractAndSaveData(phoneNumber, message, aiResponse) {
  if (!base) return;
  
  const lowerMsg = message.toLowerCase();
  
  try {
    // Extract and save contribution amount
    const amountMatch = message.match(/(\d+(?:,\d{3})*(?:\.\d{2})?)\s*(naira|₦|ngn)?/i);
    if (amountMatch && (lowerMsg.includes('paid') || lowerMsg.includes('sent') || lowerMsg.includes('transferred') || lowerMsg.includes('deposited'))) {
      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      if (amount > 0 && amount < 1000000) {
        const cycleMonth = new Date().toISOString().slice(0, 7);
        const success = await recordContribution(phoneNumber, amount, cycleMonth);
        if (success) {
          console.log(`Auto-extracted contribution: ${amount}`);
        }
      }
    }
    
    // Extract and update member name
    const nameMatch = message.match(/(?:my name is|i am|i'm|call me|this is)\s+([a-zA-Z][a-zA-Z\s]{2,30})/i);
    if (nameMatch) {
      const extractedName = nameMatch[1].trim();
      if (extractedName && extractedName.length > 2) {
        await updateMemberName(phoneNumber, extractedName);
        console.log(`Auto-extracted name: ${extractedName}`);
      }
    }
  } catch (error) {
    console.error('Error extracting data:', error);
  }
}

// Enhanced Groq LLaMA function with conversation history
async function callGroqLlama(phoneNumber, userMessage, contextInfo = '', memberInfo = null) {
  try {
    const conversationHistory = getConversationHistory(phoneNumber);
    
    let systemPrompt = `You are Adashina, an intelligent assistant for managing Adashi (rotating savings) groups.

**IMPORTANT: You have direct access to a live Airtable database containing:**
- Members table: Full names, phone numbers, join dates, status, total contributions
- Cycles table: Current and past cycles with start/end dates, cycle names
- Contributions table: Payment records with amounts, dates, and methods
- Groups table: Group information
- ConversationHistory table: All previous conversations

Your role is to:
- Access and reference REAL data from the Airtable database
- Query member information, contributions, and cycle details from the database
- Have natural, contextual conversations remembering previous messages
- Extract information from conversations (names, payment amounts, dates)
- Track monthly contributions and member details IN THE DATABASE
- Remind members about payment deadlines
- Track who should receive pooled money each month
- Answer questions about the Adashi cycle using DATABASE information
- Be friendly, clear, and use simple language

When users mention payment:

**CRITICAL: Two-Step Confirmation Process**
When you detect a payment amount or name update in the user's message:
1. IMMEDIATELY ask for confirmation in a clear, direct way
2. State EXACTLY what you detected (amount or name)
3. Ask: "Should I record this to the database?" or "Can you confirm this?"
4. Wait for explicit confirmation (yes/confirm/correct/ok)
5. ONLY after confirmation, acknowledge that it will be saved

Example for payment:
User: "I paid 5000 naira"
You: "I detected a payment of ₦5,000. Should I record this contribution to your account in the database? Please reply 'yes' to confirm."

Example for name:
User: "My name is John Doe"
You: "I detected your name as 'John Doe'. Should I update your profile with this name? Please reply 'yes' to confirm."

DO NOT say you've saved data until the user confirms!
- Ask for confirmation of amount, date, and method if not clear
- Acknowledge and confirm when you extract payment info
- Save the contribution to the Airtable database

When new users join:
- Ask for their full name politely
- Welcome them to the group
- Create their member record in the database

IMPORTANT:
- Remember context from previous messages in THIS conversation
- When answering questions about members, cycles, or contributions, CHECK THE DATABASE
- If a user says "I paid 5000", extract and confirm: "Thank you! I've recorded your payment of ₦5,000 in the database"
- If a user introduces themselves, update their name in the database: "Nice to meet you, [Name]! I've updated your profile in our system."
- Always reference database information when available instead of saying you don't have access
- Answer questions about the Adashi cycle
- Be friendly, clear, and use simple language

When users mention payment:
- Ask for confirmation of amount, date, and method if not clear
- Acknowledge and confirm when you extract payment info

When new users join:
- Ask for their full name politely
- Welcome them to the group

IMPORTANT:
- Remember context from previous messages in THIS conversation
- If a user says "I paid 5000", extract and confirm: "Thank you! I've recorded your payment of ₦5,000"
- If a user introduces themselves, update their name: "Nice to meet you, [Name]! I've updated your profile."`;

    if (contextInfo) {
      systemPrompt += `\n\nCurrent context: ${contextInfo}`;
    }
    
    if (memberInfo) {
      systemPrompt += `\n\nMember Profile:
      - Phone Number: ${memberInfo.phoneNumber || 'Not available'}
- Name: ${memberInfo.name}
- Total Contributions: ₦${memberInfo.totalContributions || 0}
- Status: ${memberInfo.status}`;
    }
    
    // Build message history for context
    const messages = [{ role: 'system', content: systemPrompt }];
    
    // Add recent conversation history (last 8 messages = 4 exchanges)
    const recentHistory = conversationHistory.slice(-8);
    recentHistory.forEach(msg => {
      messages.push({ role: msg.role, content: msg.content });
    });
    
    // Add current user message
    messages.push({ role: 'user', content: userMessage });
    
    console.log(`Calling Groq with ${messages.length} messages in context`);
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: messages,
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

// Send WhatsApp message
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

// POST /webhook - Handle incoming WhatsApp messages with conversation memory
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

            // Check for pending action and handle confirmation
      const pendingAction = getPendingAction(from);
      const isConfirmation = /^(yes|yeah|yep|confirm|confirmed|correct|ok|okay|sure|proceed|go ahead)$/i.test(messageBody.trim());      
      if (pendingAction && isConfirmation) {
        console.log(`Executing pending ${pendingAction.type} action for ${from}`);
        
        let success = false;
        let aiResponse = '';
        
        // Execute the pending action
        if (pendingAction.type === 'payment') {
          const cycleMonth = new Date().toISOString().slice(0, 7);
          success = await recordContribution(from, pendingAction.amount, cycleMonth);
          
          if (success) {
            aiResponse = `Perfect! I've recorded your payment of ₦${pendingAction.amount.toLocaleString()} to the database. Your contribution has been successfully saved!`;
          } else {
            aiResponse = `I'm sorry, there was an error saving your payment of ₦${pendingAction.amount.toLocaleString()} to the database. Please try again or contact support.`;
          }
        } else if (pendingAction.type === 'name_update') {
          success = await updateMemberName(from, pendingAction.name);
          
          if (success) {
            aiResponse = `Great! I've updated your name to "${pendingAction.name}" in the database. Your profile has been successfully updated!`;
          } else {
            aiResponse = `Your name is already set to "${pendingAction.name}" or there was an error updating it.`;
          }
        }
        
        // Clear the pending action
        clearPendingAction(from);
        
        // Send response
        await sendWhatsAppMessage(from, aiResponse);
        console.log('Confirmation response sent successfully');
        
        // Log to Airtable
        if (base) {
          await logToAirtable(from, messageBody, aiResponse, pendingAction.type);
        }
        
        res.status(200).json({ success: true });
        return;
      }
      
      // Get or create member in Airtable
      let member = null;
      let memberInfo = null;
      
      if (base) {
        member = await createOrUpdateMember(from, senderName);
        if (member) {
          memberInfo = {
                      phoneNumber: from,
            name: member.fields['Full Name'],
            totalContributions: member.fields['Total Contributions'] || 0,
            status: member.fields['Status']
          };
        }
      }
      
      // Get current cycle context
      let contextInfo = '';
      if (base) {
        const currentCycle = await getCurrentCycle();
        if (currentCycle) {
          contextInfo = `Current cycle: ${currentCycle.fields['Cycle Name']}, Started: ${currentCycle.fields['Start Date']}, Ends: ${currentCycle.fields['End Date']}`;
        }
      }

             // Add more context about available data in database
     if (member) {
       contextInfo += `\n\nYour Database Records:
- Member ID: ${member.id}
- Name on file: ${member.fields['Full Name']}
- Total contributions to date: ₦${member.fields['Total Contributions'] || 0}
- Member status: ${member.fields['Status']}
- Join date: ${member.fields['Join Date']}`;
     }
      
      // Generate AI response with full conversation history
      const aiResponse = await callGroqLlama(from, messageBody, contextInfo, memberInfo);
      console.log('AI Response:', aiResponse);

            // Detect intent and set pending action if needed
      const intent = detectIntent(messageBody);
      if (intent && !pendingAction) {
        // Set pending action for confirmation
        setPendingAction(from, intent);
        console.log(`Intent detected: ${intent.type}, awaiting confirmation`);
      }
      
      // Add messages to conversation history
      addToConversationHistory(from, 'user', messageBody);
      addToConversationHistory(from, 'assistant', aiResponse);
      
      // Send response back via WhatsApp
      await sendWhatsAppMessage(from, aiResponse);
      console.log('Response sent successfully');
      
      // Extract and save data automatically
      if (base) {
        // await extractAndSaveData(from, messageBody, aiResponse);
      }
      
      // Log conversation to Airtable
      if (base) {
        const intent = messageBody.toLowerCase().includes('paid') || messageBody.toLowerCase().includes('contribution') ? 'Payment' : 'General';
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
