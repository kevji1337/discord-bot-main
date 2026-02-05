const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultStatuses = {
    "Troxill Private": "Undetected",
    "Troxill Spoofer": "Undetected",
    "Shop": "Online"
};

function getStatuses() {
    if (!fs.existsSync(STATUS_FILE)) {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(defaultStatuses, null, 2));
        return defaultStatuses;
    }
    try {
        return JSON.parse(fs.readFileSync(STATUS_FILE));
    } catch {
        return defaultStatuses;
    }
}

function updateStatus(product, status) {
    const statuses = getStatuses();
    statuses[product] = status;
    fs.writeFileSync(STATUS_FILE, JSON.stringify(statuses, null, 2));
    return statuses;
}

function setStatusMessage(channelId, messageId) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ channelId, messageId }, null, 2));
}

function getStatusMessage() {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE));
    } catch {
        return null;
    }
}

module.exports = { getStatuses, updateStatus, setStatusMessage, getStatusMessage };
