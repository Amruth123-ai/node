require('dotenv').config();
const express = require('express');
const axios = require('axios');
const moment = require('moment-timezone');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ==============================
// CONFIG
// ==============================
const BASE_URL = "https://api.delta.exchange/v2/history/candles";
const SYMBOL = "BTC_USDT";
const RESOLUTION = "2h";
const LIMIT = 200;
const POLL_INTERVAL = 15000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const length1 = 8, a1 = 0.7, length2 = 5, a2 = 0.618;

if (!BOT_TOKEN || !CHAT_ID) {
    console.error('❌ Set BOT_TOKEN and CHAT_ID in .env');
    process.exit(1);
}

// ==============================
// STATE
// ==============================
let lastTrend = null;
let lastCandleTs = null;
let logs = [];

app.use(express.static('public'));
app.use(express.json());

// ==============================
// EMA & T3 (unchanged)
function ema(series, length) {
    const result = [];
    const multiplier = 2 / (length + 1);
    if (!series.length) return result;
    result[0] = series[0];
    for (let i = 1; i < series.length; i++) {
        result[i] = (series[i] * multiplier) + (result[i - 1] * (1 - multiplier));
    }
    return result;
}

function tillsonT3Series(high, low, close, length, a) {
    const src = close.map((c, i) => (high[i] + low[i] + 2 * c) / 4);
    const e1 = ema(src, length), e2 = ema(e1, length), e3 = ema(e2, length);
    const e4 = ema(e3, length), e5 = ema(e4, length), e6 = ema(e5, length);
    const c1 = -Math.pow(a, 3), c2 = 3 * Math.pow(a, 2) + 3 * Math.pow(a, 3);
    const c3 = -6 * Math.pow(a, 2) - 3 * a - 3 * Math.pow(a, 3);
    const c4 = 1 + 3 * a + Math.pow(a, 3) + 3 * Math.pow(a, 2);
    return e3.map((_, i) => c1 * e6[i] + c2 * e5[i] + c3 * e4[i] + c4 * e3[i]);
}

// ==============================
// TELEGRAM
async function sendTelegram(msg) {
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID, text: msg, parse_mode: 'HTML'
        }, { timeout: 10000 });
    } catch (e) {
        console.error('Telegram error:', e.message);
    }
}

// ==============================
// FETCH DATA
async function fetchData() {
    try {
        const nowSec = Math.floor(Date.now() / 1000);
        const params = {
            resolution: RESOLUTION,
            symbol: SYMBOL,
            start: (nowSec - LIMIT * 7200).toString(),
            end: nowSec.toString()
        };
        const { data } = await axios.get(BASE_URL, { params, timeout: 15000 });
        if (!data.success || !data.result?.length) return null;
        
        return data.result
            .filter(c => c.open && c.high && c.low && c.close && c.time)
            .map(c => ({
                timestamp: parseInt(c.time) * 1000,
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close)
            })).sort((a, b) => a.timestamp - b.timestamp);
    } catch (e) {
        return null;
    }
}

// ==============================
// STRATEGY LOOP
async function strategyLoop() {
    console.log('🚀 BTC T3 Trend Bot started!');
    while (true) {
        try {
            const df = await fetchData();
            if (!df || df.length < 20) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                continue;
            }

            const t3 = tillsonT3Series(df.map(d => d.high), df.map(d => d.low), df.map(d => d.close), length1, a1);
            const t3f = tillsonT3Series(df.map(d => d.high), df.map(d => d.low), df.map(d => d.close), length2, a2);

            const color1 = t3.map((v, i) => i ? v > t3[i-1] ? 'green' : 'red' : 'yellow');
            const color2 = t3f.map((v, i) => i ? v > t3f[i-1] ? 'green' : 'red' : 'yellow');

            const last = df[df.length - 1];
            const candleTs = Math.floor(last.timestamp);
            if (candleTs === lastCandleTs) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                continue;
            }
            lastCandleTs = candleTs;

            const uptrend = color1.at(-1) === 'green' && color2.at(-1) === 'green';
            const downtrend = color1.at(-1) === 'red' && color2.at(-1) === 'red';
            if (!uptrend && !downtrend) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                continue;
            }

            const trend = uptrend ? 'UPTREND' : 'DOWNTREND';
            if (trend !== lastTrend) {
                const istTime = moment(candleTs).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm IST');
                logs.push({ trend, time: istTime });
                if (logs.length > 50) logs = logs.slice(-50);
                
                const msg = `${uptrend ? '🟢' : '🔴'} <b>${trend}</b>\n${SYMBOL}: $${last.close.toLocaleString()}\n${RESOLUTION} ${istTime}`;
                console.log(msg);
                await sendTelegram(msg);
                lastTrend = trend;
                io.emit('log-update', logs);
            }
        } catch (e) {
            console.error('Strategy error:', e.message);
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
}

// ==============================
// ROUTES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/logs', (req, res) => res.json(logs));
app.get('/health', (req, res) => res.json({ status: 'ok', trend: lastTrend, logs: logs.length }));

io.on('connection', socket => {
    socket.emit('log-update', logs);
});

// ==============================
// START
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 http://localhost:${PORT}`);
    strategyLoop().catch(console.error);
});
