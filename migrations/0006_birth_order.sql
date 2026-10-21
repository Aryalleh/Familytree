-- "Which child" (فرزند چندم) for ordering siblings; when empty, the year of birth is used.
ALTER TABLE people ADD COLUMN birth_order INTEGER;
