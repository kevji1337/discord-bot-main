const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const jsonCache = new Map();
const pendingFlushTimers = new Map();

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive: true});
}

function isDangerousKey(key) {
    // Защита от prototype pollution при хранении данных в plain-object.
    return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

function toNullProtoObject(obj) {
    const out = Object.create(null);
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
        if (typeof k !== 'string' || isDangerousKey(k)) continue;
        out[k] = v;
    }
    return out;
}

function isSnowflake(value) {
    return /^\d{17,20}$/.test(String(value ?? '').trim());
}

function cleanupStaleTempFiles(filePath, maxAgeMs = 5 * 60 * 1000) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const now = Date.now();

    let entries = [];
    try {
        entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith(`${base}.tmp.`)) continue;

        const fullPath = path.join(dir, entry.name);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.size !== 0) continue;
            if (now - stat.mtimeMs < maxAgeMs) continue;
            fs.rmSync(fullPath, {force: true});
        } catch {
            // noop
        }
    }
}

function atomicWriteFileSync(filePath, content) {
    // Надёжная запись без риска получить частично записанный JSON при падении процесса.
    // На Windows rename() не перезаписывает существующий файл — удаляем целевой перед rename.
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(tmpPath, content, {encoding: 'utf8'});
        fs.rmSync(filePath, {force: true});
        fs.renameSync(tmpPath, filePath);
    } finally {
        try {
            if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, {force: true});
        } catch {
            // noop
        }
    }
}

function cloneData(data) {
    if (data === undefined) return undefined;
    if (typeof global.structuredClone === 'function') {
        return global.structuredClone(data);
    }
    return JSON.parse(JSON.stringify(data));
}

function flushPendingFile(filePath) {
    const timer = pendingFlushTimers.get(filePath);
    if (timer) {
        clearTimeout(timer);
        pendingFlushTimers.delete(filePath);
    }
    if (!jsonCache.has(filePath)) return;
    atomicWriteFileSync(filePath, JSON.stringify(jsonCache.get(filePath), null, 2));
    cleanupStaleTempFiles(filePath);
}

function scheduleFlush(filePath, debounceMs) {
    const existing = pendingFlushTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        pendingFlushTimers.delete(filePath);
        flushPendingFile(filePath);
    }, debounceMs);
    timer.unref?.();
    pendingFlushTimers.set(filePath, timer);
}

function flushAllPendingJSONWrites() {
    for (const filePath of [...pendingFlushTimers.keys()]) {
        flushPendingFile(filePath);
    }
}

let flushHooksInstalled = false;
function installFlushHooks() {
    if (flushHooksInstalled) return;
    flushHooksInstalled = true;
    process.once('beforeExit', flushAllPendingJSONWrites);
    process.once('exit', flushAllPendingJSONWrites);
    process.once('SIGINT', () => {
        flushAllPendingJSONWrites();
        process.exit(130);
    });
    process.once('SIGTERM', () => {
        flushAllPendingJSONWrites();
        process.exit(143);
    });
}

function normalizeTicketStateRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

    const ownerId = isSnowflake(record.ownerId) ? String(record.ownerId) : null;
    if (!ownerId) return null;

    const category = typeof record.category === 'string' && record.category.trim() ? record.category.trim() : 'question';
    const takenById = isSnowflake(record.takenById) ? String(record.takenById) : null;
    const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
    const takenAt = Number.isFinite(record.takenAt) ? record.takenAt : null;
    const lastActive = Number.isFinite(record.lastActive) ? record.lastActive : createdAt;
    const guildId = isSnowflake(record.guildId) ? String(record.guildId) : null;

    return {
        ownerId,
        category,
        takenById,
        createdAt,
        takenAt,
        lastActive,
        guildId
    };
}

function loadJSON(filename, defaultData = {}) {
    ensureDir();
    const filePath = path.join(DATA_DIR, filename);
    installFlushHooks();
    if (jsonCache.has(filePath)) {
        return cloneData(jsonCache.get(filePath));
    }
    cleanupStaleTempFiles(filePath);
    if (!fs.existsSync(filePath)) {
        const initial = cloneData(defaultData);
        jsonCache.set(filePath, initial);
        atomicWriteFileSync(filePath, JSON.stringify(initial, null, 2));
        return cloneData(initial);
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        jsonCache.set(filePath, parsed);
        return cloneData(parsed);
    } catch (e) {
        // Бэкапим битый файл, чтобы не терять данные и не зациклиться на ошибке парсинга.
        try {
            const backupPath = `${filePath}.corrupt.${Date.now()}.bak`;
            fs.copyFileSync(filePath, backupPath);
        } catch { /* noop */
        }
        const fallback = cloneData(defaultData);
        jsonCache.set(filePath, fallback);
        return cloneData(fallback);
    }
}

function saveJSON(filename, data, opts = {}) {
    ensureDir();
    const filePath = path.join(DATA_DIR, filename);
    installFlushHooks();
    const snapshot = cloneData(data);
    jsonCache.set(filePath, snapshot);
    const debounceMs = Number.isFinite(opts.debounceMs) ? Math.max(0, opts.debounceMs) : 0;
    if (debounceMs > 0) {
        scheduleFlush(filePath, debounceMs);
        return;
    }
    flushPendingFile(filePath);
}

// SPECIFIC MANAGERS

// SNIPPETS
exports.getSnippets = () => toNullProtoObject(loadJSON('snippets.json', Object.create(null)));
exports.addSnippet = (name, content) => {
    const key = String(name ?? '').trim();
    if (!key || isDangerousKey(key)) throw new Error('Invalid snippet name');
    const data = exports.getSnippets();
    data[key] = String(content ?? '');
    saveJSON('snippets.json', data);
};
exports.removeSnippet = (name) => {
    const key = String(name ?? '').trim();
    if (!key || isDangerousKey(key)) throw new Error('Invalid snippet name');
    const data = exports.getSnippets();
    delete data[key];
    saveJSON('snippets.json', data);
};

// BANS
exports.getBannedUsers = () => loadJSON('banned_users.json', []);
exports.banUser = (userId) => {
    const data = exports.getBannedUsers();
    if (!data.includes(userId)) {
        data.push(userId);
        saveJSON('banned_users.json', data);
    }
};
exports.unbanUser = (userId) => {
    const data = exports.getBannedUsers();
    const newData = data.filter(id => id !== userId);
    saveJSON('banned_users.json', newData);
};

// STAFF STATS
exports.getStaffStats = () => loadJSON('staff_stats.json', {});
exports.addStaffAction = (userId, type, rating = null) => {
    const data = exports.getStaffStats();
    if (!data[userId]) data[userId] = {ticketsClosed: 0, totalRating: 0, ratingCount: 0};

    if (type === 'close') {
        data[userId].ticketsClosed += 1;
    }
    if (type === 'rating' && rating) {
        data[userId].totalRating += rating;
        data[userId].ratingCount += 1;
    }
    saveJSON('staff_stats.json', data);
};

// TICKETS META (for auto-close tracking)
exports.getTicketsMeta = () => loadJSON('tickets_meta.json', {});
exports.updateTicketActivity = (channelId) => {
    const data = exports.getTicketsMeta();
    const now = Date.now();
    data[channelId] = now;
    saveJSON('tickets_meta.json', data, {debounceMs: 1000});

    const states = exports.getTicketStates();
    if (states[channelId]) {
        states[channelId].lastActive = now;
        saveJSON('ticket_state.json', states, {debounceMs: 1000});
    }
};
exports.removeTicketMeta = (channelId) => {
    const data = exports.getTicketsMeta();
    delete data[channelId];
    saveJSON('tickets_meta.json', data);
};

// TICKET STATE
exports.getTicketStates = () => {
    const raw = toNullProtoObject(loadJSON('ticket_state.json', Object.create(null)));
    const out = Object.create(null);

    for (const [channelId, record] of Object.entries(raw)) {
        if (!isSnowflake(channelId)) continue;
        const normalized = normalizeTicketStateRecord(record);
        if (!normalized) continue;
        out[channelId] = normalized;
    }

    return out;
};

exports.getTicketState = (channelId) => {
    const key = String(channelId ?? '').trim();
    if (!isSnowflake(key)) return null;
    return exports.getTicketStates()[key] || null;
};

exports.createTicketState = (channelId, state) => {
    const key = String(channelId ?? '').trim();
    if (!isSnowflake(key)) throw new Error('Invalid channelId');

    const states = exports.getTicketStates();
    const normalized = normalizeTicketStateRecord({
        ...state,
        createdAt: Number.isFinite(state?.createdAt) ? state.createdAt : Date.now(),
        lastActive: Number.isFinite(state?.lastActive) ? state.lastActive : Date.now()
    });
    if (!normalized) throw new Error('Invalid ticket state');

    states[key] = normalized;
    saveJSON('ticket_state.json', states);
};

exports.updateTicketState = (channelId, patch) => {
    const key = String(channelId ?? '').trim();
    if (!isSnowflake(key)) throw new Error('Invalid channelId');

    const states = exports.getTicketStates();
    const current = states[key];
    if (!current) throw new Error('Ticket state not found');

    const next = normalizeTicketStateRecord({...current, ...patch});
    if (!next) throw new Error('Invalid ticket state');

    states[key] = next;
    saveJSON('ticket_state.json', states);
};

exports.setTicketTakenBy = (channelId, userId) => {
    exports.updateTicketState(channelId, {
        takenById: userId,
        takenAt: Date.now()
    });
};

exports.removeTicketState = (channelId) => {
    const key = String(channelId ?? '').trim();
    if (!isSnowflake(key)) return;

    const states = exports.getTicketStates();
    delete states[key];
    saveJSON('ticket_state.json', states);
};

// FEEDBACK
exports.getTicketFeedback = () => loadJSON('ticket_feedback.json', Object.create(null));
exports.hasTicketFeedback = (ticketId) => {
    const key = String(ticketId ?? '').trim();
    if (!isSnowflake(key)) return false;
    const data = exports.getTicketFeedback();
    return Boolean(data[key]);
};
exports.setTicketFeedback = (ticketId, feedback) => {
    const key = String(ticketId ?? '').trim();
    if (!isSnowflake(key)) throw new Error('Invalid ticketId');

    const data = exports.getTicketFeedback();
    data[key] = {
        ticketId: key,
        userId: isSnowflake(feedback?.userId) ? String(feedback.userId) : null,
        staffId: isSnowflake(feedback?.staffId) ? String(feedback.staffId) : null,
        rating: Number.isFinite(feedback?.rating) ? Number(feedback.rating) : null,
        createdAt: Number.isFinite(feedback?.createdAt) ? feedback.createdAt : Date.now()
    };
    saveJSON('ticket_feedback.json', data);
};

// SETTINGS
exports.getSettings = () => loadJSON('settings.json', { moderator_recruitment: 'open', media_recruitment: 'open' });
exports.setSetting = (key, value) => {
    if (isDangerousKey(key)) throw new Error('Invalid setting key');
    const settings = exports.getSettings();
    settings[key] = value;
    saveJSON('settings.json', settings);
};
