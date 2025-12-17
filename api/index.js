/******************************************************************
 * ADASHI BOT — FULLY FIXED & EXTENDED INDEX.JS
 * Authoritative Airtable-integrated WhatsApp bot
 ******************************************************************/

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

/* ================= MEMORY ================= */

const conversationStore = new Map();
const pendingActions = new Map();

/* ================= HELPERS ================= */

const nowISO = () => new Date().toISOString();
const today = () => new Date().toISOString().split('T')[0];

function remember(phone, role, content) {
  if (!conversationStore.has(phone)) conversationStore.set(phone, []);
  const h = conversationStore.get(phone);
  h.push({ role, content });
  if (h.length > 20) h.shift();
}

function setPending(phone, action) {
  pendingActions.set(phone, {
    ...action,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
}

function getPending(phone) {
  const p = pendingActions.get(phone);
  if (!p || Date.now() > p.expiresAt) return null;
  return p;
}

function clearPending(phone) {
  pendingActions.delete(phone);
}

/* ================= WHATSAPP ================= */

async function sendWhatsAppMessage(to, body) {
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

/* ================= AIRTABLE CORE ================= */

async function getMember(phone) {
  const recs = await base('Members')
    .select({
      filterByFormula: `OR({Phone Number}='${phone}',{WhatsApp Number}='${phone}')`,
      maxRecords: 1,
    })
    .firstPage();
  return recs[0] || null;
}

async function ensureMember(phone, name) {
  const existing = await getMember(phone);
  if (existing) return existing;

  const [rec] = await base('Members').create([
    {
      fields: {
        'Full Name': name || 'Unknown',
        'Phone Number': phone,
        'WhatsApp Number': phone,
        'Join Date': today(),
        Status: 'Active',
      },
    },
  ]);
  return rec;
}

async function getGroupByName(name) {
  const r = await base('Groups')
    .select({ filterByFormula: `{Name}='${name}'`, maxRecords: 1 })
    .firstPage();
  return r[0] || null;
}

async function getGroupByLeader(phone) {
  const r = await base('Groups')
    .select({ filterByFormula: `{Leader Phone}='${phone}'`, maxRecords: 1 })
    .firstPage();
  return r[0] || null;
}

/* ================= GROUP CREATION FLOW ================= */

async function createGroupWizard(phone, groupName) {
  setPending(phone, { type: 'group_desc', groupName });
  await sendWhatsAppMessage(
    phone,
    `Great! Let's create *${groupName}*.\n\nPlease send a short *description* of the group.`
  );
}

/* ================= JOIN FLOW ================= */

async function requestJoin(member, group) {
  const leaderPhone = group.fields['Leader Phone'];

  setPending(member.fields['Phone Number'], {
    type: 'join_wait',
    groupId: group.id,
  });

  await sendWhatsAppMessage(
    leaderPhone,
    `Join request:\n\n${member.fields['Full Name']} (${member.fields['Phone Number']}) wants to join *${group.fields['Name']}*.\n\nReply:\nAPPROVE ${member.id}\nor\nREJECT ${member.id}`
  );
}

/* ================= SNAPSHOT ================= */

async function buildSnapshot(phone) {
  const member = await getMember(phone);

  let group = null;
  if (member?.fields.Group?.length) {
    group = await base('Groups').find(member.fields.Group[0]);
  }

  let cycles = [];
  if (group) {
    cycles = await base('Cycles')
      .select({
        filterByFormula: `{Group}='${group.id}'`,
      })
      .firstPage();
  }

  let reminders = [];
  if (member) {
    reminders = await base('Reminder')
      .select({
        filterByFormula: `{Member Notified}='${member.id}'`,
      })
      .firstPage();
  }

  return { member, group, cycles, reminders };
}

/* ================= AI ================= */

function systemPrompt(snapshot) {
  return `
You are ADASHINA, an Adashi savings assistant.

RULES:
- You do NOT invent data.
- You rely ONLY on the snapshot.
- All approvals & writes happen in code, not by you.

SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}

You may:
- Explain group status
- Give savings advice if user permits
- Explain next steps clearly
`;
}

async function callAI(phone, userMsg, snapshot) {
  const messages = [
    { role: 'system', content: systemPrompt(snapshot) },
    ...(conversationStore.get(phone) || []),
    { role: 'user', content: userMsg },
  ];

  const res = await fetch(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        temperature: 0.6,
        max_tokens: 400,
      }),
    }
  );

  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'Sorry, something went wrong.';
}

/* ================= WEBHOOK ================= */

app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN
  ) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = msg.from;
    const text = msg.text.body;
    const name =
      req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile
        ?.name;

    const member = await ensureMember(phone, name);
    remember(phone, 'user', text);

    const pending = getPending(phone);

    /* ---------- CREATE GROUP ---------- */
    if (/create group/i.test(text)) {
      const groupName = text.replace(/create group/i, '').trim();
      await createGroupWizard(phone, groupName);
      return res.sendStatus(200);
    }

    /* ---------- NORMAL AI ---------- */
    const snapshot = await buildSnapshot(phone);
    const reply = await callAI(phone, text, snapshot);

    remember(phone, 'assistant', reply);
    await sendWhatsAppMessage(phone, reply);

    await base('ConversationHistory').create([
      {
        fields: {
          'Phone Number': phone,
          'User Message': text,
          'Bot Response': reply,
          Timestamp: nowISO(),
        },
      },
    ]);

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

/* ================= EXPORT ================= */

module.exports = app;
