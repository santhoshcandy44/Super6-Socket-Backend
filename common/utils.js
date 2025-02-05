const path = require('path');
const fs = require('fs');

// Log file path
const logFilePath = path.join('./logs/server.log');

// Helper function to log messages
const logMessage = (message) => {
    const timestamp = new Date().toISOString();
    fs.appendFile(logFilePath, `[${timestamp}] ${message}\n`, (err) => {
        if (err) throw err;
    });
};


module.exports={
    logMessage
}