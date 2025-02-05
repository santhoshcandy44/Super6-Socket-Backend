const mysql = require('mysql2');
const { DATABASE_URL, DATABASE_USERNAME, DATABASE_PASSWORD, DATABASE_NAME } = require('../config/config');

// Create the connection pool
const db = mysql.createPool({
    host: DATABASE_URL,
    user: DATABASE_USERNAME,
    password: DATABASE_PASSWORD,
    database: DATABASE_NAME,
});

// Test the connection
db.getConnection((err, connection) => {
    if (err) {
        console.error('Error connecting to the database:', err);
        return;
    }
    console.log('Successfully connected to the database');
    connection.release();  // Always release the connection when done
});

module.exports = { db, promise: db.promise() };
