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

/* ================= ENV VARIABLES ================= */
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
const joinRequestsTable = base('JoinRequests');

/* ================= HELPER FUNCTIONS ================= */

// Fetch pending join requests
async function fetchPendingRequests() {
    try {
        const records = await joinRequestsTable.select({
            filterByFormula: `{Status} = 'pending'`,
            pageSize: 10
        }).firstPage();
        console.log(`Fetched ${records.length} pending requests`);
        return records;
    } catch (error) {
        console.error("Error fetching pending requests:", error);
        return [];
    }
}

// Approve a join request
async function approveRequest(requestId) {
    try {
        const response = await joinRequestsTable.update(requestId, {
            "Status": "approved"
        });
        console.log("Airtable update response:", response.id);
        return true;
    } catch (error) {
        console.error(`Failed to approve request ${requestId}:`, error);
        return false;
    }
}

// Create a new join request
async function createJoinRequest(memberId, groupName) {
    try {
        const response = await joinRequestsTable.create({
            "MemberID": memberId,
            "Group": groupName,
            "Status": "pending",
            "RequestDate": new Date().toISOString()
        });
        console.log("Created new join request:", response.id);
        return response.id;
    } catch (error) {
        console.error("Error creating join request:", error);
        return null;
    }
}

// Detect join request intent
function isJoinRequestMessage(messageText) {
    const keywords = ["join", "add me", "request", "sign me up"];
    return keywords.some(word => messageText.toLowerCase().includes(word));
}

// Send WhatsApp message via API
async function sendWhatsAppMessage(to, text) {
    try {
        await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: to,
                text: { body: text },
            }),
        });
        console.log(`Sent message to ${to}: ${text}`);
    } catch (error) {
        console.error(`Failed to send message to ${to}:`, error);
    }
}

/* ================= WEBHOOK POST ================= */
app.post('/webhook', async (req, res) => {
    try {
        console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));

        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const message = change?.value?.messages?.[0];

        if (!message) {
            return res.status(200).send("No messages to process");
        }

        const memberId = message.from;                  // WhatsApp number
        const messageText = message.text?.body || "";    // Message content
        const groupName = "DefaultGroup";               // You can customize per group logic

        console.log(`Received message from ${memberId}: ${messageText}`);

        if (isJoinRequestMessage(messageText)) {
            console.log("Detected join request intent");

            // Check if join request already exists
            const existing = await joinRequestsTable.select({
                filterByFormula: `{MemberID} = '${memberId}' AND {Group} = '${groupName}'`,
                maxRecords: 1
            }).firstPage();

            if (existing.length > 0) {
                console.log(`Request already exists for ${memberId} in ${groupName}`);
                await sendWhatsAppMessage(memberId, "You already have a join request for this group.");
            } else {
                // Create and approve join request
                const requestId = await createJoinRequest(memberId, groupName);
                const approved = await approveRequest(requestId);
                if (approved) console.log(`Automatically approved request ${requestId}`);
                await sendWhatsAppMessage(memberId, "Your join request has been received and approved.");
            }

        } else {
            // Generic reply for other messages
            await sendWhatsAppMessage(memberId, "Message received. If you want to join, say 'join'.");
        }

        res.sendStatus(200);

    } catch (error) {
        console.error("Error handling webhook:", error);
        res.status(500).send({ error: "Internal server error" });
    }
});

/* ================= WEBHOOK VERIFY (GET) ================= */
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        console.log('Webhook verified successfully');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
