-- Vision2Voice: full schema for a fresh Supabase project (idempotent).
-- Run once: Dashboard → SQL Editor → New query → paste this file → Run.
-- Fixes: "Could not find the table 'public.clips'", Storage RLS upload errors.

-- ---------------------------------------------------------------------------
-- Core tables (offline analysis + evaluations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clips (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT,
  file_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.detections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  clip_id UUID NOT NULL REFERENCES public.clips(id) ON DELETE CASCADE,
  event_type TEXT,
  player_name TEXT,
  team_name TEXT,
  confidence NUMERIC,
  visual_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.retrieved_context (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  clip_id UUID NOT NULL REFERENCES public.clips(id) ON DELETE CASCADE,
  player_stats_json JSONB,
  team_stats_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commentaries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  clip_id UUID NOT NULL REFERENCES public.clips(id) ON DELETE CASCADE,
  model_name TEXT,
  commentary_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.evaluations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  clip_id UUID NOT NULL REFERENCES public.clips(id) ON DELETE CASCADE,
  fluency_score INTEGER,
  factual_score INTEGER,
  style_score INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Live replay
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.live_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  file_url TEXT,
  nba_game_id TEXT NOT NULL,
  start_period INTEGER NOT NULL,
  start_clock TEXT NOT NULL,
  cadence_sec NUMERIC NOT NULL DEFAULT 3,
  window_sec NUMERIC NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'created',
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  source_type TEXT NOT NULL DEFAULT 'replay_file',
  source_url TEXT,
  youtube_video_id TEXT,
  clock_mode TEXT NOT NULL DEFAULT 'replay_media'
);

CREATE TABLE IF NOT EXISTS public.live_captions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.live_sessions(id) ON DELETE CASCADE,
  event_id TEXT,
  period INTEGER,
  game_clock TEXT,
  event_type TEXT,
  player_name TEXT,
  team_name TEXT,
  score TEXT,
  caption_text TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence NUMERIC,
  latency_ms INTEGER,
  model_name TEXT,
  feed_description TEXT,
  visual_summary TEXT,
  feed_context_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  caption_stage TEXT NOT NULL DEFAULT 'initial',
  generated_at TIMESTAMPTZ,
  enriched_from_event_id TEXT
);

-- Upgrade path: older installs may be missing columns.
ALTER TABLE public.live_sessions ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'replay_file';
ALTER TABLE public.live_sessions ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE public.live_sessions ADD COLUMN IF NOT EXISTS youtube_video_id TEXT;
ALTER TABLE public.live_sessions ADD COLUMN IF NOT EXISTS clock_mode TEXT NOT NULL DEFAULT 'replay_media';

ALTER TABLE public.live_captions ADD COLUMN IF NOT EXISTS feed_context_json JSONB;
ALTER TABLE public.live_captions ADD COLUMN IF NOT EXISTS caption_stage TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE public.live_captions ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ;
ALTER TABLE public.live_captions ADD COLUMN IF NOT EXISTS enriched_from_event_id TEXT;

-- If an older DB had live_sessions.file_url NOT NULL, relax it.
ALTER TABLE public.live_sessions ALTER COLUMN file_url DROP NOT NULL;

UPDATE public.live_sessions
SET source_url = COALESCE(source_url, file_url)
WHERE source_url IS NULL AND file_url IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retrieved_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commentaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_captions ENABLE ROW LEVEL SECURITY;

-- Public policies (tool-style app; backend may use service role)
DROP POLICY IF EXISTS "Public read clips" ON public.clips;
DROP POLICY IF EXISTS "Public insert clips" ON public.clips;
CREATE POLICY "Public read clips" ON public.clips FOR SELECT USING (true);
CREATE POLICY "Public insert clips" ON public.clips FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public read detections" ON public.detections;
DROP POLICY IF EXISTS "Public insert detections" ON public.detections;
CREATE POLICY "Public read detections" ON public.detections FOR SELECT USING (true);
CREATE POLICY "Public insert detections" ON public.detections FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public read retrieved_context" ON public.retrieved_context;
DROP POLICY IF EXISTS "Public insert retrieved_context" ON public.retrieved_context;
CREATE POLICY "Public read retrieved_context" ON public.retrieved_context FOR SELECT USING (true);
CREATE POLICY "Public insert retrieved_context" ON public.retrieved_context FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public read commentaries" ON public.commentaries;
DROP POLICY IF EXISTS "Public insert commentaries" ON public.commentaries;
DROP POLICY IF EXISTS "Public update commentaries" ON public.commentaries;
CREATE POLICY "Public read commentaries" ON public.commentaries FOR SELECT USING (true);
CREATE POLICY "Public insert commentaries" ON public.commentaries FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update commentaries" ON public.commentaries FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Public read evaluations" ON public.evaluations;
DROP POLICY IF EXISTS "Public insert evaluations" ON public.evaluations;
DROP POLICY IF EXISTS "Public update evaluations" ON public.evaluations;
CREATE POLICY "Public read evaluations" ON public.evaluations FOR SELECT USING (true);
CREATE POLICY "Public insert evaluations" ON public.evaluations FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update evaluations" ON public.evaluations FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Public read live_sessions" ON public.live_sessions;
DROP POLICY IF EXISTS "Public insert live_sessions" ON public.live_sessions;
DROP POLICY IF EXISTS "Public update live_sessions" ON public.live_sessions;
CREATE POLICY "Public read live_sessions" ON public.live_sessions FOR SELECT USING (true);
CREATE POLICY "Public insert live_sessions" ON public.live_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update live_sessions" ON public.live_sessions FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Public read live_captions" ON public.live_captions;
DROP POLICY IF EXISTS "Public insert live_captions" ON public.live_captions;
CREATE POLICY "Public read live_captions" ON public.live_captions FOR SELECT USING (true);
CREATE POLICY "Public insert live_captions" ON public.live_captions FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Storage: videos bucket + policies
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('videos', 'videos', true)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  name = EXCLUDED.name;

DROP POLICY IF EXISTS "Public read videos" ON storage.objects;
DROP POLICY IF EXISTS "Public upload videos" ON storage.objects;
CREATE POLICY "Public read videos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'videos');
CREATE POLICY "Public upload videos"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'videos');
