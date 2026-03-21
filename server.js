// ═══════════════════════════════════════════════════════════
// AgentOS v3 — Gmail + Vapi + Revenue Copilot
// Reads emails, analyzes calls, scores deal risk, suggests actions
// ═══════════════════════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { google } = require('googleapis');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const GMAIL_USER = process.env.GMAIL_USER || 'info@gamat.sk';
const PORT = process.env.PORT || 3001;

let supabase = null, anthropic = null, gmailClient = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}
if (ANTHROPIC_KEY) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
}

// ══════════════════════════════════════════════════════════
// GMAIL SETUP — Service Account with Domain-Wide Delegation
// ══════════════════════════════════════════════════════════
async function initGmail() {
  if (!GOOGLE_CREDENTIALS) { console.log('Gmail: NO CREDENTIALS — set GOOGLE_SERVICE_ACCOUNT_JSON'); return; }
  try {
    const creds = JSON.parse(GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      clientOptions: { subject: GMAIL_USER },
    });
    gmailClient = google.gmail({ version: 'v1', auth });
    // Test connection
    const profile = await gmailClient.users.getProfile({ userId: 'me' });
    console.log('Gmail: CONNECTED as', profile.data.emailAddress, '| Messages:', profile.data.messagesTotal);
  } catch(e) {
    console.log('Gmail: CONNECTION FAILED —', e.message);
    gmailClient = null;
  }
}

// Find Gmail label ID by name
async function findLabelId(labelName) {
  if (!gmailClient) return null;
  try {
    const res = await gmailClient.users.labels.list({ userId: 'me' });
    const label = (res.data.labels || []).find(l => l.name === labelName);
    if (label) { console.log('Gmail label "' + labelName + '" found, ID:', label.id); return label.id; }
    console.log('Gmail label "' + labelName + '" NOT FOUND. Vytvor ho v Gmaile.');
    return null;
  } catch(e) { console.error('Label lookup error:', e.message); return null; }
}

const GMAIL_LABEL = process.env.GMAIL_LABEL || 'AI Risk';
let labelId = null;

// Fetch ONLY emails with "AI Risk" label
async function fetchRecentEmails(maxResults = 20) {
  if (!gmailClient) return [];
  try {
    // Find label ID on first call
    if (!labelId) labelId = await findLabelId(GMAIL_LABEL);
    if (!labelId) { console.log('Label "' + GMAIL_LABEL + '" neexistuje — vytvor ho v Gmaile'); return []; }

    const res = await gmailClient.users.messages.list({ userId: 'me', maxResults, labelIds: [labelId] });
    const messages = res.data.messages || [];
    const emails = [];
    for (const msg of messages.slice(0, maxResults)) {
      try {
        const full = await gmailClient.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
        const headers = full.data.payload?.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';
        // Extract body
        let body = '';
        if (full.data.payload?.body?.data) {
          body = Buffer.from(full.data.payload.body.data, 'base64').toString('utf-8');
        } else if (full.data.payload?.parts) {
          const textPart = full.data.payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
        // Clean body — remove signatures, quoted text
        body = body.split(/\n--\s*\n/)[0].split(/\nOn .+ wrote:/)[0].trim().slice(0, 2000);

        emails.push({ id: msg.id, from, subject, date, body, snippet: full.data.snippet || '' });
      } catch(e) { /* skip unreadable emails */ }
    }
    return emails;
  } catch(e) { console.error('Gmail fetch error:', e.message); return []; }
}

// AI analyzes an email and generates FULL action plan with scripts
async function analyzeEmail(email, businessInfo) {
  if (!anthropic) return { risk_score: 50, summary: 'AI nie je pripojená', actions: [] };
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 2000,
      system: `Si Revenue Copilot pre firmu GAMAT (ploché strechy, hydroizolácie, zateplenie). Analyzuješ emaily od zákazníkov a vytváraš KOMPLETNÉ akčné plány s hotovými skriptami.

O FIRME: GAMAT s.r.o. — rodinná firma, 30+ rokov skúseností, 10 300 projektov, záruka 12-35 rokov, celá SR a ČR. Služby: hydroizolácia, zateplenie, oprava plochej strechy, zelená strecha, klampiarske práce, bleskozvod. Obhliadka a cenová ponuka zadarmo. Materiály z Talianska, Francúzska a Nemecka. Bezúročné splátky. Tel: 0911 90 91 91. Web: gamat.sk
${businessInfo || ''}

DÔLEŽITÉ: Vždy navrhuj najprv POCHOPENIE problému zákazníka, potom riešenie. Nikdy netlač obhliadku bez vysvetlenia prečo je potrebná.

Odpovedaj VŽDY v tomto JSON formáte (nič iné, žiadny markdown, žiadne backticky):
{
  "risk_score": číslo 0-100 (0=horúci lead, 100=stratený),
  "sentiment": "positive" alebo "neutral" alebo "negative",
  "summary": "1-2 vetové zhrnutie čo zákazník chce a aká je situácia",
  "customer_intent": "oprava/zateplenie/zelená strecha/cenová ponuka/reklamácia/otázka/iné",
  "urgency": "vysoká/stredná/nízka",
  "ai_analysis": "Detailná analýza situácie: prečo je riziko také aké je, čo zákazník naozaj potrebuje, na čo si dať pozor pri komunikácii. 3-5 viet.",
  "actions": [
    {
      "type": "email",
      "priority": "urgentný alebo normálny alebo follow-up",
      "title": "Krátky popis akcie",
      "why": "Prečo práve táto akcia a prečo teraz. 1-2 vety.",
      "when": "Kedy presne to urobiť",
      "script": "KOMPLETNÝ text emailovej odpovede po slovensky. Profesionálny ale priateľský. Obsahuje: oslovenie, reakciu na problém zákazníka, vysvetlenie čo GAMAT vie ponúknuť, návrh ďalšieho kroku (obhliadka), podpis. Minimálne 8-12 viet."
    },
    {
      "type": "phone",
      "priority": "urgentný alebo normálny alebo follow-up",
      "title": "Krátky popis akcie",
      "why": "Prečo volať a prečo teraz",
      "when": "Kedy zavolať",
      "script": "KOMPLETNÝ telefónny skript po slovensky. Obsahuje: pozdrav, dôvod hovoru, otázky na zákazníka, reakcie na rôzne odpovede (ak povie X → povedz Y), návrh obhliadky, zbieranie kontaktu, rozlúčka. Realistický dialóg s [ČAKAJ NA ODPOVEĎ] značkami."
    },
    {
      "type": "sms",
      "priority": "follow-up alebo záchranný",
      "title": "Krátky popis",
      "why": "Prečo SMS",
      "when": "Kedy poslať",
      "script": "Krátka SMS správa, max 300 znakov, po slovensky."
    }
  ]
}

Vždy vygeneruj 2-3 akcie (email + telefón, prípadne SMS). Skripty musia byť KOMPLETNÉ a POUŽITEĽNÉ — obchodník ich skopíruje a pošle/povie presne tak.`,
      messages: [{ role: 'user', content: `Analyzuj tento email a vytvor kompletný akčný plán s hotovými skriptami:

OD: ${email.from}
PREDMET: ${email.subject}
DÁTUM: ${email.date}
TEXT:
${email.body || email.snippet}` }],
    });

    const text = response.content[0].text;
    // Parse JSON safely
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed;
    }
    return { risk_score: 50, summary: text.slice(0, 200), suggestion: '', draft_reply: '' };
  } catch(e) {
    console.error('Email analysis error:', e.message);
    return { risk_score: 50, summary: 'Chyba pri analýze', suggestion: '', draft_reply: '' };
  }
}

// ══════════════════════════════════════════════════════════
// PHONE NUMBER MATCHING (from v2.1)
// ══════════════════════════════════════════════════════════
function normalizePhone(p) { return (p||'').replace(/[^0-9]/g, ''); }
async function findBiz(vapiPhone) {
  if (!supabase || !vapiPhone) return null;
  const d = normalizePhone(vapiPhone);
  const fmts = [...new Set([vapiPhone.trim(), '+'+d, d, '+1'+d.slice(-10), d.slice(-10)])];
  for (const f of fmts) {
    const { data } = await supabase.from('businesses').select('*').eq('vapi_phone', f).single();
    if (data) return data;
  }
  const { data: all } = await supabase.from('businesses').select('*');
  if (all?.length === 1) return all[0];
  if (all) for (const b of all) { if (normalizePhone(b.vapi_phone).slice(-10) === d.slice(-10)) return b; }
  return null;
}

function buildPrompt(biz, ch) {
  const modes = { phone:'PHONE. 1-2 vety. Príjemne.', chat:'CHAT. 2-3 vety.', sms:'SMS. Max 160 znakov.', email:'EMAIL. Profesionálne.' };
  return `Si AI asistent pre "${biz.name}". ${biz.services||''} ${biz.prices||''} ${biz.faq||''} Kanál: ${modes[ch]||modes.chat}. Odpovedaj po slovensky. Nasmeruj k obhliadke.`;
}

function extractLead(t) {
  if (!t) return {email:null,phone:null,name:null};
  return { email:(t.match(/[\w.-]+@[\w.-]+\.\w+/)||[])[0]||null, phone:(t.match(/(\+?[\d\s]{9,15})/)||[])[0]?.trim()||null, name:((t.match(/(?:volám sa|moje meno|my name is|i'm|som)\s+([A-ZÁ-Ž][a-zá-ž]+(?:\s+[A-ZÁ-Ž][a-zá-ž]+)?)/i))||[])[1]||null };
}

// ══════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({ status:'ok', v:'3.0', supabase:!!supabase, anthropic:!!anthropic, gmail:!!gmailClient }));
app.get('/', (req, res) => res.send(`<h1>AgentOS v3.0</h1><p>DB:${supabase?'✅':'❌'} AI:${anthropic?'✅':'❌'} Gmail:${gmailClient?'✅':'❌'}</p><p><a href="/debug/businesses">Firmy</a> | <a href="/api/emails/recent">Emaily</a></p>`));
app.get('/debug/businesses', async (req, res) => { if(!supabase) return res.json([]); const {data}=await supabase.from('businesses').select('id,name,vapi_phone,phone,agent_name'); res.json(data||[]); });

// ══════════════════════════════════════════════════════════
// GMAIL ENDPOINTS
// ══════════════════════════════════════════════════════════

// Get recent emails with AI analysis
app.get('/api/emails/recent', async (req, res) => {
  if (!gmailClient) return res.json({ error: 'Gmail nie je pripojený. Nastav GOOGLE_SERVICE_ACCOUNT_JSON.', emails: [], connected: false });
  try {
    const max = parseInt(req.query.max) || 10;
    const emails = await fetchRecentEmails(max);

    // Get business info for context
    let bizInfo = '';
    if (supabase) {
      const { data: biz } = await supabase.from('businesses').select('*').limit(1).single();
      if (biz) bizInfo = `Služby: ${biz.services}. Ceny: ${biz.prices}. FAQ: ${biz.faq}`;
    }

    // Analyze each email with AI
    const analyzed = [];
    for (const email of emails) {
      const analysis = await analyzeEmail(email, bizInfo);

      // Save to Supabase
      if (supabase) {
        const { data: biz } = await supabase.from('businesses').select('id').limit(1).single();
        if (biz) {
          await supabase.from('email_inbox').upsert({
            gmail_id: email.id, business_id: biz.id,
            from_address: email.from, subject: email.subject,
            body: email.body || email.snippet, date: email.date,
            risk_score: analysis.risk_score, sentiment: analysis.sentiment,
            ai_summary: analysis.summary,
            ai_suggestion: analysis.ai_analysis || analysis.suggestion || '',
            ai_draft_reply: JSON.stringify(analysis.actions || []),
            customer_intent: analysis.customer_intent,
            urgency: analysis.urgency,
            processed_at: new Date().toISOString(),
          }, { onConflict: 'gmail_id' });

          // Also create a lead if we can extract contact info
          const lead = extractLead(email.from + ' ' + email.body);
          if (lead.email || lead.name) {
            await supabase.from('leads').upsert({
              business_id: biz.id, conversation_id: 'email_' + email.id,
              email: lead.email || email.from.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0],
              name: lead.name || email.from.split('<')[0].trim().replace(/"/g,''),
              source: 'email', created_at: new Date().toISOString(),
            }, { onConflict: 'conversation_id' });
          }
        }
      }

      analyzed.push({ ...email, analysis });
    }

    res.json({ emails: analyzed, count: analyzed.length, connected: true });
  } catch(e) { res.status(500).json({ error: e.message, emails: [], connected: !!gmailClient }); }
});

// Get single email with full analysis
app.get('/api/emails/:id/analyze', async (req, res) => {
  if (!gmailClient) return res.status(503).json({ error: 'Gmail nie je pripojený' });
  try {
    const full = await gmailClient.users.messages.get({ userId: 'me', id: req.params.id, format: 'full' });
    const headers = full.data.payload?.headers || [];
    const email = {
      id: req.params.id,
      from: headers.find(h=>h.name==='From')?.value||'',
      subject: headers.find(h=>h.name==='Subject')?.value||'',
      date: headers.find(h=>h.name==='Date')?.value||'',
      body: '',
    };
    if (full.data.payload?.body?.data) email.body = Buffer.from(full.data.payload.body.data,'base64').toString('utf-8');
    else if (full.data.payload?.parts) {
      const tp = full.data.payload.parts.find(p=>p.mimeType==='text/plain');
      if (tp?.body?.data) email.body = Buffer.from(tp.body.data,'base64').toString('utf-8');
    }
    const analysis = await analyzeEmail(email);
    res.json({ email, analysis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get cached analyzed emails from Supabase
app.get('/api/emails/analyzed/:business_id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'No DB' });
  try {
    const { data } = await supabase.from('email_inbox').select('*').eq('business_id', req.params.business_id).order('processed_at', { ascending: false }).limit(50);
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
// VAPI WEBHOOK (calls → Revenue Copilot)
// ══════════════════════════════════════════════════════════
app.post('/api/voice/inbound', async (req, res) => {
  try {
    const { message, call } = req.body;
    console.log('VAPI:', message?.type, '|', call?.phoneNumber?.number);

    if (message?.type === 'assistant-request') {
      const biz = await findBiz(call?.phoneNumber?.number);
      if (!biz) return res.json({ assistant: { firstMessage:'Ďakujem že voláte. Skúste prosím neskôr.', model:{provider:'anthropic',model:'claude-sonnet-4-20250514',messages:[]}, voice:{provider:'11labs',voiceId:'EXAVITQu4vr4xnSDxMaL'} }});
      if(supabase) await supabase.from('conversations').insert({ business_id:biz.id, conversation_id:'call_'+crypto.randomUUID().slice(0,12), channel:'phone', user_message:'[Hovor od '+(call?.customer?.number||'?')+']', agent_reply:'[Začiatok]', created_at:new Date().toISOString() });
      return res.json({ assistant: {
        firstMessage: biz.phone_greeting || 'Dobrý deň, ďakujem že voláte '+biz.name+'. Ako vám môžem pomôcť?',
        model: { provider:'anthropic', model:'claude-sonnet-4-20250514', systemMessage:buildPrompt(biz,'phone'), temperature:0.7 },
        voice: { provider:'11labs', voiceId:biz.voice_id||'EXAVITQu4vr4xnSDxMaL' },
        endCallMessage:'Ďakujem za zavolanie! Pekný deň!', silenceTimeoutSeconds:30, maxDurationSeconds:600,
        functions: [
          {name:'bookAppointment',description:'Dohodnúť obhliadku',parameters:{type:'object',properties:{customerName:{type:'string'},service:{type:'string'},preferredDate:{type:'string'},phone:{type:'string'}},required:['customerName','service']}},
          {name:'transferToHuman',description:'Prepojenie na človeka',parameters:{type:'object',properties:{reason:{type:'string'}}}},
        ],
      }});
    }

    if (message?.type === 'function-call') {
      const fn=message.functionCall?.name, p=message.functionCall?.parameters||{};
      if(fn==='bookAppointment') return res.json({result:'Zapísané: '+p.customerName+' — '+p.service+', '+( p.preferredDate||'dohodne sa termín')+'. Náš technik vás bude kontaktovať.'});
      if(fn==='transferToHuman') return res.json({result:'Prepájam vás. Moment prosím.'});
      return res.json({result:'Hotovo'});
    }

    if (message?.type === 'end-of-call-report' && supabase) {
      const biz = await findBiz(call?.phoneNumber?.number);
      if(biz) {
        await supabase.from('call_logs').insert({
          business_id:biz.id, call_id:call?.id, transcript:message.transcript||'',
          duration_seconds:message.durationSeconds||0, customer_phone:call?.customer?.number,
          created_at:new Date().toISOString(),
        });
        // AI analyze the call transcript for Revenue Copilot
        if (anthropic && message.transcript) {
          try {
            const analysis = await anthropic.messages.create({
              model:'claude-sonnet-4-20250514', max_tokens:400,
              system:'Analyzuj prepis telefonátu firmy GAMAT (ploché strechy). Odpovedaj JSON: {"risk_score":0-100,"summary":"zhrnutie","customer_intent":"oprava/zateplenie/zelená/iné","next_action":"čo urobiť ďalej","sentiment":"positive/neutral/negative"}',
              messages:[{role:'user',content:message.transcript}],
            });
            const jsonMatch = analysis.content[0].text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              await supabase.from('revenue_events').insert({
                business_id:biz.id, conversation_id:call?.id,
                event_type:'call_analyzed', channel:'phone',
                details: parsed,
                created_at:new Date().toISOString(),
              });
            }
          } catch(e) { console.error('Call analysis error:', e.message); }
        }
        const lead = extractLead(message.transcript||'');
        if(lead.name||lead.phone||lead.email) await supabase.from('leads').insert({ business_id:biz.id, conversation_id:call?.id, name:lead.name, phone:lead.phone||call?.customer?.number, email:lead.email, source:'phone', created_at:new Date().toISOString() });
      }
    }

    res.json({ok:true});
  } catch(e){ console.error('VOICE:',e.message); res.json({ok:true}); }
});

// ══════════════════════════════════════════════════════════
// CHAT + SMS + REVENUE + BUSINESS (same as v2.1)
// ══════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  if(!anthropic||!supabase) return res.status(503).json({error:'Nie je nakonfigurované'});
  try {
    const {message,business_id,conversation_id,history=[],channel='chat'}=req.body;
    if(!message||!business_id) return res.status(400).json({error:'message+business_id povinné'});
    const {data:biz}=await supabase.from('businesses').select('*').eq('id',business_id).single();
    if(!biz) return res.status(404).json({error:'Firma nenájdená'});
    const cid=conversation_id||'conv_'+crypto.randomUUID().slice(0,12);
    const r=await anthropic.messages.create({model:'claude-sonnet-4-20250514',max_tokens:400,system:buildPrompt(biz,channel),messages:[...history.slice(-10).map(h=>({role:h.role,content:h.content})),{role:'user',content:message}]});
    const reply=r.content[0].text;
    await supabase.from('conversations').insert({business_id,conversation_id:cid,channel,user_message:message,agent_reply:reply,created_at:new Date().toISOString()});
    const l=extractLead(message); if(l.email||l.phone||l.name) await supabase.from('leads').upsert({business_id,conversation_id:cid,...l,source:channel,created_at:new Date().toISOString()},{onConflict:'conversation_id'});
    res.json({reply,conversation_id:cid});
  } catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/sms/inbound', async (req, res) => {
  if(!anthropic||!supabase) return res.type('text/xml').send('<Response><Message>Skúste neskôr.</Message></Response>');
  try {
    const {Body:msg,To:to}=req.body;
    const {data:biz}=await supabase.from('businesses').select('*').eq('phone',to).single();
    if(!biz) return res.type('text/xml').send('<Response><Message>Číslo neaktívne.</Message></Response>');
    const r=await anthropic.messages.create({model:'claude-sonnet-4-20250514',max_tokens:160,system:buildPrompt(biz,'sms'),messages:[{role:'user',content:msg}]});
    await supabase.from('conversations').insert({business_id:biz.id,conversation_id:'sms_'+crypto.randomUUID().slice(0,12),channel:'sms',user_message:msg,agent_reply:r.content[0].text,created_at:new Date().toISOString()});
    res.type('text/xml').send('<Response><Message>'+r.content[0].text+'</Message></Response>');
  } catch(e){res.type('text/xml').send('<Response><Message>Skúste neskôr.</Message></Response>')}
});

app.get('/api/revenue/report/:bid', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'Žiadna DB'});
  try {
    const bid=req.params.bid, today=new Date().toISOString().split('T')[0], week=new Date(Date.now()-7*864e5).toISOString();
    const [tC,wC,tL,wL,tCl,ups,emails]=await Promise.all([
      supabase.from('conversations').select('id',{count:'exact'}).eq('business_id',bid).gte('created_at',today+'T00:00:00'),
      supabase.from('conversations').select('channel',{count:'exact'}).eq('business_id',bid).gte('created_at',week),
      supabase.from('leads').select('*').eq('business_id',bid).gte('created_at',today+'T00:00:00'),
      supabase.from('leads').select('id',{count:'exact'}).eq('business_id',bid).gte('created_at',week),
      supabase.from('call_logs').select('duration_seconds').eq('business_id',bid).gte('created_at',today+'T00:00:00'),
      supabase.from('revenue_events').select('event_type,details').eq('business_id',bid).gte('created_at',week),
      supabase.from('email_inbox').select('*').eq('business_id',bid).order('processed_at',{ascending:false}).limit(10),
    ]);
    const ch={};(wC.data||[]).forEach(c=>{ch[c.channel]=(ch[c.channel]||0)+1});
    res.json({
      today:{conversations:tC.count||0,leads:(tL.data||[]).length,call_min:Math.round((tCl.data||[]).reduce((s,c)=>s+(c.duration_seconds||0),0)/60)},
      week:{conversations:wC.count||0,leads:wL.count||0,channels:ch},
      call_analyses:(ups.data||[]).filter(e=>e.event_type==='call_analyzed').map(e=>e.details),
      recent_emails:(emails.data||[]),
    });
  } catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/business/register', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'Žiadna DB'});
  try {
    const b=req.body;
    const {data,error}=await supabase.from('businesses').insert({name:b.name,type:b.type,location:b.location,hours:b.hours,services:b.services,prices:b.prices,faq:b.faq,phone:b.phone,email:b.email,booking_link:b.booking_link,agent_name:b.agent_name||'Asistent',owner_email:b.owner_email,vapi_phone:b.vapi_phone,voice_id:b.voice_id,phone_greeting:b.phone_greeting,plan:'trial',created_at:new Date().toISOString()}).select().single();
    if(error) throw error;
    res.json({business_id:data.id});
  } catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/dashboard/:bid', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'Žiadna DB'});
  try {
    const bid=req.params.bid;
    const [c,l,cl,r,em]=await Promise.all([
      supabase.from('conversations').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50),
      supabase.from('leads').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50),
      supabase.from('call_logs').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(20),
      supabase.from('revenue_events').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50),
      supabase.from('email_inbox').select('*').eq('business_id',bid).order('processed_at',{ascending:false}).limit(30),
    ]);
    res.json({conversations:c.data||[],leads:l.data||[],calls:cl.data||[],revenue_events:r.data||[],emails:em.data||[]});
  } catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/waitlist', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'Žiadna DB'});
  try { const {email}=req.body; if(!email) return res.status(400).json({error:'Email povinný'}); const {error}=await supabase.from('waitlist').insert({email,created_at:new Date().toISOString()}); if(error?.code==='23505') return res.json({message:'Už ste prihlásený!'}); if(error) throw error; res.json({message:'Vitajte!'}); } catch(e){res.status(500).json({error:e.message})}
});

// ══════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════
async function start() {
  await initGmail();
  app.listen(PORT, () => console.log(`\n=== AgentOS v3.0 | port ${PORT} | DB:${supabase?'OK':'NO'} | AI:${anthropic?'OK':'NO'} | Gmail:${gmailClient?'OK':'NO'} ===\n`));
}
start();
