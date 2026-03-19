// ═══════════════════════════════════════════════════════════
// AgentOS Backend API — server.js
// Deploy to: Vercel Serverless / Railway / Render
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── Clients ──────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── System prompt template ───────────────────────────────
function buildSystemPrompt(business) {
  return `You are a friendly, professional AI assistant for "${business.name}".

BUSINESS INFO:
- Type: ${business.type}
- Location: ${business.location || 'Not specified'}
- Hours: ${business.hours || 'Not specified'}
- Services/Menu: ${business.services || 'Not specified'}
- Prices: ${business.prices || 'Not specified'}
- FAQ: ${business.faq || 'No FAQ provided'}
- Booking link: ${business.booking_link || 'Not available'}
- Phone: ${business.phone || 'Not specified'}

YOUR RULES:
1. Be warm, helpful, and conversational. Use short replies (2-3 sentences max).
2. Answer questions about the business using ONLY the info above. If you don't know, say "Let me connect you with the team for that!" and collect their contact info.
3. Always try to guide the customer toward BOOKING or BUYING. Suggest available times, recommend services.
4. When a customer wants to book: collect their name, preferred date/time, and email/phone. Then confirm.
5. If someone asks about pricing, give specific numbers from the info above.
6. NEVER make up information that isn't provided above.
7. NEVER say you are AI or a chatbot. You are "${business.agent_name || 'the assistant'}".
8. Reply in the SAME LANGUAGE the customer uses.
9. Use emojis sparingly — max 1 per message.
10. If someone seems upset, be empathetic and offer to connect them with the owner.

LEAD CAPTURE: If the customer shares their name, email, or phone — note it. This is critical for the business.`;
}

// ── Chat endpoint ────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, business_id, conversation_id, history = [] } = req.body;

    if (!message || !business_id) {
      return res.status(400).json({ error: 'message and business_id required' });
    }

    // Fetch business config from Supabase
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', business_id)
      .single();

    if (bizError || !business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Build messages array
    const messages = [
      ...history.map(h => ({
        role: h.role,
        content: h.content,
      })),
      { role: 'user', content: message },
    ];

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: buildSystemPrompt(business),
      messages,
    });

    const reply = response.content[0].text;

    // Save conversation to Supabase
    await supabase.from('conversations').insert({
      business_id,
      conversation_id: conversation_id || crypto.randomUUID(),
      user_message: message,
      agent_reply: reply,
      created_at: new Date().toISOString(),
    });

    // Try to extract lead info (name, email, phone)
    const leadInfo = extractLeadInfo(message);
    if (leadInfo.email || leadInfo.phone || leadInfo.name) {
      await supabase.from('leads').upsert({
        business_id,
        conversation_id,
        name: leadInfo.name,
        email: leadInfo.email,
        phone: leadInfo.phone,
        source: 'chat_widget',
        created_at: new Date().toISOString(),
      }, { onConflict: 'conversation_id' });

      // Notify business owner (optional — via email webhook)
      // await notifyOwner(business, leadInfo);
    }

    res.json({
      reply,
      conversation_id: conversation_id || crypto.randomUUID(),
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Lead extraction helper ───────────────────────────────
function extractLeadInfo(text) {
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phoneMatch = text.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  const namePatterns = [
    /(?:my name is|i'm|this is|name:?)\s+([A-Z][a-z]+ ?[A-Z]?[a-z]*)/i,
    /^([A-Z][a-z]+ [A-Z][a-z]+)$/m,
  ];
  let name = null;
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match) { name = match[1].trim(); break; }
  }

  return {
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0] : null,
    name,
  };
}

// ── Waitlist endpoint ────────────────────────────────────
app.post('/api/waitlist', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { error } = await supabase
      .from('waitlist')
      .insert({ email, created_at: new Date().toISOString() });

    if (error && error.code === '23505') {
      return res.json({ message: 'Already on the waitlist!', duplicate: true });
    }
    if (error) throw error;

    res.json({ message: 'Welcome to the waitlist!' });
  } catch (err) {
    console.error('Waitlist error:', err);
    res.status(500).json({ error: 'Failed to join waitlist' });
  }
});

// ── Business registration endpoint ───────────────────────
app.post('/api/business/register', async (req, res) => {
  try {
    const { name, type, location, hours, services, prices, faq, phone, email, booking_link, agent_name } = req.body;

    const { data, error } = await supabase
      .from('businesses')
      .insert({
        name, type, location, hours, services, prices, faq,
        phone, email, booking_link,
        agent_name: agent_name || 'Assistant',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      business_id: data.id,
      widget_code: `<script src="https://YOUR_DOMAIN/widget.js" data-business-id="${data.id}"></script>`,
      message: 'Business registered! Use the widget code above on your website.',
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── Dashboard data endpoint ──────────────────────────────
app.get('/api/dashboard/:business_id', async (req, res) => {
  try {
    const { business_id } = req.params;

    const [convos, leads] = await Promise.all([
      supabase
        .from('conversations')
        .select('*')
        .eq('business_id', business_id)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('leads')
        .select('*')
        .eq('business_id', business_id)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    const today = new Date().toISOString().split('T')[0];
    const todayConvos = (convos.data || []).filter(c =>
      c.created_at.startsWith(today)
    );

    res.json({
      total_conversations: convos.data?.length || 0,
      today_conversations: todayConvos.length,
      total_leads: leads.data?.length || 0,
      recent_conversations: convos.data?.slice(0, 20) || [],
      recent_leads: leads.data?.slice(0, 20) || [],
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ── Start server ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AgentOS API running on port ${PORT}`);
});
