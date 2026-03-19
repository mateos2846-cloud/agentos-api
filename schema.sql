-- ═══════════════════════════════════════════════════════════
-- AgentOS — Supabase Database Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- 1. Waitlist (landing page signups)
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Businesses (each customer's business config)
CREATE TABLE IF NOT EXISTS businesses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT, -- restaurant, salon, dental, legal, etc.
  location TEXT,
  hours TEXT,
  services TEXT, -- full text of services/menu
  prices TEXT, -- full text of pricing
  faq TEXT, -- frequently asked questions
  phone TEXT,
  email TEXT,
  booking_link TEXT,
  agent_name TEXT DEFAULT 'Assistant',
  owner_email TEXT, -- for notifications
  plan TEXT DEFAULT 'trial', -- trial, starter, pro, business
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Conversations (every chat message)
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL, -- groups messages in one session
  user_message TEXT,
  agent_reply TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Leads (extracted contact info from chats)
CREATE TABLE IF NOT EXISTS leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id TEXT UNIQUE, -- one lead per conversation
  name TEXT,
  email TEXT,
  phone TEXT,
  source TEXT DEFAULT 'chat_widget',
  status TEXT DEFAULT 'new', -- new, contacted, converted
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversations_business ON conversations(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(conversation_id);

-- 6. Enable Row Level Security (RLS) 
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- 7. Policies — service key bypasses RLS, so API calls work
-- For dashboard access later, add auth-based policies

-- Done! Your database is ready.
-- Next: copy SUPABASE_URL and SUPABASE_SERVICE_KEY to your .env file.
