// src/lib/api/shop.js
// Frontend helpers for the cosmetics shop API.
// All calls mirror the routes in discord-bot/shop.js.
import { api } from '../api';

/** Player's current coin balance. */
export async function fetchWallet() {
  return api('/api/shop/wallet');
}

/**
 * Full shop catalog with ownership + equipped flags.
 * Returns { coins, items: [{ id, name, description, price, type, data, owned, equipped }] }
 */
export async function fetchCatalog() {
  return api('/api/shop/catalog');
}

/**
 * Currently equipped items keyed by type.
 * Returns { buzz_sound: { id, name, type, data } | null, ... }
 */
export async function fetchLoadout() {
  return api('/api/shop/loadout');
}

/** Purchase an item. Returns { ok, coins, itemId } or throws. */
export async function buyItem(itemId) {
  return api('/api/shop/buy', {
    method: 'POST',
    body: JSON.stringify({ itemId }),
  });
}

/** Equip or unequip an owned item. Returns { ok, itemId, equipped }. */
export async function equipItem(itemId, equipped) {
  return api('/api/shop/equip', {
    method: 'POST',
    body: JSON.stringify({ itemId, equipped }),
  });
}
