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
// In‑memory state for multi‑step flows (group creation, asking name, etc.)
const userState = new Map(); // phone -> { mode, data }

/* ================= MEMORY (RUNTIME ONLY, FOR SPEED) ================= */
const memory = new Map();
const rememberInRuntime = (p, r, c) => {
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

/* ================= MEMBERS HELPERS ================= */
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
          'Join Date': new Date().toISOString().split('T')[0],
          Status: 'Active',
        },
      },
    ])
  );
  return r?.[0] || null;
}

async function setPreferredName(memberId, preferredName) {
  return safe(() =>
    base('Members').update([
      {
        id: memberId,
        fields: {
          'Full Name': preferredName,
        },
      },
    ])
  );
}

/* ================= GROUPS HELPERS ================= */
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

async function createGroupWithLeader({
  name,
  leaderPhone,
  description,
  startDate,
  endDate,
  reminderFrequency,
}) {
  try {
    console.log('Creating group with data:', {
      name,
      leaderPhone,
      description,
      startDate,
      endDate,
      reminderFrequency
    });
    
    const created = await base('Groups').create([
  {
    fields: {
      Name: name,
      'Leader Phone': leaderPhone,
      Description: description || '',
      'Start Date': startDate
        ? startDate.split('T')[0]
        : new Date().toISOString().split('T')[0],
      'End Date': endDate
        ? endDate.split('T')[0]
        : '',
      Active: true,
      'Reminder Frequency': reminderFrequency || 'Weekly',
      // Removed: Total Members, Total Cycles Completed, Recent Reminder Sent (computed)
      // Removed: Members Names & Numbers (doesn't exist)
    },
  },
]);
    
    console.log('✅ Group created successfully:', created[0].id);
    return created;
  } catch (err) {
    console.error('❌ Error creating group in Airtable:', err.message);
    console.error('Full error:', JSON.stringify(err, null, 2));
    throw err;
  }
}

/* ================= SNAPSHOT FOR AI ================= */
async function snapshot(phone) {
  const member = await getMember(phone);
  let group = null;
  if (member?.fields?.Group?.[0]?.startsWith?.('rec')) {
    group = await safe(() => base('Groups').find(member.fields.Group[0]));
  }
  return { member, group };
}


/* ================= PERSISTENT MEMORY FROM AIRTABLE ================= */
async function buildConversationHistory(phone, limit = 10) {
  // Fetch last N interactions from ConversationHistory for this phone
  const records = await safe(async () => {
    const r = await base('ConversationHistory')
      .select({
        filterByFormula: `{Phone Number}='${phone}'`,
        sort: [{ field: 'Timestamp', direction: 'desc' }],
        maxRecords: limit,
      })
      .firstPage();
    return r || [];
  });

  if (!records || records.length === 0) return [];

  // Newest first -> reverse to oldest first
  const sorted = [...records].reverse();

  const msgs = [];
  for (const rec of sorted) {
    const fields = rec.fields || {};
    if (fields['User Message']) {
      msgs.push({ role: 'user', content: fields['User Message'] });
    }
    if (fields['Bot Response']) {
      msgs.push({ role: 'assistant', content: fields['Bot Response'] });
    }
  }
  return msgs;
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
  // Rebuild long‑term history from Airtable
  const persistentHistory = await buildConversationHistory(phone, 10);
  // Also include short in‑memory history for continuity within the current instance
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
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = msg.from;
    const text = (msg.text?.body || '').trim();
    const name =
      req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;

    const sender = await ensureMember(phone, name);
    rememberInRuntime(phone, 'user', text);

    /* ========== STATE MACHINE: PREFERRED NAME FLOW ========== */
    const state = userState.get(phone) || {};

    if (state.mode === 'ask_name') {
      const preferredName = text;
      await setPreferredName(sender.id, preferredName);
      userState.set(phone, {}); // clear state
      const reply = `Great! I will call you *${preferredName}* from now on. How can I help with your Adashi group today?`;
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    }

    if (state.mode === 'create_group_name') {
      // Step 1: got group name
      state.data = state.data || {};
      state.data.name = text;
      state.mode = 'create_group_description';
      userState.set(phone, state);
      const reply =
        'Nice name! Please send a short *description* for this group (what it is for).';
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    }

    if (state.mode === 'create_group_description') {
      state.data = state.data || {};
      state.data.description = text;
      state.mode = 'create_group_start_date';
      userState.set(phone, state);
      const reply =
        'Got it. When should this group *start*? Send a date like 2025-01-05 or say “today”.';
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    }

    if (state.mode === 'create_group_start_date') {
      state.data = state.data || {};
      let startDate = text.toLowerCase() === 'today' ? todayISO() : text;
      state.data.startDate = startDate;
      state.mode = 'create_group_end_date';
      userState.set(phone, state);
      const reply =
        'Thanks. When should this group *end*? Send a date like 2025-06-05, or say “none” if it is open‑ended.';
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    }

    if (state.mode === 'create_group_end_date') {
      state.data = state.data || {};
      let endDate =
        text.toLowerCase() === 'none' || text.toLowerCase() === 'no'
          ? ''
          : text;
      state.data.endDate = endDate;
      state.mode = 'create_group_reminder';
      userState.set(phone, state);
      const reply =
        'Finally, how often should I remind members? For example: “daily”, “weekly”, or “monthly”.';
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    }

      if (state.mode === 'create_group_reminder') {
    state.data = state.data || {};
    state.data.reminderFrequency = text;

    const { name: gName, description, startDate, endDate, reminderFrequency } =
      state.data;

    try {
      // Actually create the group in Airtable
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
        const reply =
          'Something went wrong while creating the group. No record was returned. Please try again later.';
        rememberInRuntime(phone, 'assistant', reply);
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
        return res.sendStatus(200);
      }

      // Attach group to leader member record
      await safe(() =>
        base('Members').update([
          {
            id: sender.id,
            fields: {
              Group: [created[0].id],
              Status: 'Active',
            },
          },
        ])
      );

      const reply = `Your group *${gName}* has been created.\n\n- Leader: ${phone}\n- Start: ${startDate}\n- End: ${endDate || 'Not set'}\n- Reminder frequency: ${reminderFrequency}\n\nYou can now ask me to add members or manage contributions.`;
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    } catch (err) {
      console.error('Failed to create group:', err);
      userState.set(phone, {});
      
      const reply = `I tried to create the group "${gName}" but got an error from the database.\n\nError: ${err.message}\n\nPlease check:\n1. All field names match exactly in Airtable\n2. The "Reminder Frequency" field exists and is a text field\n3. Your Airtable API key has write permissions`;
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    }
  }


    /* ========== INVITE INTENT (EXISTING FLOW) ========== */
    const inviteMatch = text.match(
      /^add\s+(\+?\d{10,15})\s+(?:to|into)\s+(.+)$/i
    );
    if (inviteMatch) {
      const memberPhone = inviteMatch[1].replace(/\D/g, '');
      const groupName = inviteMatch[2].trim();
      const group = await getGroupByName(groupName);

      if (!group) {
        await sendWhatsApp(
          phone,
          `I can’t find a group called "${groupName}".`
        );
        return res.sendStatus(200);
      }

      if (group.fields['Leader Phone'] !== phone) {
        await sendWhatsApp(
          phone,
          `Only the group leader can invite members.`
        );
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

    /* ========== APPROVAL HANDLER (EXISTING FLOW) ========== */
    if (/^(yes|no)$/i.test(text)) {
      const decision = text.toLowerCase();
      const reqs = await base('JoinRequests')
        .select({
          filterByFormula: `AND({Member Phone}='${phone}', {Status}='Pending')`,
          maxRecords: 1,
        })
        .firstPage();

      if (reqs.length === 0) {
        await sendWhatsApp(
          phone,
          `You don’t have any pending group invitations.`
        );
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

    /* ========== QUICK COMMANDS (NEW) ========== */
    if (/^set name$/i.test(text)) {
      userState.set(phone, { mode: 'ask_name' });
      const reply =
        'Sure. What name would you like me to call you? (Send just your preferred name.)';
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    }

    if (/^create group$/i.test(text)) {
      userState.set(phone, { mode: 'create_group_name', data: {} });
      const reply =
        'Let’s create a new group.\n\nFirst, what should the *group name* be?';
      rememberInRuntime(phone, 'assistant', reply);
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
      return res.sendStatus(200);
    }

    /* ========== NORMAL AI FLOW ========== */
    const snap = await snapshot(phone);
    const reply = await aiReply(phone, text, snap);
    rememberInRuntime(phone, 'assistant', reply);
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
