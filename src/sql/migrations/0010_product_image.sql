-- Cache the product cover image URL so the POS grid can render
-- photo-first cards offline. Mirrors restaurant_menu_items.image
-- on the server. Empty string means no image; the UI falls back
-- to the utensils icon.
ALTER TABLE products ADD COLUMN image_url TEXT NULL;
