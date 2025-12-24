const express = require('express');
const { createClient } = require('redis');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

/* ================= ENV ================= */
const {
  GROQ_API_KEY,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  WEBHOOK_VERIFY_TOKEN,
  REDIS_URL, // ADD THIS NEW VARIABLE
} = process.env;

/* ================= REDIS CLIENT ================= */
const redis = createClient({
  url: REDIS_URL || 'redis://localhost:6379',
  socket: {
    keepAlive: 30000,
    reconnectStrategy: (retries) => Math.min(retries * 50, 500)
  }
});

redis.on('error', (err) => console.error('Redis Client Error', err));

// Helper function to ensure Redis is connected
async function ensureRedisConnected() {
  if (!redis.isOpen) {
    await redis.connect();
  }
  return redis;
}
/* ================= IN-MEMORY FLAGS ================= */
const userState = new Map();

/* ================= MEMORY (RUNTIME ONLY, FOR SPEED) ================= */
const memory = new Map();
const rememberInRuntime = (p, r, c) => {
  if (!memory.has(p)) memory.set(p, []);
  memory.get(p).push({ role: r, content: c });
  if (memory.get(p).length > 15) memory.get(p).shift();
};

/* ================= UTILS ================= */
const todayISO = () => new Date().toISOString();
const generateId = () => crypto.randomBytes(16).toString('hex');

const safe = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    console.error('[SAFE ERROR]', e.message);
    return null;
  }
};

/* ================= WHATSAPP ================= */
async function sendWhatsApp(to, body) {
  await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
}

/* ================= MEMBERS HELPERS (REDIS) ================= */
async function getMember(phone) {
  return safe(async () => {
    const exists = await redis.exists(`member:${phone}`);
    if (!exists) return null;
    
    const data = await redis.hGetAll(`member:${phone}`);
    if (!data || Object.keys(data).length === 0) return null;
    
    return {
      id: phone,
      fields: {
        'Full Name': data.fullName || 'Unknown',
        'Phone Number': data.phoneNumber || phone,
        'WhatsApp Number': data.whatsappNumber || phone,
        'Join Date': data.joinDate,
        Status: data.status || 'Active',
        Group: data.groupId ? [data.groupId] : []
      }
    };
  });
}

async function ensureMember(phone, name) {
  const m = await getMember(phone);
  if (m) return m;
  
  const memberData = {
    fullName: name || 'Unknown',
    phoneNumber: phone,
    whatsappNumber: phone,
    joinDate: new Date().toISOString().split('T')[0],
    status: 'Active',
    groupId: ''
  };
  
  await redis.hSet(`member:${phone}`, memberData);
  await redis.sAdd('members:all', phone);
  
  return {
    id: phone,
    fields: {
      'Full Name': memberData.fullName,
      'Phone Number': phone,
      'WhatsApp Number': phone,
      'Join Date': memberData.joinDate,
      Status: 'Active',
      Group: []
    }
  };
}

async function setPreferredName(phone, preferredName) {
  return safe(() => redis.hSet(`member:${phone}`, 'fullName', preferredName));
}

/* ================= GROUPS HELPERS (REDIS) ================= */
async function getGroupByName(name) {
  return safe(async () => {
    const groupId = await redis.get(`groups:by_name:${name}`);
    if (!groupId) return null;
    
    const data = await redis.hGetAll(`group:${groupId}`);
    if (!data || Object.keys(data).length === 0) return null;
    
    return {
      id: groupId,
      fields: {
        Name: data.name,
        'Leader Phone': data.leaderPhone,
        Description: data.description || '',
        'Start Date': data.startDate,
        'End Date': data.endDate || '',
        Active: data.active === 'true',
        'Reminder Frequency': data.reminderFrequency || 'Weekly'
      }
    };
  });
}

async function createGroupWithLeader({
  name,
  leaderPhone,
  description,
  startDate,
  endDate,
  reminderFrequency,
}) {
  try {
    const groupId = generateId();
    
    const groupData = {
      name,
      leaderPhone,
      description: description || '',
      startDate: startDate ? startDate.split('T')[0] : new Date().toISOString().split('T')[0],
      endDate: endDate && endDate.trim() !== '' ? endDate.split('T')[0] : '',
      active: 'true',
      reminderFrequency: reminderFrequency || 'Weekly',
      createdAt: todayISO()
    };
    
    await redis.hSet(`group:${groupId}`, groupData);
    await redis.set(`groups:by_name:${name}`, groupId);
    await redis.sAdd(`groups:by_leader:${leaderPhone}`, groupId);
    await redis.sAdd('groups:all', groupId);
    
    console.log('✅ Group created successfully:', groupId);
    
    return [{
      id: groupId,
      fields: {
        Name: name,
        'Leader Phone': leaderPhone,
        Description: description || '',
        'Start Date': groupData.startDate,
        'End Date': groupData.endDate,
        Active: true,
        'Reminder Frequency': reminderFrequency || 'Weekly'
      }
    }];
  } catch (err) {
    console.error('❌ Error creating group in Redis:', err.message);
    throw err;
  }
}

/* ================= SNAPSHOT FOR AI ================= */
async function snapshot(phone) {
  const member = await getMember(phone);
  let group = null;
  
  if (member?.fields?.Group?.[0]) {
    const groupId = member.fields.Group[0];
    const groupData = await redis.hGetAll(`group:${groupId}`);
    if (groupData && Object.keys(groupData).length > 0) {
      group = {
        id: groupId,
        fields: {
          Name: groupData.name,
          'Leader Phone': groupData.leaderPhone,
          Description: groupData.description,
          'Start Date': groupData.startDate,
          'End Date': groupData.endDate,
          Active: groupData.active === 'true',
          'Reminder Frequency': groupData.reminderFrequency
        }
      };
    }
  }
  
  return { member, group };
}

/* ================= PERSISTENT MEMORY FROM REDIS ================= */
async function buildConversationHistory(phone, limit = 10) {
  const keys = await redis.keys(`conversation:${phone}:*`);
  if (!keys || keys.length === 0) return [];
  
  const sortedKeys = keys.sort().slice(-limit);
  const msgs = [];
  
  for (const key of sortedKeys) {
    const data = await redis.hGetAll(key);
    if (data.userMessage) {
      msgs.push({ role: 'user', content: data.userMessage });
    }
    if (data.botResponse) {
      msgs.push({ role: 'assistant', content: data.botResponse });
    }
  }
  
  return msgs;
}

async function saveConversation(phone, userMessage, botResponse) {
  const timestamp = Date.now();
  const key = `conversation:${phone}:${timestamp}`;
  
  await redis.hSet(key, {
    phoneNumber: phone,
    userMessage,
    botResponse,
    timestamp: todayISO()
  });
  
  await redis.expire(key, 30 * 24 * 60 * 60); // 30 days
}

/* ================= AI ================= */
function systemPrompt(snap) {
  return `
You are ADASHINA, an Adashi savings assistant for WhatsApp-based Adashi groups.
You help users create and manage groups, contributions, cycles, reminders, and provide optional financial advice.
Rules:
- Briefly explain what Adashi is and what you can do.
- Get or confirm the user's name before complex actions.
- Keep track of previous conversations (the system will send you history).
- Never invent data or claim that actions were done unless clearly requested and confirmed.
- Use only information from the snapshot and conversation.
- If user asks for financial advice and permits it, provide simple, clear advice about saving and contribution planning.
Snapshot:
${JSON.stringify(snap, null, 2)}
`;
}

async function aiReply(phone, text, snap) {
  const persistentHistory = await buildConversationHistory(phone, 10);
  const runtimeHistory = memory.get(phone) || [];
  
  const msgs = [
    { role: 'system', content: systemPrompt(snap) },
    ...persistentHistory,
    ...runtimeHistory,
    { role: 'user', content: text },
  ];
  
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: msgs,
      temperature: 0.6,
      max_tokens: 400,
    }),
  });
  
  const j = await r.json();
  return j.choices?.[0]?.message?.content || 'Sorry, something went wrong.';
}

/* ================= WEBHOOK VERIFY ================= */
app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN
  ) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

/* ================= MAIN WEBHOOK ================= */
app.post('/webhook', async (req, res) => {
  try {
    // Ensure Redis is connected
    await ensureRedisConnected();
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);
    
    const phone = msg.from;
    const text = (msg.text?.body || '').trim();
    const name = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;
    
    const sender = await ensureMember(phone, name);
    rememberInRuntime(phone, 'user', text);
    
    const state = userState.get(phone) || {};
    
    if (state.mode === 'ask_name') {
      const preferredName = text;
      await setPreferredName(phone, preferredName);
      userState.set(phone, {});
      
      const reply = `Great! I will call you *${preferredName}* from now on. How can I help with your Adashi group today?`;
      rememberInRuntime(phone, 'assistant', reply);
      await sendWhatsApp(phone, reply);
      await saveConversation(phone, text, reply);
      return res.sendStatus(200);
    }
    
    if (state.mode === 'create_group_name') {
      state.data = state.data || {};
      state.data.name = text;
      state.mode = 'create_group_description';
      userState.set(phone, state);
      
      const reply = 'Nice name! Please send a short *description* for this group (what it is for).';
      rememberInRuntime(phone, 'assistant', reply);
      await sendWhatsApp(phone, reply);
      await saveConversation(phone, text, reply);
      return res.sendStatus(200);
    }
    
    if (state.mode === 'create_group_description') {
      state.data = state.data || {};
      state.data.description = text;
      state.mode = 'create_group_start_date';
      userState.set(phone, state);
      
      const reply = 'Got it. When should this group *start*? Send a date like 2025-01-05 or say "today".';
      rememberInRuntime(phone, 'assistant', reply);
      await sendWhatsApp(phone, reply);
      await saveConversation(phone, text, reply);
      return res.sendStatus(200);
    }
    
    if (state.mode === 'create_group_start_date') {
      state.data = state.data || {};
      let startDate = text.toLowerCase() === 'today' ? todayISO() : text;
      state.data.startDate = startDate;
      state.mode = 'create_group_end_date';
      userState.set(phone, state);
      
      const reply = 'Thanks. When should this group *end*? Send a date like 2025-06-05, or say "none" if it is open-ended.';
      rememberInRuntime(phone, 'assistant', reply);
      await sendWhatsApp(phone, reply);
      await saveConversation(phone, text, reply);
      return res.sendStatus(200);
    }
    
    if (state.mode === 'create_group_end_date') {
      state.data = state.data || {};
      let endDate = text.toLowerCase() === 'none' || text.toLowerCase() === 'no' ? '' : text;
      state.data.endDate = endDate;
      state.mode = 'create_group_reminder';
      userState.set(phone, state);
      
      const reply = 'Finally, how often should I remind members? For example: "daily", "weekly", or "monthly".';
      rememberInRuntime(phone, 'assistant', reply);
      await sendWhatsApp(phone, reply);
      await saveConversation(phone, text, reply);
      return res.sendStatus(200);
    }
    
    if (state.mode === 'create_group_reminder') {
      state.data = state.data || {};
      state.data.reminderFrequency = text;
      const { name: gName, description, startDate, endDate, reminderFrequency } = state.data;
      
      try {
        const created = await createGroupWithLeader({
          name: gName,
          leaderPhone: phone,
          description,
          startDate,
          endDate,
          reminderFrequency,
        });
        
        userState.set(phone, {});
        
        if (!created || !created[0]) {
          const reply = 'Something went wrong while creating the group. Please try again later.';
          rememberInRuntime(phone, 'assistant', reply);
          await sendWhatsApp(phone, reply);
          await saveConversation(phone, text, reply);
          return res.sendStatus(200);
        }
        
        // Attach group to leader member
        await redis.hSet(`member:${phone}`, 'groupId', created[0].id);
        
        const reply = `Your group *${gName}* has been created.\n\n- Leader: ${phone}\n- Start: ${startDate}\n- End: ${endDate || 'Not set'}\n- Reminder frequency: ${reminderFrequency}\n\nYou can now ask me to add members or manage contributions.`;
        rememberInRuntime(phone, 'assistant', reply);
        await sendWhatsApp(phone, reply);
        await saveConversation(phone, text, reply);
        return res.sendStatus(200);
      } catch (err) {
        console.error('Failed to create group:', err);
        userState.set(phone, {});
        
        const reply = `I tried to create the group "${gName}" but got an error.\n\nError: ${err.message}\n\nPlease try again.`;
        rememberInRuntime(phone, 'assistant', reply);
        await sendWhatsApp(phone, reply);
        await saveConversation(phone, text, reply);
        return res.sendStatus(200);
      }
    }
    
    /* ========== INVITE INTENT ========== */
    const inviteMatch = text.match(/^add\s+(\+?\d{10,15})\s+(?:to|into)\s+(.+)$/i);
    if (inviteMatch) {
      const memberPhone = inviteMatch[1].replace(/\D/g, '');
      const groupName = inviteMatch[2].trim();
      const group = await getGroupByName(groupName);
      
      if (!group) {
        await sendWhatsApp(phone, `I can't find a group called "${groupName}".`);
        return res.sendStatus(200);
      }
      
      if (group.fields['Leader Phone'] !== phone) {
        await sendWhatsApp(phone, `Only the group leader can invite members.`);
        return res.sendStatus(200);
      }
      
      const invitedMember = await getMember(memberPhone);
      if (!invitedMember) {
        await sendWhatsApp(phone, `That member has not messaged this bot before, so I can't invite them yet.`);
        return res.sendStatus(200);
      }
      
      // Store join request in Redis
      const requestId = generateId();
      await redis.hSet(`joinrequest:${requestId}`, {
        memberPhone,
        leaderPhone: phone,
        groupId: group.id,
        status: 'Pending',
        requestedAt: todayISO()
      });
      await redis.sAdd(`joinrequests:pending:${memberPhone}`, requestId);
      
      await sendWhatsApp(memberPhone, `You've been invited to join *${group.fields.Name}*.\n\nReply YES to accept or NO to decline.`);
      await sendWhatsApp(phone, `Invitation sent to ${memberPhone}. I'll notify you when they respond.`);
      return res.sendStatus(200);
    }
    
    /* ========== APPROVAL HANDLER ========== */
    if (/^(yes|no)$/i.test(text)) {
      const decision = text.toLowerCase();
      const requestIds = await redis.sMembers(`joinrequests:pending:${phone}`);
      
      if (!requestIds || requestIds.length === 0) {
        await sendWhatsApp(phone, `You don't have any pending group invitations.`);
        return res.sendStatus(200);
      }
      
      const requestId = requestIds[0];
      const reqData = await redis.hGetAll(`joinrequest:${requestId}`);
      
      if (!reqData || !reqData.groupId) {
        await sendWhatsApp(phone, `I couldn't find your invitation details.`);
        return res.sendStatus(200);
      }
      
      const groupData = await redis.hGetAll(`group:${reqData.groupId}`);
      
      if (decision === 'yes') {
        // Update member's group
        await redis.hSet(`member:${phone}`, 'groupId', reqData.groupId);
        await redis.hSet(`member:${phone}`, 'status', 'Active');
        
        // Update request status
        await redis.hSet(`joinrequest:${requestId}`, 'status', 'Approved');
        await redis.hSet(`joinrequest:${requestId}`, 'respondedAt', todayISO());
        await redis.sRem(`joinrequests:pending:${phone}`, requestId);
        
        await sendWhatsApp(phone, `You've joined the *${groupData.name}* group successfully.`);
        
        const memberData = await getMember(phone);
        await sendWhatsApp(reqData.leaderPhone, `${memberData.fields['Full Name'] || phone} accepted your invitation and joined *${groupData.name}*.`);
        return res.sendStatus(200);
      }
      
      // NO
      await redis.hSet(`joinrequest:${requestId}`, 'status', 'Rejected');
      await redis.hSet(`joinrequest:${requestId}`, 'respondedAt', todayISO());
      await redis.sRem(`joinrequests:pending:${phone}`, requestId);
      
      await sendWhatsApp(phone, `You declined the group invitation.`);
      await sendWhatsApp(reqData.leaderPhone, `${phone} declined your group invitation.`);
      return res.sendStatus(200);
    }
    
    /* ========== QUICK COMMANDS ========== */
    if (/^set name$/i.test(text)) {
      userState.set(phone, { mode: 'ask_name' });
      const reply = 'Sure. What name would you like me to call you? (Send just your preferred name.)';
      rememberInRuntime(phone, 'assistant', reply);
      await sendWhatsApp(phone, reply);
      await saveConversation(phone, text, reply);
      return res.sendStatus(200);
    }
    
    if (/^create group$/i.test(text)) {
      userState.set(phone, { mode: 'create_group_name', data: {} });
      const reply = 'Let's create a new group.\n\nFirst, what should the *group name* be?';
      rememberInRuntime(phone, 'assistant', reply);
      await sendWhatsApp(phone, reply);
      await saveConversation(phone, text, reply);
      return res.sendStatus(200);
    }
    
    /* ========== NORMAL AI FLOW ========== */
    const snap = await snapshot(phone);
    const reply = await aiReply(phone, text, snap);
    rememberInRuntime(phone, 'assistant', reply);
    await sendWhatsApp(phone, reply);
    await saveConversation(phone, text, reply);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(200);
  }
});

module.exports = app;

