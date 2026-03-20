// AgentOS v2.1 — BULLETPROOF: phone matching, JSON limit, debug logs
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3001;

let supabase = null, anthropic = null;
if (SUPABASE_URL && SUPABASE_KEY) { const { createClient } = require('@supabase/supabase-js'); supabase = createClient(SUPABASE_URL, SUPABASE_KEY); }
if (ANTHROPIC_KEY) { const Anthropic = require('@anthropic-ai/sdk'); anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY }); }

// SMART PHONE MATCHING — tries every format
function normalizePhone(p) { return (p||'').replace(/[^0-9]/g, ''); }

async function findBiz(vapiPhone) {
  if (!supabase || !vapiPhone) return null;
  const raw = vapiPhone.trim();
  const d = normalizePhone(raw);
  const fmts = [...new Set([raw, '+'+d, d, '+1'+d.slice(-10), '1'+d.slice(-10), d.slice(-10)])];
  console.log('PHONE LOOKUP | Vapi sent:', raw, '| Trying:', fmts.join(', '));

  for (const f of fmts) {
    const { data } = await supabase.from('businesses').select('*').eq('vapi_phone', f).single();
    if (data) { console.log('MATCH:', f, '->', data.name); return data; }
  }

  // Last resort: compare last 10 digits of all businesses
  const { data: all } = await supabase.from('businesses').select('*');
  if (all && all.length > 0) {
    const last10 = d.slice(-10);
    for (const b of all) {
      if (normalizePhone(b.vapi_phone).slice(-10) === last10) { console.log('DIGIT MATCH:', b.name); return b; }
    }
    if (all.length === 1) { console.log('ONLY 1 BUSINESS, using:', all[0].name); return all[0]; }
  }
  console.log('NO MATCH FOUND for:', raw);
  return null;
}

function buildPrompt(biz, ch) {
  const modes = { phone:'PHONE. 1-2 sentences. Warm.', chat:'CHAT. 2-3 sentences.', sms:'SMS. Max 160 chars.', whatsapp:'WHATSAPP. Concise.', email:'EMAIL. Professional.' };
  return 'You are AI assistant for "'+biz.name+'". Name: "'+(biz.agent_name||'Assistant')+'". BUSINESS: '+(biz.type||'')+' in '+(biz.location||'')+'. HOURS: '+(biz.hours||'')+'. SERVICES: '+(biz.services||'')+'. PRICES: '+(biz.prices||'')+'. FAQ: '+(biz.faq||'')+'. BOOKING: '+(biz.booking_link||'Collect date/time')+'. PHONE: '+(biz.phone||'')+'. CHANNEL: '+(modes[ch]||modes.chat)+'. RULES: Only use info above. Guide to booking. Collect name+contact. Never say you are AI. Reply in customer language. UPSELL: Suggest ONE add-on naturally after booking.';
}

function extractLead(t) {
  if (!t) return {email:null,phone:null,name:null};
  return { email:(t.match(/[\w.-]+@[\w.-]+\.\w+/)||[])[0]||null, phone:(t.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/)||[])[0]||null, name:((t.match(/(?:my name is|i'm|i am|this is|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i))||[])[1]||null };
}

// ROUTES
app.get('/health', (req, res) => res.json({ status:'ok', v:'2.1', supabase:!!supabase, anthropic:!!anthropic }));
app.get('/', (req, res) => res.send('<h1>AgentOS v2.1</h1><p>Supabase: '+(supabase?'OK':'MISSING')+' | Anthropic: '+(anthropic?'OK':'MISSING')+'</p><p><a href="/debug/businesses">Debug: see businesses</a></p>'));
app.get('/debug/businesses', async (req, res) => { if(!supabase) return res.json({error:'no db'}); const {data}=await supabase.from('businesses').select('id,name,vapi_phone,phone,agent_name'); res.json(data||[]); });

// VOICE WEBHOOK
app.post('/api/voice/inbound', async (req, res) => {
  try {
    const { message, call } = req.body;
    console.log('=== VAPI ===', message?.type, '| Phone:', call?.phoneNumber?.number);

    if (message?.type === 'assistant-request') {
      const biz = await findBiz(call?.phoneNumber?.number);
      if (!biz) return res.json({ assistant: { firstMessage:"Thank you for calling. Our system is being set up. Please try again shortly.", model:{provider:'anthropic',model:'claude-sonnet-4-20250514',messages:[]}, voice:{provider:'11labs',voiceId:'EXAVITQu4vr4xnSDxMaL'} }});

      console.log('Returning assistant for:', biz.name);
      if(supabase) await supabase.from('conversations').insert({business_id:biz.id, conversation_id:'call_'+crypto.randomUUID().slice(0,12), channel:'phone', user_message:'[Inbound '+(call?.customer?.number||'?')+']', agent_reply:'[Started]', created_at:new Date().toISOString()});

      return res.json({ assistant: {
        firstMessage: biz.phone_greeting || 'Hi, thank you for calling '+biz.name+'! How can I help you?',
        model: { provider:'anthropic', model:'claude-sonnet-4-20250514', systemMessage:buildPrompt(biz,'phone'), temperature:0.7 },
        voice: { provider:'11labs', voiceId: biz.voice_id||'EXAVITQu4vr4xnSDxMaL' },
        endCallMessage:'Thanks for calling! Have a great day!', silenceTimeoutSeconds:30, maxDurationSeconds:600,
        functions: [
          {name:'bookAppointment',description:'Book appointment',parameters:{type:'object',properties:{customerName:{type:'string'},service:{type:'string'},preferredDate:{type:'string'},preferredTime:{type:'string'}},required:['customerName','service']}},
          {name:'transferToHuman',description:'Transfer to human',parameters:{type:'object',properties:{reason:{type:'string'}}}},
        ],
      }});
    }

    if (message?.type === 'function-call') {
      const fn=message.functionCall?.name, p=message.functionCall?.parameters||{};
      if(fn==='bookAppointment') return res.json({result:'Booked '+(p.customerName||'you')+' for '+(p.service||'appointment')+' on '+(p.preferredDate||'next available')+'. You are all set!'});
      if(fn==='transferToHuman') return res.json({result:'Transferring now.'});
      return res.json({result:'Done'});
    }

    if (message?.type === 'end-of-call-report' && supabase) {
      const biz = await findBiz(call?.phoneNumber?.number);
      if(biz) {
        await supabase.from('call_logs').insert({business_id:biz.id,call_id:call?.id,transcript:message.transcript||'',duration_seconds:message.durationSeconds||0,customer_phone:call?.customer?.number,created_at:new Date().toISOString()});
        const l=extractLead(message.transcript||'');
        if(l.name||l.phone||l.email) await supabase.from('leads').insert({business_id:biz.id,conversation_id:call?.id,name:l.name,phone:l.phone||call?.customer?.number,email:l.email,source:'phone',created_at:new Date().toISOString()});
      }
    }
    res.json({ok:true});
  } catch(e){ console.error('VOICE ERR:',e.message); res.json({ok:true}); }
});

// CHAT
app.post('/api/chat', async (req, res) => {
  if(!anthropic||!supabase) return res.status(503).json({error:'Not configured'});
  try {
    const {message,business_id,conversation_id,history=[],channel='chat'}=req.body;
    if(!message||!business_id) return res.status(400).json({error:'message+business_id required'});
    const {data:biz}=await supabase.from('businesses').select('*').eq('id',business_id).single();
    if(!biz) return res.status(404).json({error:'Business not found'});
    const cid=conversation_id||'conv_'+crypto.randomUUID().slice(0,12);
    const r=await anthropic.messages.create({model:'claude-sonnet-4-20250514',max_tokens:400,system:buildPrompt(biz,channel),messages:[...history.slice(-10).map(h=>({role:h.role,content:h.content})),{role:'user',content:message}]});
    const reply=r.content[0].text;
    await supabase.from('conversations').insert({business_id,conversation_id:cid,channel,user_message:message,agent_reply:reply,created_at:new Date().toISOString()});
    const l=extractLead(message); if(l.email||l.phone||l.name) await supabase.from('leads').upsert({business_id,conversation_id:cid,...l,source:channel,created_at:new Date().toISOString()},{onConflict:'conversation_id'});
    if(/also add|upgrade|premium|popular|many of our/i.test(reply)) await supabase.from('revenue_events').insert({business_id,conversation_id:cid,event_type:'upsell_attempted',channel,created_at:new Date().toISOString()});
    res.json({reply,conversation_id:cid});
  } catch(e){res.status(500).json({error:e.message})}
});

// SMS
app.post('/api/sms/inbound', async (req, res) => {
  if(!anthropic||!supabase) return res.type('text/xml').send('<Response><Message>Starting up.</Message></Response>');
  try {
    const {Body:msg,To:to}=req.body;
    const {data:biz}=await supabase.from('businesses').select('*').eq('phone',to).single();
    if(!biz) return res.type('text/xml').send('<Response><Message>Not active.</Message></Response>');
    const r=await anthropic.messages.create({model:'claude-sonnet-4-20250514',max_tokens:160,system:buildPrompt(biz,'sms'),messages:[{role:'user',content:msg}]});
    await supabase.from('conversations').insert({business_id:biz.id,conversation_id:'sms_'+crypto.randomUUID().slice(0,12),channel:'sms',user_message:msg,agent_reply:r.content[0].text,created_at:new Date().toISOString()});
    res.type('text/xml').send('<Response><Message>'+r.content[0].text+'</Message></Response>');
  } catch(e){res.type('text/xml').send('<Response><Message>Try later.</Message></Response>')}
});

// REVENUE
app.get('/api/revenue/report/:bid', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'No db'});
  try {
    const bid=req.params.bid, today=new Date().toISOString().split('T')[0], week=new Date(Date.now()-7*864e5).toISOString();
    const [tC,wC,tL,wL,tCl,ups]=await Promise.all([supabase.from('conversations').select('id',{count:'exact'}).eq('business_id',bid).gte('created_at',today+'T00:00:00'),supabase.from('conversations').select('channel',{count:'exact'}).eq('business_id',bid).gte('created_at',week),supabase.from('leads').select('*').eq('business_id',bid).gte('created_at',today+'T00:00:00'),supabase.from('leads').select('id',{count:'exact'}).eq('business_id',bid).gte('created_at',week),supabase.from('call_logs').select('duration_seconds').eq('business_id',bid).gte('created_at',today+'T00:00:00'),supabase.from('revenue_events').select('event_type').eq('business_id',bid).gte('created_at',week)]);
    const ch={};(wC.data||[]).forEach(c=>{ch[c.channel]=(ch[c.channel]||0)+1});
    res.json({today:{conversations:tC.count||0,leads:(tL.data||[]).length,call_min:Math.round((tCl.data||[]).reduce((s,c)=>s+(c.duration_seconds||0),0)/60)},week:{conversations:wC.count||0,leads:wL.count||0,channels:ch}});
  } catch(e){res.status(500).json({error:e.message})}
});

// BUSINESS + WAITLIST
app.post('/api/business/register', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'No db'});
  try {
    const b=req.body;
    const {data,error}=await supabase.from('businesses').insert({name:b.name,type:b.type,location:b.location,hours:b.hours,services:b.services,prices:b.prices,faq:b.faq,phone:b.phone,email:b.email,booking_link:b.booking_link,agent_name:b.agent_name||'Assistant',owner_email:b.owner_email,vapi_phone:b.vapi_phone,voice_id:b.voice_id,phone_greeting:b.phone_greeting||('Hi, thank you for calling '+b.name+'! How can I help?'),plan:'trial',created_at:new Date().toISOString()}).select().single();
    if(error) throw error;
    res.json({business_id:data.id});
  } catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/dashboard/:bid', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'No db'});
  try {
    const bid=req.params.bid;
    const [c,l,cl,r]=await Promise.all([supabase.from('conversations').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50),supabase.from('leads').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50),supabase.from('call_logs').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(20),supabase.from('revenue_events').select('*').eq('business_id',bid).order('created_at',{ascending:false}).limit(50)]);
    res.json({conversations:c.data||[],leads:l.data||[],calls:cl.data||[],revenue_events:r.data||[]});
  } catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/waitlist', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'No db'});
  try { const {email}=req.body; if(!email) return res.status(400).json({error:'Email required'}); const {error}=await supabase.from('waitlist').insert({email,created_at:new Date().toISOString()}); if(error?.code==='23505') return res.json({message:'Already joined!'}); if(error) throw error; res.json({message:'Welcome!'}); } catch(e){res.status(500).json({error:e.message})}
});

app.listen(PORT, () => console.log('\n=== AgentOS v2.1 on port '+PORT+' | DB:'+(supabase?'OK':'NO')+' | AI:'+(anthropic?'OK':'NO')+' ===\n'));
