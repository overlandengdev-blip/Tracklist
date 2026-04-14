-- Add 'mock' to CHECK constraints for development/testing
-- Without this, mock identification silently fails on insert/update

ALTER TABLE public.clips DROP CONSTRAINT IF EXISTS clips_resolution_source_check;
ALTER TABLE public.clips ADD CONSTRAINT clips_resolution_source_check
  CHECK (resolution_source IN ('acrcloud','audd','community','manual','mock'));

ALTER TABLE public.recognitions DROP CONSTRAINT IF EXISTS recognitions_service_check;
ALTER TABLE public.recognitions ADD CONSTRAINT recognitions_service_check
  CHECK (service IN ('acrcloud','audd','shazamkit','mock'));

INSERT INTO public.schema_version (version, description)
VALUES ('1.2.1', 'Add mock to recognition service and resolution source constraints');
