const express = require('express');
const Airtable = require('airtable');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

/* ================= ENV ================= */
const {
  GROQ_API_KEY,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  WEBHOOK_VERIFY_TOKEN,
} = process.env;

/* ================= AIRTABLE ================= */
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

/* ================= IN‑MEMORY FLAGS ================= */
const userState = new Map();
const memory = new Map();

const rememberInRuntime = (p, r, c) => {
  if (!memory.has(p)) memory.set(p, []);
  memory.get(p).push({ role: r, content: c });
  if (memory.get(p).length > 15) memory.get(p).shift();
};

/* ================= UTILS ================= */
const todayISO = () => new Date().toISOString().split('T')[0];

function snapshot() {
  const entries = [];
  for (const [phone, msgs] of memory.entries()) {
    entries.push(`Phone: ${phone}, Messages: ${msgs.length}`);
  }
  return entries.length > 0 ? entries.join('; ') : 'No memory';
}

/* ================= AIRTABLE HELPERS ================= */
async function createGroupRecord(fields) {
  try {
    const record = await base('Groups').create(fields);
    console.log('[DB] Created group:', record.id);
    return record;
  } catch (err) {
    console.error('[DB ERROR] Failed to create group:', err.message);
    throw err;
  }
}

async function findGroupsByLeader(leaderPhone) {
  try {
    const records = await base('Groups')
      .select({ filterByFormula: `{Leader Phone} = "${leaderPhone}"` })
      .firstPage();
    return records;
  } catch (err) {
    console.error('[DB ERROR] Failed to find groups by leader:', err.message);
    return [];
  }
}

async function saveConversation(phone, userMsg, botMsg, intent) {
  try {
    await base('ConversationHistory').create({
      'Phone Number': phone,
      'User Message': userMsg,
      'Bot Response': botMsg,
      'Timestamp': new Date().toISOString(),
      'Intent': intent || 'general',
    });
    console.log('[DB] Saved conversation for:', phone, 'Intent:', intent);
  } catch (err) {
    console.error('[DB ERROR] Failed to save conversation:', err.message);
  }
}

async function getConversationHistory(phone, limit = 10) {
  try {
    const records = await base('ConversationHistory')
      .select({
        filterByFormula: `{Phone Number} = "${phone}"`,
        sort: [{ field: 'Timestamp', direction: 'desc' }],
        maxRecords: limit,
      })
      .firstPage();
    return records.reverse();
  } catch (err) {
    console.error('[DB ERROR] Failed to get conversation history:', err.message);
    return [];
  }
}

/* ================= AI HELPERS ================= */
async function callGroq(messages) {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[GROQ ERROR]', response.status, errorText);
      return 'Sorry, I encountered an error. Please try again.';
    }

    const data = await response.json();
    const assistantMessage = data.choices?.[0]?.message?.content?.trim();
    
    if (!assistantMessage) {
      console.error('[GROQ ERROR] Empty response');
      return 'Sorry, I got an empty response. Please try again.';
    }

    return assistantMessage;
  } catch (err) {
    console.error('[GROQ ERROR] Exception:', err.message);
    return 'Sorry, I had trouble connecting to my AI. Please try again.';
  }
}

function classifyIntent(userMessage) {
  const msg = userMessage.toLowerCase();
  
  if (msg.includes('create') && (msg.includes('group') || msg.includes('adashi'))) return 'create_group';
  if (msg.includes('join') && msg.includes('group')) return 'join_group';
  if (msg.includes('add') && msg.includes('member')) return 'add_member';
  if (msg.includes('start') && msg.includes('cycle')) return 'start_cycle';
  if (msg.includes('contribute') || msg.includes('payment')) return 'contribution';
  if (msg.includes('payout') && msg.includes('date')) return 'set_payout';
  if (msg.includes('reminder')) return 'reminder';
  if (msg.includes('status') || msg.includes('summary')) return 'check_status';
  if (msg.includes('financial') || msg.includes('advice') || msg.includes('invest')) return 'financial_consulting';
  if (msg.includes('preferred name') || msg.includes('call me')) return 'set_preferred_name';
  
  return 'general';
}

async function buildContextForAI(phone, userMessage) {
  const history = await getConversationHistory(phone, 5);
  const runtimeMemory = memory.get(phone) || [];
  const userGroups = await findGroupsByLeader(phone);
  const groupInfo = userGroups.map(g => `Group: ${g.get('Name')}, Members: ${g.get('Total Members') || 0}`).join('; ');
  
  const systemPrompt = `You are an AI assistant for an Adashi (rotating savings) group management system via WhatsApp.

CURRENT USER INFO:
- Phone: ${phone}
- ${groupInfo || 'No groups yet'}

DATABASE SNAPSHOT: ${snapshot()}

CAPABILITIES:
- Create groups with description, dates, photos, active status
- Manage members and their preferred names
- Track cycles, contributions, payouts
- Set reminder frequency and send reminders
- Detect payout date collisions and suggest alternatives
- Provide financial consulting (if user permits)
- Handle join requests with leader approval

IMPORTANT RULES:
1. When user creates a group, ask for: name, description, start date, end date, contribution amount, reminder frequency
2. When user wants to join a group, create a join request for leader approval
3. Ask members for their preferred name
4. At cycle start, ask each member for their payout date and check for collisions
5. Track all interactions in database with proper intent classification
6. Be conversational, helpful, and remember context

Previous conversation:
${history.map(h => `User: ${h.get('User Message')}\nBot: ${h.get('Bot Response')}`).join('\n\n')}

Respond naturally to: "${userMessage}"`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...runtimeMemory,
    { role: 'user', content: userMessage },
  ];

  return messages;
}

/* ================= WHATSAPP HELPERS ================= */
async function sendWhatsApp(to, message) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: message },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[WHATSAPP ERROR]', response.status, errorText);
      return false;
    }

    console.log('[WHATSAPP] Sent to:', to);
    return true;
  } catch (err) {
    console.error('[WHATSAPP ERROR] Exception:', err.message);
    return false;
  }
}

/* ================= WEBHOOK HANDLERS ================= */
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/api/webhook', async (req, res) => {
  try {
    const { entry } = req.body;
    if (!entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      return res.sendStatus(200);
    }

    const message = entry[0].changes[0].value.messages[0];
    const from = message.from;
    const userMessage = message.text?.body;

    if (!userMessage) {
      return res.sendStatus(200);
    }

    console.log('[WEBHOOK] Received from', from, ':', userMessage);

    const intent = classifyIntent(userMessage);
    console.log('[INTENT]', intent);

    const messages = await buildContextForAI(from, userMessage);
    const botResponse = await callGroq(messages);

    rememberInRuntime(from, 'user', userMessage);
    rememberInRuntime(from, 'assistant', botResponse);

    await saveConversation(from, userMessage, botResponse, intent);

    if (intent === 'create_group') {
      const nameMatch = userMessage.match(/(?:create|make|start)\s+(?:a|an)?\s*(?:group|adashi)?\s*(?:called|named)?\s+(['"]?)([a-zA-Z0-9\s-]+)\1/i);
      if (nameMatch) {
        const groupName = nameMatch[2].trim();
        try {
          await createGroupRecord({
            'Name': groupName,
            'Leader Phone': from,
            'Active': true,
          });
          console.log('[ACTION] Created group:', groupName);
        } catch (err) {
          console.error('[ACTION] Failed to create group:', err.message);
        }
      }
    }

    await sendWhatsApp(from, botResponse);
    res.sendStatus(200);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    res.sendStatus(500);
  }
});

/* ================= ROOT & HEALTH ================= */
app.get('/', (req, res) => {
  res.send('Adashi WhatsApp Bot is running!');
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});

module.exports = app;
