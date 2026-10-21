-- How many sons and daughters a person had (when known), to spot children not entered yet.
ALTER TABLE people ADD COLUMN sons_count INTEGER;
ALTER TABLE people ADD COLUMN daughters_count INTEGER;
