// db.js
const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');

const { DATABASE_URL, DATABASE_USERNAME, DATABASE_PASSWORD, DATABASE_NAME } = require('./config');


// Log file path
const logFilePath = path.join(__dirname, 'server.log');

// Helper function to log messages
const logMessage = (message) => {
    const timestamp = new Date().toISOString();
    fs.appendFile(logFilePath, `[${timestamp}] ${message}\n`, (err) => {
        if (err) throw err;
    });
};

const db = mysql.createPool({
    host: DATABASE_URL, // your database host
    user: DATABASE_USERNAME, // default XAMPP MySQL username
    password: DATABASE_PASSWORD, // default XAMPP MySQL password (usually empty)
    database: DATABASE_NAME, // replace with your actual database name
});   




module.exports = {db, promise:db.promise()};