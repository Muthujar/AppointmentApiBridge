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
  rejectUnauthorized: false,
});

const app = express();
app.use(express.json());

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
    return sendUpstreamError(res, err, 'check-slot:');
  }
}

app.get('/check-slot', requireApiKey, handleCheckSlot);
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
    return sendUpstreamError(res, err, 'book-appointment:');
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

app.post(
  '/bookings/:appt_id/confirm',
  requireApiKey,
  async (req, res) => {
    const apptId = (req.params.appt_id || '').trim();
    if (!apptId) {
      return res.status(400).json({ error: 'Missing or invalid appt_id' });
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
  }
);

app.post(
  '/bookings/:appt_id/reschedule',
  requireApiKey,
  async (req, res) => {
    const apptId = (req.params.appt_id || '').trim();
    if (!apptId) {
      return res.status(400).json({ error: 'Missing or invalid appt_id' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const new_date = body.new_date ?? body.newDate;
    const new_time = body.new_time ?? body.newTime;
    const missing = missingFields(['new_date', 'new_time'], {
      new_date,
      new_time,
    });

    if (missing.length) {
      return res.status(400).json({
        error:
          'Missing required field(s): new_date and new_time (or newDate and newTime)',
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
  }
);

app.post('/bookings/:appt_id/cancel', requireApiKey, async (req, res) => {
  const apptId = (req.params.appt_id || '').trim();
  if (!apptId) {
    return res.status(400).json({ error: 'Missing or invalid appt_id' });
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
