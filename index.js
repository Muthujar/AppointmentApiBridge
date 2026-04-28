require('dotenv').config();

const express = require('express');
const https = require('https');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY;
const UPSTREAM_API_BASE = (
  process.env.UPSTREAM_API_BASE ||
  'https://inyeonapi.beautecloud.com/api/v1/external'
).replace(/\/+$/, '');

const httpsAgent = new https.Agent({
  rejectUnauthorized: true,
});

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  const ts = () => new Date().toISOString();

  const body =
    req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0
      ? ` | body: ${JSON.stringify(req.body)}`
      : '';

  console.log(`${ts()} → ${req.method} ${req.originalUrl}${body}`);

  const origJson = res.json.bind(res);
  res.json = function logJsonResponse(payload) {
    let serialized;
    try {
      serialized =
        typeof payload === 'string' ? payload : JSON.stringify(payload);
    } catch {
      serialized = '[could not serialize response]';
    }
    console.log(
      `${ts()} ← HTTP ${res.statusCode} | ${serialized} | ${Date.now() - start}ms`
    );
    return origJson(payload);
  };

  next();
});

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  })
);

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res
      .status(500)
      .json({ error: 'Server misconfiguration: API_KEY is not set' });
  }
  next();
}

function missingFields(fields, source) {
  return fields.filter((name) => {
    const v = source[name];
    return (
      v === undefined ||
      v === null ||
      (typeof v === 'string' && v.trim() === '')
    );
  });
}

async function upstreamJson(method, url, options = {}) {
  const headers = {
    'X-API-Key': API_KEY,
    ...options.headers,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: options.body,
    agent: httpsAgent,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(`Upstream returned non-JSON (HTTP ${res.status})`);
    err.status = 502;
    throw err;
  }

  return { status: res.status, data };
}

function sendUpstreamError(res, err, label) {
  console.error(label, err.message);
  const status = err.status || 500;
  return res.status(status).json({ error: err.message || 'Request failed' });
}

async function handleCheckSlot(req, res) {
  const { outlet, date, time } = req.query;
  const missing = missingFields(['outlet', 'date', 'time'], {
    outlet,
    date,
    time,
  });

  if (missing.length) {
    return res.status(400).json({
      error: `Missing required query parameter(s): ${missing.join(', ')}`,
    });
  }

  const params = new URLSearchParams({ outlet, date, time });
  const url = `${UPSTREAM_API_BASE}/slots/check/?${params.toString()}`;

  try {
    const { status, data } = await upstreamJson('GET', url);
    return res.status(status).json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'slots/check:');
  }
}

// Legacy path → canonical (same query string)
app.get('/check-slot', (req, res) => {
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(307, '/slots/check' + q);
});

app.get('/slots/check', requireApiKey, handleCheckSlot);

async function handleBookAppointment(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const required = [
    'outlet',
    'date',
    'time',
    'customer_name',
    'customer_phone',
  ];
  const missing = missingFields(required, body);

  if (missing.length) {
    return res.status(400).json({
      error: `Missing required field(s) in JSON body: ${missing.join(', ')}`,
    });
  }

  const payload = {
    outlet: body.outlet,
    date: body.date,
    time: body.time,
    customer_name: body.customer_name,
    customer_phone: body.customer_phone,
  };

  const url = `${UPSTREAM_API_BASE}/bookings/`;

  try {
    const { status, data } = await upstreamJson('POST', url, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.status(status).json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'bookings:');
  }
}

app.post('/book-appointment', requireApiKey, handleBookAppointment);
app.post('/bookings', requireApiKey, handleBookAppointment);

app.get(
  '/messages/unsent-confirmations',
  requireApiKey,
  async (req, res) => {
    const url = `${UPSTREAM_API_BASE}/messages/unsent-confirmations/`;
    try {
      const { status, data } = await upstreamJson('GET', url);
      return res.status(status).json(data);
    } catch (err) {
      return sendUpstreamError(res, err, 'unsent-confirmations:');
    }
  }
);

app.get('/messages/unsent-reminders', requireApiKey, async (req, res) => {
  const url = `${UPSTREAM_API_BASE}/messages/unsent-reminders/`;
  try {
    const { status, data } = await upstreamJson('GET', url);
    return res.status(status).json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'unsent-reminders:');
  }
});

function apptIdFromQuery(req) {
  const q = req.query || {};
  const raw = q.appt_id ?? q.apptId ?? q.Appt_ID;
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

/** 5) Confirm — query: appt_id (or apptId, Appt_ID). Upstream: POST bookings/{id}/confirm/ */
app.post('/bookings/confirm', requireApiKey, async (req, res) => {
  const apptId = apptIdFromQuery(req);
  if (!apptId) {
    return res.status(400).json({
      error:
        'Missing required query parameter: appt_id (or apptId / Appt_ID)',
    });
  }

  const url = `${UPSTREAM_API_BASE}/bookings/${encodeURIComponent(
    apptId
  )}/confirm/`;

  try {
    const { status, data } = await upstreamJson('POST', url);
    return res.status(status).json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'booking confirm:');
  }
});

/** 6) Reschedule — query: appt_id, new_date & new_time (or newDate & newTime); JSON body also accepted. Upstream: POST bookings/{id}/reschedule/ */
app.post('/bookings/reschedule', requireApiKey, async (req, res) => {
  const apptId = apptIdFromQuery(req);
  if (!apptId) {
    return res.status(400).json({
      error:
        'Missing required query parameter: appt_id (or apptId / Appt_ID)',
    });
  }

  const q = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const new_date =
    body.new_date ??
    body.newDate ??
    q.new_date ??
    q.newDate;
  const new_time =
    body.new_time ??
    body.newTime ??
    q.new_time ??
    q.newTime;
  const missing = missingFields(['new_date', 'new_time'], {
    new_date,
    new_time,
  });

  if (missing.length) {
    return res.status(400).json({
      error:
        'Missing new_date and new_time: pass as query (?new_date=&new_time=) or JSON body (new_date/new_time or newDate/newTime)',
    });
  }

  const url = `${UPSTREAM_API_BASE}/bookings/${encodeURIComponent(
    apptId
  )}/reschedule/`;

  try {
    const { status, data } = await upstreamJson('POST', url, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_date, new_time }),
    });
    return res.status(status).json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'booking reschedule:');
  }
});

/** 7) Cancel — query: appt_id (or apptId, Appt_ID). Upstream: POST bookings/{id}/cancel/ */
app.post('/bookings/cancel', requireApiKey, async (req, res) => {
  const apptId = apptIdFromQuery(req);
  if (!apptId) {
    return res.status(400).json({
      error:
        'Missing required query parameter: appt_id (or apptId / Appt_ID)',
    });
  }

  const url = `${UPSTREAM_API_BASE}/bookings/${encodeURIComponent(
    apptId
  )}/cancel/`;

  try {
    const { status, data } = await upstreamJson('POST', url);
    return res.status(status).json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'booking cancel:');
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
  console.log(`Upstream: ${UPSTREAM_API_BASE}`);
  if (!API_KEY) {
    console.warn('Warning: API_KEY is not set. Set it in .env before calling the API.');
  }
});
