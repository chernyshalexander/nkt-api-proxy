/**
 * Proxy server for the National Goods Catalog API (НКТ).
 *
 * Routes (all under /nat-cat-1/):
 *   POST /proxy              — look up product info by GTIN (rd-info-by-gtin)
 *   GET  /proxy-product-list — retrieve a paginated product list with date filters
 *   GET  /rate-limit-status  — return current rate limit counters
 *
 * Rate limiting: 100 requests per 5-minute sliding window.
 * API key: stored in api-key.json (excluded from the repository — see .gitignore).
 *          Copy api-key.example.json → api-key.json and fill in your key.
 * Config:  stored in config.json (excluded from the repository — see .gitignore).
 *          Copy config.example.json → config.json and set hostname and port.
 */

const express = require('express');
const https = require('https');
const fetch = require('node-fetch');
const fs = require('fs');

// Load config files — fail early with a clear message if missing
function loadJson(path, hint) {
    try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
        console.error(`Error: cannot read ${path}. ${hint}`);
        process.exit(1);
    }
}

const { apikey: API_KEY } = loadJson('./api-key.json', 'Copy api-key.example.json → api-key.json and fill in your key.');
const { hostname: HOSTNAME, port: PORT } = loadJson('./config.json', 'Copy config.example.json → config.json and set your hostname and port.');

const API_BASE_URL = 'https://апи.национальный-каталог.рф/v4';

// Disable TLS validation only for requests to the НКТ API (self-signed cert)
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

const app = express();
const router = express.Router();

app.use(express.json());

app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use('/nat-cat-1', express.static('public'));

// Rate limiting — sliding window
const MAX_REQUESTS = 100;
const TIME_WINDOW = 5 * 60 * 1000; // ms
let requestTimestamps = [];
let windowStartTime = Date.now();

function cleanupOldTimestamps() {
    const now = Date.now();
    requestTimestamps = requestTimestamps.filter(ts => ts > now - TIME_WINDOW);
    windowStartTime = requestTimestamps.length > 0 ? requestTimestamps[0] : Date.now();
}

function checkRateLimit(_req, res, next) {
    const now = Date.now();
    cleanupOldTimestamps();

    if (requestTimestamps.length >= MAX_REQUESTS) {
        const timeUntilNextSlot = Math.ceil((requestTimestamps[0] + TIME_WINDOW - now) / 1000);
        return res.status(429).json({
            error: 'Rate limit exceeded',
            retryAfter: timeUntilNextSlot,
            message: `Limit of ${MAX_REQUESTS} requests per 5 minutes reached. Retry in ${timeUntilNextSlot} seconds.`
        });
    }

    requestTimestamps.push(now);
    next();
}

function getRateLimitHeaders() {
    // Note: cleanup is expected to have already been called by checkRateLimit
    const remaining = MAX_REQUESTS - requestTimestamps.length;
    const timeUntilReset = requestTimestamps.length > 0
        ? Math.ceil((requestTimestamps[0] + TIME_WINDOW - Date.now()) / 1000)
        : 0;
    return {
        'X-RateLimit-Limit': MAX_REQUESTS,
        'X-RateLimit-Remaining': Math.max(0, remaining),
        'X-RateLimit-Reset': requestTimestamps.length > 0 ? requestTimestamps[0] + TIME_WINDOW : Date.now(),
        'X-RateLimit-RetryAfter': timeUntilReset
    };
}

// Shared fetch helper — executes request and forwards response or error to client
async function callApi(url, fetchOptions, res) {
    try {
        const response = await fetch(url, { agent: tlsAgent, ...fetchOptions });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('API error:', response.status, errorText);
            return res.status(response.status).json({ error: errorText });
        }

        const data = await response.json();
        res.set(getRateLimitHeaders()).json(data);
    } catch (error) {
        console.error('Request failed:', error);
        res.status(500).json({ error: 'Internal proxy error', details: error.message });
    }
}

// POST /proxy — product info by GTIN
router.post('/proxy', checkRateLimit, (req, res) => {
    const url = `${API_BASE_URL}/rd-info-by-gtin?apikey=${API_KEY}`;
    console.log('POST /proxy', req.body);
    callApi(url, {
        method: 'POST',
        headers: { 'Accept-Charset': 'utf-8', 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
    }, res);
});

// GET /proxy-product-list — paginated product list with optional date range
router.get('/proxy-product-list', checkRateLimit, (req, res) => {
    const { from_date, to_date, limit, offset } = req.query;

    const datePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    const validationErrors = [];

    if (from_date && !datePattern.test(from_date))
        validationErrors.push('from_date must be in format YYYY-MM-DD HH:mm:ss');
    if (to_date && !datePattern.test(to_date))
        validationErrors.push('to_date must be in format YYYY-MM-DD HH:mm:ss');
    if (limit !== undefined) {
        const n = parseInt(limit);
        if (isNaN(n) || n < 1 || n > 1000)
            validationErrors.push('limit must be an integer between 1 and 1000');
    }
    if (offset !== undefined) {
        const n = parseInt(offset);
        if (isNaN(n) || n < 0)
            validationErrors.push('offset must be a non-negative integer');
    }

    if (validationErrors.length > 0) {
        return res.status(400).json({ error: 'Invalid query parameters', details: validationErrors });
    }

    const params = new URLSearchParams({ apikey: API_KEY });
    if (from_date) params.append('from_date', from_date);
    if (to_date)   params.append('to_date', to_date);
    if (limit)     params.append('limit', limit);
    if (offset !== undefined) params.append('offset', offset); // offset=0 is valid

    const url = `${API_BASE_URL}/product-list?${params.toString()}`;
    console.log('GET /proxy-product-list', url);
    callApi(url, {
        headers: { 'Accept-Charset': 'utf-8', 'Content-Type': 'application/json' },
    }, res);
});

// GET /rate-limit-status — current rate limit counters
router.get('/rate-limit-status', (req, res) => {
    cleanupOldTimestamps();
    const now = Date.now();
    const remaining = MAX_REQUESTS - requestTimestamps.length;
    const timeUntilReset = requestTimestamps.length > 0
        ? Math.ceil((requestTimestamps[0] + TIME_WINDOW - now) / 1000)
        : 0;

    res.json({
        limit: MAX_REQUESTS,
        remaining: Math.max(0, remaining),
        used: requestTimestamps.length,
        isPaused: requestTimestamps.length >= MAX_REQUESTS,
        timeUntilReset,
        currentWindowStart: windowStartTime,
        currentWindowEnd: windowStartTime + TIME_WINDOW
    });
});

app.use('/nat-cat-1', router);

app.listen(PORT, () => {
    console.log(`Proxy server running at http://${HOSTNAME}:${PORT}/nat-cat-1/`);
});
