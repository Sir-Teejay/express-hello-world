/******************************************************************
 * ADASHI WHATSAPP BOT — INVITE & APPROVAL ENABLED
 ******************************************************************/

app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const message = change?.value?.messages?.[0];

        if (!message) {
            return res.status(200).send("No messages to process");
        }

        const memberId = message.from;
        const messageText = message.text?.body || "";

        console.log(`Received message from ${memberId}: ${messageText}`);

        // Example: hardcode group or get from somewhere
        const groupName = "DefaultGroup";

        if (isJoinRequestMessage(messageText)) {
            console.log("Detected join request intent");

            const existing = await joinRequestsTable.select({
                filterByFormula: `{MemberID} = '${memberId}' AND {Group} = '${groupName}'`,
                maxRecords: 1
            }).firstPage();

            if (existing.length === 0) {
                const requestId = await createJoinRequest(memberId, groupName);
                const approved = await approveRequest(requestId);
                if (approved) console.log(`Automatically approved request ${requestId}`);
            }

            // Send reply back via WhatsApp API
            await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: memberId,
                    text: { body: "Your join request has been received and approved." },
                }),
            });

        } else {
            // Optional: send a generic reply
            await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: memberId,
                    text: { body: "Message received." },
                }),
            });
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Error handling webhook:", error);
        res.status(500).send({ error: "Internal server error" });
    }
});
