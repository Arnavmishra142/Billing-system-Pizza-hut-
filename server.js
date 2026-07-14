// Static file server + a small proxy endpoint for the Smart AI Manager chat.
// The Groq API key stays server-side (process.env.GROQ_API_KEY) and is never
// sent to the browser — unlike the old client-side Gemini key.
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Try the higher-quality model first; if its daily/rate quota is hit (429),
// automatically fall back to the higher-limit model so chat never just dies.
const PRIMARY_MODEL  = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

async function callGroq(model, prompt) {
    const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
        }),
    });
    return res;
}

app.post('/api/chat', async (req, res) => {
    if (!GROQ_KEY) {
        return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });
    }
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Missing "prompt" string in request body.' });
    }

    try {
        let model = PRIMARY_MODEL;
        let groqRes = await callGroq(model, prompt);

        if (groqRes.status === 429) {
            model = FALLBACK_MODEL;
            groqRes = await callGroq(model, prompt);
        }

        const data = await groqRes.json();
        if (!groqRes.ok) {
            return res.status(groqRes.status).json({ error: data.error?.message || 'Groq API error', details: data });
        }

        const reply = data.choices?.[0]?.message?.content || '';
        res.json({ reply, model });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Server error contacting Groq.' });
    }
});

// Static site
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
