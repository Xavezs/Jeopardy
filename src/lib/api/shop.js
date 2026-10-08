import { api } from '../api';

// Player's current coin balance
export async function fetchWallet() {
  return api('/api/shop/wallet');
}

export async function fetchCatalog() {
  return api('/api/shop/catalog');
}

// Currently equipped items keyed by type
export async function fetchLoadout() {
  return api('/api/shop/loadout');
}

// Purchase an item
export async function buyItem(itemId) {
  return api('/api/shop/buy', {
    method: 'POST',
    body: JSON.stringify({ itemId }),
  });
}

// Equip or unequip an owned item
export async function equipItem(itemId, equipped) {
  return api('/api/shop/equip', {
    method: 'POST',
    body: JSON.stringify({ itemId, equipped }),
  });
}
