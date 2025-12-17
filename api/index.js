/******************************************************************
 * ADASHI WHATSAPP BOT — INVITE & APPROVAL ENABLED
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

const remember = (p, r, c) => {
  if (!memory.has(p)) memory.set(p, []);
  memory.get(p).push({ role: r, content: c });
  if (memory.get(p).length > 15) memory.get(p).shift();
};

/* ================= UTILS ================= */

const todayISO = () => new Date().toISOString();

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
          'Join Date': todayISO(),
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
      .select({
        filterByFormula: `{Name}='${name}'`,
        maxRecords: 1,
      })
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
You are ADASHINA, an Adashi savings assistant. A personalized assistant for Adashi groups. You help you manage contributions, schedule payment dates, send reminders and make the adashi community stay on track.

Rules:
- Explain what you do and what Adashi is
- Never invent data
- Never claim actions unless system did them
- Explain only what exists in snapshot
- Give financial advice only if user asks

Snapshot:
${JSON.stringify(snap, null, 2)}
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
    const text = msg.text.body.trim();
    const name =
      req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;

    const sender = await ensureMember(phone, name);
    remember(phone, 'user', text);

    /* ================= INVITE INTENT ================= */

    const inviteMatch = text.match(
      /^add\s+(\+?\d{10,15})\s+(?:to|into)\s+(.+)$/i
    );

    if (inviteMatch) {
      const memberPhone = inviteMatch[1].replace(/\D/g, '');
      const groupName = inviteMatch[2].trim();

      const group = await getGroupByName(groupName);
      if (!group) {
        await sendWhatsApp(phone, `I can’t find a group called "${groupName}".`);
        return res.sendStatus(200);
      }

      if (group.fields['Leader Phone'] !== phone) {
        await sendWhatsApp(phone, `Only the group leader can invite members.`);
        return res.sendStatus(200);
      }

      const invitedMember = await getMember(memberPhone);
      if (!invitedMember) {
        await sendWhatsApp(
          phone,
          `That member has not messaged this bot before, so I can’t invite them yet.`
        );
        return res.sendStatus(200);
      }

      await base('JoinRequests').create([
        {
          fields: {
            'Member Phone': memberPhone,
            'Leader Phone': phone,
            Group: [group.id],
            Status: 'Pending',
            'Requested At': todayISO(),
          },
        },
      ]);

      await sendWhatsApp(
        memberPhone,
        `You’ve been invited to join *${group.fields.Name}*.\n\nReply YES to accept or NO to decline.`
      );

      await sendWhatsApp(
        phone,
        `Invitation sent to ${memberPhone}. I’ll notify you when they respond.`
      );

      return res.sendStatus(200);
    }

    /* ================= APPROVAL HANDLER ================= */

    if (/^(yes|no)$/i.test(text)) {
      const decision = text.toLowerCase();

      const reqs = await base('JoinRequests')
        .select({
          filterByFormula: `AND({Member Phone}='${phone}', {Status}='Pending')`,
          maxRecords: 1,
        })
        .firstPage();

      if (reqs.length === 0) {
        await sendWhatsApp(phone, `You don’t have any pending group invitations.`);
        return res.sendStatus(200);
      }

      const reqRec = reqs[0];
      const groupId = reqRec.fields.Group?.[0];

      if (decision === 'yes') {
        await base('Members').update([
          {
            id: sender.id,
            fields: {
              Group: [groupId],
              Status: 'Active',
            },
          },
        ]);

        await base('JoinRequests').update([
          {
            id: reqRec.id,
            fields: {
              Status: 'Approved',
              'Responded At': todayISO(),
            },
          },
        ]);

        const group = await base('Groups').find(groupId);

        await sendWhatsApp(
          phone,
          `You’ve joined the *${group.fields.Name}* group successfully.`
        );

        await sendWhatsApp(
          reqRec.fields['Leader Phone'],
          `${sender.fields['Full Name'] || phone} accepted your invitation and joined *${group.fields.Name}*.`
        );

        return res.sendStatus(200);
      }

      // NO
      await base('JoinRequests').update([
        {
          id: reqRec.id,
          fields: {
            Status: 'Rejected',
            'Responded At': todayISO(),
          },
        },
      ]);

      await sendWhatsApp(phone, `You declined the group invitation.`);
      await sendWhatsApp(
        reqRec.fields['Leader Phone'],
        `${phone} declined your group invitation.`
      );

      return res.sendStatus(200);
    }

    /* ================= NORMAL AI ================= */

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
            Timestamp: todayISO(),
          },
        },
      ])
    );

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(200);
  }
});

module.exports = app;
