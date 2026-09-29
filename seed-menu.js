const fs = require('node:fs');
const Database = require('better-sqlite3');

const html = fs.readFileSync('menu.html', 'utf8');
const db = new Database('mamanpaz.sqlite');
const insert = db.prepare('INSERT INTO menu_items (name, description, price_cents, category, image, available, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)');
const sections = [...html.matchAll(/<section id="([^"]+)" class="menu-section">([\s\S]*?)<\/section>/g)];
let inserted = 0;
const transaction = db.transaction(() => {
  for (const [, category, section] of sections) {
    const items = [...section.matchAll(/<div class="menu-item">([\s\S]*?)(?=<div class="menu-item">|<\/section>)/g)];
    items.forEach(([block], index) => {
      const name = block.match(/<span class="item-en">([^<]+)<\/span>/)?.[1]?.trim();
      const description = block.match(/<div class="menu-desc">([^<]*)<\/div>/)?.[1]?.trim() || '';
      const priceText = block.match(/<span class="price">\s*([0-9]+,[0-9]{2}) EUR/)?.[1];
      const image = block.match(/<img class="menu-item-image" src="([^"]+)"/)?.[1] || '';
      if (!name || !priceText) return;
      const priceCents = Math.round(Number(priceText.replace(',', '.')) * 100);
      if (!db.prepare('SELECT id FROM menu_items WHERE name = ?').get(name)) {
        insert.run(name, description, priceCents, category, image, index);
        inserted += 1;
      }
    });
  }
});
transaction();
console.log(`Seeded ${inserted} menu items into mamanpaz.sqlite.`);
