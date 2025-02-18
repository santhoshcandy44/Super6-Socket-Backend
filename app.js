const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { db, promise } = require('./db/config')
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    maxHttpBufferSize: 10 * 1e9
});
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const runGeneralNotificationJob = require('./jobs/generalNotification'); // Adjust the path if necessary
const runOfflineMessagesNotificationJob = require('./jobs/offlineMessagesNotification'); // Adjust the path if necessary
const { BASE_URL, PROFILE_BASE_URL, MEDIA_ROOT_PATH, MEDIA_BASE_URL, S3_BUCKET_NAME, GL_ACCESS_TOKEN_SECRET } = require('./config/config');

const { logMessage } = require('./common/utils');
const { error } = require('console');

const { awsS3Bucket } = require('./config/awsS3')


app.get('/', (req, res) => {
    res.send('Lts360!');
});


// Variable to track if the job is running
let isJobRunning = false;

// Function to run the job
async function offlineMessagesDeliveryJob() {

    if (isJobRunning) {
        return; // Exit if the job is already running
    }
    isJobRunning = true;


    while (true) {
        try {
            // Your logic for processing offline messages
            await runOfflineMessagesNotificationJob((messaegBody) => {

            }); // Assume this is your function for processing messages
        } catch (error) {
            console.error('Error running OfflineMessage job:', error);
            throw error;

        }

    }

}


//Schedule the FCM job to run every 2 seconds
cron.schedule('*/1 * * * * *', async () => {
    try {
        await offlineMessagesDeliveryJob();
    } catch (error) {
        isJobRunning = false;
        console.error('Error running FCM job:', error);
    }
});


cron.schedule('*/1 * * * * *', async () => {
    try {
        await runGeneralNotificationJob();
    } catch (error) {
        isJobRunning = false;
        console.error('Error running FCM job:', error);
    }
});




// Serve static files
app.use(express.static(__dirname + '/public'));

const updateUserStatus = (userId, online, last_active) => {
    io.to(`chat:status-${userId}`).emit(`chat:onlineStatus-${userId}`, {
        last_active: last_active,
        user_id: userId, online: online == 1
    });

};


const sockets = {}; // Object to store socket instances globally


// Middleware to validate the token
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token; // Get the token from the handshake
    const query = socket.handshake.query; // Query parameters

    if (query) {

        if (query.error) {

            if (query.cause == "REFRESH_TOKEN_EXPIRED") {
                await handleUndeliveredMessage(socket, query);
                return next(new Error("AUTHENTICATION_ERROR_REFRESH_TOKEN_EXPIRED"));
            }
        }
    }

    if (token) {

        // Verify the token (replace 'YOUR_SECRET_KEY' with your actual secret key)
        jwt.verify(token, GL_ACCESS_TOKEN_SECRET, (err, decoded) => {
            if (err) {

                if (err.message == "jwt expired") {
                    // Token is invalid
                    return next(new Error("AUTHENTICATION_ERROR_TOKEN_EXPIRED"));
                } else {
                    // Token is invalid
                    return next(new Error("AUTHENTICATION_ERROR_INVALID_TOKEN"));
                }
            }

            // Token is valid, you can store user info if needed
            socket.user = { userId: decoded.userId }; // Attach the decoded user info to the socket
            next(); // Proceed with the connection
        });
    } else {
        next(new Error("AUTHENTICATION_ERROR_NO_TOKEN_PROVIDED"));
    }
});

// Handle new user connection with custom user_id
io.on('connection', (socket) => {

    let heartbeatTimeout;

    // In-memory store for socketId to user_id mapping
    const userSocketMap = {};



    // Listen for heartbeat messages
    socket.on('chat:heartbeat', () => {

        try {
            if (heartbeatTimeout) {
                clearTimeout(heartbeatTimeout);
            }
            heartbeatTimeout = setTimeout(() => {
                try {
                    console.log(`User disconnected (no heartbeat)`);
                    logMessage(`User disconnected (no heartbeat)}`);
                    socket.disconnect(); // Optionally disconnect if you want to clean up
                } catch (error) {
                    console.log(error);
                    logMessage(error);
                }

            }, 10000); // Timeout of 10 seconds
        } catch (error) {
            console.log(error);
            logMessage(error);

        }

    });



    socket.on('chat:userJoined', async (userData) => {



        try {
            const { user_id, is_background } = userData;
            // Store the mapping
            userSocketMap[socket.id] = { user_id, is_background };  // Store both user_id and is_background status
            sockets[user_id] = socket;


            if (is_background) {
                return;
            }



            const query = `INSERT INTO chat_info (user_id, socket_id, online, last_active)
        VALUES (?, ?, true, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
            socket_id = VALUES(socket_id),
            online = true,
            last_active = CURRENT_TIMESTAMP`;



            // Use promise.query() with await
            await promise.query(query, [user_id, socket.id]);

            // Fetch user status
            const sql = `SELECT online, last_active FROM chat_info WHERE user_id = ?`;
            const [statusResults] = await promise.query(sql, [user_id]);
            const { online, last_active } = statusResults[0];
            updateUserStatus(user_id, online, last_active);

            // Check for offline messages and deliver if any

            const ackQuery = `
    SELECT * FROM offline_acks 
    WHERE sender_id = ? 
    ORDER BY 
        CASE 
            WHEN status = 'SENT' THEN 1 
            WHEN status = 'DELIVERED' THEN 2 
            ELSE 3 
        END
`;
            const [ackResults] = await promise.query(ackQuery, [user_id]);

            if (ackResults.length > 0) {
                for (const result of ackResults) {
                    const { sender_id, message_id, recipient_id, status, ack_type } = result;


                    io.to(socket.id).emit('chat:messageStatus', { sender: sender_id, message_id, recipient_id, status, ack_type }, (response) => {

                    });

                    const deleteQuery = 'DELETE FROM offline_acks WHERE sender_id = ? AND message_id = ?';
                    await promise.query(deleteQuery, [sender_id, message_id]);
                }
            }


            // Deliver offline messages if any
            const offlineQuery = 'SELECT sender_id, message_body, message_id, type, reply_id, category, file_meta_data FROM offline_messages WHERE chat_info_id = ?';
            const [offlineMessages] = await promise.query(offlineQuery, [user_id]);

            if (offlineMessages.length > 0) {
                for (const message of offlineMessages) {
                    const { sender_id, message_body, message_id, type, reply_id, category, file_meta_data } = message;

                    io.to(socket.id).emit('chat:offlineMessages', {
                        sender: sender_id,
                        message: message_body,
                        message_id,
                        type,
                        reply_id,
                        category,
                        file_metadata: file_meta_data
                    });

                    const updateQuery = 'DELETE FROM offline_messages WHERE chat_info_id = ? AND message_id = ?';
                    await promise.query(updateQuery, [user_id, message_id]);
                }
            }


        } catch (error) {
            logMessage('Error in handling new user: ' + error.message);

        }
    });


    // Handle subscription to status updates
    socket.on('chat:subscribeToStatus', async (data) => {

        try {
            const { userIds } = data;

            for (const userId of userIds) {
                socket.join(`chat:status-${userId}`);

                // Fetch user status
                const query = 'SELECT online, last_active FROM chat_info WHERE user_id = ?';
                const [statusResults] = await promise.query(query, [userId]);

                const isOnline = statusResults[0].online === 1;
                const lastActive = statusResults[0].last_active;
                io.to(`chat:status-${userId}`).emit(`chat:onlineStatus-${userId}`, { user_id: userId, online: isOnline, last_active: lastActive });

                // Fetch user profile info
                const profileQuery = 'SELECT profile_pic_url, profile_pic_url_96x96, updated_at FROM users WHERE user_id = ?';
                const [profileResults] = await promise.query(profileQuery, [userId]);

                const { updated_at, profile_pic_url, profile_pic_url_96x96 } = profileResults[0];
                io.to(`chat:status-${userId}`).emit('chat:profileInfo', {
                    updated_at,
                    user_id: userId,
                    profile_pic_url: `${PROFILE_BASE_URL}/${profile_pic_url}`,
                    profile_pic_url_96x96: `${PROFILE_BASE_URL}/${profile_pic_url_96x96}`
                });


            }
        } catch (error) {
            console.log('Error in subscribing to status: ' + error.message);
            logMessage('Error in subscribing to status: ' + error.message);
        }
    });


    // Handle new chat open
    socket.on('chat:chatOpen', async (userData) => {


        try {

            const { user_id, recipient_id } = userData;

            const checkRecipientQuery = 'SELECT socket_id, online, last_active FROM chat_info WHERE user_id = ?';

            // Use await with promise.query for async handling
            const [results] = await promise.query(checkRecipientQuery, [recipient_id]);

            if (results.length === 0) {
                socket.emit(`chat:onlineStatus-${recipient_id}`, { user_id: recipient_id, online: false, last_active: null });
                return;
            }

            const recipientUser = results[0];

            // Emit the recipient's online status to the recipient
            io.to(recipientUser.socket_id).emit(`chat:onlineStatus-${user_id}`, { user_id, online: true, last_active: null });

            // Emit the status to the requesting user
            socket.emit(`chat:onlineStatus-${recipient_id}`, { user_id: recipient_id, online: recipientUser.online !== 0, last_active: recipientUser.last_active });

        } catch (err) {

            console.log('Database query error: ' + err.message);
            logMessage('Database query error: ' + err.message);
        }
    });

    // Handle typing status
    socket.on('chat:typing', async (data) => {

        try {

            const { user_id, recipient_id, message, is_typing } = data;

            const checkSenderQuery = 'SELECT socket_id FROM chat_info WHERE user_id = ?';

            // Use await with promise.query for asynchronous query handling
            const [senderResults] = await promise.query(checkSenderQuery, [user_id]);

            if (senderResults.length === 0) {
                logMessage('Sender not found');
                return;
            }

            const senderSocketId = senderResults[0].socket_id;

            const checkRecipientQuery = 'SELECT socket_id, online FROM chat_info WHERE user_id = ?';

            // Use await with promise.query for recipient query
            const [recipientResults] = await promise.query(checkRecipientQuery, [recipient_id]);

            if (recipientResults.length === 0) {
                return;
            }

            const recipientUser = recipientResults[0];

            // Emit typing status if recipient is online
            if (recipientUser.online) {
                io.to(recipientUser.socket_id).emit('chat:typing', { sender: user_id, recipient_id, is_typing });
            }

        } catch (err) {
            logMessage('Database query error: ' + err.message);
        }
    });




    // Handle incoming messages
    socket.on('chat:chatMessage', async (data, callback) => {

        try {

            const { user_id, recipient_id, message, message_id, reply_id, type, category, key_version } = data;

            const checkSenderQuery = 'SELECT socket_id FROM chat_info WHERE user_id = ?';
            const query = 'SELECT encrypted_public_key, key_version FROM e2ee_public_keys WHERE user_id = ?';

            // Check recipient's account status
            const [accountStatusRows] = await promise.query('SELECT account_status FROM users WHERE user_id = ?', [recipient_id]);

            if (accountStatusRows.length > 0 && accountStatusRows[0].account_status === 'deactivated') {
                callback("User is not authenticated", { status: "USER_NOT_ACTIVE_ERROR", recipient_id });
                return;
            }

            // Get recipient's public key and key version
            const [keyRows] = await promise.query(query, [recipient_id]);
            if (keyRows.length === 0) {
                callback("Failed to get public key", { status: "FAILED_ON_KEY" });
                return;
            }

            const publicKey = keyRows[0].encrypted_public_key;
            const latestKeyVersion = keyRows[0].key_version;

            if (latestKeyVersion !== key_version) {
                callback("Invalid key version", {
                    status: "KEY_ERROR", recipient_id, publicKey: publicKey.toString('utf-8'), keyVersion: latestKeyVersion
                });
                return;
            }

            // Check sender's socket ID
            const [senderResults] = await promise.query(checkSenderQuery, [user_id]);
            if (senderResults.length === 0) {
                logMessage('Sender not found');
                return;
            }

            const senderSocketId = senderResults[0].socket_id;

            // Check recipient's socket ID and online status
            const [recipientResults] = await promise.query('SELECT socket_id, online FROM chat_info WHERE user_id = ?', [recipient_id]);
            if (recipientResults.length === 0) {
                return;
            }

            const recipientUser = recipientResults[0];

            // If recipient is offline, insert message into offline_messages table
            if (!recipientUser.online) {
                const insertOfflineMessageQuery = 'INSERT INTO offline_messages (type, category, reply_id, sender_id, message_id, message_body, chat_info_id) VALUES (?,?,?,?,?,?,?)';
                await promise.query(insertOfflineMessageQuery, [type, category, reply_id, user_id, message_id, message, recipient_id]);

                // Delay and acknowledge message delivery
                await delay(500);
                callback('Message successfully delivered and acknowledged', {
                    delivered_at: new Date(),
                    message_id
                });
                return;
            }

            // If recipient is online, emit the message
            const recipientSocket = sockets[recipient_id];
            if (recipientSocket) {

                await delay(1000);

                recipientSocket.emit('chat:check', { sender: user_id }, (response) => {
                    clearTimeout(timeout); // Clear timeout if pong is received
                    io.to(recipientUser.socket_id).emit('chat:chatMessage', { sender: user_id, message, message_id, reply_id, type, category, key_version }, () => {
                        callback('Message successfully delivered and acknowledged', {
                            delivered_at: new Date(),
                            message_id
                        });
                    });
                });

                // Set timeout if no response from recipient
                const timeout = setTimeout(async () => {

                    try {
                        const insertOfflineMessageQuery = 'INSERT INTO offline_messages (type, category, reply_id, sender_id, message_id, message_body, chat_info_id) VALUES (?,?,?,?,?,?,?)';
                        await promise.query(insertOfflineMessageQuery, [type, category, reply_id, user_id, message_id, message, recipient_id]);

                        await delay(500);
                        callback('Message successfully delivered and acknowledged', {
                            delivered_at: new Date(),
                            message_id
                        });
                    } catch (error) {
                        console.log(error);
                        logMessage(error);
                    }


                }, 1000); // Timeout duration


            } else {
                // Recipient is not connected, insert offline message
                const insertOfflineMessageQuery = 'INSERT INTO offline_messages (type, category, reply_id, sender_id, message_id, message_body, chat_info_id) VALUES (?,?,?,?,?,?,?)';
                await promise.query(insertOfflineMessageQuery, [type, category, reply_id, user_id, message_id, message, recipient_id]);

                await delay(500);
                callback('Message successfully sent and acknowledged', {
                    delivered_at: new Date(),
                    message_id
                });
            }

        } catch (err) {
            console.log(err);
            logMessage('Database query error: ' + err.message);
            callback('An error occurred', { status: 'ERROR' });
        }
    });



    let fileTransfers = {}; // Store the state of ongoing file transfers



    const CHUNK_SIZE = 1 * 1024 * 1024;  // 5MB in bytes


    // Handle the start of file transfer
    socket.on('chat:startFileTransfer', async (fileData, callback) => {



        try {

            const {
                sender_id,
                recipient_id,
                message_id,
                reply_id,
                message,
                content_type,
                category,
                type,
                file_id,
                file_name,
                extension,
                file_size,
                width,
                height,
                total_duration,
                key_version,
                total_chunks,
                byte_offset

            } = fileData;



            // Check if the recipient is active
            const [rows] = await promise.query('SELECT account_status FROM users WHERE user_id = ?', [recipient_id]);

            if (rows.length > 0 && rows[0].account_status === 'deactivated') {
                callback({ status: "USER_NOT_ACTIVE_ERROR", recipient_id });
                return;
            }

            // Get the recipient's public key and key version
            const [keyRows] = await promise.query('SELECT encrypted_public_key, key_version FROM e2ee_public_keys WHERE user_id = ?', [recipient_id]);

            if (keyRows.length === 0) {
                callback({ status: "FAILED_ON_KEY", recipient_id });
                return;
            }

            const publicKey = keyRows[0].encrypted_public_key;
            const latestKeyVersion = keyRows[0].key_version;

            if (latestKeyVersion !== key_version) {
                callback({ status: "KEY_ERROR", recipient_id, publicKey: publicKey.toString('utf-8'), keyVersion: latestKeyVersion });
                return;
            }

            const parsedFileName = path.parse(file_name); // This will break the filename into parts (name, ext, etc.)

            const dirPath = path.join(MEDIA_ROOT_PATH, `uploads`, recipient_id.toString()); // ✅ Correct file path
            const mediaPath = path.join(dirPath, `${file_id}_${parsedFileName.name}.enc`); // ✅ Correct file path




            if (fs.existsSync(mediaPath)) {


                const stats = fs.statSync(mediaPath);

                // If file exists, get the size and check if the upload is complete
                const receivedPartsLength = stats.size;



                if (receivedPartsLength == file_size) {

                    socket.emit(`chat:fileTransferCompleted-${file_id}`, {
                        delivered_at: new Date(),
                        message_id,
                        status: "ALL_CHUNKS_RECEIVED_FILE_TRANSFER_COMPLETED"
                    });

                    return
                }



                const byteOffset = Math.min(byte_offset, receivedPartsLength); // Resume from the correct byte offset

                const receivedChunks = Math.floor((byteOffset + (CHUNK_SIZE) - 1) / (CHUNK_SIZE)); // Calculate received chunks


                // Initialize the file transfer in progress
                fileTransfers[file_id] = {
                    senderId: sender_id,
                    recipientId: recipient_id,
                    messageId: message_id,
                    replyId: reply_id,
                    type,
                    category,
                    contentType: content_type,
                    message,
                    originalFileName: file_name,
                    fileSize: file_size,
                    fileExtension: extension,
                    width,
                    height,
                    totalDuration: total_duration,
                    totalChunks: total_chunks,
                    receivedChunks: receivedChunks,
                    keyVersion: key_version,
                    filePath: mediaPath,


                };


                callback({ status: "Success" });


            } else {


                fs.mkdirSync(dirPath, { recursive: true });

                // Initialize the file transfer in progress
                fileTransfers[file_id] = {
                    senderId: sender_id,
                    recipientId: recipient_id,
                    messageId: message_id,
                    replyId: reply_id,
                    type,
                    category,
                    contentType: content_type,
                    message,
                    originalFileName: file_name,
                    fileSize: file_size,
                    fileExtension: extension,
                    width,
                    height,
                    totalDuration: total_duration,
                    totalChunks: total_chunks,
                    receivedChunks: 0,
                    keyVersion: key_version,
                    filePath: mediaPath,

                };

                callback({ status: "Success" });

            }



        } catch (err) {
            console.log(err);
            logMessage('Database query error: ' + err.message);
            callback({ status: "ERROR", message: "An error occurred during the file transfer." });
        }
    });



    // Handle receiving file chunk
    socket.on('chat:sendFileChunk', async (chunkData, callback) => {


        const { file_id, chunk_index, data, byte_offset } = chunkData; // Use `file_id` consistently
        const fileTransfer = fileTransfers[file_id]; // Use `file_id` here


        try {
            if (!fileTransfer) {
                callback('Invalid file transfer state', { status: "MEDIA_TRANSFER_NOT_FOUND" });
                return;
            }

            const {
                messageId,
                filePath,
                fileSize
            } = fileTransfer;

            const byteOffset = fs.existsSync(filePath)
                ? Math.min(byte_offset, fs.statSync(filePath).size)  // If file exists, get the size and return the correct byte offset
                : 0;  // Start from 0 if the file doesn't exist

            const buffer = Buffer.from(data, 'binary');

            let fd;
            try {
                // Open the file for writing in append mode or read-write mode
                fd = fs.existsSync(filePath)
                    ? fs.openSync(filePath, 'r+')
                    : fs.openSync(filePath, 'a+');

                // Write the data at the specified byte offset
                fs.writeSync(fd, buffer, 0, buffer.length, byteOffset);

                // Get updated file size
                const totalUploadedSize = fs.statSync(filePath).size;

                socket.emit(`chat:mediaChunkAck-${file_id}-${chunk_index}`, {
                    delivered_at: new Date(),
                    messageId,
                    fileId: file_id,
                    chunkIndex: chunk_index,
                    updatedSize: totalUploadedSize,
                });

                // Update receivedChunks count
                fileTransfer.receivedChunks++;

                // Check if all chunks are received
                if (fileTransfer.receivedChunks === fileTransfer.totalChunks) {


                    socket.emit(`chat:fileTransferCompleted-${file_id}`, {
                        delivered_at: new Date(),
                        messageId,
                        status: "FILE_TRANSFER_COMPLETED"
                    });

                    // Clean up transfer state
                    delete fileTransfers[file_id];
                }
            } catch (err) {
                console.log(err);
                logMessage('Unexpected error: ' + err.message);
                callback('Unexpected error occurred', { status: "UNKNOWN_ERROR" });
            } finally {
                // Ensure file descriptor is always closed, even if an error occurred
                if (fd) {
                    fs.closeSync(fd);
                }
            }

        } catch (err) {
            console.log(err);
            logMessage('Unexpected error: ' + err.message);
            callback('Unexpected error occurred', { status: "UNKNOWN_ERROR" });
        }


    });



    // Object to track ongoing thumbnail transfers by file_id
    let thumbnailTransfers = {};



    // Handle the start of file transfer

    socket.on('chat:startThumbnailTransfer', async (fileData, callback) => {

        try {

            const {
                sender_id,
                recipient_id,
                message_id,
                reply_id,
                message,
                content_type,
                category,
                type,
                file_id,
                file_name,
                extension,
                file_size,
                width,
                height,
                total_duration,
                key_version,
                total_chunks,
                byte_offset,
            } = fileData;



            // Check if the recipient is active
            const [rows] = await promise.query('SELECT account_status FROM users WHERE user_id = ?', [recipient_id]);

            if (rows.length > 0 && rows[0].account_status === 'deactivated') {
                callback({ status: "USER_NOT_ACTIVE_ERROR", recipient_id });
                return;
            }

            // Get the recipient's public key and key version
            const [keyRows] = await promise.query('SELECT encrypted_public_key, key_version FROM e2ee_public_keys WHERE user_id = ?', [recipient_id]);

            if (keyRows.length === 0) {
                callback({ status: "FAILED_ON_KEY", recipient_id });
                return;
            }

            const publicKey = keyRows[0].encrypted_public_key;
            const latestKeyVersion = keyRows[0].key_version;

            if (latestKeyVersion !== key_version) {
                callback({ status: "KEY_ERROR", recipient_id, publicKey: publicKey.toString('utf-8'), keyVersion: latestKeyVersion });
                return;
            }



            const parsedFileName = path.parse(file_name); // This will break the filename into parts (name, ext, etc.)

            const originalFilePath = path.join(MEDIA_ROOT_PATH, "uploads", `${recipient_id}/${file_id}_${parsedFileName.name}.enc`);

            const dirPath = path.join(MEDIA_ROOT_PATH, `uploads`, `thumbnails`, recipient_id.toString());
            const mediaPath = path.join(dirPath, `${file_id}_${parsedFileName.name}_thumbnail.enc`);





            if (fs.existsSync(mediaPath)) {


                const stats = fs.statSync(mediaPath);

                // If file exists, get the size and check if the upload is complete
                const receivedPartsLength = stats.size;

                if (receivedPartsLength == file_size) {

                    socket.emit(`chat:thumbnailTransferCompleted-${file_id}`, {
                        delivered_at: new Date(),
                        message_id,
                        status: "ALL_CHUNKS_RECEIVED_THUMBNAIL_TRANSFER_COMPLETED"
                    });

                    return
                }



                const byteOffset = Math.min(byte_offset, receivedPartsLength); // Resume from the correct byte offset

                const receivedChunks = Math.floor((byteOffset + (CHUNK_SIZE) - 1) / (CHUNK_SIZE)); // Calculate received chunks


                // Initialize the file transfer in progress
                thumbnailTransfers[file_id] = {
                    senderId: sender_id,
                    recipientId: recipient_id,
                    messageId: message_id,
                    replyId: reply_id,
                    type,
                    category,
                    contentType: content_type,
                    message,
                    originalFileName: file_name,
                    fileSize: file_size,
                    fileExtension: extension,
                    width,
                    height,
                    totalDuration: total_duration,
                    totalChunks: total_chunks,
                    receivedChunks: receivedChunks,
                    keyVersion: key_version,
                    filePath: mediaPath,


                };


                callback({ status: "Success" });


            } else {



                fs.mkdirSync(dirPath, { recursive: true });

                // Initialize the file transfer in progress
                thumbnailTransfers[file_id] = {
                    senderId: sender_id,
                    recipientId: recipient_id,
                    messageId: message_id,
                    replyId: reply_id,
                    type,
                    category,
                    contentType: content_type,
                    message,
                    originalFileName: file_name,
                    fileSize: file_size,
                    fileExtension: extension,
                    width,
                    height,
                    totalDuration: total_duration,
                    totalChunks: total_chunks,
                    receivedChunks: 0,
                    keyVersion: key_version,
                    originalFilePath,
                    filePath: mediaPath,

                };

                callback({ status: "Success" });

            }




        } catch (err) {
            logMessage('Database query error: ' + err.message);
            callback({ status: "ERROR", message: "An error occurred during the file transfer." });
        }
    });


    socket.on('chat:sendThumbnailChunk', async (chunkData, callback) => {


        try {


            const { file_id, chunk_index, data, byte_offset } = chunkData; // Use `file_id` consistently

            const thumbnailTransfer = thumbnailTransfers[file_id]; // Use `file_id` here


            if (!thumbnailTransfer) {
                console.log("Thumbnail transfer not found");
                callback('Invalid file transfer state', { status: "MEDIA_TRANSFER_NOT_FOUND" });
                return;
            }


            const {
                messageId,
                originalFilePath,
                filePath
            } = thumbnailTransfer;


            const buffer = Buffer.from(data, 'binary');




            const byteOffset = fs.existsSync(filePath)
                ? Math.min(byte_offset, fs.statSync(filePath).size)  // If file exists, get the size and return the correct byte offset
                : 0;  // Start from 0 if the file doesn't exist


            let fd;
            try {
                // Open the file for writing in append mode or read-write mode
                fd = fs.existsSync(filePath)
                    ? fs.openSync(filePath, 'r+')
                    : fs.openSync(filePath, 'a+');

                // Write the data at the specified byte offset
                fs.writeSync(fd, buffer, 0, buffer.length, byteOffset);


                // Get updated file size
                const totalUploadedSize = fs.statSync(originalFilePath).size + fs.statSync(filePath).size;



                socket.emit(`chat:mediaThumbnailChunkAck-${file_id}-${chunk_index}`, {
                    delivered_at: new Date(),
                    messageId,
                    fileId: file_id,
                    chunkIndex: chunk_index,
                    updatedSize: totalUploadedSize,
                });

                // Update receivedChunks count
                thumbnailTransfer.receivedChunks++;


                // Check if all chunks are received
                if (thumbnailTransfer.receivedChunks === thumbnailTransfer.totalChunks) {

                    socket.emit(`chat:thumbnailTransferCompleted-${file_id}`, {
                        delivered_at: new Date(),
                        messageId,
                        status: "THUMBNAIL_TRANSFER_COMPLETED"
                    });


                    // Clean up transfer state
                    delete thumbnailTransfers[file_id];

                }


            } catch (err) {
                console.log(err);
                logMessage('Unexpected error: ' + err.message);
                callback('Unexpected error occurred', { status: "UNKNOWN_ERROR" });
            } finally {
                // Ensure file descriptor is always closed, even if an error occurred
                if (fd) {
                    fs.closeSync(fd);
                }
            }


        } catch (err) {
            console.log(err);
            logMessage('Database query error: ' + err.message);
        }
    });


    socket.on('chat:sendMedia', async (data) => {
        const {
            key_version,
            category,
            sender_id,
            recipient_id,
            reply_id,
            type,
            message_id,
            message,
            file_id,
            file_name,
            content_type,
            extension,
            width,
            height,
            total_duration
        } = data;


        const parsedFileName = path.parse(file_name);

        // Define the S3 key (file path in the bucket) for storage
        const mediaPath = path.join('uploads', recipient_id.toString(), `${file_id}_${parsedFileName.name}.enc`);

        // Get file stats
        const stats = fs.statSync(path.join(MEDIA_ROOT_PATH, mediaPath));


        // Construct the URL for accessing the file
        const fileUrl = `${MEDIA_BASE_URL}/${mediaPath}`;



        const fileSize = stats.size; // File size from S3


        const file_meta_data = JSON.stringify({
            download_url: fileUrl,
            original_file_name: file_name,
            file_size: fileSize,
            content_type: content_type,
            extension: extension,
            width: width,
            height: height,
            total_duration: total_duration
        });



        const insert_offline_message = async () => {

            try {
                const query = `
                INSERT INTO offline_messages 
                (type, reply_id, sender_id, message_id, message_body, chat_info_id, category, file_meta_data) 
                VALUES (?,?,?,?,?,?,?,?)
            `;
                await promise.query(query, [type, reply_id, sender_id, message_id, message, recipient_id, category, file_meta_data]);
                await delay(500);

                handleAckOfMessage({
                    sender: sender_id,
                    recipient_id: recipient_id,
                    ackType: "self",
                    message_id,
                    status: "sent"


                });

            } catch (error) {
                logMessage("Error inserting offline media messages", error);
                console.log(error);
            }
        };

        // Check recipient's online status
        const [results] = await promise.query('SELECT socket_id, online FROM chat_info WHERE user_id = ?', [recipient_id]);

        if (results.length === 0) {
            return;
        }

        const recipient_user = results[0];
        const recipient_socket = sockets[recipient_id];

        // If recipient is offline
        if (!recipient_user.online) {
            await insert_offline_message();



            return;
        }

        // If recipient is online
        if (recipient_socket) {
            // Delay before sending the chat message
            await delay(500);

            recipient_socket.timeout(10000).emit('chat:check', { sender: sender_id }, async (error, response) => {
                if (error) {
                    await insert_offline_message();
                } else {
                    // Send the message
                    io.to(recipient_user.socket_id).emit('chat:chatMessage', {
                        sender: sender_id,
                        message: message,
                        message_id: message_id,
                        reply_id: reply_id,
                        type: type,
                        key_version: key_version,
                        category: category,
                        file_metadata: file_meta_data
                    }, () => {

                        handleAckOfMessage({
                            sender: sender_id,
                            recipient_id: recipient_id,
                            ackType: "self",
                            message_id,
                            status: "sent"
                        });

                    });
                }
            });
        } else {
            // If recipient socket doesn't exist
            await insert_offline_message();
        }
    });



    socket.on('chat:sendVisualMedia', async (data) => {
        const {
            key_version,
            category,
            sender_id,
            recipient_id,
            reply_id,
            type,
            message_id,
            message,
            file_id,
            file_name,
            content_type,
            extension,
            width,
            height,
            total_duration
        } = data;



        const parsedFileName = path.parse(file_name);

        // Define the S3 key (file path in the bucket) for storage
        const mediaPath = path.join('uploads', recipient_id.toString(), `${file_id}_${parsedFileName.name}.enc`);

        // Get file stats
        const stats = fs.statSync(path.join(MEDIA_ROOT_PATH, mediaPath));


        // Construct the URL for accessing the file
        const fileUrl = `${MEDIA_BASE_URL}/${mediaPath}`;



        const fileSize = stats.size; // File size from S3

        // Define the S3 key (file path in the bucket) for storage
        const thumbnailFile = path.join('uploads', 'thumbnails', recipient_id.toString(), `${file_id}_${parsedFileName.name}_thumbnail.enc`);


        // Construct the URL for accessing the file
        const thumbnailUrl = `${MEDIA_BASE_URL}/${thumbnailFile}`;



        const file_meta_data = JSON.stringify({
            download_url: fileUrl,
            original_file_name: file_name,
            file_size: fileSize,
            content_type: content_type,
            extension: extension,
            width: width,
            height: height,
            total_duration: total_duration,
            thumb_download_url: thumbnailUrl
        });

        const insert_offline_message = async () => {

            try {
                const query = `
                INSERT INTO offline_messages 
                (type, reply_id, sender_id, message_id, message_body, chat_info_id, category, file_meta_data) 
                VALUES (?,?,?,?,?,?,?,?)
            `;
                await promise.query(query, [type, reply_id, sender_id, message_id, message, recipient_id, category, file_meta_data]);
                await delay(500);

                handleAckOfMessage({
                    sender: sender_id,
                    recipient_id: recipient_id,
                    ackType: "self",
                    message_id,
                    status: "sent"


                });

            } catch (error) {
                logMessage("Error inserting offline media messages", error);
                console.log(error);
            }
        };

        // Check recipient's online status
        const [results] = await promise.query('SELECT socket_id, online FROM chat_info WHERE user_id = ?', [recipient_id]);

        if (results.length === 0) {
            return;
        }

        const recipient_user = results[0];
        const recipient_socket = sockets[recipient_id];

        // If recipient is offline
        if (!recipient_user.online) {
            await insert_offline_message();
            return;
        }

        // If recipient is online
        if (recipient_socket) {
            // Delay before sending the chat message
            await delay(500);

            recipient_socket.timeout(10000).emit('chat:check', { sender: sender_id }, async (error, response) => {
                if (error) {
                    await insert_offline_message();
                } else {
                    // Send the message
                    io.to(recipient_user.socket_id).emit('chat:chatMessage', {
                        sender: sender_id,
                        message: message,
                        message_id: message_id,
                        reply_id: reply_id,
                        type: type,
                        key_version: key_version,
                        category: category,
                        file_metadata: file_meta_data
                    }, () => {

                        handleAckOfMessage({
                            sender: sender_id,
                            recipient_id: recipient_id,
                            ackType: "self",
                            message_id,
                            status: "sent"
                        });

                    });
                }
            });
        } else {


            // If recipient socket doesn't exist
            await insert_offline_message();
        }
    });





    socket.on('chat:getChatUserProfileInfo', async (data, callback) => {


        const { user_id, recipient_id } = data;

        const query = 'SELECT * FROM users WHERE user_id = ?';

        try {
            // Use promise.query with async/await for better error handling
            const [results] = await promise.query(query, [recipient_id]);

            if (results.length === 0) {
                callback("USER_NOT_EXIST", {});
                return;
            }

            const result = results[0];

            const date = new Date(result.created_at);
            // Extract the year
            const createdAtYear = date.getFullYear().toString();


            const userProfile = {
                user_id: user_id,
                first_name: result.first_name, // User's first name
                last_name: result.last_name, // User's last name (corrected to access from the first result)
                about: result.about,
                email: result.email, // User's email address
                is_email_verified: Boolean(result.is_email_verified),
                profile_pic_url: PROFILE_BASE_URL + "/" + result.profile_pic_url, // URL to the user's profile picture (if applicable)
                profile_pic_url_96x96: PROFILE_BASE_URL + "/" + result.profile_pic_url_96x96,
                account_type: result.account_type,
                location: {
                    latitude: result.latitude,
                    longitude: result.longitude,
                    geo: result.geo,
                    location_type: result.location_type,
                    updated_at: result.updated_at,
                },
                created_at: createdAtYear, // Date when the user was created
                updated_at: result.updated_at, // Date when the user details were last updated
                // Add any other relevant fields here

            }
            // Send the retrieved public key and key version
            callback("SUCCESS", userProfile);

        } catch (err) {
            console.log(err);
            // Error handling if the query fails
            callback("FAILED", {});
            logMessage('Database query error: ' + err.message);
        }

    });


    // Utility function to handle file append errors
    function handleFileWriteError(err) {
        if (err) {
            console.error("File write error:", err);
            // Optionally emit an error message to the client
            socket.emit('chat:fileTransferError', { status: 'error', message: err.message });
        }
    }


    // Error handling for file transfers
    socket.on('chat:fileTransferError', (errorData) => {
        console.error(`Error in file transfer: ${errorData.message}`);
        socket.emit('chat:fileTransferComplete', { messageId: errorData.messageId, status: 'error' });
    });

    // Handle disconnections
    socket.on('disconnect', () => {
    });



    // Handle incoming messages
    socket.on('chat:queryPublicKey', async (data, callback) => {
        const { user_id, recipient_id } = data;

        const query = 'SELECT encrypted_public_key, key_version FROM e2ee_public_keys WHERE user_id = ?';

        try {
            // Use promise.query with async/await for better error handling
            const [results] = await promise.query(query, [recipient_id]);

            if (results.length === 0) {
                callback("Public key not found", {});
                return;
            }

            const publicKey = results[0].encrypted_public_key;
            const keyVersion = results[0].key_version;

            // Send the retrieved public key and key version
            callback("Successfully retrieved public key", { recipient_id, publicKey: publicKey.toString('utf-8'), keyVersion });

        } catch (err) {
            console.log(err);
            // Error handling if the query fails
            callback("Failed to get public key", {});
            logMessage('Database query error: ' + err.message);
        }
    });





    async function handleAckOfMessage(data) {

        try {

            const { sender, message_id, recipient_id, status, ackType } = data;

            const checkRecipientQuery = 'SELECT socket_id, online FROM chat_info WHERE user_id = ?';
            // Use promise.query with async/await for better error handling
            const [results] = await promise.query(checkRecipientQuery, [sender]);

            if (results.length === 0) {
                return;
            }

            const recipientUser = results[0];

            const recipientSocket = sockets[sender];


            if (!recipientSocket || !recipientUser.online) {
                // Insert acknowledgment into offline_acks if recipient is offline
                await promise.query(
                    `INSERT INTO offline_acks (message_id, sender_id, recipient_id, status, ack_type) VALUES (?, ?, ?, ?, ?)`,
                    [message_id, sender, recipient_id, status, ackType]
                );
                return;
            }


            delay(500);

            io.to(recipientSocket.id).timeout(10000).emit('chat:messageStatus', { sender, message_id, status, recipient_id, ack_type: ackType },


                async (err, response) => {
                    if (err) {

                        // Insert acknowledgment into offline_acks if recipient is offline
                        await promise.query(
                            `INSERT INTO offline_acks (message_id, sender_id, recipient_id, status, ack_type) VALUES (?, ?, ?, ?, ?)`,
                            [message_id, sender, recipient_id, status, ackType]
                        );
                        logMessage(`No acknowledgment received for message ${data.message_id}.`, err);
                        return;
                    }
                }
            );





        } catch (err) {
            logMessage('Error handling acknowledgment:', err);
            // Log any errors that occur during the process
            console.error('Error handling acknowledgment:', err);
        }
    }


    // Handle acknowledgment
    socket.on('chat:acknowledgment', async (data, callback) => {


        try {

            const { sender, message_id, recipient_id, status } = data;


            const ackType = "recepient";

            const checkRecipientQuery = 'SELECT socket_id, online FROM chat_info WHERE user_id = ?';
            // Use promise.query with async/await for better error handling
            const [results] = await promise.query(checkRecipientQuery, [sender]);

            if (results.length === 0) {
                return;
            }

            const recipientUser = results[0];

            const recipientSocket = sockets[sender];


            if (!recipientSocket || !recipientUser.online) {

                // Insert acknowledgment into offline_acks if recipient is offline
                await promise.query(
                    `INSERT INTO offline_acks (message_id, sender_id, recipient_id, status, ack_type) VALUES (?, ?, ?, ?, ?)`,
                    [message_id, sender, recipient_id, status, ackType]
                );



                if (callback) {
                    callback();
                }
                return;
            }


            delay(500);


            io.to(recipientSocket.id).timeout(10000).emit('chat:messageStatus', { sender, message_id, status, recipient_id, ack_type: ackType },

                async (err, response) => {
                    if (err) {


                        // Insert acknowledgment into offline_acks if recipient is offline
                        await promise.query(
                            `INSERT INTO offline_acks (message_id, sender_id, recipient_id, status, ack_type) VALUES (?, ?, ?, ?, ?)`,
                            [message_id, sender, recipient_id, status, ackType]
                        );

                        logMessage(`No acknowledgment received for message ${data.message_id}.`, err);
                        console.log("User offline ack");
                        if (callback) {
                            callback();
                        }
                        return;
                    } else {

                        if (callback) {
                            callback();
                        }
                    }
                }
            );




        } catch (err) {
            logMessage('Error handling acknowledgment:', err);
            // Log any errors that occur during the process
            console.error('Error handling acknowledgment:', err);
        }
    });




    // Socket event to handle media status
    socket.on('chat:mediaStatus', async (data, callback) => {
        try {
          
            const downloadUrl = data.download_url

            // Check if the download URL starts with the base URL
            if (downloadUrl.startsWith(MEDIA_BASE_URL)) {
                const relativeFilePath = downloadUrl.replace(MEDIA_BASE_URL, '');

                // Now, join it with the root directory of your server where files are stored
                const filePath = path.join(MEDIA_ROOT_PATH, relativeFilePath);

                // Check if the file exists
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        if (err.code === 'ENOENT') {
                            // If the file doesn't exist, return an error response
                            return callback();
                        }
                        // Handle other errors
                        return callback();
                    }

                    // File exists, attempt to delete it
                    fs.unlink(filePath, (err) => {
                        if (err) {
                            // Error deleting the file
                            return callback();
                        }

                        return callback();
                    });
                });
            } else {
                // If the URL doesn't start with the expected base URL, return an error
                return callback();
            }
        } catch (error) {
            // General error handling
            return callback();
        }
    });

    // Handle profile picture update
    socket.on('chat:profilePicUpdated', async (data) => {
        const { user_id: userId } = data;

        const query = 'SELECT profile_pic_url, profile_pic_url_96x96, updated_at FROM users WHERE user_id = ?';

        try {
            // Use promise.query with async/await for better error handling
            const [results] = await promise.query(query, [userId]);

            if (results.length === 0) {
                return;
            }

            // Emit the profile info to the subscribed users
            io.to(`chat:status-${userId}`).emit('chat:profileInfo', {
                updated_at: results[0].updated_at,
                user_id: userId,
                profile_pic_url: `${PROFILE_BASE_URL}` + "/" + results[0].profile_pic_url,
                profile_pic_url_96x96: `${PROFILE_BASE_URL}` + "/" + results[0].profile_pic_url_96x96
            });

        } catch (err) {

            console.log('Database query error: ' + err.message);
            // Log any errors that occur during the query execution
            logMessage('Database query error: ' + err.message);
        }
    });





    socket.on('reconnect', () => {
    });



    // Handle disconnection
    socket.on('disconnect', async (reason) => {


        try {
            console.log("Disconnected: " + reason);

            clearTimeout(heartbeatTimeout);

            if (!userSocketMap[socket.id]) {
                return;
            }

            const { user_id, is_background } = userSocketMap[socket.id];

            delete sockets[user_id];

            // If the user is in the background, do not update online status
            if (is_background) {
                return;
            }

            const query = 'UPDATE chat_info SET online = false, socket_id = NULL, last_active = CURRENT_TIMESTAMP WHERE socket_id = ?';


            // Perform the update query
            await promise.query(query, [socket.id]);

            const sql = `SELECT online, last_active, socket_id FROM chat_info WHERE user_id = ?`;
            const [results] = await promise.query(sql, [user_id]);

            if (results.length > 0) {
                const { online, last_active, socket_id } = results[0];

                // Emit the updated online status to the user's status channel
                io.to(`chat:status-${user_id}`).emit(`chat:onlineStatus-${user_id}`, { user_id, online: false, last_active });
            }

        } catch (err) {
            console.log('Database query error: ' + err.message);
            logMessage('Database query error: ' + err.message);
        }
    });


});


function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


async function handleUndeliveredMessage(socket, data) {
    try {

        const { sender, message_id, recipient_id, status } = data;


        const checkRecipientQuery = 'SELECT socket_id, online FROM chat_info WHERE user_id = ?';
        // Use promise.query with async/await for better error handling
        const [results] = await promise.query(checkRecipientQuery, [sender]);

        if (results.length === 0) {
            return;
        }

        const recipientUser = results[0];

        if (!recipientUser.online) {
            // Insert acknowledgment into offline_acks if recipient is offline
            await promise.query(
                `INSERT INTO offline_acks (message_id, sender_id, recipient_id, status, ack_type) VALUES (?, ?, ?, ?, ?)`,
                [message_id, sender, recipient_id, status, "self"]
            );

            return;
        }

        // If recipient is online, broadcast the message status after a delay
        await delay(500); // Ensure delay is wrapped in a promise


        socket.broadcast.timeout(10000).emit('chat:messageStatus', { sender, recipient_id, message_id, status },
           
            async (err, response) => {
                if (err) {

                    // Insert acknowledgment into offline_acks if recipient is offline
                    await promise.query(
                        `INSERT INTO offline_acks (message_id, sender_id, recipient_id, status, ack_type) VALUES (?, ?, ?, ?, ?)`,
                        [message_id, sender, recipient_id, status, "self"]
                    );
                    logMessage(`No acknowledgment received for message ${data.message_id}.`, err);
                    return;
                }
            }
        );



    } catch (err) {
        logMessage('Error handling acknowledgment:', err);
        // Log any errors that occur during the process
        console.error('Error handling acknowledgment:', err);
    }
}


const PORT = process.env.PORT || 3080;




server.listen(PORT, () => {
    logMessage(`Server is running on http://localhost:${PORT}`);
});
