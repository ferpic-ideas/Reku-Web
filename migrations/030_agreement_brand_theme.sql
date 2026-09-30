ALTER TABLE agreements ADD COLUMN IF NOT EXISTS brand_theme TEXT NOT NULL DEFAULT '';
ALTER TABLE agreements ADD CONSTRAINT agreements_brand_theme_check CHECK (brand_theme IN ('', 'ypf-os'));
