const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const { FCM_TOKEN_SECRET } = require('../config/config');


const keyJson = JSON.parse(fs.readFileSync('./jobs/service_account.json', 'utf8'));


async function getAccessToken() {

    const audience = 'https://oauth2.googleapis.com/token';
    const jwtHeader = {
        alg: 'RS256',
        typ: 'JWT'
    };
    const jwtClaims = {
        iss: keyJson.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
    };

    const jwtHeaderEncoded = Buffer.from(JSON.stringify(jwtHeader)).toString('base64').replace(/=+$/, '');
    const jwtClaimsEncoded = Buffer.from(JSON.stringify(jwtClaims)).toString('base64').replace(/=+$/, '');
    const signingInput = `${jwtHeaderEncoded}.${jwtClaimsEncoded}`;

    const signature = crypto.createSign('SHA256').update(signingInput).sign(keyJson.private_key, 'base64');
    const jwtSignatureEncoded = signature.replace(/=+$/, '');

    const jwt = `${jwtHeaderEncoded}.${jwtClaimsEncoded}.${jwtSignatureEncoded}`;

    const postData = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
    });

    const response = await axios.post('https://oauth2.googleapis.com/token', postData.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    return response.data.access_token;

}


function decodeFCMToken(text) {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex'); // Extract the IV from the text
    const encryptedText = Buffer.from(parts.join(':'), 'hex'); // Combine the rest as encrypted text
    const key = Buffer.from(FCM_TOKEN_SECRET.padEnd(32, '0').slice(0, 32)); // Ensure key length is 32 bytes
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

    let decrypted = decipher.update(encryptedText, 'binary', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted; // Return the decrypted text as a string
}

// Function to send FCM notification
async function sendFCMNotification(accessToken, fcmToken, type, title, data, message_id) {


    const url = 'https://fcm.googleapis.com/v1/projects/pot-app-5cebb/messages:send';


    const payload = {
        type: type,
        title: title,
        data: data
    };




    const MAX_PAYLOAD_SIZE = 4 * 1024; // 4 KB limit

    const payloadString = JSON.stringify(payload);
    const byteSize = Buffer.byteLength(payloadString, 'utf8');
    console.log(`Payload size: ${byteSize} bytes`);


    const { v4: uuidv4 } = require('uuid');


    if (byteSize > MAX_PAYLOAD_SIZE) {


        // Generate a unique UUID for each payload
        const uuid4Id = uuidv4();


        const parts = Math.ceil(byteSize / MAX_PAYLOAD_SIZE);
        console.log(`Message will be split into ${parts} parts.`);

        // Split the payload into parts
        const chunks = [];
        for (let i = 0; i < parts; i++) {
            const chunkData = payloadString.slice(i * MAX_PAYLOAD_SIZE, (i + 1) * MAX_PAYLOAD_SIZE);
            chunks.push({
                messageId: String(message_id==-1?uuid4Id:message_id),
                partNumber: String(i + 1),
                totalParts: String(parts),
                data: chunkData // The actual chunk of data
            });
        }


        const responses = []; // Initialize an array to store responses

        // Use a for...of loop to process each chunk with async/await
        for (const chunk of chunks) {
            const notificationPayload = {
                message: {
                    token: fcmToken,
                    data: {
                        messageId: chunk.messageId, // Pass correct fields
                        partNumber: chunk.partNumber,
                        totalParts: chunk.totalParts,
                        data: chunk.data // The chunk data is what you're sending
                    },
                    android: {
                        priority: "high",
                    },
                }
            };

            try {
                // Send the notification via axios
                const response = await axios.post(url, notificationPayload, {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });

                // Push the response to the responses array
                responses.push(response.data);
            } catch (error) {

                throw error;

            }
        }

        return responses; // Return the collected responses after all chunks have been processed

    }
    else {



        const notificationPayload = {
            message: {
                token: fcmToken,
                data: {
                    messageId: String(message_id),
                    partNumber: String(1),
                    totalParts: String(1),
                    data: payloadString

                },
                android: {
                    priority: "high",

                },
            }
        };

        const response = await axios.post(url, notificationPayload, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });



        return response.data;


    }



}

module.exports = {
    decodeFCMToken,
    sendFCMNotification,
    getAccessToken
}