require('dotenv').config();

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const he = require('he');
const followHttps = require('follow-redirects').https;

const app = express();
const port = process.env.PORT || 3000;

const INFOBIP_API_KEY = process.env.INFOBIP_API_KEY;
const INFOBIP_BASE_URL = process.env.INFOBIP_BASE_URL;
const WHATSAPP_SENDER = process.env.WHATSAPP_SENDER;
const UVDESK_URL = process.env.UVDESK_URL;
const UVDESK_API_TOKEN = process.env.UVDESK_API_TOKEN;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Global JSON parser
app.use(express.json());

async function downloadImage(mediaUrl, filename) {
    const filePath = path.join(uploadsDir, filename);

    const urlParts = mediaUrl.split('/');
    const senderIndex = urlParts.indexOf('senders');
    const mediaIndex = urlParts.indexOf('media');

    const senderId = senderIndex !== -1 ? urlParts[senderIndex + 1] : null;
    const mediaId = mediaIndex !== -1 ? urlParts[mediaIndex + 1] : null;

    if (!senderId || !mediaId) {
        throw new Error('Could not extract senderId or mediaId from the URL.');
    }

    const options = {
        method: 'GET',
        hostname: 'dmxgeg.api.infobip.com',
        path: `/whatsapp/1/senders/${senderId}/media/${mediaId}`,
        headers: {
            Authorization: `App ${INFOBIP_API_KEY}`,
            Accept: '*/*'
        },
        maxRedirects: 20
    };

    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);

        const req = followHttps.request(options, (res) => {
            if (res.statusCode >= 400) {
                reject(new Error(`Failed to download media. Status: ${res.statusCode}`));
                return;
            }

            res.pipe(file);

            file.on('finish', () => {
                file.close(() => {
                    console.log('Media saved to:', filePath);
                    resolve(filePath);
                });
            });
        });

        req.on('error', (err) => {
            console.error('Error during download:', err.message);
            reject(err);
        });

        req.end();
    });
}

async function createUVDeskTicketWithAttachment(
    description,
    subject,
    phone,
    fullName,
    attachmentPath,
    originalFileName
) {
    const form = new FormData();

    form.append('message', description);
    form.append('actAsType', 'customer');
    form.append('name', fullName);
    form.append('subject', subject);
    form.append('from', phone);

    if (attachmentPath && fs.existsSync(attachmentPath)) {
        form.append('attachments[]', fs.createReadStream(attachmentPath), originalFileName);
    }

    try {
        const response = await axios.post(UVDESK_URL, form, {
            headers: {
                ...form.getHeaders(),
                Authorization: `Basic ${UVDESK_API_TOKEN}`,
            },
        });

        console.log('Ticket created:', response.data);

        // Extract ticketId safely from UVDesk response
        let ticketId = null;
        const data = response.data;

        if (data && data.ticket && data.ticket.id) {
            ticketId = data.ticket.id;
        } else if (data && data.id) {
            ticketId = data.id;
        }

        // If we don't have a ticketId, treat it as failure
        if (!ticketId) {
            console.error('Ticket ID missing from UVDesk response');
            return { success: false, error: 'Ticket ID missing from UVDesk response' };
        }

        return { success: true, ticketId };
    } catch (error) {
        console.error('Error creating UVDesk ticket:', error.message);
        return { success: false, error: error.message };
    } finally {
        if (attachmentPath && fs.existsSync(attachmentPath)) {
            fs.unlinkSync(attachmentPath);
        }
    }
}

app.post('/create-ticket', async (req, res) => {
    const {
        ticketAttachment,
        ticketDescription,
        ticketSubject,
        ticketUserPhone,
        ticketUserFullName
    } = req.body;

    let attachmentUrl = null;

    // Case 1 → { url: "…" }
    if (ticketAttachment && typeof ticketAttachment === 'object' && ticketAttachment.url) {
        attachmentUrl = ticketAttachment.url;

    // Case 2 → direct string URL
    } else if (typeof ticketAttachment === 'string' && ticketAttachment.startsWith('http')) {
        attachmentUrl = ticketAttachment;
    }

    if (!attachmentUrl) {
        console.error('No valid attachment URL provided');
        return res.status(400).send({ success: false });
    }

    try {
        const originalFileName = 'image.jpg';
        const imagePath = await downloadImage(attachmentUrl, originalFileName);

        const result = await createUVDeskTicketWithAttachment(
            ticketDescription,
            ticketSubject,
            ticketUserPhone,
            ticketUserFullName,
            imagePath,
            originalFileName
        );

        if (!result.success) {
            return res.status(500).send({ success: false });
        }

        return res.send({ success: true, ticketId: result.ticketId });
    } catch (error) {
        console.error('Error in /create-ticket:', error.message);
        return res.status(500).send({ success: false });
    }
});

app.post('/create-ticket-no-attachment', async (req, res) => {
    const {
        ticketDescription,
        ticketSubject,
        ticketUserPhone,
        ticketUserFullName
    } = req.body;

    try {
        const result = await createUVDeskTicketWithAttachment(
            ticketDescription,
            ticketSubject,
            ticketUserPhone,
            ticketUserFullName,
            null,
            null
        );

        if (!result.success) {
            return res.status(500).send({ success: false });
        }

        return res.status(200).send({ success: true, ticketId: result.ticketId });
    } catch (error) {
        console.error('Error in /create-ticket-no-attachment:', error.message);
        return res.status(500).send({ success: false });
    }
});

app.post('/reply', async (req, res) => {
    const { ticket_id, message, agent_email, from } = req.body;

    const customerPhone = from;
    let plainMessage = he.decode(message).replace(/<\/?[^>]+(>|$)/g, '');

    const payload = {
        from: WHATSAPP_SENDER,
        to: customerPhone,
        content: {
            text: `Agent (${agent_email}) replied on ticket #${ticket_id}:\n\n${plainMessage}`
        }
    };

    try {
        const response = await axios.post(INFOBIP_BASE_URL, payload, {
            headers: {
                Authorization: `App ${INFOBIP_API_KEY}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            }
        });

        console.log('Message sent via Infobip:', response.data);
        return res.send({ success: true });
    } catch (err) {
        console.error('Error sending Infobip message:', err.response?.data || err.message);
        return res.status(500).send({ success: false });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
