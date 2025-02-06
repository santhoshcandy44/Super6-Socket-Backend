const { db, promise } = require('../db/config')
const { getAccessToken, decodeFCMToken, sendFCMNotification } = require('./utils');
// Your service account key JSON object
const {logMessage} = require('../common/utils')

    

// Main function to fetch users and send notifications
async function runOfflineMessageNotificationJob() {


    try {


        const [results] = await promise.query(
            `SELECT om.sender_id, om.message_body, om.message_id, ft.fcm_token, om.chat_info_id , om.reply_id,
            om.type,
                om.category, 
    om.file_meta_data 
FROM offline_messages om
JOIN fcm_tokens ft ON om.chat_info_id = ft.user_id
ORDER BY om.created_at ASC;`);


      
        for (const row of results) {

            const senderId = row.sender_id; // Get sender_id
            const messageBody = row.message_body; // Directly get the message body
            const messageId = row.message_id; // Directly get the message body
            const chatInfoId = row.chat_info_id; // Directly get the message body
            const replyId = row.reply_id; // Directly get the message body
            const type = row.type; // Directly get the message body

            const fcm_token = row.fcm_token;

            const category = row.category; // Get message content type (text, image, file, etc.)
            const fileMetaData = row.file_meta_data; // Get file metadata (JSON string)
          
            // If the file_meta_data exists, you can parse the JSON string to access the individual properties
            let parsedFileMetaData = null;
            if (fileMetaData) {
              parsedFileMetaData = JSON.parse(fileMetaData);
            }

         

            let accessToken;
            try {
                accessToken = await getAccessToken();

                if(fcm_token==null){
                    return;
                }

                const fcmToken = decodeFCMToken(fcm_token);

            
                const response = await sendFCMNotification(accessToken, fcmToken, "chat_message", `You got messages from ${senderId}`,
                    JSON.stringify(
                      { reply_id:replyId,
                        type:type,
                        sender: senderId,
                        message_id: messageId,
                        message: messageBody,
                        category:category,
                        file_metadata:parsedFileMetaData

                    }
                ),
                 messageId,
            );

                if (response) {
                    // Remove the sent message from the offline_messages table
                    await promise.query("DELETE FROM offline_messages WHERE chat_info_id = ? AND message_id = ?", [chatInfoId, messageId]);
                }
            } catch (error) {


                if (error.response && error.response.data.error) {
                    const errorCode = error.response.data.error.code;
                    const errorMessage = error.response.data.error.message;
                    const errorReason = error.response.data.error.details[0]?.reason;
                    const errorDetailCode = error.response.data.error.details[0]?.errorCode;

                    // Handle specific error based on code and reason
                    if (errorCode === 401 && errorReason === 'ACCESS_TOKEN_EXPIRED') {
                        accessToken = await getAccessToken(); // Refresh token
                    } else if (errorCode === 404 && errorDetailCode ==='UNREGISTERED'){
                        console.log("USER UNISTALLED");
                    } else {
                    logMessage(`Error: ${JSON.stringify(error.response.data.error)}`);
                    }
                } else {

                    logMessage(`Failed to send notification to user ${senderId}: ${error.message}`);
                }
            }
        }

    } catch (error) {
        logMessage(error);
    }

}

module.exports = runOfflineMessageNotificationJob;

