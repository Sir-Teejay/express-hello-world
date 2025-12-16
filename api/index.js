// NEW index.js IMPLEMENTATION FOR ADASHI BOT

const express = require('express');
const app = express();
const Airtable = require('airtable');
const path = require('path');
const fetch = require('node-fetch');

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
  base = new Airtable({ apiKey: airtableApiKey }).base(airtableBaseId);
  console.log('Airtable initialized');
}

// In-memory conversation store (use Redis in production)
const conversationStore = new Map();
// Pending actions store for two-step confirmation
const pendingActions = new Map();

/* ------------ Conversation helpers ------------ */

function getConversationHistory(phoneNumber) {
  if (!conversationStore.has(phoneNumber)) {
    conversationStore.set(phoneNumber, []);
  }
  return conversationStore.get(phoneNumber);
}

function addToConversationHistory(phoneNumber, role, content) {
  const history = getConversationHistory(phoneNumber);
  history.push({ role, content, timestamp: Date.now() });
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }
  conversationStore.set(phoneNumber, history);
}

function setPendingAction(phoneNumber, action) {
  pendingActions.set(phoneNumber, {
    ...action,
    timestamp: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });
  console.log(`Pending action set for ${phoneNumber}:`, action.type);
}

function getPendingAction(phoneNumber) {
  const action = pendingActions.get(phoneNumber);
  if (!action) return null;
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

/* ------------ Intent detection ------------ */

function detectIntent(message) {
  const lowerMsg = message.toLowerCase();

  // Payment intent
  const amountMatch = message.match(
    /(\d+(?:,\d{3})*(?:\.\d{2})?)\s*(naira|₦|ngn|k)?/i
  );
  if (amountMatch) {
    const hasPaymentKeyword = /\b(paid|pay|sent|send|transferred|transfer|deposited|deposit|contribute|contribution)\b/i.test(
      lowerMsg
    );
    if (hasPaymentKeyword) {
      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      const finalAmount =
        amountMatch[2] && amountMatch[2].toLowerCase() === 'k'
          ? amount * 1000
          : amount;
      if (finalAmount > 0 && finalAmount < 1000000) {
        return { type: 'payment', amount: finalAmount, confidence: 'high' };
      }
    }
  }

  // Name update intent
  const nameMatch = message.match(
    /(?:my name is|i am|i'm|call me|this is|name:?)\s+([a-zA-Z][a-zA-Z\s]{2,40})/i
  );
  if (nameMatch) {
    const extractedName = nameMatch[1].trim();
    if (
      extractedName &&
      extractedName.length > 2 &&
      !/\b(user|unknown|member)\b/i.test(extractedName)
    ) {
      return { type: 'name_update', name: extractedName, confidence: 'high' };
    }
  }

  // Create group intent
  const createGroupMatch =
    message.match(
      /(?:create|start|open|set up)\s+(?:a\s+)?(group|community)\s+called\s+(.{2,50})/i
    ) ||
    message.match(
      /(?:create|start|open|set up)\s+(?:a\s+)?(group|community)\s+named\s+(.{2,50})/i
    );
  if (createGroupMatch) {
    const groupName = createGroupMatch[2].trim();
    if (groupName.length > 1) {
      return { type: 'create_group', groupName, confidence: 'high' };
    }
  }

  // Join group intent
  const joinGroupMatch = message.match(/join\s+(group|community)\s+(.{2,50})/i);
  if (joinGroupMatch) {
    const groupName = joinGroupMatch[2].trim();
    if (groupName.length > 1) {
      return { type: 'join_group', groupName, confidence: 'high' };
    }
  }

  // Leader payment commands
  const leaderConfirmMatch = message.match(
    /confirm payment\s+([a-zA-Z0-9]+)/i
  );
  if (leaderConfirmMatch) {
    return {
      type: 'leader_confirm_payment',
      pendingId: leaderConfirmMatch[1],
      confidence: 'high',
    };
  }

  const leaderRejectMatch = message.match(/reject payment\s+([a-zA-Z0-9]+)/i);
  if (leaderRejectMatch) {
    return {
      type: 'leader_reject_payment',
      pendingId: leaderRejectMatch[1],
      confidence: 'high',
    };
  }

  return null;
}

/* ------------ Airtable helpers ------------ */

async function logToAirtable(phoneNumber, message, response, intent = 'General') {
  if (!base) return;
  try {
    await base('ConversationHistory').create([
      {
        fields: {
          'Phone Number': phoneNumber,
          'User Message': message,
          'Bot Response': response,
          Intent: intent,
          Timestamp: new Date().toISOString(),
        },
      },
    ]);
    console.log('Conversation logged to Airtable');
  } catch (error) {
    console.error('Error logging to Airtable:', error.message);
  }
}

async function getMemberByPhone(phoneNumber) {
  if (!base) return null;
  try {
    const records = await base('Members')
      .select({
        filterByFormula: `OR({Phone Number} = '${phoneNumber}', {WhatsApp Number} = '${phoneNumber}')`,
        maxRecords: 1,
      })
      .firstPage();
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

    const records = await base('Members').create([
      {
        fields: {
          'Full Name': name,
          'Phone Number': phoneNumber,
          'WhatsApp Number': phoneNumber,
          'Join Date': new Date().toISOString().split('T')[0],
          Status: 'Active',
        },
      },
    ]);
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
    if (!member) return false;

    await base('Members').update([
      {
        id: member.id,
        fields: { 'Full Name': newName },
      },
    ]);
    console.log(`Updated member name to: ${newName}`);
    return true;
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

    await base('Contributions').create([
      {
        fields: {
          Name: `${member.fields['Full Name']} - ${cycleMonth}`,
          'Contribution Amount': amount,
          'Contribution Date': new Date().toISOString().split('T')[0],
          'Payment Method': 'WhatsApp Bot',
        },
      },
    ]);

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
    const records = await base('Cycles')
      .select({
        filterByFormula:
          'AND(IS_BEFORE({Start Date}, TODAY()), IS_AFTER({End Date}, TODAY()))',
        maxRecords: 1,
        sort: [{ field: 'Start Date', direction: 'desc' }],
      })
      .firstPage();
    return records.length > 0 ? records[0] : null;
  } catch (error) {
    console.error('Error getting current cycle:', error);
    return null;
  }
}

/* ------------ Groups & leaders ------------ */

async function getGroupByLeaderPhone(phoneNumber) {
  if (!base) return null;
  try {
    const records = await base('Groups')
      .select({
        filterByFormula: `{Leader Phone} = '${phoneNumber}'`,
        maxRecords: 1,
      })
      .firstPage();
    return records.length > 0 ? records[0] : null;
  } catch (error) {
    console.error('Error getting group by leader phone:', error);
    return null;
  }
}

async function createGroup(name, leaderPhone) {
  if (!base) return null;
  try {
    const existing = await getGroupByLeaderPhone(leaderPhone);
    if (existing) {
      console.log(
        'Group already exists for this leader:',
        existing.fields['Name']
      );
      return existing;
    }
    const records = await base('Groups').create([
      {
        fields: {
          Name: name,
          'Leader Phone': leaderPhone,
        },
      },
    ]);
    console.log('New group created:', name);
    return records[0];
  } catch (error) {
    console.error('Error creating group:', error);
    return null;
  }
}

async function getGroupByName(name) {
  if (!base) return null;
  try {
    const records = await base('Groups')
      .select({
        filterByFormula: `{Name} = '${name}'`,
        maxRecords: 1,
      })
      .firstPage();
    return records.length > 0 ? records[0] : null;
  } catch (error) {
    console.error('Error getting group by name:', error);
    return null;
  }
}

async function assignMemberToGroup(memberRecord, groupRecord) {
  if (!base || !memberRecord || !groupRecord) return false;
  try {
    await base('Members').update([
      {
        id: memberRecord.id,
        fields: {
          Group: groupRecord.fields['Name'],
          'Leader Phone': groupRecord.fields['Leader Phone'],
        },
      },
    ]);
    console.log(
      `Member ${memberRecord.fields['Full Name']} added to group ${groupRecord.fields['Name']}`
    );
    return true;
  } catch (error) {
    console.error('Error assigning member to group:', error);
    return false;
  }
}

/* ------------ Pending payments (leader confirmation) ------------ */

async function createPendingPayment(memberPhone, leaderPhone, amount) {
  if (!base) return null;
  try {
    const records = await base('PendingPayments').create([
      {
        fields: {
          'Member Phone': memberPhone,
          'Leader Phone': leaderPhone,
          Amount: amount,
          Status: 'Awaiting Leader',
          'Created At': new Date().toISOString(),
        },
      },
    ]);
    console.log('Pending payment created:', records[0].id);
    return records[0];
  } catch (error) {
    console.error('Error creating pending payment:', error);
    return null;
  }
}

async function approvePendingPayment(pendingId) {
  if (!base) return false;
  try {
    await base('PendingPayments').update([
      {
        id: pendingId,
        fields: {
          Status: 'Approved',
          'Approved At': new Date().toISOString(),
        },
      },
    ]);
    console.log('Pending payment approved:', pendingId);
    return true;
  } catch (error) {
    console.error('Error approving pending payment:', error);
    return false;
  }
}

async function rejectPendingPayment(pendingId) {
  if (!base) return false;
  try {
    await base('PendingPayments').update([
      {
        id: pendingId,
        fields: {
          Status: 'Rejected',
          'Approved At': new Date().toISOString(),
        },
      },
    ]);
    console.log('Pending payment rejected:', pendingId);
    return true;
  } catch (error) {
    console.error('Error rejecting pending payment:', error);
    return false;
  }
}

/* ------------ DB snapshot + prompt ------------ */

async function buildDbSnapshot(phoneNumber) {
  if (!base) {
    return {
      member: null,
      currentCycle: null,
      group: null,
      dbSnapshotText: '',
    };
  }

  const member = await getMemberByPhone(phoneNumber);
  const currentCycle = await getCurrentCycle();

  // Try to find this member's group, if any
  let group = null;
  if (member && member.fields['Group']) {
    try {
      const groupRecords = await base('Groups')
        .select({
          filterByFormula: `{Name} = '${member.fields['Group']}'`,
          maxRecords: 1,
        })
        .firstPage();
      group = groupRecords.length > 0 ? groupRecords[0] : null;
    } catch (error) {
      console.error('Error getting group in buildDbSnapshot:', error);
    }
  }

  // Optional: total contributions / counts for this member
  // (Assumes your Members table has these fields, as described in your doc.)
  const totalContributions =
    member?.fields['Total Contributions'] ?? member?.fields['Total Contribution Amount'] ?? 0;
  const totalContributionsCount =
    member?.fields['Total Contributions Count'] ??
    member?.fields['Contributions Count'] ??
    member?.fields['Contributions Confirmed Count'] ??
    null;
  const lastContributionDate =
    member?.fields['Last Contribution Date'] ?? null;
  const upcomingReminder =
    member?.fields['Upcoming Reminder'] ?? null;

  let text = '';

  if (member) {
    text += `
Member:
- Name: ${member.fields['Full Name'] || 'Unknown'}
- Phone: ${phoneNumber}
- WhatsApp Number: ${member.fields['WhatsApp Number'] || phoneNumber}
- Status: ${member.fields['Status'] || 'Unknown'}
- Group: ${member.fields['Group'] || 'None'}
- Leader Phone: ${member.fields['Leader Phone'] || 'None'}
- Join Date: ${member.fields['Join Date'] || 'Unknown'}
- Total Contributions: ${totalContributions || 0}
- Total Contributions Count: ${totalContributionsCount || 'Unknown'}
- Last Contribution Date: ${lastContributionDate || 'Unknown'}
- Upcoming Reminder: ${upcomingReminder || 'None'}
`;
  }

  if (group) {
    text += `
Group:
- Name: ${group.fields['Name']}
- Description: ${group.fields['Description'] || 'None'}
- Leader Phone: ${group.fields['Leader Phone'] || 'Unknown'}
- Active: ${group.fields['Active'] || 'Unknown'}
- Start Date: ${group.fields['Start Date'] || 'Unknown'}
- End Date: ${group.fields['End Date'] || 'Unknown'}
- Total Members: ${group.fields['Total Members'] || 'Unknown'}
- Total Cycles Completed: ${group.fields['Total Cycles Completed'] || 0}
- Total Contributions Collected: ${group.fields['Total Contributions Collected'] || 0}
- Active Cycles: ${group.fields['Active Cycles'] || 'Unknown'}
- Upcoming Cycles: ${group.fields['Upcoming Cycles'] || 'Unknown'}
- Completed Cycles: ${group.fields['Completed Cycles'] || 'Unknown'}
- Average Contribution per Member: ${group.fields['Average Contribution per Member'] || 'Unknown'}
- Last Cycle's End Date: ${group.fields["Last Cycle's End Date"] || 'Unknown'}
- Next Scheduled Payout: ${group.fields['Next Scheduled Payout'] || 'Unknown'}
- Recent Reminder Sent: ${group.fields['Recent Reminder Sent'] || 'Unknown'}
- Reminder Frequency: ${group.fields['Reminder Frequency'] || 'Unknown'}
- Group Summary: ${group.fields['Group Summary (AI)'] || 'None'}
`;
  }

  if (currentCycle) {
    text += `
Current Cycle:
- Name: ${currentCycle.fields['Cycle Name']}
- Start Date: ${currentCycle.fields['Start Date']}
- End Date: ${currentCycle.fields['End Date']}
- Status: ${currentCycle.fields['Status'] || 'Unknown'}
- Total Contribution Amount: ${currentCycle.fields['Total Contribution Amount'] || 0}
- Recipient: ${currentCycle.fields['Recipient'] || 'Unknown'}
- Group: ${currentCycle.fields['Group'] || 'Unknown'}
- Number of Contributions: ${currentCycle.fields['Number of Contributions'] || 'Unknown'}
- Contribution Completion Rate: ${
      currentCycle.fields['Contribution Completion Rate'] || 'Unknown'
    }
- Outstanding Amount: ${currentCycle.fields['Outstanding Amount'] || 0}
- Confirmed Contributions Count: ${
      currentCycle.fields['Confirmed Contributions Count'] || 0
    }
`;
  }

  return {
    member,
    currentCycle,
    group,
    dbSnapshotText: text.trim(),
  };
}


function buildSystemPrompt(dbSnapshotText, extraContext) {
  return `
You are Adashina, a WhatsApp assistant for managing Adashi (rotating savings) groups.

YOU DO NOT HAVE DIRECT DATABASE ACCESS.
You only know what is in the "Database snapshot" and what users say.
If something is missing, say you don't know and DO NOT GUESS.

Database snapshot (ground truth, do not change):
${dbSnapshotText || 'No records were found for this user.'}

Extra context:
${extraContext || 'None.'}

Strict rules:
- Never claim you have created groups, updated names, recorded payments, or sent reminders unless the system has already done it in code.
- When describing groups, cycles, contributions, or reminders, rely only on the values in the snapshot.
- If a user asks about something that is not present in the snapshot, say you can't see it yet and suggest what they or the leader should do next.
- For payments: confirm intent, then explain that the system will ask the group leader to confirm before recording.
- For name updates: ask for confirmation; say that the system will update the database and only then treat the new name as official.
- For group creation/joining: ask for confirmation before proceeding; explain what the system will do (e.g. notify leader, wait for leader approval, etc.).
- For reminders and payout dates: you can explain the schedule and upcoming events that appear in the snapshot, but do NOT invent dates or frequencies.

Tone:
- Use simple, friendly language.
- When asked for advice about saving, contributions, or basic personal finance and the user permits it, give practical, non-judgmental suggestions based on the group and cycle context.
`;
}


/* ------------ Groq LLaMA call ------------ */

async function callGroqLlama(phoneNumber, userMessage, systemPrompt) {
  try {
    const conversationHistory = getConversationHistory(phoneNumber);
    const messages = [{ role: 'system', content: systemPrompt }];

    const recentHistory = conversationHistory.slice(-8);
    recentHistory.forEach((msg) => {
      messages.push({ role: msg.role, content: msg.content });
    });

    messages.push({ role: 'user', content: userMessage });

    console.log(`Calling Groq with ${messages.length} messages in context`);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        temperature: 0.7,
        max_tokens: 500,
      }),
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
// -------- WhatsApp send helper --------
async function sendWhatsAppMessage(to, message) {
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${whatsappToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      }),
    });

    const data = await response.json();
    console.log('WhatsApp message sent:', data);
    return data;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
}

// -------- Webhook routes --------

// GET /webhook - verification for Facebook/WhatsApp
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

// POST /webhook - main WhatsApp handler
app.post('/webhook', async (req, res) => {
  try {
    console.log('Received message from WhatsApp');
    console.log('Full Message Data:', JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msg = value?.messages?.[0];

    if (!msg || msg.type !== 'text') {
      console.log('Not a text message, ignoring');
      return res.status(200).json({ success: true });
    }

    const from = msg.from;
    const messageBody = msg.text.body;
    const senderName = value?.contacts?.[0]?.profile?.name || 'User';

    console.log(`From ${from}: ${messageBody}`);

    // Ensure member exists
    let memberRecord = base ? await createOrUpdateMember(from, senderName) : null;

    const intent = detectIntent(messageBody);
    const pendingAction = getPendingAction(from);
    const isConfirmation = /^(yes|yeah|yep|confirm|confirmed|correct|ok|okay|sure|proceed|go ahead)$/i.test(
      messageBody.trim()
    );

    /* ---------- 1. Leader commands (confirm / reject payment) ---------- */
    if (intent?.type === 'leader_confirm_payment') {
      const pendingId = intent.pendingId;

      const recs = await base('PendingPayments')
        .select({ filterByFormula: `RECORD_ID() = '${pendingId}'`, maxRecords: 1 })
        .firstPage();

      if (recs.length === 0) {
        await sendWhatsAppMessage(from, `I couldn't find any pending payment with ID ${pendingId}.`);
        return res.status(200).json({ success: false });
      }

      const pendingPay = recs[0];
      if (pendingPay.fields['Status'] !== 'Awaiting Leader') {
        await sendWhatsAppMessage(
          from,
          `This payment request is already ${pendingPay.fields['Status']}.`
        );
        return res.status(200).json({ success: false });
      }

      const memberPhone = pendingPay.fields['Member Phone'];
      const amount = pendingPay.fields['Amount'];
      const cycleMonth = new Date().toISOString().slice(0, 7);

      const success = await recordContribution(memberPhone, amount, cycleMonth);
      if (success) {
        await approvePendingPayment(pendingPay.id);
        await sendWhatsAppMessage(
          from,
          `Thanks! I've recorded a contribution of ₦${amount.toLocaleString()} for member ${memberPhone}.`
        );
        await sendWhatsAppMessage(
          memberPhone,
          `Your leader has confirmed your payment of ₦${amount.toLocaleString()}. It has been recorded in the system.`
        );
      } else {
        await sendWhatsAppMessage(
          from,
          `There was an error recording the contribution for ${memberPhone}. Please try again later.`
        );
      }

      return res.status(200).json({ success });
    }

    if (intent?.type === 'leader_reject_payment') {
      const pendingId = intent.pendingId;

      const recs = await base('PendingPayments')
        .select({ filterByFormula: `RECORD_ID() = '${pendingId}'`, maxRecords: 1 })
        .firstPage();

      if (recs.length === 0) {
        await sendWhatsAppMessage(from, `I couldn't find any pending payment with ID ${pendingId}.`);
        return res.status(200).json({ success: false });
      }

      const pendingPay = recs[0];
      if (pendingPay.fields['Status'] !== 'Awaiting Leader') {
        await sendWhatsAppMessage(
          from,
          `This payment request is already ${pendingPay.fields['Status']}.`
        );
        return res.status(200).json({ success: false });
      }

      const memberPhone = pendingPay.fields['Member Phone'];
      const amount = pendingPay.fields['Amount'];

      const success = await rejectPendingPayment(pendingPay.id);
      if (success) {
        await sendWhatsAppMessage(
          from,
          `You have rejected the payment of ₦${amount.toLocaleString()} from ${memberPhone}.`
        );
        await sendWhatsAppMessage(
          memberPhone,
          `Your leader has NOT confirmed your payment of ₦${amount.toLocaleString()}. Please contact your leader if you think this is a mistake.`
        );
      }

      return res.status(200).json({ success });
    }

    /* ---------- 2. Member pending actions (payment, name, groups) ---------- */

    if (pendingAction && isConfirmation) {
      console.log(`Executing pending ${pendingAction.type} action for ${from}`);

      let aiResponse = '';

      if (pendingAction.type === 'payment') {
        const member = await getMemberByPhone(from);
        const leaderPhone = member?.fields['Leader Phone'];

        if (!leaderPhone) {
          aiResponse = `I detected your payment of ₦${pendingAction.amount.toLocaleString()}, but you are not linked to any group leader yet. Please ask your leader to register you first.`;
        } else {
          const pendingRecord = await createPendingPayment(
            from,
            leaderPhone,
            pendingAction.amount
          );

          if (!pendingRecord) {
            aiResponse = `Sorry, I couldn't create a pending payment record right now. Please try again later.`;
          } else {
            aiResponse = `Thanks! I have recorded your payment of ₦${pendingAction.amount.toLocaleString()} as pending. I will ask your group leader to confirm before it is added to the database.`;

            const memberName = member.fields['Full Name'] || from;
            const leaderMsg = `Payment confirmation requested:\n\nMember: ${memberName} (${from})\nAmount: ₦${pendingAction.amount.toLocaleString()}\n\nIf you confirm this payment, reply with:\n"confirm payment ${pendingRecord.id}"\n\nIf you reject it, reply with:\n"reject payment ${pendingRecord.id}"`;
            await sendWhatsAppMessage(leaderPhone, leaderMsg);
          }
        }
      } else if (pendingAction.type === 'name_update') {
        const success = await updateMemberName(from, pendingAction.name);
        if (success) {
          aiResponse = `Great! I've updated your name to "${pendingAction.name}" in the database. This name will be used for you from now on.`;
        } else {
          aiResponse = `I wasn't able to update your name right now. Please try again later.`;
        }
      } else if (pendingAction.type === 'create_group') {
        const group = await createGroup(pendingAction.groupName, from);
        if (group) {
          if (memberRecord) await assignMemberToGroup(memberRecord, group);
          aiResponse = `Great! I've created a new group called "${pendingAction.groupName}" and set you as the leader. You can now invite members to join this group.`;
        } else {
          aiResponse = `Sorry, there was a problem creating the group "${pendingAction.groupName}". Please try again later.`;
        }
      } else if (pendingAction.type === 'join_group') {
        const group = await getGroupByName(pendingAction.groupName);
        if (group && memberRecord) {
          await assignMemberToGroup(memberRecord, group);
          aiResponse = `You have been added to the group "${pendingAction.groupName}".`;
        } else {
          aiResponse = `I couldn't find a group named "${pendingAction.groupName}". Please check the name or ask your leader to create it first.`;
        }
      }

      clearPendingAction(from);
      await sendWhatsAppMessage(from, aiResponse);
      if (base) await logToAirtable(from, messageBody, aiResponse, pendingAction.type);

      return res.status(200).json({ success: true });
    }

    /* ---------- 3. Set new pending action if detected ---------- */

    if (intent && !pendingAction) {
      if (
        intent.type === 'payment' ||
        intent.type === 'name_update' ||
        intent.type === 'create_group' ||
        intent.type === 'join_group'
      ) {
        setPendingAction(from, intent);
      }
    }

    /* ---------- 4. Normal AI reply with DB snapshot ---------- */

    const { member, currentCycle, dbSnapshotText } = await buildDbSnapshot(from);

    let extraContext = '';
    if (member) {
      extraContext += `This user is a member named ${
        member.fields['Full Name'] || 'Unknown'
      } in group ${member.fields['Group'] || 'None'}.`;
    }
    if (currentCycle) {
      extraContext += ` Current cycle: ${currentCycle.fields['Cycle Name']} from ${currentCycle.fields['Start Date']} to ${currentCycle.fields['End Date']}.`;
    }

    const systemPrompt = buildSystemPrompt(dbSnapshotText, extraContext);
    const aiResponse = await callGroqLlama(from, messageBody, systemPrompt);

    addToConversationHistory(from, 'user', messageBody);
    addToConversationHistory(from, 'assistant', aiResponse);

    await sendWhatsAppMessage(from, aiResponse);

    if (base) {
      const loggedIntent =
        intent && intent.type === 'payment'
          ? 'Payment'
          : intent && intent.type
          ? intent.type
          : 'General';
      await logToAirtable(from, messageBody, aiResponse, loggedIntent);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* -------- Export app for Vercel -------- */

module.exports = app;


