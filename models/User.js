// models/User.js

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userSchema = new Schema({
    username: String,
    socketId: String,
    online: { type: Boolean, default: false },
    offlineMessages: [{ sender: String, message: String, timestamp: { type: Date, default: Date.now } }]
});

module.exports = mongoose.model('User', userSchema,"users");