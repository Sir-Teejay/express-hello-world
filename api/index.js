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
const joinRequestsTable = base('JoinRequests');

/* ================= HELPER FUNCTIONS ================= */
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

async function approveRequest(requestId) {
    try {
        const response = await joinRequestsTable.update(requestId, {
            "Status": "approved"
        });
        console.log("Airtable update response:", response);
        return true;
    } catch (error) {
        console.error(`Failed to approve request ${requestId}:`, error);
        return false;
    }
}

async function createJoinRequest(memberId, groupName) {
    try {
        const response = await joinRequestsTable.create({
            "MemberID": memberId,
            "Group": groupName,
            "Status": "pending",
            "RequestDate": new Date().toISOString()
        });
        console.log("Created new join request:", response);
        return response.id;
    } catch (error) {
        console.error("Error creating join request:", error);
        return null;
    }
}

// Detect "join request" intent
function isJoinRequestMessage(messageText) {
    const keywords = ["join", "add me", "request", "sign me up"];
    return keywords.some(word => messageText.toLowerCase().includes(word));
}

/* ================= WEBHOOK ================= */
app.post('/webhook', async (req, res) => {
    try {
        const { memberId, messageText, groupName } = req.body;

        console.log(`Received message from ${memberId}: ${messageText}`);

        if (isJoinRequestMessage(messageText)) {
            console.log("Detected join request intent");

            // Check if request already exists
            const existing = await joinRequestsTable.select({
                filterByFormula: `{MemberID} = '${memberId}' AND {Group} = '${groupName}'`,
                maxRecords: 1
            }).firstPage();

            if (existing.length > 0) {
                console.log(`Request already exists for member ${memberId} in ${groupName}`);
            } else {
                // Create new join request
                const requestId = await createJoinRequest(memberId, groupName);
                console.log(`Join request created with ID: ${requestId}`);

                // Automatically approve request
                const approved = await approveRequest(requestId);
                if (approved) {
                    console.log(`Automatically approved request ${requestId}`);
                }
            }

            res.status(200).send({ reply: "Your join request has been received and approved." });
        } else {
            res.status(200).send({ reply: "Message received." });
        }
    } catch (error) {
        console.error("Error handling webhook:", error);
        res.status(500).send({ error: "Internal server error" });
    }
});

/* ================= VERIFY WEBHOOK (GET) ================= */
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
