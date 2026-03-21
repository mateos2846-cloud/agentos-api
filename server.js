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

        // Skip emails FROM our own domain (our replies to customers)
        const senderAddr = (from.match(/[\w.-]+@[\w.-]+\.\w+/) || [])[0] || '';
        const isOurEmail = ['gamat.sk','gamat.cz'].some(d => senderAddr.toLowerCase().endsWith(d));
        if (isOurEmail) continue; // skip our own outgoing emails

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
app.get('/', (req, res) => res.send(`<h1>AgentOS v3.0</h1><p>DB:${supabase?'✅':'❌'} AI:${anthropic?'✅':'❌'} Gmail:${gmailClient?'✅':'❌'}</p><p><a href="/dashboard">Dashboard</a> | <a href="/debug/businesses">Firmy</a></p>`));
app.get('/debug/businesses', async (req, res) => { if(!supabase) return res.json([]); const {data}=await supabase.from('businesses').select('id,name,vapi_phone,phone,agent_name'); res.json(data||[]); });

// ══════════════════════════════════════════════════════════
// DASHBOARD — served directly from server, no CORS issues
// ══════════════════════════════════════════════════════════
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="sk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>GAMAT Revenue Copilot</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',system-ui,sans-serif;background:#F5F4F0;color:#1A1614;line-height:1.6}
.nav{background:#1A1614;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:50;flex-wrap:wrap;gap:8px}
.nav-logo{font-size:20px;font-weight:800;color:#fff}
.nav-logo span{color:#E85D26}
.nav-badge{background:rgba(232,93,38,.2);color:#E85D26;padding:2px 10px;border-radius:100px;font-size:10px;font-weight:700}
.nav-tabs{display:flex;gap:3px;flex-wrap:wrap}
.tab-btn{padding:5px 12px;border-radius:8px;border:none;cursor:pointer;font-size:11px;font-weight:600;background:rgba(255,255,255,.08);color:rgba(255,255,255,.5);font-family:inherit}
.tab-btn.active{background:#E85D26;color:#fff}
.tab-btn .badge{background:#DC2626;color:#fff;padding:0 5px;border-radius:100px;font-size:9px;margin-left:4px}
.wrap{max-width:1200px;margin:0 auto;padding:20px}
.card{background:#fff;border-radius:14px;padding:18px 20px;border:1px solid rgba(0,0,0,.06)}
.grid{display:grid;gap:10px}
.grid-4{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.grid-2{grid-template-columns:1fr 1fr}
.grid-split{grid-template-columns:340px 1fr;align-items:start}
.stat-n{font-size:11px;color:#9A918B}
.stat-v{font-size:28px;font-weight:800;letter-spacing:-1px}
.btn{padding:8px 16px;border-radius:8px;border:1px solid rgba(0,0,0,.1);background:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit}
.btn-primary{background:#E85D26;color:#fff;border-color:#E85D26}
.btn:disabled{opacity:.5}
.risk-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:100px;font-size:11px;font-weight:700}
.risk-low{background:#ECFDF5;color:#059669}.risk-med{background:#FFFBEB;color:#D97706}.risk-high{background:#FEF2F2;color:#DC2626}
.email-item{background:#fff;border:1px solid rgba(0,0,0,.06);border-radius:12px;padding:12px 14px;cursor:pointer;margin-bottom:6px}
.email-item.sel{background:#FFF7F4;border:2px solid #E85D26}
.action-card{background:#fff;border:1px solid rgba(0,0,0,.06);border-radius:14px;overflow:hidden;margin-bottom:8px}
.action-header{padding:12px 16px;cursor:pointer;display:flex;align-items:flex-start;gap:10px}
.action-body{border-top:1px solid rgba(0,0,0,.06)}
.action-why{padding:12px 16px;background:#FFFBEB;border-bottom:1px solid rgba(0,0,0,.04)}
.action-script{padding:12px 16px}
.script-box{background:#FAFAF8;border-radius:10px;padding:14px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.8;color:#3D3D3A;white-space:pre-wrap;max-height:400px;overflow-y:auto}
.pri{padding:2px 8px;border-radius:100px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.empty{text-align:center;padding:40px}
.empty-icon{font-size:36px;margin-bottom:12px}
.empty-title{font-size:16px;font-weight:700;margin-bottom:6px}
.empty-text{font-size:13px;color:#9A918B;max-width:450px;margin:0 auto;line-height:1.7}
.ai-box{background:linear-gradient(135deg,#FFF7F4,#FEF3C7);border:1.5px solid #E85D26;border-radius:16px;padding:18px}
.loading{text-align:center;padding:32px}
.err{padding:12px;background:#FEF2F2;border-radius:10px;color:#DC2626;font-size:13px;margin-bottom:14px}
.ch-icon{font-size:13px}
.convo-user{background:#F5F4F0;border-radius:8px;padding:10px;margin-bottom:6px}
.convo-ai{background:#FFF7F4;border-radius:8px;padding:10px}
@media(max-width:768px){.grid-split{grid-template-columns:1fr}.grid-2{grid-template-columns:1fr}}
</style></head><body>
<div class="nav">
  <div style="display:flex;align-items:center;gap:10px">
    <span class="nav-logo">GAMAT <span>Revenue Copilot</span></span>
  </div>
  <div class="nav-tabs" id="tabs"></div>
</div>
<div class="wrap" id="content"></div>

<script>
const API='';
let bizId='',businesses=[],tab='setup',emails=[],convos=[],leads=[],calls=[];
let emailLoading=false,loading=false,selEmail=null,error='';

function h(tag,props,...kids){const el=document.createElement(tag);if(props)Object.entries(props).forEach(([k,v])=>{if(k==='onclick')el.onclick=v;else if(k==='className')el.className=v;else if(k==='innerHTML')el.innerHTML=v;else if(k==='style'&&typeof v==='object')Object.assign(el.style,v);else el.setAttribute(k,v)});kids.flat().forEach(c=>{if(typeof c==='string')el.appendChild(document.createTextNode(c));else if(c)el.appendChild(c)});return el}

function riskBadge(s){s=parseInt(s)||50;const c=s<30?'low':s<60?'med':'high';const l=s<30?'Nízke':s<60?'Stredné':'Vysoké';return h('span',{className:'risk-badge risk-'+c},h('span',{style:{width:'5px',height:'5px',borderRadius:'50%',background:s<30?'#059669':s<60?'#D97706':'#DC2626',display:'inline-block'}}),l+' '+s+'%')}

function timeAgo(d){if(!d)return'—';const m=Math.floor((Date.now()-new Date(d).getTime())/60000);if(m<1)return'teraz';if(m<60)return'pred '+m+'min';const hr=Math.floor(m/60);if(hr<24)return'pred '+hr+'h';return'pred '+Math.floor(hr/24)+'d'}

function chIcon(t){return({'phone':'📞','chat':'💬','sms':'📱','email':'📧','task':'📋'})[t]||'💬'}

function priColor(p){return({'urgentný':'#DC2626','urgent':'#DC2626','normálny':'#059669','normal':'#059669','follow-up':'#D97706','záchranný':'#9333EA'})[p]||'#5C5652'}

async function fetchBiz(){try{const r=await fetch(API+'/debug/businesses');const d=await r.json();businesses=Array.isArray(d)?d:d.businesses||[];render()}catch(e){businesses=[];render()}}

async function fetchData(){if(!bizId)return;loading=true;render();try{const dr=await fetch(API+'/api/dashboard/'+bizId);const dash=await dr.json();convos=dash.conversations||[];leads=dash.leads||[];calls=dash.calls||[];if(dash.emails?.length){emails=dash.emails.map(e=>({...e,analysis:e.analysis||{risk_score:e.risk_score,summary:e.ai_summary,ai_analysis:e.ai_suggestion,customer_intent:e.customer_intent,urgency:e.urgency,actions:(()=>{try{return JSON.parse(e.ai_draft_reply||'[]')}catch(x){return[]}})()}}))}if(tab==='setup')tab='emails';error=''}catch(e){error='Chyba: '+e.message}loading=false;render()}

async function fetchEmails(){emailLoading=true;render();try{const r=await fetch(API+'/api/emails/recent?max=10');const d=await r.json();if(d.error){error='Gmail: '+d.error}else if(d.emails?.length){emails=d.emails;selEmail=null}else{error='Žiadne emaily so štítkom "AI Risk" v Gmaile. Označ nejaké emaily týmto štítkom a skús znova.'}}catch(e){error='Gmail: '+e.message}emailLoading=false;render()}

function setTab(t){tab=t;selEmail=null;render()}

function render(){
  const tabs=document.getElementById('tabs');
  const content=document.getElementById('content');
  tabs.innerHTML='';content.innerHTML='';

  const allTabs=bizId?['emails','overview','leads','convos','calls','setup']:['setup'];
  const tabNames={emails:'Emaily & Skripty',overview:'Prehľad',leads:'Leady',convos:'Konverzácie',calls:'Hovory',setup:'Nastavenia'};
  allTabs.forEach(t=>{const b=h('button',{className:'tab-btn'+(tab===t?' active':''),onclick:()=>setTab(t)},tabNames[t]);
    if(t==='emails'&&emails.filter(e=>(e.analysis?.risk_score??e.risk_score??50)>=60).length>0){const badge=h('span',{className:'badge'},String(emails.filter(e=>(e.analysis?.risk_score??e.risk_score??50)>=60).length));b.appendChild(badge)}
    tabs.appendChild(b)});

  if(error){const err=h('div',{className:'err'},error,' ',h('button',{onclick:()=>{error='';render()},style:{background:'none',border:'none',color:'#DC2626',cursor:'pointer',fontWeight:'700'}},'\u2715'));content.appendChild(err)}

  if(tab==='setup')renderSetup(content);
  else if(tab==='emails')renderEmails(content);
  else if(tab==='overview')renderOverview(content);
  else if(tab==='leads')renderLeads(content);
  else if(tab==='convos')renderConvos(content);
  else if(tab==='calls')renderCalls(content);
}

function renderSetup(el){
  const wrap=h('div',{style:{maxWidth:'500px'}});
  wrap.appendChild(h('h2',{style:{fontSize:'22px',fontWeight:'800',marginBottom:'6px'}},'Nastavenie'));
  wrap.appendChild(h('p',{style:{color:'#9A918B',fontSize:'14px',marginBottom:'20px'}},'Vyber firmu a načítaj dáta.'));

  const card1=h('div',{className:'card',style:{marginBottom:'14px'}});
  card1.appendChild(h('div',{style:{fontSize:'11px',fontWeight:'700',color:'#9A918B',textTransform:'uppercase',letterSpacing:'1px',marginBottom:'8px'}},'Firma'));
  const loadBtn=h('button',{className:'btn',onclick:fetchBiz},'Načítať firmy');
  card1.appendChild(loadBtn);
  if(businesses.length){businesses.forEach(b=>{
    const item=h('div',{onclick:()=>{bizId=b.id;render()},style:{padding:'10px 14px',borderRadius:'10px',cursor:'pointer',marginTop:'6px',border:bizId===b.id?'2px solid #E85D26':'1px solid rgba(0,0,0,.08)',background:bizId===b.id?'#FFF7F4':'#fff'}});
    item.appendChild(h('div',{style:{fontWeight:'700',fontSize:'14px'}},b.name));
    item.appendChild(h('div',{style:{fontSize:'11px',color:'#9A918B'}},''+(b.agent_name||'')+' | '+(b.vapi_phone||'bez tel.')));
    card1.appendChild(item)})}
  else{card1.appendChild(h('div',{style:{padding:'16px',background:'#F5F4F0',borderRadius:'10px',fontSize:'13px',color:'#9A918B',textAlign:'center',marginTop:'8px'}},'Klikni "Načítať firmy"'))}
  wrap.appendChild(card1);

  if(bizId){const go=h('button',{className:'btn btn-primary',style:{width:'100%',padding:'14px',fontSize:'15px',fontWeight:'700'},onclick:fetchData},loading?'Načítavam...':'Pripojiť a načítať dáta');wrap.appendChild(go)}
  el.appendChild(wrap);
}

function renderEmails(el){
  const header=h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'14px',flexWrap:'wrap',gap:'8px'}});
  header.appendChild(h('h2',{style:{fontSize:'20px',fontWeight:'800'}},'Emaily & AI Skripty'));
  const btns=h('div',{style:{display:'flex',gap:'6px'}});
  const loadBtn=h('button',{className:'btn btn-primary',onclick:fetchEmails,disabled:emailLoading},emailLoading?'Analyzujem...':'Načítať nové z Gmail');
  btns.appendChild(loadBtn);
  btns.appendChild(h('button',{className:'btn',onclick:fetchData},'Obnoviť'));
  header.appendChild(btns);
  el.appendChild(header);

  if(emailLoading){const ld=h('div',{className:'card loading'});ld.appendChild(h('div',{style:{fontSize:'24px',marginBottom:'8px'}},'🤖'));ld.appendChild(h('div',{style:{fontSize:'14px',fontWeight:'600',color:'#E85D26'}},'AI analyzuje emaily zo štítku "AI Risk"...'));ld.appendChild(h('div',{style:{fontSize:'12px',color:'#9A918B',marginTop:'4px'}},'Pre každý email sa generujú kompletné skripty. Môže to trvať 30-60 sekúnd.'));el.appendChild(ld);return}

  if(!emails.length){const emp=h('div',{className:'card empty'});emp.appendChild(h('div',{className:'empty-icon'},'📧'));emp.appendChild(h('div',{className:'empty-title'},'Zatiaľ žiadne analyzované emaily'));emp.appendChild(h('div',{className:'empty-text',innerHTML:'1. Otvor Gmail (info@gamat.sk)<br>2. Označ emaily od zákazníkov štítkom <strong>"AI Risk"</strong><br>3. Klikni <strong>"Načítať nové z Gmail"</strong> vyššie'}));el.appendChild(emp);return}

  const grid=h('div',{className:'grid grid-split'});
  const list=h('div',{style:{display:'flex',flexDirection:'column',maxHeight:'calc(100vh - 200px)',overflowY:'auto'}});

  emails.forEach((em,i)=>{
    const id=em.id||em.gmail_id||i;
    const risk=em.analysis?.risk_score??em.risk_score??50;
    const item=h('div',{className:'email-item'+(selEmail===id?' sel':''),onclick:()=>{selEmail=id;render()}});
    const top=h('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:'4px'}});
    const left=h('div',{style:{flex:'1',minWidth:'0'}});
    left.appendChild(h('div',{style:{fontWeight:'700',fontSize:'13px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},em.from_address||em.from||'Neznámy'));
    left.appendChild(h('div',{style:{fontSize:'11px',color:'#9A918B',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},em.subject||'(bez predmetu)'));
    top.appendChild(left);
    top.appendChild(riskBadge(risk));
    item.appendChild(top);
    const meta=h('div',{style:{display:'flex',gap:'6px',alignItems:'center',fontSize:'11px',color:'#9A918B'}},timeAgo(em.processed_at||em.date));
    const actions=em.analysis?.actions||[];
    if(!actions.length&&em.ai_draft_reply){try{const p=JSON.parse(em.ai_draft_reply);if(p.length)actions.push(...p)}catch(e){}}
    if(actions.length){meta.appendChild(h('span',{style:{color:'#E85D26',fontWeight:'600',marginLeft:'auto'}},actions.length+' AI akci'+(actions.length===1?'a':actions.length<5?'e':'í')))}
    item.appendChild(meta);
    list.appendChild(item);
  });
  grid.appendChild(list);

  const detail=h('div',{style:{background:'#FAFAF8',borderRadius:'16px',padding:'16px',minHeight:'400px',border:'1px solid rgba(0,0,0,.04)'}});
  const selData=emails.find(e=>(e.id||e.gmail_id)===selEmail);
  if(!selData){detail.appendChild(h('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:'300px',color:'#9A918B',fontSize:'14px'}},'Vyber email z ľavej strany'))}
  else{renderEmailDetail(detail,selData)}
  grid.appendChild(detail);
  el.appendChild(grid);
}

function renderEmailDetail(el,email){
  const analysis=email.analysis||{};
  const risk=analysis.risk_score??email.risk_score??50;
  const summary=analysis.summary||email.ai_summary||'';
  const aiText=analysis.ai_analysis||email.ai_suggestion||'';
  const intent=analysis.customer_intent||email.customer_intent||'';

  let actions=analysis.actions||[];
  if(!actions.length&&email.ai_draft_reply){try{actions=JSON.parse(email.ai_draft_reply)}catch(e){}}

  // AI Analysis
  const aiBox=h('div',{className:'ai-box',style:{marginBottom:'14px'}});
  const badges=h('div',{style:{display:'flex',alignItems:'center',gap:'6px',marginBottom:'8px',flexWrap:'wrap'}});
  badges.appendChild(h('span',{style:{background:'#E85D26',color:'#fff',padding:'2px 10px',borderRadius:'100px',fontSize:'10px',fontWeight:'700',letterSpacing:'1px',textTransform:'uppercase'}},'AI Analýza'));
  badges.appendChild(riskBadge(risk));
  if(intent)badges.appendChild(h('span',{style:{padding:'2px 8px',borderRadius:'100px',background:'rgba(37,99,235,.1)',color:'#2563EB',fontSize:'10px',fontWeight:'600'}},intent));
  aiBox.appendChild(badges);
  if(summary)aiBox.appendChild(h('div',{style:{fontSize:'14px',fontWeight:'600',color:'#1A1614',marginBottom:'6px'}},summary));
  if(aiText)aiBox.appendChild(h('div',{style:{fontSize:'13px',color:'#5C5652',lineHeight:'1.7'}},aiText));
  el.appendChild(aiBox);

  // Original email
  const emailCard=h('div',{className:'card',style:{marginBottom:'14px'}});
  emailCard.appendChild(h('div',{style:{fontSize:'10px',fontWeight:'700',color:'#9A918B',textTransform:'uppercase',letterSpacing:'1px',marginBottom:'8px'}},'Pôvodný email'));
  const meta=h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'8px',marginBottom:'10px',fontSize:'12px'}});
  meta.appendChild(h('div',{innerHTML:'<span style="color:#9A918B">Od:</span> <strong>'+(email.from_address||email.from||'?')+'</strong>'}));
  meta.appendChild(h('div',{innerHTML:'<span style="color:#9A918B">Dátum:</span> <strong>'+(email.date||'?')+'</strong>'}));
  emailCard.appendChild(meta);
  emailCard.appendChild(h('div',{style:{fontWeight:'600',fontSize:'13px',marginBottom:'6px'}},email.subject||''));
  emailCard.appendChild(h('div',{style:{background:'#F5F4F0',borderRadius:'8px',padding:'12px',fontSize:'12.5px',color:'#5C5652',lineHeight:'1.6',maxHeight:'200px',overflowY:'auto',whiteSpace:'pre-wrap'}},email.body||email.snippet||'(prázdny)'));
  el.appendChild(emailCard);

  // Actions
  if(actions.length){
    el.appendChild(h('div',{style:{fontSize:'10px',fontWeight:'700',color:'#E85D26',textTransform:'uppercase',letterSpacing:'1px',marginBottom:'8px',paddingLeft:'4px'}},'Akčný plán — '+actions.length+(actions.length===1?' krok':' krokov')));
    actions.forEach(a=>el.appendChild(renderAction(a)));
  }
}

function renderAction(action){
  const card=h('div',{className:'action-card'});
  const isOpen={v:false};
  const body=h('div',{className:'action-body',style:{display:'none'}});
  const arrow=h('span',{style:{fontSize:'16px',color:'#9A918B',transition:'transform .2s',flexShrink:'0'}},'▾');

  const header=h('div',{className:'action-header',onclick:()=>{isOpen.v=!isOpen.v;body.style.display=isOpen.v?'block':'none';arrow.style.transform=isOpen.v?'rotate(180deg)':'none'}});
  header.appendChild(h('span',{style:{fontSize:'13px'}},chIcon(action.type)));
  const info=h('div',{style:{flex:'1'}});
  const top=h('div',{style:{display:'flex',gap:'6px',alignItems:'center',flexWrap:'wrap',marginBottom:'3px'}});
  const pc=priColor(action.priority);
  top.appendChild(h('span',{className:'pri',style:{background:pc+'18',color:pc}},action.priority||''));
  top.appendChild(h('span',{style:{fontSize:'13px',fontWeight:'700'}},action.title||''));
  info.appendChild(top);
  if(action.when)info.appendChild(h('div',{style:{fontSize:'11px',color:'#9A918B'}},'⏰ '+action.when));
  header.appendChild(info);
  header.appendChild(arrow);
  card.appendChild(header);

  if(action.why){const why=h('div',{className:'action-why'});why.appendChild(h('div',{style:{fontSize:'10px',fontWeight:'700',color:'#92400E',textTransform:'uppercase',letterSpacing:'1px',marginBottom:'3px'}},'Prečo táto akcia'));why.appendChild(h('div',{style:{fontSize:'13px',color:'#78350F',lineHeight:'1.6'}},action.why));body.appendChild(why)}

  const scriptDiv=h('div',{className:'action-script'});
  const scriptHeader=h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px'}});
  const typeLabel=action.type==='task'?'Akčný plán':action.type==='phone'?'Telefónny skript':action.type==='email'?'Emailový skript':'SMS správa';
  scriptHeader.appendChild(h('span',{style:{fontSize:'10px',fontWeight:'700',color:'#E85D26',textTransform:'uppercase',letterSpacing:'1px'}},typeLabel));
  scriptHeader.appendChild(h('button',{className:'btn',style:{fontSize:'10px',padding:'3px 10px'},onclick:(e)=>{e.stopPropagation();navigator.clipboard.writeText(action.script||'')}},'Kopírovať'));
  scriptDiv.appendChild(scriptHeader);
  scriptDiv.appendChild(h('div',{className:'script-box'},action.script||''));
  body.appendChild(scriptDiv);
  card.appendChild(body);
  return card;
}

function renderOverview(el){
  const today=new Date().toISOString().split('T')[0];
  const tC=convos.filter(c=>c.created_at?.startsWith(today)).length;
  const tL=leads.filter(l=>l.created_at?.startsWith(today)).length;
  const tM=Math.round(calls.reduce((s,c)=>s+(c.duration_seconds||0),0)/60);

  const stats=h('div',{className:'grid grid-4',style:{marginBottom:'14px'}});
  [['Konverzácie dnes',tC,''],['Nové leady',tL,'#059669'],['Min. hovorov',tM,''],['Emaily',emails.length,'#E85D26']].forEach(([l,v,c])=>{
    const s=h('div',{className:'card'});s.appendChild(h('div',{className:'stat-n'},l));s.appendChild(h('div',{className:'stat-v',style:{color:c||'#1A1614'}},String(v)));stats.appendChild(s)});
  el.appendChild(stats);

  const chCount={};convos.forEach(c=>{chCount[c.channel]=(chCount[c.channel]||0)+1});
  if(Object.keys(chCount).length){const chCard=h('div',{className:'card'});chCard.appendChild(h('div',{style:{fontSize:'10px',fontWeight:'700',color:'#9A918B',textTransform:'uppercase',letterSpacing:'1px',marginBottom:'12px'}},'Kanály'));
  const max=Math.max(...Object.values(chCount));
  Object.entries(chCount).sort((a,b)=>b[1]-a[1]).forEach(([ch,n])=>{const row=h('div',{style:{display:'flex',alignItems:'center',gap:'10px',marginBottom:'6px'}});row.appendChild(h('span',{style:{fontSize:'13px'}},chIcon(ch)));row.appendChild(h('span',{style:{fontSize:'12px',fontWeight:'600',width:'55px',textTransform:'capitalize'}},ch));const bar=h('div',{style:{flex:'1',height:'6px',background:'#F5F4F0',borderRadius:'3px'}});const fill=h('div',{style:{height:'100%',width:Math.max(4,n/max*100)+'%',background:({phone:'#E85D26',chat:'#2563EB',sms:'#059669',email:'#D97706'})[ch]||'#9A918B',borderRadius:'3px'}});bar.appendChild(fill);row.appendChild(bar);row.appendChild(h('span',{style:{fontSize:'12px',fontWeight:'600',width:'28px',textAlign:'right'}},String(n)));chCard.appendChild(row)});
  el.appendChild(chCard)}
}

function renderLeads(el){
  el.appendChild(h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'14px'}},h('h2',{style:{fontSize:'20px',fontWeight:'800'}},'Leady ('+leads.length+')'),h('button',{className:'btn',onclick:fetchData},'Obnoviť')));
  if(!leads.length){const emp=h('div',{className:'card empty'});emp.appendChild(h('div',{className:'empty-icon'},'🎯'));emp.appendChild(h('div',{className:'empty-title'},'Zatiaľ žiadne leady'));el.appendChild(emp);return}
  leads.forEach(l=>{const risk=Math.min(100,Math.max(0,Math.floor((Date.now()-new Date(l.created_at||0).getTime())/(1000*3600*24)*15)));
    const card=h('div',{className:'card',style:{marginBottom:'8px',borderLeft:'3px solid '+(risk<30?'#059669':risk<60?'#D97706':'#DC2626')}});
    const top=h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}});
    const left=h('div');left.appendChild(h('div',{style:{fontWeight:'700',fontSize:'15px'}},l.name||'Neznámy'));
    const meta=h('div',{style:{fontSize:'12px',color:'#9A918B',marginTop:'2px'}});
    if(l.phone)meta.appendChild(h('span',{},'📞 '+l.phone+' '));if(l.email)meta.appendChild(h('span',{},'📧 '+l.email+' '));
    left.appendChild(meta);top.appendChild(left);
    const right=h('div',{style:{textAlign:'right'}});right.appendChild(riskBadge(risk));right.appendChild(h('div',{style:{fontSize:'11px',color:'#9A918B',marginTop:'4px'}},timeAgo(l.created_at)));
    top.appendChild(right);card.appendChild(top);el.appendChild(card)});
}

function renderConvos(el){
  el.appendChild(h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'14px'}},h('h2',{style:{fontSize:'20px',fontWeight:'800'}},'Konverzácie ('+convos.length+')'),h('button',{className:'btn',onclick:fetchData},'Obnoviť')));
  if(!convos.length){const emp=h('div',{className:'card empty'});emp.appendChild(h('div',{className:'empty-icon'},'💬'));emp.appendChild(h('div',{className:'empty-title'},'Zatiaľ žiadne konverzácie'));el.appendChild(emp);return}
  convos.forEach(c=>{const card=h('div',{className:'card',style:{marginBottom:'6px',padding:'14px 18px'}});
    card.appendChild(h('div',{style:{display:'flex',alignItems:'center',gap:'8px',marginBottom:'8px'}},h('span',{},chIcon(c.channel)),h('span',{style:{fontSize:'11px',fontWeight:'600',textTransform:'capitalize',color:'#5C5652'}},c.channel),h('span',{style:{fontSize:'11px',color:'#9A918B'}},timeAgo(c.created_at))));
    const u=h('div',{className:'convo-user'});u.appendChild(h('div',{style:{fontSize:'10px',fontWeight:'600',color:'#9A918B',marginBottom:'2px'}},'ZÁKAZNÍK'));u.appendChild(h('div',{style:{fontSize:'13px'}},c.user_message));card.appendChild(u);
    const a=h('div',{className:'convo-ai'});a.appendChild(h('div',{style:{fontSize:'10px',fontWeight:'600',color:'#E85D26',marginBottom:'2px'}},'AI'));a.appendChild(h('div',{style:{fontSize:'13px'}},c.agent_reply));card.appendChild(a);
    el.appendChild(card)});
}

function renderCalls(el){
  el.appendChild(h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'14px'}},h('h2',{style:{fontSize:'20px',fontWeight:'800'}},'Hovory ('+calls.length+')'),h('button',{className:'btn',onclick:fetchData},'Obnoviť')));
  if(!calls.length){const emp=h('div',{className:'card empty'});emp.appendChild(h('div',{className:'empty-icon'},'📞'));emp.appendChild(h('div',{className:'empty-title'},'Zatiaľ žiadne hovory'));el.appendChild(emp);return}
  calls.forEach(c=>{const card=h('div',{className:'card',style:{marginBottom:'8px'}});
    card.appendChild(h('div',{style:{fontWeight:'700',fontSize:'14px'}},'📞 '+(c.customer_phone||'Neznáme')));
    card.appendChild(h('div',{style:{fontSize:'11px',color:'#9A918B'}},timeAgo(c.created_at)+' | '+Math.round((c.duration_seconds||0)/60)+' min'));
    if(c.transcript)card.appendChild(h('div',{style:{background:'#F5F4F0',borderRadius:'8px',padding:'10px',fontSize:'12px',color:'#5C5652',lineHeight:'1.6',maxHeight:'150px',overflowY:'auto',whiteSpace:'pre-wrap',marginTop:'8px'}},c.transcript));
    el.appendChild(card)});
}

render();
fetchBiz();
</script></body></html>`);
});

// ══════════════════════════════════════════════════════════
// GMAIL ENDPOINTS
// ══════════════════════════════════════════════════════════

// FAST — just list emails from "AI Risk" label, no AI analysis yet
app.get('/api/emails/recent', async (req, res) => {
  if (!gmailClient) return res.json({ error: 'Gmail nie je pripojený.', emails: [], connected: false });
  try {
    const max = parseInt(req.query.max) || 10;
    const emails = await fetchRecentEmails(max);
    if (!emails.length) return res.json({ emails: [], count: 0, connected: true });

    // Get business for context
    let biz = null, bizInfo = '';
    if (supabase) {
      const { data } = await supabase.from('businesses').select('*').limit(1).single();
      biz = data;
      if (biz) bizInfo = 'Služby: ' + (biz.services||'') + '. Ceny: ' + (biz.prices||'') + '. FAQ: ' + (biz.faq||'');
    }

    // Check which are already analyzed
    const cacheMap = {};
    if (supabase && emails.length > 0) {
      const ids = emails.map(e => e.id);
      const { data: cached } = await supabase.from('email_inbox').select('*').in('gmail_id', ids);
      (cached || []).forEach(c => { cacheMap[c.gmail_id] = c; });
    }

    // Analyze uncached emails and save to Supabase
    const result = [];
    for (const email of emails) {
      let analysis = null;

      if (cacheMap[email.id]) {
        // Already analyzed — use cached
        const c = cacheMap[email.id];
        analysis = {
          risk_score: c.risk_score, sentiment: c.sentiment,
          summary: c.ai_summary, ai_analysis: c.ai_suggestion,
          customer_intent: c.customer_intent, urgency: c.urgency,
          actions: (() => { try { return JSON.parse(c.ai_draft_reply); } catch(x) { return []; } })(),
        };
      } else if (anthropic) {
        // NEW email — analyze with AI
        console.log('Analyzing email:', email.subject, 'from:', email.from);
        analysis = await analyzeEmail(email, bizInfo);

        // Save to Supabase
        if (supabase && biz) {
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

          // Create/update lead (deduplicated by email address)
          const senderEmail = (email.from.match(/[\w.-]+@[\w.-]+\.\w+/) || [])[0] || '';
          const senderName = email.from.split('<')[0].trim().replace(/"/g, '') || '';
          const isOurs = ['gamat.sk','gamat.cz'].some(d => senderEmail.toLowerCase().endsWith(d));
          if (!isOurs && senderEmail) {
            const { data: existing } = await supabase.from('leads')
              .select('id').eq('business_id', biz.id).eq('email', senderEmail.toLowerCase()).limit(1).single();
            if (existing) {
              await supabase.from('leads').update({ updated_at: new Date().toISOString() }).eq('id', existing.id);
            } else {
              const lead = extractLead(email.from + ' ' + (email.body || ''));
              await supabase.from('leads').insert({
                business_id: biz.id, conversation_id: 'lead_' + senderEmail.toLowerCase().replace(/[^a-z0-9]/g, '_'),
                email: senderEmail.toLowerCase(), name: lead.name || senderName,
                phone: lead.phone || null, source: 'email', created_at: new Date().toISOString(),
              });
            }
          }
        }
      }

      result.push({ ...email, analysis });
    }

    res.json({ emails: result, count: result.length, connected: true });
  } catch(e) { res.status(500).json({ error: e.message, emails: [], connected: !!gmailClient }); }
});

// ANALYZE ONE EMAIL — call this per email, returns full AI scripts
app.post('/api/emails/analyze', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'AI nie je pripojená' });
  try {
    const { email_id } = req.body;

    // If email data is provided directly
    let email = req.body.email;

    // Or fetch from Gmail by ID
    if (!email && email_id && gmailClient) {
      try {
        const full = await gmailClient.users.messages.get({ userId: 'me', id: email_id, format: 'full' });
        const headers = full.data.payload?.headers || [];
        email = {
          id: email_id,
          from: headers.find(h => h.name === 'From')?.value || '',
          subject: headers.find(h => h.name === 'Subject')?.value || '',
          date: headers.find(h => h.name === 'Date')?.value || '',
          body: '', snippet: full.data.snippet || '',
        };
        if (full.data.payload?.body?.data) email.body = Buffer.from(full.data.payload.body.data, 'base64').toString('utf-8');
        else if (full.data.payload?.parts) {
          const tp = full.data.payload.parts.find(p => p.mimeType === 'text/plain');
          if (tp?.body?.data) email.body = Buffer.from(tp.body.data, 'base64').toString('utf-8');
        }
        email.body = email.body.split(/\n--\s*\n/)[0].split(/\nOn .+ wrote:/)[0].trim().slice(0, 2000);
      } catch(e) { return res.status(404).json({ error: 'Email nenájdený: ' + e.message }); }
    }

    if (!email) return res.status(400).json({ error: 'Pošli email_id alebo email objekt' });

    // Get business context
    let bizInfo = '';
    if (supabase) {
      const { data: biz } = await supabase.from('businesses').select('*').limit(1).single();
      if (biz) bizInfo = `Služby: ${biz.services}. Ceny: ${biz.prices}. FAQ: ${biz.faq}`;
    }

    console.log('Analyzing email:', email.subject, 'from:', email.from);
    const analysis = await analyzeEmail(email, bizInfo);
    console.log('Analysis done. Risk:', analysis.risk_score, 'Actions:', (analysis.actions||[]).length);

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
          ai_suggestion: analysis.ai_analysis || '',
          ai_draft_reply: JSON.stringify(analysis.actions || []),
          customer_intent: analysis.customer_intent,
          urgency: analysis.urgency,
          processed_at: new Date().toISOString(),
        }, { onConflict: 'gmail_id' });

        // Extract sender email for lead deduplication
        const senderEmail = (email.from.match(/[\w.-]+@[\w.-]+\.\w+/) || [])[0] || '';
        const senderName = email.from.split('<')[0].trim().replace(/"/g, '') || '';
        
        // Skip emails FROM our own domain (our replies) — only create leads from customers
        const ourDomains = ['gamat.sk', 'gamat.cz'];
        const isOurEmail = ourDomains.some(d => senderEmail.toLowerCase().endsWith(d));
        
        if (!isOurEmail && senderEmail) {
          // Use email address as the key — same customer = same lead regardless of how many emails
          const leadKey = 'lead_' + senderEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
          
          // First check if lead with this email already exists
          const { data: existingLead } = await supabase.from('leads')
            .select('id,created_at')
            .eq('business_id', biz.id)
            .eq('email', senderEmail.toLowerCase())
            .limit(1)
            .single();
          
          if (existingLead) {
            // Lead exists — just update the last contact time
            await supabase.from('leads').update({
              updated_at: new Date().toISOString(),
            }).eq('id', existingLead.id);
          } else {
            // New lead — create it
            const lead = extractLead(email.from + ' ' + (email.body || ''));
            await supabase.from('leads').insert({
              business_id: biz.id,
              conversation_id: leadKey,
              email: senderEmail.toLowerCase(),
              name: lead.name || senderName,
              phone: lead.phone || null,
              source: 'email',
              created_at: new Date().toISOString(),
            });
          }
        }
      }
    }

    res.json({ email, analysis });
  } catch(e) { console.error('Analyze error:', e.message); res.status(500).json({ error: e.message }); }
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

// One-click: delete all old businesses and register GAMAT
app.get('/setup/gamat', async (req, res) => {
  if(!supabase) return res.status(503).json({error:'Žiadna DB'});
  try {
    // Delete all old businesses
    await supabase.from('businesses').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    // Also clean up orphaned leads/emails/convos
    await supabase.from('leads').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('email_inbox').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    
    // Register GAMAT
    const {data,error}=await supabase.from('businesses').insert({
      name: 'GAMAT, s.r.o.',
      type: 'hydroizolácie a ploché strechy',
      location: 'Bobrovec 562, 032 21 Bobrovec / Prevádzka: Liptovský Mikuláš',
      hours: 'Po-Pia 7:00-16:00',
      services: 'Hydroizolácia plochej strechy, zateplenie plochej strechy, oprava a rekonštrukcia plochej strechy, zelená strecha, klampiarske práce, montáž bleskozvodu, revízie a údržba striech',
      prices: 'Cena závisí od stavu strechy. Orientačná kalkulácia na gamat.sk/cennik. Obhliadka, diagnostika a cenová ponuka sú ZADARMO.',
      faq: 'Pracujeme po celej SR a ČR za rovnaké ceny. Záruka 12-35 rokov. Materiály z Talianska, Francúzska a Nemecka. Bezúročné splátky. ISO 9001, 45001, 14001. 30+ rokov skúseností, 10300 projektov, 2.4 mil m2 striech.',
      phone: '+421911909191',
      email: 'info@gamat.sk',
      agent_name: 'Katka',
      phone_greeting: 'Dobrý deň, ďakujem že voláte firmu GAMAT. Pri telefóne Katka, ako vám môžem pomôcť?',
      plan: 'professional',
      created_at: new Date().toISOString(),
    }).select().single();
    if(error) throw error;
    res.send('<h1>✅ GAMAT zaregistrovaný!</h1><p>Business ID: <strong>'+data.id+'</strong></p><p>Stará pizzéria a staré dáta vymazané.</p><p><a href="/dashboard">Otvoriť Dashboard →</a></p>');
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
