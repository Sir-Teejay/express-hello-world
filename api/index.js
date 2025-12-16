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
  if (member && (member.fields['Group'] || member.fields['Group Name'])) {
    const memberGroupName = member.fields['Group'] || member.fields['Group Name'];

    // Escape any single quotes in the group name for Airtable formula safety
    const escapedGroupName = String(memberGroupName).replace(/'/g, "\\'");

    try {
      const groupRecords = await base('Groups')
        .select({
          filterByFormula: `{Name} = '${escapedGroupName}'`,
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
- Group: ${member.fields['Group'] || member?.fields['Group Name'] || 'None'}
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
- End Date: ${group.fields
