require('dotenv').config();

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const he = require('he');
const followHttps = require('follow-redirects').https;
const ldap = require('ldapjs');

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

async function downloadImage(mediaUrl, filename) {
    const filePath = path.join(uploadsDir, filename);

    const urlParts = mediaUrl.split('/');
    const senderId = urlParts[urlParts.indexOf('senders') + 1];
    const mediaId = urlParts[urlParts.indexOf('media') + 1];

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

async function createUVDeskTicketWithAttachment(description, subject, phone, fullName, attachmentPath, originalFileName) {
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
        return { success: true };
    } catch (error) {
        console.error('Error creating UVDesk ticket:', error.message);
        return { success: false, error: error.message };
    } finally {
        if (attachmentPath && fs.existsSync(attachmentPath)) {
            fs.unlinkSync(attachmentPath);
        }
    }
}

app.post('/create-ticket', express.json(), async (req, res) => {
    const {
        ticketAttachment,
        ticketDescription,
        ticketSubject,
        ticketUserPhone,
        ticketUserFullName,
        ticketType,
        transactionType
    } = req.body;

    if (!ticketAttachment || !ticketAttachment.url) {
        return res.status(400).send({ error: 'No attachment URL provided' });
    }

    try {
        const imageUrl = ticketAttachment.url;
        const originalFileName = 'image.jpg';
        const imagePath = await downloadImage(imageUrl, originalFileName);

        console.log("Ticket type:", ticketType);
        console.log("Transaction type:", transactionType);

        const result = await createUVDeskTicketWithAttachment(
            ticketDescription,
            ticketSubject,
            ticketUserPhone,
            ticketUserFullName,
            imagePath,
            originalFileName
        );

        if (result.success) {
            res.send({ success: true });
        } else {
            res.status(500).send({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error downloading image:', error.message);
        res.status(500).send({ success: false, error: 'Error downloading image' });
    }
});

app.post('/reply', express.json(), async (req, res) => {
    const { ticket_id, message, agent_email, from } = req.body;

    const customerPhone = from;
    let plainMessage = he.decode(message).replace(/<\/?[^>]+(>|$)/g, "");

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
                'Accept': 'application/json'
            }
        });

        console.log('Message sent via Infobip:', response.data);
        res.send({ success: true });
    } catch (err) {
        console.error('Error sending Infobip message:', err.response?.data || err.message);
        res.status(500).send({ success: false, error: err.message });
    }
});

app.get('/auth',express.json(),async(req,res)=>{
    const {username,password}  = req.body;
    const ldap = require('ldapjs');

    const client = ldap.createClient({
    url: 'ldap://37.34.243.17', 
    timeout: 5000,
    connectTimeout: 10000
    });

    const bindDN = `CN=${username},CN=Users,DC=actd,DC=ascotes,DC=com`;

    client.bind(bindDN, password, (err) => {
    if (err) {
        console.log("error");
        res.status(400).send({ success: false });
    } else {
        console.log("auth successful");
        res.status(200).send({ success: true });
    }

    client.unbind();
});


});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
