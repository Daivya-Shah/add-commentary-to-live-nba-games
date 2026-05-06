ALTER TABLE public.live_sessions
ALTER COLUMN file_url DROP NOT NULL;

ALTER TABLE public.live_sessions
ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'replay_file',
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS youtube_video_id TEXT,
ADD COLUMN IF NOT EXISTS clock_mode TEXT NOT NULL DEFAULT 'replay_media';

UPDATE public.live_sessions
SET source_url = COALESCE(source_url, file_url)
WHERE source_url IS NULL;
