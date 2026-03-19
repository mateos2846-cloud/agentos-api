// ═══════════════════════════════════════════════════════════
// AgentOS v2 — CRASH-PROOF VERSION
// ═══════════════════════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ══════════════════════════════════════════════════════════
// ENV CHECK — server starts even without keys (shows errors)
// ══════════════════════════════════════════════════════════
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3001;

console.log('--- AgentOS v2 Starting ---');
console.log('SUPABASE_URL set:', SUPABASE_URL ? 'YES (' + SUPABASE_URL.substring(0, 30) + '...)' : 'NO <<<< PROBLEM!');
console.log('SUPABASE_SERVICE_KEY set:', SUPABASE_KEY ? 'YES (length: ' + SUPABASE_KEY.length + ')' : 'NO <<<< PROBLEM!');
console.log('ANTHROPIC_API_KEY set:', ANTHROPIC_KEY ? 'YES (starts with: ' + ANTHROPIC_KEY.substring(0, 10) + '...)' : 'NO <<<< PROBLEM!');
console.log('PORT:', PORT);
console.log('---');

// Only create clients if keys exist
let supabase = null;
let anthropic = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('Supabase connected OK');
} else {
  console.log('WARNING: Supabase NOT connected - missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

if (ANTHROPIC_KEY) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
  console.log('Anthropic connected OK');
} else {
  console.log('WARNING: Anthropic NOT connected - missing ANTHROPIC_API_KEY');
}

// ── System Prompt ────────────────────────────────────────
function buildSystemPrompt(biz, channel) {
  const ch = {
    phone: 'PHONE. 1-2 sentences. Warm, natural. Never spell URLs.',
    chat: 'CHAT. 2-3 sentences. One emoji max.',
    whatsapp: 'WHATSAPP. Concise, friendly. Under 300 chars.',
    sms: 'SMS. Max 160 chars. No emoji.',
    email: 'EMAIL. Professional, warm. Detailed OK.',
  };
  return `You are AI assistant for "${biz.name}". Name: "${biz.agent_name || 'Assistant'}".
BUSINESS: ${biz.type || 'general'} in ${biz.location || 'N/A'}
HOURS: ${biz.hours || 'N/A'} | SERVICES: ${biz.services || 'N/A'} | PRICES: ${biz.prices || 'N/A'}
FAQ: ${biz.faq || 'N/A'} | BOOKING: ${biz.booking_link || 'Collect date/time'} | PHONE: ${biz.phone || 'N/A'}
CHANNEL: ${ch[channel] || ch.chat}
RULES: Only use info above. Guide to booking. Collect name+contact. Never say you are AI. Reply in customer language.
UPSELL: After basic booking suggest ONE add-on naturally. Max one per conversation.`;
}

function extractLead(text) {
  const email = text.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0] || null;
  const phone = text.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/)?.[0] || null;
  let name = null;
  const m = text.match(/(?:my name is|i'm|i am|this is|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (m) name = m[1].trim();
  return { email, phone, name };
}

// ══════════════════════════════════════════════════════════
// HEALTH CHECK — always works, shows what is connected
// ══════════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '2.0',
  supabase: supabase ? 'connected' : 'NOT CONNECTED - check SUPABASE_URL and SUPABASE_SERVICE_KEY',
  anthropic: anthropic ? 'connected' : 'NOT CONNECTED - check ANTHROPIC_API_KEY',
  channels: ['phone', 'chat', 'whatsapp', 'sms', 'email'],
}));

// Show all env var status at root
app.get('/', (req, res) => res.send(`
  <h1>AgentOS v2 is running!</h1>
  <p>Supabase: ${supabase ? '✅ Connected' : '❌ NOT connected (SUPABASE_URL or SUPABASE_SERVICE_KEY missing)'}</p>
  <p>Anthropic: ${anthropic ? '✅ Connected' : '❌ NOT connected (ANTHROPIC_API_KEY missing)'}</p>
  <p>Go to <a href="/health">/health</a> for JSON status.</p>
  <h3>Environment variables received:</h3>
  <ul>
    <li>SUPABASE_URL: ${SUPABASE_URL ? '✅ Set (' + SUPABASE_URL.substring(0, 25) + '...)' : '❌ MISSING'}</li>
    <li>SUPABASE_SERVICE_KEY: ${SUPABASE_KEY ? '✅ Set (length: ' + SUPABASE_KEY.length + ')' : '❌ MISSING'}</li>
    <li>ANTHROPIC_API_KEY: ${ANTHROPIC_KEY ? '✅ Set (starts: ' + ANTHROPIC_KEY.substring(0, 8) + '...)' : '❌ MISSING'}</li>
    <li>PORT: ${PORT}</li>
  </ul>
  <p><strong>If any show ❌, go to Railway Variables tab and add them.</strong></p>
`));

// ══════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY in Railway Variables.' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY in Railway Variables.' });

  try {
    const { message, business_id, conversation_id, history = [], channel = 'chat' } = req.body;
    if (!message || !business_id) return res.status(400).json({ error: 'message + business_id required' });

    const { data: biz } = await supabase.from('businesses').select('*').eq('id', business_id).single();
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const convId = conversation_id || 'conv_' + crypto.randomUUID().slice(0, 12);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 400,
      system: buildSystemPrompt(biz, channel),
      messages: [...history.slice(-10).map(h => ({ role: h.role, content: h.content })), { role: 'user', content: message }],
    });
    const reply = response.content[0].text;

    await supabase.from('conversations').insert({ business_id, conversation_id: convId, channel, user_message: message, agent_reply: reply, created_at: new Date().toISOString() });

    const lead = extractLead(message);
    if (lead.email || lead.phone || lead.name) {
      await supabase.from('leads').upsert({ business_id, conversation_id: convId, ...lead, source: channel, created_at: new Date().toISOString() }, { onConflict: 'conversation_id' });
    }

    if (/also add|upgrade|premium|popular|many of our/i.test(reply)) {
      await supabase.from('revenue_events').insert({ business_id, conversation_id: convId, event_type: 'upsell_attempted', channel, created_at: new Date().toISOString() });
    }

    res.json({ reply, conversation_id: convId });
  } catch (err) { console.error('Chat error:', err.message); res.status(500).json({ error: 'Chat failed: ' + err.message }); }
});

// ══════════════════════════════════════════════════════════
// VOICE — Vapi Webhook
// ══════════════════════════════════════════════════════════
app.post('/api/voice/inbound', async (req, res) => {
  try {
    const { message, call } = req.body;

    if (message?.type === 'assistant-request') {
      if (!supabase) return res.json({ assistant: { firstMessage: "Sorry, system is starting up. Please call back shortly.", model: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', messages: [] }, voice: { provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL' } } });

      const businessPhone = call?.phoneNumber?.number || '';
      const { data: biz } = await supabase.from('businesses').select('*').eq('vapi_phone', businessPhone).single();

      if (!biz) return res.json({ assistant: { firstMessage: "Sorry, we can't take your call right now.", model: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', messages: [] }, voice: { provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL' } } });

      await supabase.from('conversations').insert({ business_id: biz.id, conversation_id: 'call_' + crypto.randomUUID().slice(0,12), channel: 'phone', user_message: '[Inbound from ' + (call?.customer?.number||'unknown') + ']', agent_reply: '[Started]', created_at: new Date().toISOString() });

      return res.json({ assistant: {
        firstMessage: biz.phone_greeting || 'Hi, thank you for calling ' + biz.name + '! How can I help you?',
        model: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', systemMessage: buildSystemPrompt(biz, 'phone'), temperature: 0.7 },
        voice: { provider: '11labs', voiceId: biz.voice_id || 'EXAVITQu4vr4xnSDxMaL' },
        endCallMessage: 'Thanks for calling! Have a great day!',
        silenceTimeoutSeconds: 30, maxDurationSeconds: 600,
        functions: [
          { name: 'bookAppointment', description: 'Book appointment', parameters: { type: 'object', properties: { customerName: { type: 'string' }, service: { type: 'string' }, preferredDate: { type: 'string' }, preferredTime: { type: 'string' }, phone: { type: 'string' } }, required: ['customerName','service'] } },
          { name: 'transferToHuman', description: 'Transfer to human', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
        ],
      }});
    }

    if (message?.type === 'function-call') {
      const fn = message.functionCall?.name;
      const p = message.functionCall?.parameters || {};
      if (fn === 'bookAppointment') return res.json({ result: 'Booked: ' + p.customerName + ' for ' + p.service + ' on ' + (p.preferredDate||'TBD') + ' at ' + (p.preferredTime||'TBD') });
      if (fn === 'transferToHuman') return res.json({ result: 'Transferring now.' });
      return res.json({ result: 'Done' });
    }

    if (message?.type === 'end-of-call-report' && supabase) {
      const businessPhone = call?.phoneNumber?.number || '';
      const { data: biz } = await supabase.from('businesses').select('id').eq('vapi_phone', businessPhone).single();
      if (biz) {
        await supabase.from('call_logs').insert({ business_id: biz.id, call_id: call?.id, transcript: message.transcript || '', duration_seconds: message.durationSeconds || 0, customer_phone: call?.customer?.number, created_at: new Date().toISOString() });
        const lead = extractLead(message.transcript || '');
        if (lead.name || lead.phone || lead.email) {
          await supabase.from('leads').insert({ business_id: biz.id, conversation_id: call?.id, ...lead, phone: lead.phone || call?.customer?.number, source: 'phone', created_at: new Date().toISOString() });
        }
      }
    }

    res.json({ ok: true });
  } catch (err) { console.error('Voice error:', err.message); res.json({ ok: true }); }
});

// ══════════════════════════════════════════════════════════
// SMS — Twilio Webhook
// ══════════════════════════════════════════════════════════
app.post('/api/sms/inbound', async (req, res) => {
  if (!anthropic || !supabase) return res.type('text/xml').send('<Response><Message>System starting. Try again shortly.</Message></Response>');
  try {
    const { Body: msg, From: from, To: to } = req.body;
    const { data: biz } = await supabase.from('businesses').select('*').eq('phone', to).single();
    if (!biz) return res.type('text/xml').send('<Response><Message>This number is not active.</Message></Response>');
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 160, system: buildSystemPrompt(biz, 'sms'), messages: [{ role: 'user', content: msg }] });
    const reply = r.content[0].text;
    await supabase.from('conversations').insert({ business_id: biz.id, conversation_id: 'sms_' + crypto.randomUUID().slice(0,12), channel: 'sms', user_message: msg, agent_reply: reply, created_at: new Date().toISOString() });
    res.type('text/xml').send('<Response><Message>' + reply + '</Message></Response>');
  } catch (err) { res.type('text/xml').send('<Response><Message>Please try again later.</Message></Response>'); }
});

// ══════════════════════════════════════════════════════════
// REVENUE COPILOT
// ══════════════════════════════════════════════════════════
app.get('/api/revenue/report/:business_id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not connected' });
  try {
    const bid = req.params.business_id;
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
    const [tC, wC, tL, wL, tCl, ups] = await Promise.all([
      supabase.from('conversations').select('id', { count:'exact' }).eq('business_id', bid).gte('created_at', today+'T00:00:00'),
      supabase.from('conversations').select('channel', { count:'exact' }).eq('business_id', bid).gte('created_at', weekAgo),
      supabase.from('leads').select('*').eq('business_id', bid).gte('created_at', today+'T00:00:00'),
      supabase.from('leads').select('id', { count:'exact' }).eq('business_id', bid).gte('created_at', weekAgo),
      supabase.from('call_logs').select('duration_seconds').eq('business_id', bid).gte('created_at', today+'T00:00:00'),
      supabase.from('revenue_events').select('event_type').eq('business_id', bid).gte('created_at', weekAgo),
    ]);
    const channels = {}; (wC.data||[]).forEach(c => { channels[c.channel]=(channels[c.channel]||0)+1; });
    const uA = (ups.data||[]).filter(e => e.event_type==='upsell_attempted').length;
    const uC = (ups.data||[]).filter(e => e.event_type==='upsell_converted').length;
    res.json({ today: { conversations: tC.count||0, leads: (tL.data||[]).length, call_minutes: Math.round((tCl.data||[]).reduce((s,c)=>s+(c.duration_seconds||0),0)/60) }, week: { conversations: wC.count||0, leads: wL.count||0, channels, upsell_attempts: uA, upsell_conversions: uC } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════
// BUSINESS MANAGEMENT
// ══════════════════════════════════════════════════════════
app.post('/api/business/register', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not connected. Add SUPABASE_URL and SUPABASE_SERVICE_KEY.' });
  try {
    const b = req.body;
    const { data, error } = await supabase.from('businesses').insert({
      name: b.name, type: b.type, location: b.location, hours: b.hours, services: b.services, prices: b.prices, faq: b.faq,
      phone: b.phone, email: b.email, booking_link: b.booking_link, agent_name: b.agent_name || 'Assistant',
      owner_email: b.owner_email, vapi_phone: b.vapi_phone, voice_id: b.voice_id,
      phone_greeting: b.phone_greeting || ('Hi, thank you for calling ' + b.name + '! How can I help?'),
      plan: 'trial', created_at: new Date().toISOString(),
    }).select().single();
    if (error) throw error;
    res.json({ business_id: data.id, widget_code: '<script src="https://YOUR_DOMAIN/widget.js" data-business-id="' + data.id + '"></script>' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/:bid', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not connected' });
  try {
    const bid = req.params.bid;
    const [c,l,cl,r] = await Promise.all([
      supabase.from('conversations').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50),
      supabase.from('leads').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50),
      supabase.from('call_logs').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(20),
      supabase.from('revenue_events').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50),
    ]);
    res.json({ conversations:c.data||[], leads:l.data||[], calls:cl.data||[], revenue_events:r.data||[] });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/waitlist', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not connected' });
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const { error } = await supabase.from('waitlist').insert({ email, created_at: new Date().toISOString() });
    if (error?.code === '23505') return res.json({ message: 'Already on waitlist!' });
    if (error) throw error;
    res.json({ message: 'Welcome!' });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════════
// START — this will NEVER crash
// ══════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  AgentOS v2 running on port ' + PORT);
  console.log('  Supabase: ' + (supabase ? 'OK' : 'NOT CONNECTED'));
  console.log('  Anthropic: ' + (anthropic ? 'OK' : 'NOT CONNECTED'));
  console.log('========================================');
  console.log('');
  if (!supabase) console.log('>>> Add SUPABASE_URL and SUPABASE_SERVICE_KEY to Railway Variables to connect database');
  if (!anthropic) console.log('>>> Add ANTHROPIC_API_KEY to Railway Variables to enable AI');
});
