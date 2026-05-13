-- Repair Storage + clips RLS for local/dev projects where the `videos` bucket
-- exists but storage.objects policies were never applied (or were removed).
-- Fixes: "Upload failed: new row violates row-level security policy"

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

-- Idempotent repair for clip rows after upload (same RLS symptom if policies missing)
DROP POLICY IF EXISTS "Public read clips" ON public.clips;
DROP POLICY IF EXISTS "Public insert clips" ON public.clips;
CREATE POLICY "Public read clips" ON public.clips FOR SELECT USING (true);
CREATE POLICY "Public insert clips" ON public.clips FOR INSERT WITH CHECK (true);
