const jwt = require('jsonwebtoken');

const {promise}= require('../db/config')
const {getAccessToken, decodeFCMToken, sendFCMNotification} = require('./utils');
// Your service account key JSON object
const {logMessage} = require('../common/utils')



// Main function to fetch users and send notifications
async function runGeneralNotificationJob() {


    try {
        const accessToken = await getAccessToken();

        const query = `SELECT 
    n.id AS notification_id,
    n.user_id,
    n.title,        
    n.message,
    n.type,
    fcm_tokens.fcm_token,
    n.flag
FROM notifications n
JOIN users u ON n.user_id = u.user_id
JOIN fcm_tokens ON u.user_id = fcm_tokens.user_id
WHERE n.type = 'welcome'                     
  AND n.created_at >= NOW() - INTERVAL 5 MINUTE
  AND n.flag = FALSE;`;


    const [results] = await promise.query(query);


    for (const row of results) {
        try {



            const {user_id, notification_id, title, message, fcm_token,type } = row;
        
            if(!fcm_token){
                return
            }
            
            const decodedFCMToken =  decodeFCMToken(fcm_token);
            await sendFCMNotification(accessToken, decodedFCMToken, "general", title, JSON.stringify(
                {
                    message,
                 type
              }
            
            ),
             -1);

            const deleteQuery = "DELETE FROM notifications WHERE id = ?";
            promise.query(deleteQuery, [notification_id], (err) => {
                if (err) throw err;
            });

        } catch (error) {

            console.log(error);

            if (error.response) {
                // Server responded with a status code outside of the 2xx range
                logMessage('Error response:', error.response.data);
                logMessage('Error status:', error.response.status);
            } else if (error.request) {
                // Request was made but no response was received
                logMessage('Error request:', error.request);
            } else {
                // Something went wrong setting up the request
                logMessage('Error message:', error.message);
            }                    
        }
      
    }


    } catch (error) {
        console.log("Seomething wrong on running general notification job");
    }

}

module.exports = runGeneralNotificationJob;

