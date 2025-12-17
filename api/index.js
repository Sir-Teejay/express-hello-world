/******************************************************************
 * ADASHI WHATSAPP BOT — STABLE, STATEFUL, AIRTABLE-SAFE
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

const memory = new Map();
const pending = new Map();

const remember = (p, r, c) => {
  if (!memory.has(p)) memory.set(p, []);
  memory.get(p).push({ role: r, content: c });
  if (memory.get(p).length > 15) memory.get(p).shift();
};

const setPending = (p, data) =>
  pending.set(p, { ...data, exp: Date.now() + 10 * 60 * 1000 });
const getPending = (p) => {
  const d = pending.get(p);
  if (!d || Date.now() > d.exp) return null;
  return d;
};
const clearPending = (p) => pending.delete(p);

/* ================= UTILS ================= */

const today = () => new Date().toISOString().split('T')[0];
const safe = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    console.error('[Airtable]', e.message);
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

/* ================= MEMBERS ================= */

async function getMember(phone) {
  return safe(async () => {
    const r = await base('Members')
      .select({
        filterByFormula: `OR({Phone Number}='${phone}',{WhatsApp Number}='${phone}')`,
        maxRecords: 1,
      })
      .firstPage();
    return r[0] || null;
  });
}

async function ensureMember(phone, name) {
  const m = await getMember(phone);
  if (m) return m;

  const r = await safe(() =>
    base('Members').create([
      {
        fields: {
          'Full Name': name || 'Unknown',
          'Phone Number': phone,
          'WhatsApp Number': phone,
          'Join Date': today(),
          Status: 'Active',
        },
      },
    ])
  );
  return r?.[0] || null;
}

/* ================= GROUPS ================= */

async function getGroupByName(name) {
  return safe(async () => {
    const r = await base('Groups')
      .select({ filterByFormula: `{Name}='${name}'`, maxRecords: 1 })
      .firstPage();
    return r[0] || null;
  });
}

/* ================= SNAPSHOT ================= */

async function snapshot(phone) {
  const member = await getMember(phone);
  let group = null;

  if (member?.fields?.Group?.[0]?.startsWith?.('rec')) {
    group = await safe(() =>
      base('Groups').find(member.fields.Group[0])
    );
  }

  return { member, group };
}

/* ================= AI ================= */
function systemPrompt(snap) {
  return `
You are ADASHINA, an Adashi savings assistant.

Rules:
- Do NOT invent data
- Only explain what exists
- Ask clarifying questions if info is missing

Snapshot:
${JSON.stringify(snap, null, 2)}

You may give financial advice ONLY if the user asks or agrees.
`;
}

async function aiReply(phone, text, snap) {
  const msgs = [
    { role: 'system', content: systemPrompt(snap) },
    ...(memory.get(phone) || []),
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

    /* Always reply — no silent exits */
    const snap = await snapshot(phone);
    const reply = await aiReply(phone, text, snap);

    remember(phone, 'assistant', reply);
    await sendWhatsApp(phone, reply);

    await safe(() =>
      base('ConversationHistory').create([
        {
          fields: {
            'Phone Number': phone,
            'User Message': text,
            'Bot Response': reply,
            Timestamp: new Date().toISOString(),
          },
        },
      ])
    );

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error', e);
    res.sendStatus(200); // never block WhatsApp
  }
});

module.exports = app;

